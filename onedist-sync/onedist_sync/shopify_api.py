"""Minimal Shopify Admin GraphQL client with cost-aware throttling and retries."""
from __future__ import annotations

import json
import time
from typing import Any
from urllib import error, request

from .config import Settings


class ShopifyError(RuntimeError):
    pass


class UserErrors(ShopifyError):
    def __init__(self, op: str, errors: list[dict]) -> None:
        super().__init__(f"{op}: " + "; ".join(f"{'/'.join(map(str, e.get('field') or []))}: {e.get('message')}" for e in errors))
        self.errors = errors


class Shopify:
    def __init__(self, settings: Settings, dry_run: bool = False, verbose: bool = False) -> None:
        if not dry_run:
            settings.require_shopify()
        self.domain = settings.shop_domain()
        self.url = f"https://{self.domain}/admin/api/{settings.api_version}/graphql.json"
        self.settings = settings
        self.token = settings.token
        self._token_expiry = 0.0
        if not self.token and settings.client_id and settings.client_secret:
            try:
                self._refresh_token()
            except ShopifyError:
                if not dry_run:
                    raise
        self.dry_run = dry_run
        self.verbose = verbose
        self.calls = 0

    def _refresh_token(self) -> None:
        """Client-credentials grant: exchanges app id/secret for a 24h Admin token."""
        body = json.dumps({"grant_type": "client_credentials", "client_id": self.settings.client_id,
                           "client_secret": self.settings.client_secret}).encode()
        req = request.Request(f"https://{self.domain}/admin/oauth/access_token", data=body, method="POST",
                              headers={"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
        except error.HTTPError as e:
            raise ShopifyError(f"token exchange failed: HTTP {e.code} {e.read().decode(errors='replace')[:300]}") from e
        self.token = data["access_token"]
        self._token_expiry = time.time() + int(data.get("expires_in", 86400)) - 300

    def gql(self, query: str, variables: dict | None = None, op: str = "") -> dict:
        if self._token_expiry and time.time() > self._token_expiry:
            self._refresh_token()
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        for attempt in range(8):
            req = request.Request(self.url, data=body, method="POST", headers={
                "X-Shopify-Access-Token": self.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            })
            try:
                with request.urlopen(req, timeout=120) as resp:
                    payload = json.loads(resp.read() or b"{}")
            except error.HTTPError as e:
                text = e.read().decode(errors="replace")
                if e.code in (429, 502, 503, 504) and attempt < 7:
                    time.sleep(float(e.headers.get("Retry-After", 2)) + attempt)
                    continue
                raise ShopifyError(f"HTTP {e.code} {op}: {text[:400]}") from e
            except (error.URLError, TimeoutError) as e:
                if attempt < 7:
                    time.sleep(2 + attempt)
                    continue
                raise ShopifyError(f"network error {op}: {e}") from e
            self.calls += 1
            errs = payload.get("errors")
            if errs:
                if any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errs):
                    self._wait_for_bucket(payload)
                    continue
                raise ShopifyError(f"GraphQL {op}: {json.dumps(errs)[:600]}")
            self._pace(payload)
            return payload.get("data") or {}
        raise ShopifyError(f"{op}: retry budget exhausted")

    def _pace(self, payload: dict) -> None:
        ts = ((payload.get("extensions") or {}).get("cost") or {}).get("throttleStatus") or {}
        avail = ts.get("currentlyAvailable")
        restore = ts.get("restoreRate") or 50
        if avail is not None and avail < 200:
            time.sleep(min(5.0, (200 - avail) / restore))

    def _wait_for_bucket(self, payload: dict) -> None:
        ts = ((payload.get("extensions") or {}).get("cost") or {}).get("throttleStatus") or {}
        need = ((payload.get("extensions") or {}).get("cost") or {}).get("requestedQueryCost") or 100
        avail = ts.get("currentlyAvailable") or 0
        restore = ts.get("restoreRate") or 50
        time.sleep(max(1.0, (need - avail) / restore + 0.5))

    def mutate(self, query: str, variables: dict, op: str) -> dict:
        """Run a mutation and raise on userErrors. Honors dry_run."""
        if self.dry_run:
            if self.verbose:
                print(f"  [dry-run] {op} {json.dumps(variables)[:300]}")
            return {}
        data = self.gql(query, variables, op)
        node = data.get(op) or {}
        ue = node.get("userErrors") or []
        if ue:
            raise UserErrors(op, ue)
        return node

    # ---- helpers -----------------------------------------------------------
    def shop_info(self) -> dict:
        return self.gql("{ shop { name myshopifyDomain currencyCode plan { displayName } } }", op="shop")["shop"]

    def scopes(self) -> list[str]:
        data = self.gql("{ currentAppInstallation { accessScopes { handle } } }", op="scopes")
        return [s["handle"] for s in data["currentAppInstallation"]["accessScopes"]]

    def locations(self) -> list[dict]:
        data = self.gql("{ locations(first: 20, includeInactive: false) { nodes { id name isActive fulfillsOnlineOrders } } }", op="locations")
        return data["locations"]["nodes"]

    def publications(self) -> list[dict]:
        data = self.gql("{ publications(first: 20) { nodes { id name catalog { title } } } }", op="publications")
        return data["publications"]["nodes"]

    def product_by_handle(self, handle: str) -> dict | None:
        q = """query($h: String!) { productByIdentifier(identifier: {handle: $h}) {
                 id handle status
                 media(first: 50) { nodes { id alt ... on MediaImage { image { url } } } }
                 variants(first: 100) { nodes { id sku inventoryItem { id } selectedOptions { name value } } } } }"""
        return self.gql(q, {"h": handle}, "productByIdentifier")["productByIdentifier"]

    def collection_by_handle(self, handle: str) -> dict | None:
        q = "query($h: String!) { collectionByIdentifier(identifier: {handle: $h}) { id handle title } }"
        return self.gql(q, {"h": handle}, "collectionByIdentifier")["collectionByIdentifier"]

    def publish(self, resource_id: str, publication_ids: list[str]) -> None:
        if not publication_ids:
            return
        m = """mutation($id: ID!, $input: [PublicationInput!]!) {
                 publishablePublish(id: $id, input: $input) { userErrors { field message } } }"""
        self.mutate(m, {"id": resource_id, "input": [{"publicationId": p} for p in publication_ids]}, "publishablePublish")
