"""Smart collections: one per PrestaShop category (tag rule) and one per brand (vendor rule).

Titles can be overridden (e.g. Bulgarian names) in collection_titles.csv — the file is
generated on first run with the English names and is never overwritten.
"""
from __future__ import annotations

import csv
import hashlib
import json

from .config import BRANDS_CATEGORY_ID, OVERRIDES_FILE, ROOT_CATEGORY_IDS, Settings
from .prestashop import PrestaShop
from .shopify_api import Shopify, ShopifyError
from .state import State
from .transform import Catalog, slugify, title_case
from .util import dump_json, load_json, log, warn

COLLECTION_CREATE = """
mutation collectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }"""
COLLECTION_UPDATE = """
mutation collectionUpdate($input: CollectionInput!) {
  collectionUpdate(input: $input) { collection { id handle } userErrors { field message } } }"""


def load_overrides() -> dict[str, dict]:
    if not OVERRIDES_FILE.exists():
        return {}
    with OVERRIDES_FILE.open(newline="", encoding="utf-8") as fh:
        return {row["key"]: row for row in csv.DictReader(fh)}


def write_overrides_template(rows: list[dict]) -> None:
    if OVERRIDES_FILE.exists():
        return
    with OVERRIDES_FILE.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["key", "kind", "parent", "source_title", "title", "description", "publish"])
        w.writeheader()
        w.writerows(rows)
    log(f"wrote {OVERRIDES_FILE.name} — edit `title`/`description` (e.g. Bulgarian names), set publish=0 to skip")


def plan_collections(settings: Settings, catalog: Catalog, vendors: set[str]) -> list[dict]:
    plans: list[dict] = []
    template_rows: list[dict] = []
    overrides = load_overrides()

    for cid, c in sorted(catalog.cats.items(), key=lambda kv: (int(kv[1]["level_depth"]), kv[0])):
        if cid in ROOT_CATEGORY_IDS or cid == BRANDS_CATEGORY_ID or catalog.is_brand_category(cid):
            continue
        if str(c.get("active")) != "1":
            continue
        key = f"cat:{cid}"
        parent = int(c["id_parent"])
        parent_title = catalog.category_title(parent) if parent not in ROOT_CATEGORY_IDS else ""
        src_title = catalog.category_title(cid)
        ov = overrides.get(key, {})
        template_rows.append({"key": key, "kind": "category", "parent": parent_title, "source_title": src_title,
                              "title": src_title, "description": "", "publish": "1"})
        if ov.get("publish", "1").strip() in {"0", "false", "no"}:
            continue
        title = (ov.get("title") or "").strip() or src_title
        if src_title.lower() == "pants" and parent_title:  # disambiguate duplicate leaf names
            title = f"{parent_title} {title}" if not ov.get("title") else title
        desc = (ov.get("description") or "").strip() or (c.get("description") or "")
        plans.append({
            "key": key, "handle": catalog.category_handle(cid), "title": title, "descriptionHtml": desc,
            "breadcrumb": " > ".join(catalog.category_path_titles(cid)),
            "rules": [{"column": "TAG", "relation": "EQUALS", "condition": catalog.category_tag(cid)}],
        })

    for vendor in sorted(v for v in vendors if v):
        key = f"brand:{slugify(vendor)}"
        ov = overrides.get(key, {})
        template_rows.append({"key": key, "kind": "brand", "parent": "Brands", "source_title": vendor,
                              "title": vendor, "description": "", "publish": "1"})
        if ov.get("publish", "1").strip() in {"0", "false", "no"}:
            continue
        plans.append({
            "key": key, "handle": f"brand-{slugify(vendor)}", "title": (ov.get("title") or "").strip() or vendor,
            "descriptionHtml": (ov.get("description") or "").strip(), "breadcrumb": f"Brands > {vendor}",
            "rules": [{"column": "VENDOR", "relation": "EQUALS", "condition": vendor}],
        })
    write_overrides_template(template_rows)
    return plans


def run_collections(settings: Settings, ps: PrestaShop, shop: Shopify, state: State, catalog: Catalog,
                    export_only: bool = False) -> dict:
    index = load_json("product_index.json") or ps.product_index()
    vendors = {(r.get("manufacturer_name") or "") for r in index if r.get("active") == "1" and isinstance(r.get("manufacturer_name"), str)}
    plans = plan_collections(settings, catalog, vendors)
    dump_json("collections_plan.json", plans)
    log(f"{len(plans)} collections planned ({sum(p['key'].startswith('cat:') for p in plans)} categories, "
        f"{sum(p['key'].startswith('brand:') for p in plans)} brands)")
    if export_only:
        return {"planned": len(plans)}

    publication_ids = state.data.get("publication_ids") or []
    counts = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}
    for plan in plans:
        input_ = {
            "title": plan["title"], "handle": plan["handle"], "descriptionHtml": plan["descriptionHtml"],
            "ruleSet": {"appliedDisjunctively": False, "rules": plan["rules"]}, "sortOrder": "BEST_SELLING",
        }
        digest = hashlib.sha256(json.dumps(input_, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        st = state.collections.get(plan["key"]) or {}
        if st.get("hash") == digest:
            counts["skipped"] += 1
            continue
        try:
            cid = st.get("collection_id")
            if not cid and not shop.dry_run:
                existing = shop.collection_by_handle(plan["handle"])
                cid = existing["id"] if existing else None
            if cid:
                input_["id"] = cid
                input_.pop("handle", None)
                input_.pop("ruleSet", None)  # rule sets of existing smart collections are not editable here
                node = shop.mutate(COLLECTION_UPDATE, {"input": input_}, "collectionUpdate")
                action = "updated"
            else:
                node = shop.mutate(COLLECTION_CREATE, {"input": input_}, "collectionCreate")
                action = "created"
            counts[action] += 1
            if shop.dry_run:
                log(f"[dry-run] {action} collection {plan['handle']} «{plan['title']}»")
                continue
            coll = node["collection"]
            if action == "created":
                shop.publish(coll["id"], publication_ids)
            state.collections[plan["key"]] = {"collection_id": coll["id"], "handle": coll["handle"], "hash": digest,
                                              "title": plan["title"]}
            log(f"{action} collection {coll['handle']} «{plan['title']}»")
        except ShopifyError as e:
            counts["errors"] += 1
            warn(f"collection {plan['handle']}: {e}")
    if not shop.dry_run:
        state.save()
    log(f"collections done: {counts}")
    return counts
