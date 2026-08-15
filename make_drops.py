"""
Work out how often each rune actually drops, from the game's own drop tables.

Nothing here is copied off a wiki. treasureclassex.txt is a tree: a monster
points at a treasure class, that class points at other classes with weights,
and somewhere down the chain sit the "Runes N" classes that hold the runes
themselves. Walking that tree gives the real numbers, including the thing every
rune hunter cares about — that most bosses simply cannot roll the high runes at
all, because their chain tops out at a low "Runes N".

Two knobs in the table matter:
  Picks > 0  the class is rolled that many times, and NoDrop competes with the
             listed items on each roll (this is where "nothing dropped" lives)
  Picks < 0  the listed items are dropped outright, Prob times each, no contest
             — this is how bosses drop "their item table AND their rune table"

The result is the expected number of that rune per kill, which for numbers this
small is the same as the chance of seeing one.
"""

import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "drops.json")
SOURCE = "https://raw.githubusercontent.com/blizzhackers/d2data/master/json/treasureclassex.json"
CACHE = os.path.join(DATA, "treasureclassex.json")

RUNES = [f"r{i:02d}" for i in range(1, 34)]

# What people actually run, in the order you meet them. Hell only: the lower
# difficulties cannot reach the high runes at all, which makes them noise here.
#
# The last two numbers — seconds per run, and how many drop-eligible kills that
# run yields — are NOT game data. Nothing in the game files knows how fast you
# clear Travincal. They are starting estimates for a geared character with
# teleport, and the page lets you replace them, because per-hour numbers are
# only as honest as the pace you actually run at.
TARGETS = [
    ("countess", "女伯爵", 1, "Countess (H)", 25, 1),
    ("smith", "铁匠", 1, "Smith (H)", 20, 1),
    ("andariel", "安达利尔", 1, "Andarielq (H)", 35, 1),
    ("radament", "拉达门特", 2, "Radament (H)", 30, 1),
    ("summoner", "召唤者", 2, "Summoner (H)", 25, 1),
    ("duriel", "督瑞尔", 2, "Duriel (H)", 70, 1),
    ("council", "崔凡克议会", 3, "Council (H)", 25, 12),
    ("mephisto", "墨菲斯托", 3, "Mephisto (H)", 45, 1),
    ("izual", "伊苏尔", 4, "Izual (H)", 35, 1),
    ("hephasto", "锻炉守卫", 4, "Haphesto (H)", 40, 1),
    ("diablo", "暗黑破坏神", 4, "Diablo (H)", 90, 1),
    ("shenk", "香克", 5, "Act 5 (H) Super A", 25, 1),
    ("pindle", "平德尔斯金", 5, "Act 5 (H) Super Cx", 15, 1),
    ("nihlathak", "尼拉塞克", 5, "Nihlathak (H)", 35, 1),
    ("cowking", "牛王", 5, "Cow King (H)", 90, 1),
    ("cow", "地狱奶牛", 5, "Cow (H)", 180, 150),
    ("baal", "巴尔", 5, "Baal (H)", 120, 1),
]


def load_tc():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as fh:
            return json.load(fh)
    print(f"下载掉落表: {SOURCE}")
    with urllib.request.urlopen(SOURCE, timeout=120) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    with open(CACHE, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False)
    return raw


def expected(tc, name, want, seen=()):
    """Expected number of `want` dropped by one roll of treasure class `name`."""
    row = tc.get(name)
    if row is None:
        return 1.0 if name == want else 0.0
    if name in seen:            # the tables are authored by hand; do not trust them blindly
        return 0.0
    seen = seen + (name,)

    items = [(row.get(f"Item{i}"), row.get(f"Prob{i}"))
             for i in range(1, 11) if row.get(f"Item{i}")]
    picks = row.get("Picks", 1)
    if picks < 0:
        return sum(p * expected(tc, it, want, seen) for it, p in items)
    total = row.get("*ItemProbTotal", sum(p for _, p in items)) + (row.get("NoDrop") or 0)
    if not total:
        return 0.0
    return picks * sum((p / total) * expected(tc, it, want, seen) for it, p in items)


def main():
    tc = load_tc()
    missing = [t for _, _, _, t, _, _ in TARGETS if t not in tc]
    if missing:
        raise SystemExit(f"掉落表里没有这些目标: {missing}")

    targets = []
    for key, zh, act, name, secs, kills in TARGETS:
        rates = [expected(tc, name, r) for r in RUNES]
        top = max((i + 1 for i, e in enumerate(rates) if e > 0), default=0)
        targets.append({
            "key": key, "zh": zh, "act": act, "tc": name,
            # Editable in the page; see the note on TARGETS above.
            "secs": secs, "kills": kills,
            # Rounded hard: these are one-in-tens-of-thousands numbers, and
            # carrying more digits would only pretend to a precision the
            # rounding of the tables does not support.
            "rates": [float(f"{e:.3e}") if e else 0 for e in rates],
            "top": top,
            "any": float(f"{sum(rates):.4f}"),
        })

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"runes": RUNES, "targets": targets}, fh,
                  ensure_ascii=False, separators=(",", ":"))

    print(f"掉落: {len(targets)} 个目标 × {len(RUNES)} 个符文")
    for t in targets:
        print(f"  {t['zh']:<6} 最高 {t['top']:>2} 号 · 任意符文 {t['any']:.3f} 次/杀")
    print(f"已生成: {OUT}  ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
