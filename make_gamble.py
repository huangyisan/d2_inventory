"""
What赌博 actually gives you, kept deliberately apart from the boss tables.

Gambling shares exactly one step with the drop calculation — "which unique of
this base do I get" — and shares nothing else. There is no treasure class, no
NoDrop, no monster level, and magic find does not apply. So it gets its own
file and its own panel rather than being folded into the per-boss numbers,
where it would look comparable and is not.

Two things drive the whole answer:

  1. a flat quality roll out of 100000, from difficultylevels.txt, identical on
     all three difficulties — gambling does not care what difficulty you are on
  2. the rarity weights of everything sharing that base which your item level
     allows

Step 2 is why level matters so much. The Stone of Jordan is one of three ring
uniques a level-40 character can roll and one of eleven at level 99, so the
same gamble is twice as good on the lower character. That window is the only
real lever gambling has, and it is what this file computes.

Only bases the vendor offers directly are included. Gambling can upgrade an
item to its exceptional or elite tier, but the rate for that upgrade is not
something these tables state plainly, and guessing it would put invented
numbers next to measured ones.
"""

import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "gamble.json")

SOURCES = {
    "gamble.json": "https://raw.githubusercontent.com/blizzhackers/d2data/master/json/gamble.json",
    "difficultylevels.json":
        "https://raw.githubusercontent.com/blizzhackers/d2data/master/json/difficultylevels.json",
}

# The roll is out of this; the fields in difficultylevels are numerators.
GAMBLE_DENOM = 100000

# Character levels worth asking about. Below 12 no vendor gambles anything
# interesting, and 99 is the ceiling.
LEVELS = range(1, 100)


def fetch(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        print(f"下载: {SOURCES[name]}")
        with urllib.request.urlopen(SOURCES[name], timeout=120) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(raw, fh, ensure_ascii=False)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def rows(name):
    data = fetch(name) if name in SOURCES else None
    if data is None:
        with open(os.path.join(DATA, name), encoding="utf-8") as fh:
            data = json.load(fh)
    return list(data.values() if isinstance(data, dict) else data)


def quality_rates():
    """Chance a gambled item comes out unique / set, from the game's own table."""
    diffs = rows("difficultylevels.json")
    got = {(d["GambleUnique"], d["GambleSet"]) for d in diffs}
    if len(got) != 1:
        raise SystemExit(f"三个难度的赌博概率不一致，需要重新处理: {got}")
    uniq, st = got.pop()
    return {"u": uniq / GAMBLE_DENOM, "s": st / GAMBLE_DENOM}


def steps_for(entry, rivals):
    """
    How the item's share of its base changes as your level rises.

    Returns [[minLevel, share], ...] — each entry holds from that level until
    the next one. Share only ever drops, because rivals only ever get added.
    """
    own = entry["_lvl"]
    thresholds = sorted({r["_lvl"] for r in rivals if r["_lvl"] >= own})
    out = []
    for lvl in thresholds:
        pool = [r for r in rivals if r["_lvl"] <= lvl]
        total = sum(r["_rarity"] for r in pool)
        share = entry["_rarity"] / total if total else 0.0
        if out and abs(out[-1][1] - share) < 1e-12:
            continue                      # a rival that changes nothing
        out.append([lvl, float(f"{share:.6f}")])
    return out


def main():
    gamble_codes = {(r["code"] or "").strip() for r in rows("gamble.json")}
    gamble_codes.discard("")
    rates = quality_rates()

    pools = {"u": {}, "s": {}}
    meta = {}
    for entries, code_key, kind in ((rows("uniqueitems.json"), "code", "u"),
                                    (rows("setitems.json"), "item", "s")):
        for e in entries:
            code = (e.get(code_key) or "").strip()
            if not code:
                continue
            if kind == "u" and not e.get("spawnable"):
                continue
            e["_lvl"] = e.get("lvl") or 0
            e["_rarity"] = e.get("rarity") or 1
            pools[kind].setdefault(code, []).append(e)
            meta[e["index"]] = (kind, code, e.get("lvl req") or 0)

    items = {}
    for name, (kind, code, req) in meta.items():
        if code not in gamble_codes:
            continue                      # vendor never offers this base
        rivals = pools[kind][code]
        entry = next(r for r in rivals if r["index"] == name)
        steps = steps_for(entry, rivals)
        if not steps or steps[0][1] <= 0:
            continue
        items[name] = {
            "k": kind,
            "code": code,
            "req": req,
            "rivals": len(rivals),
            "steps": steps,
        }

    out = {"rate": rates, "denom": GAMBLE_DENOM, "items": items}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    u = sum(1 for v in items.values() if v["k"] == "u")
    print(f"赌博: {len(gamble_codes)} 种底材可赌 · "
          f"暗金 {u} 件 · 绿装 {len(items) - u} 件")
    print(f"  出暗金 {rates['u'] * 100:.3f}% · 出绿装 {rates['s'] * 100:.3f}%（三个难度相同）")
    narrowing = [(n, v) for n, v in items.items() if len(v["steps"]) > 1]
    narrowing.sort(key=lambda kv: kv[1]["steps"][0][1] / kv[1]["steps"][-1][1], reverse=True)
    print(f"  其中 {len(narrowing)} 件存在「卡等级」窗口，落差最大的几件：")
    for n, v in narrowing[:5]:
        a, b = v["steps"][0], v["steps"][-1]
        print(f"    {n:<26} {a[0]:>2} 级时占 {a[1] * 100:5.1f}% →"
              f" {b[0]:>2} 级后只剩 {b[1] * 100:5.1f}%")
    print(f"已生成: {OUT}  ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
