"""Image transfer: PrestaShop (authenticated API) -> Shopify staged upload -> productSet files.

Shopify's own fetcher is blocked (403) by onedistribution.com's Cloudflare, so we move the bytes ourselves.
"""
from __future__ import annotations

import json
import uuid
from urllib import error, request

from .prestashop import PrestaShop, PrestaShopError
from .shopify_api import Shopify, ShopifyError
from .util import warn

STAGED_UPLOADS = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message } } }"""


def _multipart(fields: list[tuple[str, str]], filename: str, data: bytes, mime: str) -> tuple[bytes, str]:
    boundary = "----onedist" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields:
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
    out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode()
    out += data + f"\r\n--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def stage_images(ps: PrestaShop, shop: Shopify, product_id: int, files: list[dict]) -> list[dict]:
    """Return FileSetInput list whose originalSource points at Shopify staged uploads.
    `files` items carry `ps_image_id` (set by transform). Images that fail to transfer are dropped (warned)."""
    if shop.dry_run or not files:
        return files
    blobs: list[tuple[dict, bytes]] = []
    for f in files:
        try:
            data = ps.image_bytes(product_id, int(f["ps_image_id"]))
        except PrestaShopError as e:
            warn(f"image {f['ps_image_id']} of product {product_id}: download failed: {e}")
            continue
        if not data or len(data) < 100:
            warn(f"image {f['ps_image_id']} of product {product_id}: empty download")
            continue
        blobs.append((f, data))
    if not blobs:
        return []
    inputs = [{"resource": "IMAGE", "filename": f"od-{product_id}-{f['ps_image_id']}.jpg", "mimeType": "image/jpeg",
               "httpMethod": "POST", "fileSize": str(len(data))} for f, data in blobs]
    node = shop.mutate(STAGED_UPLOADS, {"input": inputs}, "stagedUploadsCreate")
    targets = node.get("stagedTargets") or []
    if len(targets) != len(blobs):
        raise ShopifyError(f"stagedUploadsCreate returned {len(targets)} targets for {len(blobs)} files")
    out: list[dict] = []
    for (f, data), t in zip(blobs, targets):
        body, ctype = _multipart([(p["name"], p["value"]) for p in t["parameters"]], inputs[0]["filename"], data, "image/jpeg")
        req = request.Request(t["url"], data=body, method="POST", headers={"Content-Type": ctype})
        ok = False
        for attempt in range(3):
            try:
                with request.urlopen(req, timeout=120) as resp:
                    ok = 200 <= resp.status < 300
                    break
            except error.HTTPError as e:
                warn(f"staged upload {f['ps_image_id']}: HTTP {e.code} {e.read()[:200]!r}")
            except (error.URLError, TimeoutError) as e:
                warn(f"staged upload {f['ps_image_id']}: {e}")
        if ok:
            out.append({"originalSource": t["resourceUrl"], "alt": f.get("alt", ""), "contentType": "IMAGE"})
    return out


FAILED_MEDIA_QUERY = """
query($cursor: String) {
  products(first: 100, after: $cursor, query: "tag:od-*") {
    pageInfo { hasNextPage endCursor }
    nodes { id handle mediaCount { count } media(first: 30) { nodes { id status } } } } }"""


def find_broken_media(shop: Shopify) -> dict[str, list[str]]:
    """product gid -> ids of FAILED media (products with no media at all are legitimate: 37 upstream products have none)."""
    broken: dict[str, list[str]] = {}
    cursor = None
    while True:
        data = shop.gql(FAILED_MEDIA_QUERY, {"cursor": cursor}, "products")["products"]
        for p in data["nodes"]:
            failed = [m["id"] for m in p["media"]["nodes"] if m["status"] == "FAILED"]
            if failed:
                broken[p["id"]] = failed
        if not data["pageInfo"]["hasNextPage"]:
            break
        cursor = data["pageInfo"]["endCursor"]
    return broken
