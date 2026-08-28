"""Inventory sync: PrestaShop stock_availables -> Shopify inventory levels (diff-based)."""
from __future__ import annotations

import datetime as dt
import time

from .config import Settings
from .prestashop import PrestaShop
from .reference import load_stock
from .shopify_api import Shopify, ShopifyError
from .state import State
from .util import log, warn

SET_QTY = """
mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { createdAt }
    userErrors { field message code } } }"""

BATCH = 100


def run_inventory(settings: Settings, ps: PrestaShop, shop: Shopify, state: State, full: bool = False) -> dict:
    t0 = time.time()
    location_id = state.data.get("location_id") or settings.location_id
    if not shop.dry_run and not location_id:
        raise SystemExit("No location id in state — run `sync.py bootstrap` first")
    stock = load_stock(ps)

    pending: list[tuple[str, str, str, int]] = []  # (ps_id, key, inventory_item_id, qty)
    for ps_id, st in state.products.items():
        for key, v in (st.get("variants") or {}).items():
            qty = stock.get((ps_id, key), 0)
            if full or v.get("qty") != qty:
                pending.append((ps_id, key, v["inventory_item_id"], qty))

    upstream_linked = {k for k in stock if k[0] in state.products}
    from .util import load_json
    active = {str(r["id"]) for r in (load_json("product_index.json") or []) if r.get("active") == "1"}
    unlinked_products = ({k[0] for k in stock} & active) - set(state.products)
    log(f"inventory: {len(pending)} level changes to push; {len(upstream_linked)} linked stock rows; "
        f"{len(unlinked_products)} upstream products not in Shopify (run catalog)")

    pushed = errors = 0
    for i in range(0, len(pending), BATCH):
        chunk = pending[i:i + BATCH]
        payload = {
            "name": "available", "reason": "correction", "ignoreCompareQuantity": True,
            "quantities": [{"inventoryItemId": iid, "locationId": location_id, "quantity": q} for _, _, iid, q in chunk],
        }
        try:
            shop.mutate(SET_QTY, {"input": payload}, "inventorySetQuantities")
        except ShopifyError as e:
            errors += len(chunk)
            warn(f"inventory batch {i // BATCH + 1}: {e}")
            if "inventoryItemId" in str(e) or "not found" in str(e).lower():
                _push_one_by_one(shop, state, chunk, location_id)
            continue
        pushed += len(chunk)
        if not shop.dry_run:
            for ps_id, key, _, q in chunk:
                state.products[ps_id]["variants"][key]["qty"] = q
            state.save()
    if not shop.dry_run:
        state.data["last_inventory_sync"] = dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
        state.save()
    log(f"inventory done in {time.time() - t0:.0f}s: pushed={pushed} errors={errors}")
    return {"pushed": pushed, "errors": errors, "pending": len(pending)}


def _push_one_by_one(shop: Shopify, state: State, chunk: list, location_id: str) -> None:
    """Isolate the bad inventory item(s) in a failed batch so the rest still land."""
    for ps_id, key, iid, q in chunk:
        payload = {"name": "available", "reason": "correction", "ignoreCompareQuantity": True,
                   "quantities": [{"inventoryItemId": iid, "locationId": location_id, "quantity": q}]}
        try:
            shop.mutate(SET_QTY, {"input": payload}, "inventorySetQuantities")
            state.products[ps_id]["variants"][key]["qty"] = q
        except ShopifyError as e:
            warn(f"inventory item {iid} (ps {ps_id}/{key}): {e} — drop from state so catalog re-links it")
            state.products[ps_id]["hash"] = ""
    state.save()
