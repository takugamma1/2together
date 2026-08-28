from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

from .config import DATA_DIR


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] WARNING: {msg}", file=sys.stderr, flush=True)


def dump_json(name: str, data) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / name
    path.write_text(json.dumps(data, ensure_ascii=False, indent=0))
    return path


def load_json(name: str):
    path = DATA_DIR / name
    return json.loads(path.read_text()) if path.exists() else None


def now_ps() -> str:
    """PrestaShop-style timestamp (server is Europe/Sofia-ish; we keep a safety margin anyway)."""
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
