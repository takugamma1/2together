#!/usr/bin/env python3
"""OneDistribution -> Shopify sync CLI.

    python3 sync.py bootstrap                 # verify tokens, pick location & sales channels
    python3 sync.py catalog [--full] [--ids 1,2] [--limit N] [--dry-run] [--export-only]
    python3 sync.py collections [--dry-run] [--export-only]
    python3 sync.py inventory [--full] [--dry-run] [--loop SECONDS]
    python3 sync.py discounts [--dry-run]      # mirror the public DISCOUNT page into compare-at prices + on-sale tag
    python3 sync.py all [--full]              # repair-media + catalog (incremental) + collections + discounts + inventory
    python3 sync.py repair-media              # re-flag products whose images failed to process
    python3 sync.py report                    # upstream catalog statistics, no Shopify calls

Environment: see onedist_sync/config.py (ONEDIST_API_KEY, SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, …).
A `.env` file next to this script is loaded if present (KEY=VALUE lines).
"""
from __future__ import annotations

import argparse
import collections
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main() -> int:
    load_dotenv()
    from onedist_sync.config import Settings
    from onedist_sync.prestashop import PrestaShop
    from onedist_sync.shopify_api import Shopify
    from onedist_sync.state import State
    from onedist_sync.util import log

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["bootstrap", "catalog", "collections", "inventory", "discounts", "all", "report", "repair-media"])
    ap.add_argument("--full", action="store_true", help="ignore watermarks/diffs and process everything")
    ap.add_argument("--ids", help="comma-separated PrestaShop product ids (catalog only)")
    ap.add_argument("--limit", type=int, help="process at most N products (catalog only)")
    ap.add_argument("--dry-run", action="store_true", help="no Shopify writes")
    ap.add_argument("--export-only", action="store_true", help="write payloads/plans to data/ and exit, no Shopify calls")
    ap.add_argument("--loop", type=int, metavar="SECONDS", help="inventory: keep running every N seconds")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    settings = Settings()
    state = State()
    ps = PrestaShop(settings, verbose=args.verbose)
    offline = args.export_only or args.command == "report"
    shop = Shopify(settings, dry_run=args.dry_run or offline, verbose=args.verbose)

    if args.command == "report":
        return report(ps, state)
    if args.command == "bootstrap":
        from onedist_sync.bootstrap import run_bootstrap
        run_bootstrap(settings, ps, shop, state)
        return 0

    from onedist_sync.catalog import build_catalog, run_catalog, run_repair_media
    from onedist_sync.collections import run_collections
    from onedist_sync.inventory import run_inventory

    ids = [int(x) for x in args.ids.split(",") if x.strip()] if args.ids else None
    rc = 0
    if args.command in {"repair-media", "all"}:
        run_repair_media(shop, state)
    if args.command in {"catalog", "all"}:
        c = run_catalog(settings, ps, shop, state, full=args.full, ids=ids, limit=args.limit, export_only=args.export_only)
        rc |= 1 if c.get("errors") else 0
    if args.command in {"collections", "all"}:
        catalog = build_catalog(settings, ps, state)
        c = run_collections(settings, ps, shop, state, catalog, export_only=args.export_only)
        rc |= 2 if c.get("errors") else 0
    if args.command in {"discounts", "all"}:
        from onedist_sync.discounts import run_discounts
        c = run_discounts(settings, shop, state, dry_run=args.dry_run or offline)
        rc |= 8 if c.get("errors") else 0
    if args.command in {"inventory", "all"}:
        while True:
            c = run_inventory(settings, ps, shop, state, full=args.full)
            rc |= 4 if c.get("errors") else 0
            if not args.loop:
                break
            log(f"sleeping {args.loop}s")
            time.sleep(args.loop)
    return rc


def report(ps, state) -> int:
    from onedist_sync.reference import load_combos, load_stock
    from onedist_sync.util import log
    index = ps.product_index()
    combos = load_combos(ps)
    stock = load_stock(ps)
    active = [r for r in index if r.get("active") == "1"]
    in_stock = {k[0] for k, q in stock.items() if q > 0}
    log(f"products upstream: {len(index)} total, {len(active)} active, "
        f"{sum(1 for r in active if str(r['id']) in in_stock)} active with stock")
    log(f"products with variants: {len(combos)} ({sum(len(v) for v in combos.values())} combinations)")
    brands = collections.Counter((r.get("manufacturer_name") or "—") for r in active if isinstance(r.get("manufacturer_name"), (str, bool)))
    log("top brands (active): " + ", ".join(f"{b} {n}" for b, n in brands.most_common(15)))
    log(f"linked in Shopify (state): {len(state.products)} products, {len(state.collections)} collections; "
        f"last catalog sync {state.data.get('last_catalog_sync') or '—'}, last inventory sync {state.data.get('last_inventory_sync') or '—'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
