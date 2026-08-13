"""Download D2R localized string tables and build an English -> Chinese name map."""
import json, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
os.makedirs(OUT, exist_ok=True)

SOURCES = [
    "https://raw.githubusercontent.com/SeonEngineer/D2R/main/item-names.json",
    "https://raw.githubusercontent.com/SeonEngineer/D2R/main/item-nameaffixes.json",
    "https://raw.githubusercontent.com/SeonEngineer/D2R/main/item-runes.json",
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


merged = []
for url in SOURCES:
    name = url.rsplit("/", 1)[-1]
    try:
        raw = get(url)
    except Exception as exc:
        print(f"{name}: FAILED {exc}")
        continue
    rows = json.loads(raw)
    print(f"{name}: {len(rows)} rows")
    if rows:
        print("   keys:", list(rows[0].keys()))
        print("   sample:", json.dumps(rows[0], ensure_ascii=False)[:200])
    merged.extend(rows)

with open(os.path.join(OUT, "strings_raw.json"), "w", encoding="utf-8") as fh:
    json.dump(merged, fh, ensure_ascii=False)
print("\ntotal rows:", len(merged))
