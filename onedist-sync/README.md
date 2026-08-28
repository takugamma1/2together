# OneDistribution → Shopify sync

Imports the OneDistribution (PrestaShop) wholesale catalog into the 2gether Shopify store and keeps
**inventory** in sync from their side. Pure Python 3.10+ stdlib — no dependencies.

| What | Source | Shopify |
|---|---|---|
| Products (active only by default) | `/api/products` | `productSet` upsert, handle `<link_rewrite>-od<id>` |
| Variants | `/api/combinations` + option labels scraped from the public product page (the API key can't read `product_option_values`) | options/variants, SKU = combination reference or `<ref>-<combo id>`, barcode = EAN |
| Images | downloaded via the authenticated API (`/api/images/products/<id>/<img>`) and pushed through Shopify staged uploads — onedistribution.com's Cloudflare 403s Shopify's own fetcher | product media, re-uploaded only when the image set changes |
| Price | API price is **ex‑VAT EUR** → `price × PRICE_VAT_MULTIPLIER (1.20) × PRICE_MARKUP (1.00)` | variant price |
| Brand | `manufacturer_name` | Vendor |
| Categories | every non‑brand category of the product + its ancestors | tags `od-<slug>-c<id>`; `productType` = default category; metafield `onedist.category_path` |
| Collections | each category → smart collection (tag rule), each brand → smart collection (vendor rule) | `collections` command |
| Stock | `/api/stock_availables` | `inventorySetQuantities` at one location, diff-based |
| Removed / deactivated upstream | — | status `DRAFT` (`ON_REMOVED=archive` to archive instead) |

Tags also get `Feature: value` (from PrestaShop features, where set), `Size: M`‑style option tags,
and `on-sale` — use them in **Search & Discovery → Filters**.

## Setup (once)

1. Shopify admin → **Settings → Apps and sales channels → Develop apps → Create app** (`OneDistribution sync`).
   Admin API scopes: `write_products`, `read_products`, `write_inventory`, `read_inventory`,
   `read_locations`, `write_publications`, `read_publications`, `write_files`. Install → copy the `shpat_…` token.
   Alternatively use an app from the Dev Dashboard with the same scopes: its **Client ID / Client secret**
   work directly (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`) — the tool exchanges them for a 24h token itself.
2. `cp .env.example .env` and fill in `SHOPIFY_STORE` + token or client credentials.
3. `python3 sync.py bootstrap` — checks both APIs, picks the inventory location and the sales channels
   (Online Store / POS) to publish to, and writes `state/state.json`.

## First import

```bash
python3 sync.py catalog --dry-run --limit 20     # look at what would happen
python3 sync.py catalog --ids 8720,6038          # push two real products, check them in admin
python3 sync.py catalog --full                   # everything (~4,900 active products, ~1–2 h)
python3 sync.py collections                      # ~140 category + ~60 brand smart collections
python3 sync.py inventory --full                 # set every stock level
```

`catalog --export-only` writes all Shopify payloads to `data/shopify_payloads.json` without any Shopify call —
handy to review titles/tags/prices first.

Collection titles: the first `collections` run writes `collection_titles.csv` (English names from
OneDistribution). Edit the `title`/`description` columns (e.g. Bulgarian), set `publish=0` for ones you
don't want, then re-run `collections`. Hook the collections into the menu in **Online Store → Navigation**.

## Keeping it in sync

- `python3 sync.py inventory` — pulls every stock row (one request) and pushes only the levels that changed.
  Run it every 10–15 min. `--loop 600` keeps it running in the foreground.
- `python3 sync.py repair-media` — finds products whose media failed/missing and flags them for re-upload (part of `all`).
- `python3 sync.py all` — repair-media, incremental catalog (products updated since the last run + anything new),
  collections, inventory. Run hourly or nightly.
- `deploy/onedist-sync.yml` is a ready GitHub Actions workflow (inventory every 15 min, `all` nightly,
  commits `state/state.json` back); `deploy/com.2gether.onedist-inventory.plist` does the same on a Mac via launchd.

Inventory in Shopify is **owned by OneDistribution**: any manual stock edit in Shopify admin is overwritten
on the next run. Price/description edits in Shopify are also overwritten when the upstream product changes
(the product is rewritten as a whole); edit `PRICE_*` in `.env` rather than single products.

## State & safety

`state/state.json` maps PrestaShop ids → Shopify ids, content hashes and last pushed quantities.
Unchanged products are skipped, so re-running `catalog --full` is cheap. If the file is lost the next run
re-links products by handle. Nothing is ever deleted in Shopify; removed products become drafts.

Exit code bits: 1 catalog errors, 2 collection errors, 4 inventory errors. Errors are written to
`data/catalog_errors.json`.

## Known limits

- Sizes are mostly separate products upstream (e.g. one product per jersey size). They are imported 1:1;
  merging them into size variants is a possible follow-up (heuristic on title).
- PrestaShop has no Bulgarian product texts; titles/descriptions are English.
- Weight is 0 for every upstream product, so no weights are set.
