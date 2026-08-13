"""
Bundle the catalogue, the parser and the app into one self-contained HTML file.

The result runs from a plain file:// double-click — no server, no network, no
Python at runtime. ES module syntax is stripped because file:// blocks modules.
"""

import datetime
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DATA_DIR = os.path.join(HERE, "data")
OUTPUT = os.path.join(HERE, "暗黑2存档管家.html")
DIST = os.path.join(HERE, "dist")  # deploy root (Cloudflare Pages)


def strip_modules(js):
    """Turn the ES module into a classic script (file:// cannot load modules)."""
    js = re.sub(r"^\s*import\s+.*?;\s*$", "", js, flags=re.M | re.S)
    js = re.sub(r"^export\s+\{[^}]*\};\s*$", "", js, flags=re.M)
    js = re.sub(r"^export\s+", "", js, flags=re.M)
    return js


def version():
    """
    What to stamp on the page so a refresh tells you which build you got.

    Cloudflare Pages exposes the deployed commit when it runs a build command;
    otherwise fall back to the local HEAD, which is the commit the bundle was
    generated *from*. A dirty tree gets a "+" so a local trial build is never
    mistaken for a released one.
    """
    sha = os.environ.get("CF_PAGES_COMMIT_SHA")
    if sha:
        return sha[:7]
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=HERE, text=True,
            stderr=subprocess.DEVNULL).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"
    # The bundle itself is a build artefact; rebuilding must not make the tree
    # look dirty, only real source edits count.
    generated = {"dist/index.html", "dist/_headers", os.path.basename(OUTPUT)}
    try:
        lines = subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=HERE, text=True,
            stderr=subprocess.DEVNULL).splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        lines = []
    dirty = any(line[3:].strip('"') not in generated for line in lines if line.strip())
    return sha + ("+" if dirty else "")


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

    built = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    html = (page
            .replace("__VERSION__", version())
            .replace("__BUILT__", built)
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
    print(f"版本: {version()}  构建于 {built}")
    print(f"已生成: {OUTPUT}  ({os.path.getsize(OUTPUT):,} bytes)")
    print(f"        {os.path.join(DIST, 'index.html')}  (部署用)")


if __name__ == "__main__":
    main()
