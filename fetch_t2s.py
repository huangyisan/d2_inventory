"""
Download OpenCC's traditional -> simplified conversion tables.

The game's zhTW names are the ones the player actually sees, but they want them
rendered in simplified glyphs, so wording comes from zhTW and only the
characters are converted.
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
os.makedirs(OUT, exist_ok=True)

BASE = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/"
FILES = ["TSPhrases.txt", "TSCharacters.txt"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


tables = {}
for fn in FILES:
    text = get(BASE + fn)
    mapping = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        # Multiple candidates are space-separated; the first is the default.
        mapping[parts[0]] = parts[1].split(" ")[0]
    tables[fn] = mapping
    print(f"{fn}: {len(mapping)} 条")

dest = os.path.join(OUT, "t2s.json")
with open(dest, "w", encoding="utf-8") as fh:
    json.dump({"phrases": tables["TSPhrases.txt"], "chars": tables["TSCharacters.txt"]},
              fh, ensure_ascii=False)
print(f"{dest}  {os.path.getsize(dest):,} bytes")
