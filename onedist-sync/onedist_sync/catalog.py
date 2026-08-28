"""Product catalog sync: PrestaShop products -> Shopify products (productSet upsert)."""
from __future__ import annotations

import datetime as dt
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .config import Settings
from .prestashop import PrestaShop
from .media import find_broken_media, stage_images
from .reference import ensure_option_labels, load_combos, load_stock
from .shopify_api import Shopify, ShopifyError, UserErrors
from .state import State
from .transform import Catalog
from .util import dump_json, log, warn

PRODUCT_SET = """
mutation productSet($input: ProductSetInput!, $sync: Boolean!) {
  productSet(input: $input, synchronous: $sync) {
    product {
      id handle status
      variants(first: 100) { nodes { id sku inventoryItem { id } } }
    }
    userErrors { field message code }
  }
}"""

DELETE_MEDIA = """
mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds userErrors { field message } } }"""

PRODUCT_UPDATE_STATUS = """
mutation productUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id status } userErrors { field message } } }"""


def build_catalog(settings: Settings, ps: PrestaShop, state: State) -> Catalog:
    categories = ps.categories()
    dump_json("categories.json", categories)
    features = ps.product_features()
    feature_values = ps.product_feature_values()
    return Catalog(settings, categories, features, feature_values, state.data["option_labels"])


def select_products(ps: PrestaShop, state: State, settings: Settings, full: bool, ids: list[int] | None,
                    limit: int | None) -> tuple[list[dict], dict[str, dict], str]:
    """Returns (products to process, index by id, new watermark)."""
    index = {str(r["id"]): r for r in ps.product_index()}
    dump_json("product_index.json", list(index.values()))
    watermark = max((r.get("date_upd") or "" for r in index.values()), default="")
    if ids:
        products = ps.products_full(ids=ids)
    elif full or not state.data.get("last_catalog_sync"):
        products = ps.products_full()
    else:
        # 2h safety margin: PrestaShop timestamps are server-local and not monotonic.
        since = dt.datetime.strptime(state.data["last_catalog_sync"], "%Y-%m-%d %H:%M:%S") - dt.timedelta(hours=2)
        products = ps.products_full(updated_since=since.strftime("%Y-%m-%d %H:%M:%S"))
        # products never pushed before must be included even if not recently updated
        missing = [int(pid) for pid, r in index.items()
                   if pid not in state.products and (r.get("active") == "1" or settings.include_inactive)
                   and pid not in {str(p["id"]) for p in products}]
        have = {str(p["id"]) for p in products}
        redo = [int(pid) for pid, st in state.products.items()
                if (not st.get("images_sig") or not st.get("hash")) and pid in index and pid not in have]
        if redo:
            log(f"{len(redo)} products flagged for re-push (images/relink), fetching them too")
        missing += redo
        if missing:
            products.extend(ps.products_full(ids=missing))
    if limit:
        products = products[:limit]
    return products, index, watermark


