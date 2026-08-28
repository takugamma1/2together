"""Reference data shared by catalog/collections/inventory: categories, combos, stock, option labels."""
from __future__ import annotations

from collections import defaultdict

from .prestashop import PrestaShop
from .state import State
from .util import dump_json, log, warn


def load_stock(ps: PrestaShop) -> dict[tuple[str, str], int]:
    rows = ps.stock()
    stock: dict[tuple[str, str], int] = {}
    for r in rows:
        stock[(str(r["id_product"]), str(r["id_product_attribute"]))] = max(0, int(r.get("quantity") or 0))
    dump_json("stock.json", rows)
    return stock


def load_combos(ps: PrestaShop) -> dict[str, list[dict]]:
    rows = ps.combinations()
    by_product: dict[str, list[dict]] = defaultdict(list)
    for c in rows:
        by_product[str(c["id_product"])].append(c)
    for lst in by_product.values():
        lst.sort(key=lambda c: (c.get("default_on") != "1", int(c["id"])))
    dump_json("combinations.json", rows)
    return by_product


def ensure_option_labels(ps: PrestaShop, state: State, combos: dict[str, list[dict]],
                         active_ids: set[str], max_pages: int = 400) -> dict:
    """Scrape public product pages until every option value id used by an active product has a label."""
    labels = state.data["option_labels"]
    known = set(labels["values"])
    needed: dict[str, set[str]] = defaultdict(set)  # value id -> product ids that use it
    for pid, lst in combos.items():
        if pid not in active_ids:
            continue
        for c in lst:
            for ov in c["associations"].get("product_option_values") or []:
                if str(ov["id"]) not in known:
                    needed[str(ov["id"])].add(pid)
    if not needed:
        return labels
    log(f"option labels: {len(needed)} value ids unknown, scraping product pages…")
    pages = 0
    while needed and pages < max_pages:
        # pick the product covering the most unknown values
        counts: dict[str, int] = defaultdict(int)
        for vid, pids in needed.items():
            for pid in pids:
                counts[pid] += 1
        pid = max(counts, key=counts.get)
        groups, values = ps.scrape_option_labels(int(pid))
        pages += 1
        labels["groups"].update(groups)
        for vid, (gid, label) in values.items():
            labels["values"][vid] = [gid, label]
        got = [vid for vid in list(needed) if vid in values]
        for vid in got:
            needed.pop(vid, None)
        if not got:
            # page gave nothing for this product (inactive / hidden) — drop its values from the queue
            for vid in list(needed):
                needed[vid].discard(pid)
                if not needed[vid]:
                    needed.pop(vid)
    if needed:
        warn(f"{len(needed)} option value ids still unlabeled (will show as 'Value <id>'): {sorted(needed)[:20]}")
    state.save()
    log(f"option labels: {len(labels['groups'])} groups, {len(labels['values'])} values known")
    return labels
