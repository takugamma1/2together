"""Configuration — everything comes from environment variables (no secrets in source).

Required:
    ONEDIST_API_KEY        PrestaShop webservice key
    SHOPIFY_STORE          e.g. 2togetherb.myshopify.com
    SHOPIFY_ACCESS_TOKEN   shpat_... (Admin API, see README for scopes) — OR instead:
    SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   app credentials; a 24h token is fetched automatically

Optional:
    ONEDIST_API_URL        default https://www.onedistribution.com/api
    ONEDIST_SITE_URL       default https://www.onedistribution.com (public image/page URLs)
    SHOPIFY_API_VERSION    default 2025-10
    SHOPIFY_LOCATION_ID    gid://shopify/Location/... (default: first active location)
    PRICE_VAT_MULTIPLIER   default 1.20  (API prices are net of 20% VAT)
    PRICE_MARKUP           default 1.00  (extra multiplier on top of VAT)
    PRICE_ROUNDING         default 0.01  (e.g. 0.10 or 1.00 to round up to nicer prices)
    INCLUDE_INACTIVE       default 0     (1 = import inactive products as DRAFT)
    ON_REMOVED             default draft (draft | archive | skip) for products gone/inactive upstream
    HANDLE_SUFFIX          default od    (handle = <link_rewrite>-od<id>)
    TAG_PREFIX             default od    (category tags: od-<slug>-c<id>)
    IMAGE_SIZE             default large_default (PrestaShop image type for public URLs)
    SYNC_WORKERS           default 4 (parallel product pushes)
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATE_DIR = ROOT / "state"
STATE_FILE = STATE_DIR / "state.json"
OVERRIDES_FILE = ROOT / "collection_titles.csv"

# PrestaShop category ids that are structural, never become collections/tags.
ROOT_CATEGORY_IDS = {1, 2}   # Root, Home
BRANDS_CATEGORY_ID = 3       # "BRANDS" subtree -> vendor, not category


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_float(name: str, default: float) -> float:
    raw = env(name)
    return float(raw) if raw else default


def env_bool(name: str, default: bool = False) -> bool:
    raw = env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        self.ps_key = env("ONEDIST_API_KEY")
        self.ps_api = env("ONEDIST_API_URL", "https://www.onedistribution.com/api").rstrip("/")
        self.ps_site = env("ONEDIST_SITE_URL", "https://www.onedistribution.com").rstrip("/")
        self.shop = env("SHOPIFY_STORE")
        self.token = env("SHOPIFY_ACCESS_TOKEN")
        self.client_id = env("SHOPIFY_CLIENT_ID")
        self.client_secret = env("SHOPIFY_CLIENT_SECRET")
        self.api_version = env("SHOPIFY_API_VERSION", "2025-10")
        self.location_id = env("SHOPIFY_LOCATION_ID")
        self.vat = env_float("PRICE_VAT_MULTIPLIER", 1.20)
        self.markup = env_float("PRICE_MARKUP", 1.00)
        self.rounding = env_float("PRICE_ROUNDING", 0.01)
        self.include_inactive = env_bool("INCLUDE_INACTIVE", False)
        self.on_removed = env("ON_REMOVED", "draft").lower()
        self.handle_suffix = env("HANDLE_SUFFIX", "od")
        self.tag_prefix = env("TAG_PREFIX", "od")
        self.image_size = env("IMAGE_SIZE", "large_default")
        self.workers = int(env("SYNC_WORKERS", "4") or 4)

    def shop_domain(self) -> str:
        s = self.shop.replace("https://", "").replace("http://", "").rstrip("/")
        if s and not s.endswith(".myshopify.com"):
            s += ".myshopify.com"
        return s

    def require_prestashop(self) -> None:
        if not self.ps_key:
            raise SystemExit("ONEDIST_API_KEY env var not set")

    def require_shopify(self) -> None:
        if not self.shop_domain():
            raise SystemExit("SHOPIFY_STORE env var not set")
        if not self.token and not (self.client_id and self.client_secret):
            raise SystemExit("set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET")