def upsert_product(shop: Shopify, state: State, built: dict, ps_id: str, location_id: str,
                   publication_ids: list[str], ps: PrestaShop | None = None) -> str:
    """Create/update one product. Returns 'created' | 'updated' | 'skipped'."""
    st = state.product(ps_id) or {}
    if st and st.get("hash") == built["hash"] and st.get("images_sig") == built["images_sig"] and st.get("variants"):
        return "skipped"

    product_id = st.get("product_id")
    existing = None
    if not product_id:
        existing = shop.product_by_handle(built["handle"]) if not shop.dry_run else None
        if existing:
            product_id = existing["id"]

    input_ = dict(built["input"])
    if product_id:
        input_["id"] = product_id
        input_.pop("handle", None)
    need_files = (not product_id) or (st.get("images_sig") != built["images_sig"])
    if need_files:
        if product_id and not shop.dry_run:
            if existing is None:
                existing = shop.gql("query($id: ID!){ product(id:$id){ media(first:100){ nodes{ id } } } }",
                                    {"id": product_id}, "product").get("product")
            media_ids = [m["id"] for m in ((existing or {}).get("media") or {}).get("nodes", [])]
            if media_ids:
                shop.mutate(DELETE_MEDIA, {"productId": product_id, "mediaIds": media_ids}, "productDeleteMedia")
        staged = stage_images(ps, shop, int(ps_id), built["files"]) if ps else built["files"]
        if staged:
            input_["files"] = staged
        images_ok = len(staged) == len(built["files"])
    else:
        images_ok = True
    if product_id:
        # inventory is owned by the inventory sync once the product exists
        for v in input_["variants"]:
            v.pop("inventoryQuantities", None)

    result = shop.mutate(PRODUCT_SET, {"input": input_, "sync": True}, "productSet")
    action = "updated" if product_id else "created"
    if shop.dry_run:
        return action

    product = result.get("product") or {}
    by_sku = {v["sku"]: v for v in product.get("variants", {}).get("nodes", [])}
    variants: dict[str, dict] = {}
    prev_variants = st.get("variants", {})
    for key, vin in zip(built["variant_keys"], built["input"]["variants"]):
        node = by_sku.get(vin["sku"])
        if not node:
            warn(f"product {ps_id}: variant sku {vin['sku']} not returned by Shopify")
            continue
        qty = None
        if action == "created" and vin.get("inventoryQuantities"):
            qty = vin["inventoryQuantities"][0]["quantity"]
        elif key in prev_variants:
            qty = prev_variants[key].get("qty")
        variants[key] = {"variant_id": node["id"], "inventory_item_id": node["inventoryItem"]["id"],
                         "sku": vin["sku"], "qty": qty}
    if action == "created" or not st.get("published"):
        try:
            shop.publish(product["id"], publication_ids)
            published = True
        except ShopifyError as e:
            warn(f"publish failed for {ps_id}: {e}")
            published = False
    else:
        published = True
    state.products[ps_id] = {
        "product_id": product["id"], "handle": product["handle"], "hash": built["hash"],
        "images_sig": built["images_sig"] if images_ok else "", "status": built["status"], "variants": variants,
        "published": published, "synced_at": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    return action


def set_status(shop: Shopify, state: State, ps_id: str, status: str) -> None:
    st = state.product(ps_id)
    if not st or st.get("status") == status:
        return
    shop.mutate(PRODUCT_UPDATE_STATUS, {"product": {"id": st["product_id"], "status": status}}, "productUpdate")
    if not shop.dry_run:
        st["status"] = status


def run_catalog(settings: Settings, ps: PrestaShop, shop: Shopify, state: State, full: bool = False,
                ids: list[int] | None = None, limit: int | None = None, export_only: bool = False) -> dict:
    t0 = time.time()
    location_id = state.data.get("location_id") or settings.location_id
    publication_ids = state.data.get("publication_ids") or []
    if not shop.dry_run and not location_id:
        raise SystemExit("No location id in state — run `sync.py bootstrap` first")

    log("loading reference data (categories, features, combinations, stock)…")
    combos = load_combos(ps)
    stock = load_stock(ps)
    products, index, watermark = select_products(ps, state, settings, full, ids, limit)
    active_ids = {pid for pid, r in index.items() if r.get("active") == "1"}
    ensure_option_labels(ps, state, combos, active_ids)
    catalog = build_catalog(settings, ps, state)
    log(f"{len(products)} products to evaluate ({len(active_ids)} active upstream, {len(state.products)} already linked)")

    counts = {"created": 0, "updated": 0, "skipped": 0, "ignored_inactive": 0, "drafted": 0, "errors": 0}
    exported: list[dict] = []
    errors: list[dict] = []
    work: list[tuple[str, dict]] = []
    for p in products:
        pid = str(p["id"])
        active = str(p.get("active")) == "1"
        if not active and not settings.include_inactive:
            if state.product(pid):
                try:
                    _apply_removed(shop, state, pid, settings)
                    counts["drafted"] += 1
                except ShopifyError as e:
                    counts["errors"] += 1
                    errors.append({"id": pid, "error": str(e)})
            else:
                counts["ignored_inactive"] += 1
            continue
        built = catalog.build(p, combos.get(pid, []), stock, location_id, ps.image_url)
        if export_only:
            exported.append({"ps_id": pid, **{k: built[k] for k in ("handle", "input", "files", "variant_keys")}})
        else:
            work.append((pid, built))

    lock = threading.Lock()
    done = 0

    def push(item: tuple[str, dict]) -> tuple[str, dict, str | Exception]:
        pid, built = item
        try:
            return pid, built, upsert_product(shop, state, built, pid, location_id, publication_ids, ps)
        except (UserErrors, ShopifyError) as e:
            return pid, built, e

    if work:
        workers = 1 if shop.dry_run else max(1, settings.workers)
        log(f"pushing {len(work)} products with {workers} worker(s)")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for fut in as_completed([pool.submit(push, w) for w in work]):
                pid, built, outcome = fut.result()
                with lock:
                    done += 1
                    if isinstance(outcome, Exception):
                        counts["errors"] += 1
                        errors.append({"id": pid, "handle": built["handle"], "error": str(outcome)})
                        warn(f"[{done}/{len(work)}] {built['handle']}: {outcome}")
                    else:
                        counts[outcome] += 1
                        if outcome != "skipped":
                            log(f"[{done}/{len(work)}] {outcome} {built['handle']} ({len(built['variant_keys'])} var, {len(built['files'])} img)")
                    if done % 25 == 0 and not shop.dry_run:
                        state.save()

    if export_only:
        path = dump_json("shopify_payloads.json", exported)
        log(f"exported {len(exported)} payloads to {path}")
        return counts

    # Products we pushed before that vanished upstream entirely (only trustworthy on a full listing).
    if not ids:
        gone = [pid for pid in list(state.products) if pid not in index]
        for pid in gone:
            try:
                _apply_removed(shop, state, pid, settings)
                counts["drafted"] += 1
            except ShopifyError as e:
                counts["errors"] += 1
                errors.append({"id": pid, "error": str(e)})

    if not shop.dry_run and not ids and not limit:
        state.data["last_catalog_sync"] = watermark
    if not shop.dry_run:
        state.save()
    if errors:
        dump_json("catalog_errors.json", errors)
    log(f"catalog done in {time.time() - t0:.0f}s: {counts}  (Shopify calls: {shop.calls})")
    return counts


def run_repair_media(shop: Shopify, state: State) -> int:
    """Find products whose media failed/missing, delete the failed media and flag them for re-upload."""
    if shop.dry_run:
        return 0
    broken = find_broken_media(shop)
    by_gid = {st["product_id"]: pid for pid, st in state.products.items() if st.get("product_id")}
    flagged = 0
    for gid, failed in broken.items():
        pid = by_gid.get(gid)
        if not pid:
            continue
        shop.mutate(DELETE_MEDIA, {"productId": gid, "mediaIds": failed}, "productDeleteMedia")
        log(f"repair-media: {state.products[pid].get('handle')} had {len(failed)} failed image(s)")
        state.products[pid]["images_sig"] = ""
        flagged += 1
    state.save()
    log(f"repair-media: {flagged} products flagged for image re-upload (run `catalog` to push)")
    return flagged


def _apply_removed(shop: Shopify, state: State, pid: str, settings: Settings) -> None:
    mode = settings.on_removed
    if mode == "skip":
        return
    set_status(shop, state, pid, "ARCHIVED" if mode == "archive" else "DRAFT")
