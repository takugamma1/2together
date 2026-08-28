"""Map PrestaShop product data into Shopify ProductSetInput payloads."""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from .config import BRANDS_CATEGORY_ID, ROOT_CATEGORY_IDS, Settings

METAFIELD_NS = "onedist"


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "item"


def title_case(name: str) -> str:
    """'HELMETS - PROTECTORS - GLOVES' -> 'Helmets - Protectors - Gloves', keep short all-caps tokens."""
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name:
        return name
    keep_upper = {"CO2", "GPS", "MTB", "XC", "BMX", "TCS", "KIT", "DH", "TLD"}
    words = []
    for w in name.split(" "):
        if w.upper() in keep_upper:
            words.append(w.upper())
        elif w.isupper() or w.islower():
            words.append(w.capitalize() if "&" not in w else w)
        else:
            words.append(w)
    return " ".join(words)


class Catalog:
    """Holds the reference tables needed to transform products."""

    def __init__(self, settings: Settings, categories: list[dict], features: dict[str, str],
                 feature_values: dict[str, dict], option_labels: dict) -> None:
        self.s = settings
        self.cats: dict[int, dict] = {int(c["id"]): c for c in categories}
        self.features = features
        self.feature_values = feature_values
        self.option_groups: dict[str, str] = option_labels.get("groups", {})
        self.option_values: dict[str, list] = option_labels.get("values", {})
        self._path_cache: dict[int, list[int]] = {}

    # ---- categories --------------------------------------------------------
    def ancestry(self, cid: int) -> list[int]:
        """[root..cid] excluding Root/Home. Empty for unknown ids."""
        if cid in self._path_cache:
            return self._path_cache[cid]
        path: list[int] = []
        cur = cid
        seen = set()
        while cur in self.cats and cur not in seen and cur not in ROOT_CATEGORY_IDS:
            seen.add(cur)
            path.append(cur)
            cur = int(self.cats[cur]["id_parent"])
        path.reverse()
        self._path_cache[cid] = path
        return path

    def is_brand_category(self, cid: int) -> bool:
        path = self.ancestry(cid)
        return bool(path) and path[0] == BRANDS_CATEGORY_ID

    def category_tag(self, cid: int) -> str:
        c = self.cats[cid]
        slug = slugify(c.get("link_rewrite") or c.get("name"))
        return f"{self.s.tag_prefix}-{slug}-c{cid}"

    def category_handle(self, cid: int) -> str:
        c = self.cats[cid]
        return f"{slugify(c.get('link_rewrite') or c.get('name'))}-{self.s.handle_suffix}{cid}"

    def category_title(self, cid: int) -> str:
        return title_case(self.cats[cid]["name"])

    def category_path_titles(self, cid: int) -> list[str]:
        return [self.category_title(c) for c in self.ancestry(cid)]

    def product_categories(self, p: dict) -> list[int]:
        """Non-brand categories the product belongs to, deepest last."""
        ids = [int(c["id"]) for c in (p.get("associations", {}).get("categories") or [])]
        ids = [c for c in ids if c in self.cats and c not in ROOT_CATEGORY_IDS and not self.is_brand_category(c)]
        return sorted(set(ids), key=lambda c: (len(self.ancestry(c)), c))

    def product_type(self, p: dict) -> str:
        cats = self.product_categories(p)
        default = int(p.get("id_category_default") or 0)
        if default in cats:
            return self.category_title(default)
        return self.category_title(cats[-1]) if cats else ""

    # ---- pricing -----------------------------------------------------------
    def price(self, base: str | float, impact: str | float = 0) -> str:
        raw = (Decimal(str(base or 0)) + Decimal(str(impact or 0))) * Decimal(str(self.s.vat)) * Decimal(str(self.s.markup))
        step = Decimal(str(self.s.rounding))
        if step > 0:
            raw = (raw / step).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * step
        return f"{raw.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"

    # ---- product -----------------------------------------------------------
    def handle(self, p: dict) -> str:
        return f"{slugify(p.get('link_rewrite') or p.get('name'))}-{self.s.handle_suffix}{p['id']}"

    def vendor(self, p: dict) -> str:
        v = p.get("manufacturer_name")
        return (v or "").strip() if isinstance(v, str) else ""

    @staticmethod
    def _normalise_feature_tag(fname: str, val: str) -> str:
        """Map PrestaShop feature tags onto the storefront facet format:
        Tire Size 29 -> 'Tyre Size: 29"'; Tire Width 700x25 -> 'Tyre Width: 25 mm'; 2.4 -> '2.4"'."""
        import re as _re
        name = fname.strip()
        v = str(val).strip().replace(",", ".")
        if name in ("Tire Size", "Tyre Size"):
            low = v.replace('"', "").replace("\u201d", "").strip().lower()
            if low in ("700c", "700", "28", "700c / 28"):
                return 'Tyre Size: 28" / 700c'
            if low == "650b":
                return 'Tyre Size: 27.5"'
            if _re.fullmatch(r"\d{2}(\.\d)?", low):
                return f'Tyre Size: {low}"'
            return f"Tyre Size: {v}"
        if name in ("Tire Width", "Tyre Width"):
            m = _re.fullmatch(r"700\s*[x\u00d7]\s*(\d{2})c?", v, _re.I)
            if m:
                return f"Tyre Width: {m.group(1)} mm"
            m = _re.fullmatch(r'(\d\.\d{1,2})"?', v)
            if m:
                return f'Tyre Width: {m.group(1)}"'
            return f"Tyre Width: {v}"
        return f"{name}: {v}"

    def tags(self, p: dict, option_names: list[str], option_values_by_name: dict[str, list[str]]) -> list[str]:
        tags: set[str] = set()
        for cid in self.product_categories(p):
            for anc in self.ancestry(cid):
                tags.add(self.category_tag(anc))
        for fv in p.get("associations", {}).get("product_features") or []:
            fid = str(fv.get("id"))
            vid = str(fv.get("id_feature_value"))
            fname = self.features.get(fid)
            val = (self.feature_values.get(vid) or {}).get("value", "").strip()
            if fname and val:
                tags.add(self._normalise_feature_tag(fname, val))
        for name in option_names:
            for val in option_values_by_name.get(name, []):
                tags.add(f"{name}: {val}")
        if p.get("on_sale") == "1":
            tags.add("on-sale")
        return sorted(tags)

    def images(self, p: dict, ps_site_image_url) -> list[dict]:
        link = p.get("link_rewrite") or slugify(p.get("name"))
        ids = [str(i["id"]) for i in (p.get("associations", {}).get("images") or [])]
        default = str(p.get("id_default_image") or "")
        if default in ids:
            ids.remove(default)
            ids.insert(0, default)
        return [{"originalSource": ps_site_image_url(i, link), "alt": p.get("name", ""), "contentType": "IMAGE",
                 "ps_image_id": i} for i in ids]

    def build(self, p: dict, combos: list[dict], stock: dict[tuple[str, str], int], location_id: str,
              image_url_fn) -> dict[str, Any]:
        """Return dict with keys: handle, input (ProductSetInput minus id), variant_keys, images_sig, hash."""
        pid = str(p["id"])
        active = str(p.get("active")) == "1"
        status = "ACTIVE" if active else "DRAFT"
        cats = self.product_categories(p)
        default = int(p.get("id_category_default") or 0)
        path_titles = self.category_path_titles(default if default in cats else cats[-1]) if cats else []

        base_sku = (p.get("reference") or "").strip() or f"OD-{pid}"
        variants: list[dict] = []
        variant_keys: list[str] = []
        option_names: list[str] = []
        option_values_by_name: dict[str, list[str]] = {}
        product_options: list[dict] = []

        if combos:
            # Determine option groups from the combos' option values (ordered by first appearance).
            group_order: list[str] = []
            for c in combos:
                for ov in c["associations"].get("product_option_values") or []:
                    g = (self.option_values.get(str(ov["id"])) or [None, None])[0]
                    g = g or f"g{ov['id']}"
                    if g not in group_order:
                        group_order.append(g)
            option_names = [self.option_groups.get(g, f"Option {g}") for g in group_order]
            seen_variant_values: set[tuple[str, ...]] = set()
            for c in combos:
                vals_by_group: dict[str, str] = {}
                for ov in c["associations"].get("product_option_values") or []:
                    g, label = (self.option_values.get(str(ov["id"])) or [None, None])
                    vals_by_group[g or f"g{ov['id']}"] = label or f"Value {ov['id']}"
                values = tuple(vals_by_group.get(g, "Default") for g in group_order)
                if values in seen_variant_values:
                    continue  # duplicate combos would be rejected by Shopify
                seen_variant_values.add(values)
                for name, val in zip(option_names, values):
                    option_values_by_name.setdefault(name, [])
                    if val not in option_values_by_name[name]:
                        option_values_by_name[name].append(val)
                key = str(c["id"])
                variant_keys.append(key)
                sku = (c.get("reference") or "").strip() or f"{base_sku}-{key}"
                qty = stock.get((pid, key), 0)
                v = {
                    "optionValues": [{"optionName": n, "name": val} for n, val in zip(option_names, values)],
                    "sku": sku,
                    "price": self.price(p.get("price"), c.get("price")),
                    "inventoryPolicy": "DENY",
                    "inventoryItem": {"tracked": True, "requiresShipping": True},
                    "metafields": [{"namespace": METAFIELD_NS, "key": "combination_id", "type": "number_integer", "value": key}],
                }
                if location_id:
                    v["inventoryQuantities"] = [{"locationId": location_id, "name": "available", "quantity": qty}]
                bc = (c.get("ean13") or "").strip()
                if bc:
                    v["barcode"] = bc
                variants.append(v)
            product_options = [{"name": n, "position": i + 1, "values": [{"name": v} for v in option_values_by_name[n]]}
                               for i, n in enumerate(option_names)]
        else:
            variant_keys.append("0")
            v = {
                "optionValues": [{"optionName": "Title", "name": "Default Title"}],
                "sku": base_sku,
                "price": self.price(p.get("price")),
                "inventoryPolicy": "DENY",
                "inventoryItem": {"tracked": True, "requiresShipping": True},
            }
            if location_id:
                v["inventoryQuantities"] = [{"locationId": location_id, "name": "available", "quantity": stock.get((pid, "0"), 0)}]
            bc = (p.get("ean13") or "").strip()
            if bc:
                v["barcode"] = bc
            variants.append(v)
            product_options = [{"name": "Title", "position": 1, "values": [{"name": "Default Title"}]}]

        body = p.get("description") or p.get("description_short") or ""
        files = self.images(p, image_url_fn)
        images_sig = hashlib.sha1("|".join(f["originalSource"] for f in files).encode()).hexdigest()

        input_: dict[str, Any] = {
            "handle": self.handle(p),
            "title": (p.get("name") or "").strip(),
            "descriptionHtml": body,
            "vendor": self.vendor(p),
            "productType": self.product_type(p),
            "tags": self.tags(p, option_names, option_values_by_name),
            "status": status,
            "productOptions": product_options,
            "variants": variants,
            "metafields": [
                {"namespace": METAFIELD_NS, "key": "product_id", "type": "number_integer", "value": pid},
                {"namespace": METAFIELD_NS, "key": "category_path", "type": "single_line_text_field", "value": " > ".join(path_titles)[:255]},
                {"namespace": METAFIELD_NS, "key": "date_upd", "type": "single_line_text_field", "value": p.get("date_upd") or ""},
            ],
        }
        input_["metafields"] = [m for m in input_["metafields"] if m["value"]]
        seo_title = (p.get("meta_title") or "").strip()
        seo_desc = (p.get("meta_description") or "").strip()
        if seo_title or seo_desc:
            input_["seo"] = {k: v for k, v in (("title", seo_title), ("description", seo_desc)) if v}

        # Hash excludes inventory quantities (inventory has its own sync) and files (tracked by images_sig).
        hashable = json.loads(json.dumps(input_))
        for v in hashable["variants"]:
            v.pop("inventoryQuantities", None)
        digest = hashlib.sha256(json.dumps(hashable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return {"handle": input_["handle"], "input": input_, "files": files, "variant_keys": variant_keys,
                "images_sig": images_sig, "hash": digest, "status": status}
