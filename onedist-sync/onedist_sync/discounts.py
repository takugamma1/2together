"""Promotions: mirror OneDistribution's public DISCOUNT category into Shopify compare-at prices.

The API key cannot read `specific_prices`, and the API `price` is always the regular price, so the
only discount source is the public category page (/100-discount), which lists every discounted
product with its regular price, promo price and percentage — no login needed.

For each discounted product we set on every variant:
    compareAtPrice = regular (the variant's current price, or its existing compareAtPrice once applied)
    price          = compareAtPrice × (1 − pct)
and add the `on-sale` tag. Products that disappear from the list are restored (price = compareAtPrice,
compareAtPrice cleared, tag removed). Idempotent — safe to run after every catalog sync.
"""
from __future__ import annotations

import html as html_mod
import re
from decimal import Decimal, ROUND_HALF_UP
from urllib import request

from .util import log, warn

DISCOUNT_URL = "https://www.onedistribution.com/100-discount"
UA = "Mozilla/5.0 (compatible; 2gether-onedist-sync/1.0)"


def _fetch(url: str) -> str:
    req = request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with request.urlopen(req, timeout=90) as r:
        return r.read().decode("utf-8", "ignore")


def _money(s: str) -> Decimal:
    s = re.sub(r"[^\d,.\-]", "", s or "").replace(",", "")
    return Decimal(s) if s else Decimal(0)


def scrape_discounts() -> dict[int, dict]:
    """Return {prestashop_product_id: {pct, regular, price, name}} for every discounted product."""
    out: dict[int, dict] = {}
    page = 1
    while True:
        doc = _fetch(f"{DISCOUNT_URL}?page={page}")
        arts = re.findall(r"<article[^>]*data-id-product=\"(\d+)\"(.*?)</article>", doc, re.S)
        if not arts:
            break
        for pid, body in arts:
            reg = re.search(r'class="regular-price"[^>]*>([^<]+)<', body)
            cur = re.search(r'class="price"[^>]*>\s*(?:<span[^>]*>)?\s*([^<]+)<', body)
            pct = re.search(r'discount-percentage"[^>]*>\s*-?\s*([\d.]+)\s*%', body)
            name = re.search(r'<h\d[^>]*product-title[^>]*>\s*<a[^>]*>([^<]+)<', body, re.S) or re.search(r'itemprop="name"[^>]*>([^<]+)<', body)
            if not (reg and cur):
                continue
            regular, price = _money(reg.group(1)), _money(cur.group(1))
            if regular <= 0 or price <= 0 or price >= regular:
                continue
            ratio = (Decimal(pct.group(1)) / 100) if pct else (1 - price / regular)
            out[int(pid)] = {"pct": float(ratio.quantize(Decimal("0.0001"))), "regular": str(regular), "price": str(price),
                             "name": html_mod.unescape(name.group(1).strip()) if name else ""}
        m = re.search(r"Showing \d+-(\d+) of (\d+) item", doc)
        if not m or int(m.group(1)) >= int(m.group(2)):
            break
        page += 1
        if page > 60:
            break
    return out


_Q_VARIANTS = """query($id: ID!) { product(id: $id) { id tags
  variants(first: 100) { nodes { id price compareAtPrice } } } }"""
_M_UPDATE = """mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { field message } } }"""
_M_TAGS_ADD = "mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }"
_M_TAGS_REMOVE = "mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { message } } }"
TAG = "on-sale"


def _round(d: Decimal, step: float) -> str:
    st = Decimal(str(step))
    if st > 0:
        d = (d / st).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * st
    return f"{d.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"


def run_discounts(settings, shop, state, dry_run: bool = False) -> dict:
    discounts = scrape_discounts()
    log(f"discounts: {len(discounts)} products discounted upstream")
    products = state.data.setdefault("products", {})
    applied: dict = state.data.setdefault("discounts", {})
    errors = 0
    changed = 0
    wanted = {str(pid): d for pid, d in discounts.items() if str(pid) in products}
    missing = [pid for pid in discounts if str(pid) not in products]
    if missing:
        log(f"discounts: {len(missing)} discounted products are not in Shopify (inactive/unsynced): {missing[:10]}")

    def _apply(pid: str, pct: float | None) -> None:
        nonlocal changed, errors
        gid = products[pid]["product_id"]
        try:
            prod = shop.gql(_Q_VARIANTS, {"id": gid}, "product")["product"]
        except Exception as e:  # noqa: BLE001
            warn(f"discounts: cannot read {pid}: {e}"); errors += 1; return
        if not prod:
            return
        updates = []
        for v in prod["variants"]["nodes"]:
            price, cmp_ = Decimal(v["price"]), Decimal(v["compareAtPrice"]) if v.get("compareAtPrice") else None
            if pct is not None:
                base = cmp_ if cmp_ and cmp_ > price else price
                new_price = _round(base * (1 - Decimal(str(pct))), settings.rounding)
                new_cmp = f"{base.quantize(Decimal('0.01'))}"
                if new_price != f"{price.quantize(Decimal('0.01'))}" or new_cmp != (v.get("compareAtPrice") or ""):
                    updates.append({"id": v["id"], "price": new_price, "compareAtPrice": new_cmp})
            elif cmp_ and cmp_ > price:
                updates.append({"id": v["id"], "price": f"{cmp_.quantize(Decimal('0.01'))}", "compareAtPrice": None})
        has_tag = TAG in (prod.get("tags") or [])
        if not updates and has_tag == (pct is not None):
            return
        changed += 1
        if dry_run:
            log(f"  [dry-run] {pid} {'discount %.0f%%' % (pct * 100) if pct is not None else 'restore'} → {updates[:2]}")
            return
        try:
            if updates:
                shop.mutate(_M_UPDATE, {"pid": gid, "v": updates}, "productVariantsBulkUpdate")
            if pct is not None and not has_tag:
                shop.mutate(_M_TAGS_ADD, {"id": gid, "t": [TAG]}, "tagsAdd")
            if pct is None and has_tag:
                shop.mutate(_M_TAGS_REMOVE, {"id": gid, "t": [TAG]}, "tagsRemove")
        except Exception as e:  # noqa: BLE001
            warn(f"discounts: update failed for {pid}: {e}"); errors += 1

    for pid, d in wanted.items():
        _apply(pid, d["pct"])
        applied[pid] = d["pct"]
    for pid in [p for p in list(applied) if p not in wanted]:
        if pid in products:
            _apply(pid, None)
        applied.pop(pid, None)
    if not dry_run:
        state.save()
    log(f"discounts: {len(wanted)} active in Shopify, {changed} products updated, {errors} errors")
    return {"active": len(wanted), "changed": changed, "errors": errors}
