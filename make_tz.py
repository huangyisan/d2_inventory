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

# Which zones are actually worth dropping what you are doing for. Same split the
# community trackers use: all-round best, best experience, best loot.
TAGS = {
    "boss": [
        "Tal Rasha's Tombs, Tal Rasha's Chamber, Canyon of the Magi",
        "Chaos Sanctuary",
        "Cathedral, Catacombs, Inner Cloister",
        "Worldstone Keep, Throne of Destruction, Worldstone Chamber",
    ],
    "exp": [
        "Flayer Jungle, Flayer Dungeon, Swampy Pit",
        "Tamoe Highland, Outer Cloister, Pit, Monastery Gate",
        "Rocky Waste, Stony Tomb",
        "Lut Gholein Sewers",
        "Dry Hills, Halls of the Dead",
        "Bloody Foothills, Frigid Highlands, Abaddon",
    ],
    "loot": [
        "Travincal",
        "Durance of Hate",
        "The Secret Cow Level",
    ],
}
TAG_OF = {name: tag for tag, names in TAGS.items() for name in names}


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
                "tag": TAG_OF.get(key, ""),
            })
    if len(zones) > len(ALPHABET):
        raise SystemExit(f"地区数 {len(zones)} 超出字母表")
    unknown = set(TAG_OF) - set(order)
    if unknown:
        raise SystemExit(f"标记了不存在的地区: {sorted(unknown)}")

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
