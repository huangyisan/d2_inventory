"""Download the property / stat-description tables needed to render item stats."""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")

D2DATA = "https://raw.githubusercontent.com/blizzhackers/d2data/master/json/"
STRINGS = "https://raw.githubusercontent.com/SeonEngineer/D2R/main/"

TABLES = ["properties.json", "skills.json", "skilldesc.json", "charstats.json"]
STRING_FILES = ["item-modifiers.json", "skills.json", "monsters.json", "ui.json"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


for fn in TABLES:
    try:
        data = get(D2DATA + fn)
        with open(os.path.join(OUT, fn), "wb") as fh:
            fh.write(data)
        print(f"{fn}: {len(json.loads(data))} rows")
    except Exception as exc:
        print(f"{fn}: FAILED {exc}")

merged = []
for fn in STRING_FILES:
    try:
        rows = json.loads(get(STRINGS + fn))
        print(f"strings/{fn}: {len(rows)} rows")
        merged.extend(rows)
    except Exception as exc:
        print(f"strings/{fn}: FAILED {exc}")

with open(os.path.join(OUT, "strings_mod.json"), "w", encoding="utf-8") as fh:
    json.dump(merged, fh, ensure_ascii=False)
print("strings_mod.json rows:", len(merged))
