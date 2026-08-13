"""
Bundle the catalogue, the parser and the app into one self-contained HTML file.

The result runs from a plain file:// double-click — no server, no network, no
Python at runtime. ES module syntax is stripped because file:// blocks modules.
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DATA_DIR = os.path.join(HERE, "data")
OUTPUT = os.path.join(HERE, "暗黑2收藏台账.html")
DIST = os.path.join(HERE, "dist")  # deploy root (Cloudflare Pages)


def strip_modules(js):
    """Turn the ES module into a classic script (file:// cannot load modules)."""
    js = re.sub(r"^\s*import\s+.*?;\s*$", "", js, flags=re.M | re.S)
    js = re.sub(r"^export\s+\{[^}]*\};\s*$", "", js, flags=re.M)
    js = re.sub(r"^export\s+", "", js, flags=re.M)
    return js


def main():
    catalog_path = os.path.join(DATA_DIR, "catalog.json")
    if not os.path.exists(catalog_path):
        subprocess.check_call([sys.executable, os.path.join(HERE, "make_catalog.py")])

    with open(catalog_path, encoding="utf-8") as fh:
        catalog = fh.read()
    with open(os.path.join(SRC, "parser.js"), encoding="utf-8") as fh:
        parser = strip_modules(fh.read())
    with open(os.path.join(SRC, "app.js"), encoding="utf-8") as fh:
        app = fh.read()
    with open(os.path.join(SRC, "page.html"), encoding="utf-8") as fh:
        page = fh.read()

    # Guard against an early </script> closing the inline block.
    catalog = catalog.replace("</", "<\\/")

    html = (page
            .replace("__CATALOG__", catalog)
            .replace("__PARSER__", parser)
            .replace("__APP__", app))

    with open(OUTPUT, "w", encoding="utf-8") as fh:
        fh.write(html)

    # Same file again as the deploy root's index.html.
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    with open(os.path.join(DIST, "_headers"), "w", encoding="utf-8") as fh:
        fh.write("/*\n"
                 "  X-Content-Type-Options: nosniff\n"
                 "  Referrer-Policy: no-referrer\n"
                 "  Permissions-Policy: geolocation=(), camera=(), microphone=()\n"
                 "/index.html\n"
                 "  Cache-Control: public, max-age=0, must-revalidate\n")

    cat = json.loads(open(catalog_path, encoding="utf-8").read())
    print(f"目录: {len(cat['uniques'])} 种暗金 · "
          f"{len(cat['sets'])} 个套装 / {sum(len(g['pieces']) for g in cat['sets'])} 件绿装 · "
          f"{len(cat['bases'])} 种基础物品")
    print(f"已生成: {OUTPUT}  ({os.path.getsize(OUTPUT):,} bytes)")
    print(f"        {os.path.join(DIST, 'index.html')}  (部署用)")


if __name__ == "__main__":
    main()
