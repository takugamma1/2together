"""PrestaShop Webservice client for onedistribution.com.

Only GET is used. Authentication is HTTP Basic with the key as username.
The key is restricted: products, categories, combinations, stock_availables,
images, product_features, product_feature_values, manufacturers, languages work;
product_options / product_option_values / tags / specific_prices are blocked,
so variant option labels are scraped from the public product page instead.
"""
from __future__ import annotations

import base64
import html
import json
import re
import time
from typing import Any, Iterator
from urllib import error, parse, request

from .config import Settings

UA = "2gether-onedist-sync/1.0"


class PrestaShopError(RuntimeError):
    pass


class PrestaShop:
    def __init__(self, settings: Settings, verbose: bool = False) -> None:
        settings.require_prestashop()
        self.base = settings.ps_api
        self.site = settings.ps_site
        self.image_size = settings.image_size
        self.verbose = verbose
        token = base64.b64encode(f"{settings.ps_key}:".encode()).decode()
        self._auth = f"Basic {token}"

    # ---- low level -------------------------------------------------------
    def _get(self, resource: str, params: dict[str, str] | None = None, raw: bool = False,
             timeout: int = 180) -> Any:
        q = {"output_format": "JSON"}
        q.update(params or {})
        # PrestaShop wants literal [] in display/filter params; quote only values.
        query = "&".join(f"{k}={parse.quote(str(v), safe='[],%:><')}" for k, v in q.items())
        url = f"{self.base}/{resource}?{query}"
        if self.verbose:
            print(f"  GET {url}")
        req = request.Request(url, headers={"Authorization": self._auth, "User-Agent": UA})
        last_err: Exception | None = None
        for attempt in range(5):
            try:
                with request.urlopen(req, timeout=timeout) as resp:
                    body = resp.read()
                    if raw:
                        return body
                    if not body:
                        return {}
                    data = json.loads(body)
                    if isinstance(data, dict) and data.get("errors"):
                        raise PrestaShopError(json.dumps(data["errors"])[:500])
                    return data
            except (error.HTTPError, error.URLError, TimeoutError) as e:
                last_err = e
                code = getattr(e, "code", 0)
                if code in (401, 403, 404):
                    raise PrestaShopError(f"{code} for {url}") from e
                time.sleep(2 * (attempt + 1))
        raise PrestaShopError(f"giving up on {url}: {last_err}")

    def _list(self, resource: str, key: str, display: str = "full", extra: dict[str, str] | None = None,
              batch: int = 0) -> list[dict]:
        """Fetch a whole resource. batch>0 pages with limit=offset,count (sorted by id)."""
        params = {"display": display}
        params.update(extra or {})
        if not batch:
            data = self._get(resource, params)
            return data.get(key, []) if isinstance(data, dict) else []
        out: list[dict] = []
        offset = 0
        while True:
            p = dict(params)
            p["limit"] = f"{offset},{batch}"
            p["sort"] = "[id_ASC]"
            data = self._get(resource, p)
            rows = data.get(key, []) if isinstance(data, dict) else []
            out.extend(rows)
            if self.verbose:
                print(f"  {resource}: {len(out)} so far")
            if len(rows) < batch:
                break
            offset += batch
        return out

    # ---- resources -------------------------------------------------------
    def languages(self) -> list[dict]:
        return self._list("languages", "languages", "[id,iso_code,name]")

    def categories(self, language: int | None = None) -> list[dict]:
        extra = {"language": str(language)} if language else None
        return self._list("categories", "categories",
                          "[id,id_parent,name,level_depth,active,link_rewrite,description,nb_products_recursive]",
                          extra)

    def manufacturers(self) -> list[dict]:
        return self._list("manufacturers", "manufacturers", "[id,name,active]")

    def product_features(self) -> dict[str, str]:
        rows = self._list("product_features", "product_features", "[id,name]")
        return {str(r["id"]): r["name"] for r in rows}

    def product_feature_values(self) -> dict[str, dict]:
        rows = self._list("product_feature_values", "product_feature_values", "[id,id_feature,value]")
        return {str(r["id"]): r for r in rows}

    def product_index(self) -> list[dict]:
        """Light listing of every product: ids, active flag, date_upd."""
        return self._list("products", "products", "[id,active,date_upd,manufacturer_name,id_category_default]")

    def products_full(self, ids: list[int] | None = None, updated_since: str | None = None,
                      batch: int = 300) -> list[dict]:
        extra: dict[str, str] = {}
        if ids is not None:
            if not ids:
                return []
            out: list[dict] = []
            for i in range(0, len(ids), 100):
                chunk = ids[i:i + 100]
                extra = {"filter[id]": "[" + "|".join(map(str, chunk)) + "]"}
                out.extend(self._list("products", "products", "full", extra))
            return out
        if updated_since:
            extra = {"filter[date_upd]": f"[{updated_since},2100-01-01 00:00:00]", "date": "1"}
        return self._list("products", "products", "full", extra, batch=batch)

    def product(self, pid: int) -> dict:
        data = self._get(f"products/{pid}")
        return data.get("product", {})

    def combinations(self) -> list[dict]:
        return self._list("combinations", "combinations", "full")

    def stock(self) -> list[dict]:
        return self._list("stock_availables", "stock_availables",
                          "[id,id_product,id_product_attribute,quantity,out_of_stock]")

    # ---- images ----------------------------------------------------------
    def image_url(self, image_id: str | int, link_rewrite: str) -> str:
        """Public, unauthenticated URL Shopify can fetch."""
        slug = link_rewrite or "image"
        return f"{self.site}/{image_id}-{self.image_size}/{slug}.jpg"

    def image_bytes(self, product_id: int, image_id: int) -> bytes:
        return self._get(f"images/products/{product_id}/{image_id}", raw=True)

    # ---- option labels (scraped) ---------------------------------------
    _ITEM_RE = re.compile(r'<div class="clearfix product-variants-item">(.*?)</div>\s*</div>', re.S)
    _LABEL_RE = re.compile(r'<span class="control-label">\s*([^<]*?)\s*</span>')
    _GROUP_RE = re.compile(r'name="group\[(\d+)\]"')
    _OPTION_RE = re.compile(r'<option[^>]*value="(\d+)"[^>]*title="([^"]*)"')
    _RADIO_RE = re.compile(r'<input[^>]*name="group\[\d+\]"[^>]*value="(\d+)"[^>]*>\s*<span[^>]*>.*?<span class="sr-only">([^<]*)</span>', re.S)

    def scrape_option_labels(self, product_id: int) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
        """Returns (group_id -> group label, value_id -> (group_id, value label))."""
        url = f"{self.site}/index.php?id_product={product_id}&controller=product&id_lang=1"
        req = request.Request(url, headers={"User-Agent": "Mozilla/5.0 " + UA})
        try:
            with request.urlopen(req, timeout=60) as resp:
                page = resp.read().decode("utf-8", "replace")
        except (error.HTTPError, error.URLError, TimeoutError):
            return {}, {}
        groups: dict[str, str] = {}
        values: dict[str, tuple[str, str]] = {}
        # Split on the variants container; be tolerant of markup differences.
        blocks = re.split(r'<div class="clearfix product-variants-item">', page)[1:]
        for block in blocks:
            g = self._GROUP_RE.search(block)
            if not g:
                continue
            gid = g.group(1)
            lab = self._LABEL_RE.search(block)
            label = html.unescape(lab.group(1)).strip() if lab else f"Option {gid}"
            groups[gid] = label
            for vid, vlabel in self._OPTION_RE.findall(block):
                values[vid] = (gid, html.unescape(vlabel).strip())
            for vid, vlabel in self._RADIO_RE.findall(block):
                values[vid] = (gid, html.unescape(vlabel).strip())
        return groups, values
