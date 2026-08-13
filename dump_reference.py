"""Dump the Python reference parser's results for cross-checking the JS port."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from d2parse import parse_directory, location_label  # noqa: E402

gd, sources = parse_directory(os.path.join(HERE, "Diablo_2_Resurrected"), os.path.join(HERE, "data"))

CLS_ZH = {"Amazon": "亚马逊", "Sorceress": "女法师", "Necromancer": "死灵法师",
          "Paladin": "圣骑士", "Barbarian": "野蛮人", "Druid": "德鲁伊", "Assassin": "刺客"}

out = []
for src in sources:
    if src["source_type"] == "error":
        out.append({"source": src["file"], "error": src["error"]})
        continue
    cls = src.get("class", "")
    out.append({
        "source": src["source"],
        "type": src["source_type"],
        "cls": CLS_ZH.get(cls, cls) if cls else "",
        "level": src.get("level", 0),
        "declared": src.get("declared_item_count"),
        "warnings": src.get("warnings", []),
        "chronicle": src.get("chronicle"),
        "items": [{
            "code": it["code"],
            "quality": it["quality"],
            "uniqueId": it.get("unique_id"),
            "setId": it.get("set_id"),
            "where": location_label(it),
            "ilvl": it.get("item_level"),
            "eth": it.get("ethereal", False),
            "sockets": it.get("sockets", 0),
            "socketedIn": it.get("socketed_in"),
            "stackCount": it.get("stack_count", 1),
        } for it in src["items"]],
    })

with open(os.path.join(HERE, "py_dump.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
print("py items:", sum(len(s.get("items", [])) for s in out))
