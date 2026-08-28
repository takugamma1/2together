"""Local JSON state: PrestaShop id -> Shopify ids, content hashes, last-known stock.

This file is the source of truth for "what have we already pushed". Losing it is
not fatal — `catalog` re-links products by handle — but keep it (commit it or
store it where the scheduled job runs).
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .config import STATE_FILE

EMPTY: dict[str, Any] = {
    "version": 1,
    "shop": "",
    "location_id": "",
    "publication_ids": [],
    "last_catalog_sync": "",     # PrestaShop date_upd watermark (UTC-naive string)
    "last_inventory_sync": "",
    "option_labels": {"groups": {}, "values": {}},
    "products": {},               # ps_id -> {product_id, handle, hash, images_sig, status, variants:{key:{...}}}
    "collections": {},            # key -> {collection_id, handle, hash}
}


class State:
    def __init__(self, path: Path = STATE_FILE) -> None:
        self.path = path
        self.data: dict[str, Any] = json.loads(json.dumps(EMPTY))
        if path.exists():
            loaded = json.loads(path.read_text() or "{}")
            for k, v in EMPTY.items():
                loaded.setdefault(k, json.loads(json.dumps(v)))
            self.data = loaded

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".state-", suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(self.data, fh, indent=1, sort_keys=True)
        os.replace(tmp, self.path)

    # convenience
    @property
    def products(self) -> dict[str, dict]:
        return self.data["products"]

    @property
    def collections(self) -> dict[str, dict]:
        return self.data["collections"]

    def product(self, ps_id: int | str) -> dict | None:
        return self.products.get(str(ps_id))
