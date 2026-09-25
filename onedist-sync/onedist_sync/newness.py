"""Keep the `new` tag on products created in the last NEW_ARRIVAL_DAYS days (default 30).

The storefront uses the tag for the "НОВО" badge and for the automated
"Нови постъпления" collection (rule: tag = new, inventory > 0, newest first).
Idempotent — safe to run after every catalog sync.
"""
from __future__ import annotations
import datetime, os
from .util import log, warn

TAG = "new"
_Q_IDS = """query($q: String!, $after: String) {
  products(first: 250, query: $q, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } } }"""
_M_TAGS_ADD = "mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }"
_M_TAGS_REMOVE = "mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { message } } }"


def _ids(shop, query: str) -> set[str]:
    out, after = set(), None
    while True:
        d = shop.gql(_Q_IDS, {"q": query, "after": after})["products"]
        out.update(n["id"] for n in d["nodes"])
        if not d["pageInfo"]["hasNextPage"]:
            return out
        after = d["pageInfo"]["endCursor"]


def run_newness(settings, shop, state, dry_run: bool = False) -> dict:
    days = int(os.environ.get("NEW_ARRIVAL_DAYS", "30") or 30)
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%d")
    wanted = _ids(shop, f"created_at:>{since} status:active")
    current = _ids(shop, f"tag:{TAG}")
    add, remove = wanted - current, current - wanted
    log(f"newness: {len(wanted)} products created in the last {days} days, {len(current)} tagged; +{len(add)} / -{len(remove)}")
    errors = 0
    if dry_run:
        return {"add": len(add), "remove": len(remove), "errors": 0}
    for gid in add:
        try:
            shop.mutate(_M_TAGS_ADD, {"id": gid, "t": [TAG]}, "tagsAdd")
        except Exception as e:
            warn(f"newness: tagsAdd failed for {gid}: {e}"); errors += 1
    for gid in remove:
        try:
            shop.mutate(_M_TAGS_REMOVE, {"id": gid, "t": [TAG]}, "tagsRemove")
        except Exception as e:
            warn(f"newness: tagsRemove failed for {gid}: {e}"); errors += 1
    log(f"newness done: tagged={len(add)} untagged={len(remove)} errors={errors}")
    return {"add": len(add), "remove": len(remove), "errors": errors}
