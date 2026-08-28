"""Verify credentials/scopes and pin the location + sales-channel publications into state."""
from __future__ import annotations

from .config import Settings
from .prestashop import PrestaShop
from .shopify_api import Shopify
from .state import State
from .util import log, warn

REQUIRED_SCOPES = {"write_products", "write_inventory", "read_locations", "write_publications"}
NICE_SCOPES = {"write_files"}


def run_bootstrap(settings: Settings, ps: PrestaShop, shop: Shopify, state: State) -> None:
    langs = ps.languages()
    log(f"PrestaShop OK — languages: {', '.join(l['iso_code'] for l in langs)}")
    info = shop.shop_info()
    log(f"Shopify OK — {info['name']} ({info['myshopifyDomain']}), currency {info['currencyCode']}, plan {info['plan']['displayName']}")
    if info["currencyCode"] != "EUR":
        warn(f"store currency is {info['currencyCode']} but OneDistribution prices are EUR — set PRICE_MARKUP to convert")
    scopes = set(shop.scopes())
    missing = REQUIRED_SCOPES - scopes
    if missing:
        raise SystemExit(f"Admin API token is missing scopes: {sorted(missing)} (has {sorted(scopes)})")
    if NICE_SCOPES - scopes:
        warn(f"optional scopes missing: {sorted(NICE_SCOPES - scopes)}")

    locs = shop.locations()
    chosen = settings.location_id or next((l["id"] for l in locs if l["fulfillsOnlineOrders"]), locs[0]["id"] if locs else "")
    if not chosen:
        raise SystemExit("no active location found")
    names = {l["id"]: l["name"] for l in locs}
    log(f"inventory location: {names.get(chosen, '?')} ({chosen})")

    pubs = shop.publications()
    wanted = [p["id"] for p in pubs if (p.get("catalog") or {}).get("title") in {"Online Store", "Point of Sale"}
              or p.get("name") in {"Online Store", "Point of Sale"}]
    log("publish to: " + ", ".join((p.get("catalog") or {}).get("title") or p.get("name") or p["id"] for p in pubs if p["id"] in wanted))

    state.data["shop"] = info["myshopifyDomain"]
    state.data["location_id"] = chosen
    state.data["publication_ids"] = wanted
    state.save()
    log(f"state written to {state.path}")
