"""Download D2 game data tables (uniques, sets, base items) into data/."""
import json, os, urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)

BASE = "https://raw.githubusercontent.com/blizzhackers/d2data/master/json/"
FILES = [
    "uniqueitems.json",
    "setitems.json",
    "sets.json",
    "armor.json",
    "weapons.json",
    "misc.json",
    "itemtypes.json",
    "itemstatcost.json",
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


for f in FILES:
    dest = os.path.join(OUT, f)
    data = get(BASE + f)
    with open(dest, "wb") as fh:
        fh.write(data)
    parsed = json.loads(data)
    print(f"{f:22s} {len(data):9,d} bytes  {len(parsed)} rows")
    if isinstance(parsed, list) and parsed:
        print("    keys:", list(parsed[0].keys())[:18])
