"""
Build the slim catalogue that gets embedded into the web page.

Everything the in-browser parser needs is precomputed here so the page carries
no game-data dependency at runtime:
  - base items keyed by code, with type flags already resolved from the
    itemtypes hierarchy
  - the stat table (save bits / param bits / add / shift) keyed by stat id
  - the unique and set-item catalogues, with localized names
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d2parse import GameData, slot_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")


class Traditional2Simplified:
    """
    Character-level traditional -> simplified conversion (OpenCC tables).

    Only the glyphs change; the wording stays exactly as the zhTW client shows
    it, which is what the player recognizes in game.
    """

    def __init__(self, path):
        self.phrases = {}
        self.chars = {}
        if not os.path.exists(path):
            return
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.phrases = data.get("phrases", {})
        self.chars = data.get("chars", {})
        self.max_phrase = max((len(p) for p in self.phrases), default=0)

    def __call__(self, text):
        if not text or not self.chars:
            return text
        out = []
        i = 0
        while i < len(text):
            hit = None
            for n in range(min(self.max_phrase, len(text) - i), 1, -1):
                cand = text[i:i + n]
                if cand in self.phrases:
                    hit = (self.phrases[cand], n)
                    break
            if hit:
                out.append(hit[0])
                i += hit[1]
            else:
                ch = text[i]
                out.append(self.chars.get(ch, ch))
                i += 1
        return "".join(out)


class Strings:
    """D2R localized string tables, looked up by string key or English name."""

    def __init__(self, path, lang="zhTW", transform=None):
        self.lang = lang
        self.transform = transform or (lambda s: s)
        self.by_key = {}
        self.by_en = {}
        if not os.path.exists(path):
            return
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)
        for row in rows:
            key, en = row.get("Key"), row.get("enUS")
            if key and key not in self.by_key:
                self.by_key[key] = row
            if en and en not in self.by_en:
                self.by_en[en] = row

    def get(self, key, fallback=None):
        row = self.by_key.get(key) or self.by_en.get(key)
        if not row:
            return fallback if fallback is not None else key
        value = row.get(self.lang) or row.get("enUS") or key
        # D2R colour codes look like "ÿc1"; strip them.
        while "ÿc" in value:
            i = value.index("ÿc")
            value = value[:i] + value[i + 3:]
        value = self.transform(value.strip())
        return value or (fallback if fallback is not None else key)

# Base-item flags, packed as a bitmask to keep the payload small.
FLAG_ARMOR = 1
FLAG_WEAPON = 2
FLAG_GOLD = 4
FLAG_CHARM = 8
FLAG_BODYPART = 16
FLAG_PLAYERBODYPART = 32
FLAG_SCROLLBOOK = 64
FLAG_STACKABLE = 128
FLAG_QUEST = 256
FLAG_QUESTDIFF = 512
FLAG_COMPACT = 1024


def main():
    gd = GameData(DATA_DIR)
    # zhTW wording (what the player's client shows), simplified glyphs.
    t2s = Traditional2Simplified(os.path.join(DATA_DIR, "t2s.json"))
    strings = Strings(os.path.join(DATA_DIR, "strings_raw.json"), lang="zhTW", transform=t2s)

    # ---- base items ------------------------------------------------------
    bases = {}
    for code, b in gd.base.items():
        flags = 0
        if b["is_armor"]:
            flags |= FLAG_ARMOR
        if b["is_weapon"]:
            flags |= FLAG_WEAPON
        if b["is_gold"]:
            flags |= FLAG_GOLD
        if b["is_charm"]:
            flags |= FLAG_CHARM
        if b["is_bodypart"]:
            flags |= FLAG_BODYPART
        if b["is_playerbodypart"]:
            flags |= FLAG_PLAYERBODYPART
        if b["is_scroll_or_book"]:
            flags |= FLAG_SCROLLBOOK
        if b["is_stackable"]:
            flags |= FLAG_STACKABLE
        if b["is_quest"]:
            flags |= FLAG_QUEST
        if b["questdiffcheck"]:
            flags |= FLAG_QUESTDIFF
        if b["compactsave"]:
            flags |= FLAG_COMPACT
        zh = strings.get(code, b["name"])
        bases[code] = [b["name"], zh if zh != b["name"] else 0, flags, slot_of(b)]

    # ---- stat table ------------------------------------------------------
    stats = {}
    for sid, s in gd.stats.items():
        if s["save_bits"] or s["save_param_bits"]:
            stats[sid] = [s["save_bits"], s["save_param_bits"], s["save_add"], s["val_shift"]]

    # ---- unique catalogue, grouped by name -------------------------------
    uniques = {}
    for uid, info in sorted(gd.unique_by_id.items()):
        if not info["code"]:
            continue
        entry = uniques.setdefault(info["name"], {
            "name": info["name"],
            "zh": strings.get(info["name"], info["name"]),
            "slot": info["slot"],
            "code": info["code"],
            "base": info["base"],
            "base_zh": strings.get(info["code"], info["base"]),
            "lvlreq": 0,
            "standard": False,
            "ids": [],
        })
        entry["ids"].append(uid)
        entry["lvlreq"] = max(entry["lvlreq"], info["lvlreq"] or 0)
        entry["standard"] = entry["standard"] or bool(info["spawnable"])

    # ---- set catalogue, grouped by set -----------------------------------
    sets = {}
    for sid, info in sorted(gd.setitem_by_id.items()):
        if not info["code"]:
            continue
        group = sets.setdefault(info["set"], {
            "name": info["set"],
            "zh": strings.get(info["set"], info["set"]),
            "pieces": [],
        })
        group["pieces"].append({
            "name": info["name"],
            "zh": strings.get(info["name"], info["name"]),
            "slot": info["slot"],
            "code": info["code"],
            "base": info["base"],
            "base_zh": strings.get(info["code"], info["base"]),
            "lvlreq": info["lvlreq"] or 0,
            "id": sid,
        })

    # ---- runewords, keyed by the string id stored on items ---------------
    # Item records and chronicle entries both reference runewords by their
    # localized-string id (e.g. 20635 -> Runeword130 -> 精神).
    runewords = {}
    for key, row in strings.by_key.items():
        if not key.startswith("Runeword"):
            continue
        rid = row.get("id")
        en = (row.get("enUS") or "").strip()
        if rid is None or not en or en.lower() == "runeword":
            continue
        runewords[rid] = [en, strings.get(key, en)]

    catalog = {
        "bases": bases,
        "stats": stats,
        "runewords": runewords,
        "uniques": sorted(uniques.values(), key=lambda e: e["name"]),
        "sets": sorted(sets.values(), key=lambda g: g["name"]),
    }

    out = os.path.join(DATA_DIR, "catalog.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(out)
    print(f"runewords={len(runewords)}")
    print(f"bases={len(bases)} stats={len(stats)} "
          f"uniques={len(catalog['uniques'])} sets={len(catalog['sets'])} "
          f"pieces={sum(len(g['pieces']) for g in catalog['sets'])}")
    print(f"{out}  {size:,} bytes")


if __name__ == "__main__":
    main()
