"""
Create the 5 metaobject DEFINITIONS for the 2gether Sunday Club feature
(rides, destination polls, RSVPs and votes) via the Shopify Admin GraphQL API.

Idempotent: each definition is looked up first with metaobjectDefinitionByType
and skipped if it already exists (the same definitions may already have been
created via another channel — re-running is always safe and exits 0).

Definitions created, in dependency order:
    1. sunday_ride        public rides shown on the storefront
    2. poll_option        a single answer in a destination poll
    3. destination_poll   references poll_option entries
    4. ride_rsvp          PRIVATE (PII) — references sunday_ride
    5. poll_vote          PRIVATE — references destination_poll + poll_option

Run:
    export SHOPIFY_STORE="2togetherb.myshopify.com"
    export SHOPIFY_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxxxxx"

    python3 create_club_metaobjects.py --dry-run    # show planned definitions only
    python3 create_club_metaobjects.py              # create missing definitions

Required Admin API scope: write_metaobject_definitions
(the access token / custom app must have this scope enabled, otherwise the
API returns an ACCESS_DENIED error).

No-code alternative for the store owner
---------------------------------------
Everything this script does can also be done by hand in the Shopify admin:
open Settings -> Custom data -> Metaobjects -> "Add definition". For each of
the five definitions above, type in the name, add the fields listed in this
script one by one (picking the matching field type: single line text, date,
URL, file, integer, and so on), and under "Options" turn ON "Active on
storefronts" only for Sunday Ride, Poll Option and Destination Poll — leave
it OFF for Ride RSVP and Poll Vote, because those hold customer names and
emails and must never be readable from the public site. The script just
automates that clicking and guarantees the field names match exactly what
the theme code expects.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib import error, request

API_VERSION = "2025-10"

# Sentinel key: a validation whose value must be resolved at runtime to the
# GID of another metaobject definition (looked up / created earlier in order).
REF = "__definition_ref__"


def shop_base() -> str:
    store = os.environ.get("SHOPIFY_STORE", "").strip()
    if not store:
        sys.exit("SHOPIFY_STORE env var not set")
    store = store.replace("https://", "").replace("http://", "").rstrip("/")
    if not store.endswith(".myshopify.com"):
        store = f"{store}.myshopify.com"
    return f"https://{store}/admin/api/{API_VERSION}"


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict, dict]:
    url = path if path.startswith("http") else shop_base() + path
    data = json.dumps(body).encode() if body else None
    req = request.Request(url, data=data, method=method, headers={
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    for attempt in range(5):
        try:
            with request.urlopen(req) as resp:
                payload = json.loads(resp.read() or b"{}")
                return resp.status, payload, dict(resp.headers)
        except error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After", 2)))
                continue
            if 500 <= e.code < 600 and attempt < 2:
                time.sleep(1 + attempt)
                continue
            return e.code, {"_error": text}, dict(e.headers or {})
        except error.URLError as e:
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            return 0, {"_error": str(e)}, {}
    return 0, {"_error": "retry budget exhausted"}, {}


def graphql(query: str, variables: dict, token: str) -> dict:
    """POST a GraphQL query; retries THROTTLED responses, exits on hard errors."""
    for attempt in range(5):
        status, data, _ = api("POST", "/graphql.json", token,
                              {"query": query, "variables": variables})
        if status != 200:
            sys.exit(f"GraphQL HTTP {status}: {data.get('_error')}")
        errors = data.get("errors") or []
        if errors and all((e.get("extensions") or {}).get("code") == "THROTTLED"
                          for e in errors):
            time.sleep(1 + attempt)
            continue
        if errors:
            sys.exit(f"GraphQL errors: {json.dumps(errors, ensure_ascii=False)}")
        return data.get("data") or {}
    sys.exit("GraphQL throttle retry budget exhausted")


QUERY_DEF_BY_TYPE = """
query DefByType($type: String!) {
  metaobjectDefinitionByType(type: $type) { id type name }
}
"""

MUTATION_CREATE = """
mutation CreateDef($definition: MetaobjectDefinitionCreateInput!) {
  metaobjectDefinitionCreate(definition: $definition) {
    metaobjectDefinition { id type name }
    userErrors { field message code }
  }
}
"""


def f(key: str, ftype: str, name: str, required: bool = False,
      validations: list[dict] | None = None) -> dict:
    fd: dict = {"key": key, "type": ftype, "name": name, "required": required}
    if validations:
        fd["validations"] = validations
    return fd


def choices(values: list[str]) -> list[dict]:
    return [{"name": "choices", "value": json.dumps(values)}]


def def_ref(target_type: str) -> list[dict]:
    # Resolved to the target definition's GID just before the create call.
    return [{"name": "metaobject_definition_id", "value": {REF: target_type}}]


# Definitions in dependency order: destination_poll needs poll_option's GID,
# ride_rsvp needs sunday_ride's, poll_vote needs destination_poll + poll_option.
DEFINITIONS: list[dict] = [
    {
        "type": "sunday_ride",
        "name": "Sunday Ride",
        "displayNameKey": "title",
        "access": {"storefront": "PUBLIC_READ"},
        "capabilities": {"publishable": {"enabled": True}},
        "fieldDefinitions": [
            f("title", "single_line_text_field", "Title", required=True),
            f("date", "date", "Date", required=True),
            f("start_time", "single_line_text_field", "Start time"),
            f("location", "single_line_text_field", "Location"),
            f("location_url", "url", "Location URL"),
            f("photo", "file_reference", "Photo",
              validations=[{"name": "file_type_options", "value": json.dumps(["Image"])}]),
            f("description", "multi_line_text_field", "Description"),
            f("difficulty", "single_line_text_field", "Difficulty",
              validations=choices(["easy", "medium", "hard"])),
            f("distance", "single_line_text_field", "Distance"),
            f("route_link", "url", "Route link"),
            f("capacity", "number_integer", "Capacity"),
            f("going_count", "number_integer", "Going count"),
        ],
    },
    {
        "type": "poll_option",
        "name": "Poll Option",
        "displayNameKey": "label",
        "access": {"storefront": "PUBLIC_READ"},
        "capabilities": {"publishable": {"enabled": True}},
        "fieldDefinitions": [
            f("label", "single_line_text_field", "Label", required=True),
            f("vote_count", "number_integer", "Vote count"),
        ],
    },
    {
        "type": "destination_poll",
        "name": "Destination Poll",
        "displayNameKey": "question",
        "access": {"storefront": "PUBLIC_READ"},
        "capabilities": {"publishable": {"enabled": True}},
        "fieldDefinitions": [
            f("question", "single_line_text_field", "Question", required=True),
            f("status", "single_line_text_field", "Status",
              validations=choices(["active", "closed"])),
            f("options", "list.metaobject_reference", "Options",
              validations=def_ref("poll_option")),
        ],
    },
    {
        # Contains customer PII -> never storefront-readable, not publishable.
        "type": "ride_rsvp",
        "name": "Ride RSVP",
        "displayNameKey": "customer_name",
        "access": {"storefront": "NONE"},
        "capabilities": {"publishable": {"enabled": False}},
        "fieldDefinitions": [
            f("ride", "metaobject_reference", "Ride",
              validations=def_ref("sunday_ride")),
            f("customer_id", "single_line_text_field", "Customer ID", required=True),
            f("customer_name", "single_line_text_field", "Customer name"),
            f("customer_email", "single_line_text_field", "Customer email"),
            f("status", "single_line_text_field", "Status",
              validations=choices(["going", "not_going"])),
            f("rsvp_at", "date_time", "RSVP at"),
        ],
    },
    {
        "type": "poll_vote",
        "name": "Poll Vote",
        "displayNameKey": "customer_id",
        "access": {"storefront": "NONE"},
        "capabilities": {"publishable": {"enabled": False}},
        "fieldDefinitions": [
            f("poll", "metaobject_reference", "Poll",
              validations=def_ref("destination_poll")),
            f("option", "metaobject_reference", "Option",
              validations=def_ref("poll_option")),
            f("customer_id", "single_line_text_field", "Customer ID", required=True),
            f("voted_at", "date_time", "Voted at"),
        ],
    },
]


def resolve_refs(definition: dict, gids: dict[str, str]) -> dict:
    """Return a deep copy with {REF: type} validation values replaced by GIDs."""
    resolved = json.loads(json.dumps(definition))
    for fd in resolved["fieldDefinitions"]:
        for v in fd.get("validations", []):
            if isinstance(v["value"], dict) and REF in v["value"]:
                target = v["value"][REF]
                gid = gids.get(target)
                if not gid:
                    sys.exit(f"Internal error: definition '{target}' GID not "
                             f"resolved before '{resolved['type']}' (order bug)")
                v["value"] = gid
    return resolved


def describe(definition: dict) -> None:
    storefront = definition["access"]["storefront"]
    publishable = definition["capabilities"]["publishable"]["enabled"]
    print(f"  type={definition['type']!r} name={definition['name']!r} "
          f"displayNameKey={definition['displayNameKey']!r} "
          f"storefront={storefront} publishable={publishable}")
    for fd in definition["fieldDefinitions"]:
        extras = []
        if fd.get("required"):
            extras.append("required")
        for v in fd.get("validations", []):
            value = v["value"]
            if isinstance(value, dict) and REF in value:
                value = f"<GID of {value[REF]} definition>"
            extras.append(f"{v['name']}={value}")
        suffix = f"  [{', '.join(extras)}]" if extras else ""
        print(f"    - {fd['key']}: {fd['type']}{suffix}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Print planned definitions without calling the API")
    args = ap.parse_args()

    token = os.environ.get("SHOPIFY_ACCESS_TOKEN", "").strip()
    if not token and not args.dry_run:
        sys.exit("SHOPIFY_ACCESS_TOKEN env var not set")

    if args.dry_run:
        print(f"DRY RUN — {len(DEFINITIONS)} metaobject definitions planned "
              f"(existing ones would be skipped):")
        for d in DEFINITIONS:
            print()
            describe(d)
        return 0

    gids: dict[str, str] = {}
    created = existing = failed = 0

    for d in DEFINITIONS:
        dtype = d["type"]

        data = graphql(QUERY_DEF_BY_TYPE, {"type": dtype}, token)
        found = data.get("metaobjectDefinitionByType")
        if found:
            gids[dtype] = found["id"]
            print(f"EXISTS   {dtype}  ({found['id']}) — already exists, skipping")
            existing += 1
            continue

        definition = resolve_refs(d, gids)
        data = graphql(MUTATION_CREATE, {"definition": definition}, token)
        result = data.get("metaobjectDefinitionCreate") or {}
        errors = result.get("userErrors") or []

        if any(e.get("code") == "TAKEN" for e in errors):
            # Created concurrently via another channel between query and create.
            data = graphql(QUERY_DEF_BY_TYPE, {"type": dtype}, token)
            found = data.get("metaobjectDefinitionByType")
            if found:
                gids[dtype] = found["id"]
                print(f"EXISTS   {dtype}  ({found['id']}) — already exists, skipping")
                existing += 1
                continue

        if errors:
            details = "; ".join(
                f"{'.'.join(e.get('field') or [])}: {e.get('message')} "
                f"({e.get('code')})" for e in errors)
            print(f"FAILED   {dtype} :: {details}")
            failed += 1
            continue

        node = result.get("metaobjectDefinition")
        if not node:
            print(f"FAILED   {dtype} :: empty response from metaobjectDefinitionCreate")
            failed += 1
            continue

        gids[dtype] = node["id"]
        print(f"CREATED  {dtype}  ({node['id']})")
        created += 1

        time.sleep(0.6)

    print(f"\nSummary: created={created} existing={existing} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
