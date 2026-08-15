"""
Build the terror-zone schedule that the page ships with.

Offline (single player) terror zones are not rolled by your machine: they follow
a fixed published calendar, the same one every offline game reads. So the whole
schedule can be baked into the bundle and looked up with zero network at
runtime -- which is the point, this tool is meant to work from file://.

The upstream feed is one entry per half hour with the zone name repeated in
thirteen languages; that is ~6 MB for four months. Since the slots are exactly
evenly spaced and each zone always carries the same immunities, boss-pack count
and super uniques, it compresses to a zone table plus one character per slot.
"""

import datetime
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "tz.json")
SOURCE = "https://d2emu.com/data/tz-2023-localized.json"
CACHE = os.path.join(HERE, "data", "tz_raw.json")

# One printable character per zone index, so the slot list is a plain string.
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

# Which act each zone belongs to, so the list can say where to walk.
ACTS = {
    1: [
        "Blood Moor, Den of Evil",
        "Burial Grounds, Crypt, Mausoleum",
        "Stony Field, Tristram",
        "Cold Plains, Cave",
        "Dark Wood, Underground Passage",
        "Black Marsh, The Hole, Forgotten Tower",
        "Tamoe Highland, Outer Cloister, Pit, Monastery Gate",
        "Barracks, Jail",
        "Cathedral, Catacombs, Inner Cloister",
        "The Secret Cow Level",
    ],
    2: [
        "Lut Gholein Sewers",
        "Rocky Waste, Stony Tomb",
        "Dry Hills, Halls of the Dead",
        "Far Oasis, Maggot Lair",
        "Lost City, Valley of Snakes, Claw Viper Temple, Ancient Tunnels",
        "Arcane Sanctuary, Harem, Palace Cellar",
        "Tal Rasha's Tombs, Tal Rasha's Chamber, Canyon of the Magi",
    ],
    3: [
        "Spider Forest, Arachnid Lair, Spider Cavern",
        "Great Marsh",
        "Flayer Jungle, Flayer Dungeon, Swampy Pit",
        "Kurast Bazaar, Lower Kurast, Upper Kurast, Kurast Causeway, Kurast Sewers, "
        "Ruined Temple, Disused Fane, Forgotten Reliquary, Forgotten Temple, "
        "Ruined Fane, Disused Reliquary",
        "Travincal",
        "Durance of Hate",
    ],
    4: [
        "Outer Steppes, Plains of Despair",
        "City of the Damned, River of Flame",
        "Chaos Sanctuary",
    ],
    5: [
        "Bloody Foothills, Frigid Highlands, Abaddon",
        "Frozen Tundra, Infernal Pit",
        "Arreat Plateau, Pit of Acheron",
        "Crystalline Passage, Frozen River",
        "Nihlathak's Temple, Temple Halls",
        "Glacial Trail, Drifter Cavern",
        "Ancient's Way, Icy Cellar",
        "Worldstone Keep, Throne of Destruction, Worldstone Chamber",
    ],
}
ACT_OF = {name: act for act, names in ACTS.items() for name in names}


def load_raw():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as fh:
            return json.load(fh)
    print(f"下载排期: {SOURCE}")
    with urllib.request.urlopen(SOURCE, timeout=120) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    with open(CACHE, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False)
    return raw


def main():
    raw = load_raw()
    if not raw:
        raise SystemExit("排期为空")

    times = [datetime.datetime.fromisoformat(e["datetime"]) for e in raw]
    steps = {(times[i + 1] - times[i]).total_seconds() for i in range(len(times) - 1)}
    if len(steps) != 1:
        raise SystemExit(f"时间间隔不均匀: {sorted(steps)}")
    step = int(steps.pop())

    order, zones = {}, []
    for e in raw:
        key = e["zone"]["enUS"]
        if key not in order:
            order[key] = len(zones)
            zones.append({
                "zh": e["zone"]["zhCN"],
                "en": key,
                "imm": e.get("immunities", []),
                "packs": e.get("numBossPacks") or [],
                "su": e.get("superuniques", []),
                "act": ACT_OF.get(key, 0),
            })
    if len(zones) > len(ALPHABET):
        raise SystemExit(f"地区数 {len(zones)} 超出字母表")
    unknown = set(ACT_OF) - set(order)
    if unknown:
        raise SystemExit(f"标了幕但排期里没有的地区: {sorted(unknown)}")
    unplaced = [z["en"] for z in zones if not z["act"]]
    if unplaced:
        raise SystemExit(f"这些地区不知道属于第几幕: {unplaced}")

    slots = "".join(ALPHABET[order[e["zone"]["enUS"]]] for e in raw)
    data = {
        "start": times[0].astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "step": step,
        "alphabet": ALPHABET[:len(zones)],
        "zones": zones,
        "slots": slots,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))

    end = times[0] + datetime.timedelta(seconds=step * len(raw))
    print(f"恐怖地带: {len(zones)} 种地区 · {len(raw)} 个时段 · 每 {step // 60} 分钟一轮")
    print(f"覆盖: {times[0]:%Y-%m-%d} ~ {end:%Y-%m-%d} (UTC)")
    print(f"已生成: {OUT}  ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
