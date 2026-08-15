"""
How often each unique and set item actually drops, per boss, from the game tables.

Three layers stack up, and only the first is shared with the rune calculation:

  1. which BASE item drops     — the treasure-class tree, same walk as runes
  2. whether it rolls unique   — itemratio.txt, a level-difference formula
  3. WHICH unique of that base — rarity weights among the ones your level allows

Layer 3 is the one people underestimate. Eleven unique rings compete for every
ring that drops, so the Stone of Jordan gets 2% of a very common base; the
Harlequin Crest owns its base outright but that base almost never drops.

One honest caveat is baked into this file. Treasure classes refer to groups
like "weap18" — "any weapon of level 18 or below" — which the game builds at
load time and which exist in no data file. They are rebuilt here from the item
tables (spawnable, level <= N, weighted by rarity). The reconstruction is
checked for structure, but its relative weights have no external ground truth,
unlike everything else here.

Magic find is deliberately NOT applied. It belongs to your character, not to
the game tables, so the page applies it at display time; what is stored is the
raw chance parameters it needs.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_drops import TARGETS, load_tc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "itemdrops.json")

# How many places to keep per item. Nobody farms their fourth-best option.
KEEP = 3

# Rows reference targets by position, which is a lot smaller than repeating
# the name 1500 times.
TARGET_INDEX = {}

# Monster level in Hell for each target, so the item level of what it drops is
# known. Superuniques and bosses carry their own level; these come from
# monstats / superuniques and are the level the drop is rolled at.
MLVL = {
    "countess": 79, "smith": 81, "andariel": 75, "radament": 81, "summoner": 82,
    "duriel": 88, "council": 88, "mephisto": 87, "izual": 86, "hephasto": 88,
    "diablo": 94, "shenk": 87, "pindle": 86, "nihlathak": 87,
    "cowking": 81, "cow": 81, "baal": 99,
}


def rows(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as fh:
        data = json.load(fh)
    return list(data.values() if isinstance(data, dict) else data)


def load_bases():
    """Every base item by code, plus the auto-generated weapNN / armoNN groups."""
    base, groups = {}, {"weap": [], "armo": []}
    for fn, grp in (("weapons.json", "weap"), ("armor.json", "armo"),
                    ("misc.json", None)):
        for r in rows(fn):
            code = (r.get("code") or "").strip()
            if not code:
                continue
            base[code] = r
            if grp and r.get("spawnable") and (r.get("rarity") or 0) > 0:
                groups[grp].append((code, r.get("level") or 0, r["rarity"]))
    return base, groups


def make_walker(tc, groups):
    """Expected count of each base-item code from one roll of a treasure class."""
    cache = {}

    def group_dist(name):
        prefix, num = name[:4], name[4:]
        if prefix not in groups or not num.isdigit():
            return None
        limit = int(num)
        picked = [(c, w) for c, lvl, w in groups[prefix] if lvl <= limit]
        total = sum(w for _, w in picked)
        if not total:
            return {}
        return {c: w / total for c, w in picked}

    def walk(name, seen=()):
        auto = group_dist(name)
        if auto is not None:
            return auto
        row = tc.get(name)
        if row is None:
            return {name: 1.0}
        if name in seen:
            return {}
        if name in cache:
            return cache[name]
        seen = seen + (name,)
        items = [(row.get(f"Item{i}"), row.get(f"Prob{i}"))
                 for i in range(1, 11) if row.get(f"Item{i}")]
        picks = row.get("Picks", 1)
        out = {}
        if picks < 0:
            for it, p in items:
                for k, v in walk(it, seen).items():
                    out[k] = out.get(k, 0) + p * v
        else:
            total = row.get("*ItemProbTotal", sum(p for _, p in items)) + (row.get("NoDrop") or 0)
            if total:
                for it, p in items:
                    for k, v in walk(it, seen).items():
                        out[k] = out.get(k, 0) + picks * (p / total) * v
        if not seen[:-1]:
            cache[name] = out
        return out

    return walk


def ratio_row(ratios, base_item, code):
    """
    Which itemratio line governs this base.

    Uber means the exceptional/elite tier — an item whose own code is what the
    tier chain points at. Class-specific bases (amazon bows, sorceress orbs)
    get their own, kinder line.
    """
    uber = 1 if code in (base_item.get("ubercode"), base_item.get("ultracode")) else 0
    cls = 1 if (base_item.get("type") or "") in CLASS_TYPES else 0
    for r in ratios:
        if r["Version"] == 1 and r["Uber"] == uber and r["Class Specific"] == cls:
            return r
    return ratios[0]


# Item types only one class can use; the game gives them their own drop ratio.
CLASS_TYPES = {"abow", "aspe", "ajav", "h2h", "h2h2", "orb", "head", "ashd",
               "phlm", "pelt", "abow", "scep"}


def chance_params(ratio, ilvl, qlvl, kind):
    """
    The quality roll, minus magic find.

    The game computes `(ratio - levelDifference/divisor) * 128`, lowers it by
    magic find, floors it at the table's minimum, then succeeds on a 1-in-128.
    Everything except the magic-find step is fixed here.
    """
    key, div, mn = {
        "u": ("Unique", "UniqueDivisor", "UniqueMin"),
        "s": ("Set", "SetDivisor", "SetMin"),
    }[kind]
    value = ratio[key] - (max(0, ilvl - qlvl) // ratio[div])
    return max(1, value) * 128, ratio[mn]


def main():
    TARGET_INDEX.update({t[0]: i for i, t in enumerate(TARGETS)})
    tc = load_tc()
    base, groups = load_bases()
    walk = make_walker(tc, groups)
    ratios = rows("itemratio.json")

    uniques = [r for r in rows("uniqueitems.json")
               if r.get("spawnable") and (r.get("code") or "").strip()]
    sets = [r for r in rows("setitems.json") if (r.get("item") or "").strip()]

    # Everything on the same base competes for the same slot.
    def pool(entries, code_key, mlvl):
        out = {}
        for e in entries:
            code = (e[code_key] or "").strip()
            if (e.get("lvl") or 0) <= mlvl:
                out.setdefault(code, []).append(e)
        return out

    drops = {t[0]: walk(t[3]) for t in TARGETS}
    missing_level = sorted(set(t[0] for t in TARGETS) - set(MLVL))
    if missing_level:
        raise SystemExit(f"这些目标没有怪物等级: {missing_level}")

    items = {}
    skipped = 0
    for entries, code_key, kind in ((uniques, "code", "u"), (sets, "item", "s")):
        for e in entries:
            code = (e[code_key] or "").strip()
            b = base.get(code)
            if not b:
                skipped += 1
                continue
            qlvl = b.get("level") or 0
            rows_out = []
            rivals_seen = 0
            for key, zh, act, tcname, _secs, _kills in TARGETS:
                mlvl = MLVL[key]
                if (e.get("lvl") or 0) > mlvl:
                    continue                      # your level allows it, the monster's does not
                base_exp = drops[key].get(code, 0)
                if not base_exp:
                    continue
                rivals = pool(entries, code_key, mlvl).get(code, [])
                weight = sum(x["rarity"] for x in rivals) or 1
                share = e["rarity"] / weight
                cb, mn = chance_params(ratio_row(ratios, b, code), mlvl, qlvl, kind)
                rivals_seen = len(rivals)
                # For a set item the unique roll happens first and wins ties,
                # so a set only gets what uniques leave behind.
                pre = 0.0
                if kind == "s":
                    u_rivals = pool(uniques, "code", mlvl).get(code, [])
                    if u_rivals:
                        ucb, umn = chance_params(ratio_row(ratios, b, code), mlvl, qlvl, "u")
                        pre = 128 / max(umn, ucb)
                # Stored as: the answer at zero magic find, plus the two
                # numbers needed to rescale it for any magic find. Three
                # numbers instead of five, and the common case needs no maths.
                p0 = base_exp * share * (1 - pre) * 128 / max(mn, cb)
                if p0 <= 0:
                    continue
                rows_out.append([TARGET_INDEX[key], float(f"{p0:.4e}"), cb, mn])

            if not rows_out:
                continue
            rows_out.sort(key=lambda r: -r[1])
            items[e["index"]] = {
                "k": kind,
                "rivals": rivals_seen,
                "rows": rows_out[:KEEP],
            }

    out = {
        "targets": [{"key": t[0], "zh": t[1], "act": t[2], "mlvl": MLVL[t[0]]} for t in TARGETS],
        "items": items,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    print(f"物品掉落: {len(items)} 件有掉落来源"
          f"（暗金 {sum(1 for v in items.values() if v['k'] == 'u')} ·"
          f" 绿装 {sum(1 for v in items.values() if v['k'] == 's')}）")
    if skipped:
        print(f"  跳过 {skipped} 件：底材不在物品表里")
    print(f"已生成: {OUT}  ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
