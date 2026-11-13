#!/usr/bin/env python3
"""Unpack / repack the app template inside deploy/index.html.

deploy/index.html is a self-contained bundle: a loader script, a manifest of
assets (fonts, icons, support.js, firebase-sync.js, React) and one JSON-encoded
HTML template that holds the whole app (markup + the <script type="text/x-dc">
component). The old deploy/source/*.dc.html is out of date, so the template
inside the bundle is the real source.

    python3 tools/bundle.py unpack   # deploy/index.html -> deploy/source/app.html
    python3 tools/bundle.py pack     # deploy/source/app.html -> deploy/index.html

Edit deploy/source/app.html, then pack. Asset references in the template are
manifest UUIDs and must be left as they are.

pack also copies deploy/firebase-sync.js into the bundle (the app loads the
copy inside index.html, not the file next to it), so edit that file and pack.
"""
import base64, gzip, json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "deploy" / "index.html"
SOURCE = ROOT / "deploy" / "source" / "app.html"
PAT = re.compile(r'(<script type="__bundler/template">\n)(.*?)(\n  </script>)', re.S)
# Manifest assets that are kept in step with a file in deploy/.
ASSETS = {"f57e760c-9b61-420a-9612-415d961b985d": ROOT / "deploy" / "firebase-sync.js"}


def asset_pat(uuid):
    return re.compile(r'("' + re.escape(uuid) + r'":\{"mime":"[^"]+","compressed":)(true|false)(,"data":")([^"]*)(")')


def embed_assets(html):
    for uuid, path in ASSETS.items():
        m = asset_pat(uuid).search(html)
        if not m:
            sys.exit("asset " + uuid + " not found in " + str(BUNDLE))
        data = base64.b64encode(gzip.compress(path.read_bytes(), mtime=0)).decode("ascii")
        html = html[:m.start()] + m.group(1) + "true" + m.group(3) + data + m.group(5) + html[m.end():]
    return html


def encode(tpl):
    return json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002F")


def main(cmd):
    html = BUNDLE.read_text(encoding="utf-8")
    m = PAT.search(html)
    if not m:
        sys.exit("template block not found in " + str(BUNDLE))
    if cmd == "unpack":
        SOURCE.write_text(json.loads(m.group(2)), encoding="utf-8")
        print("wrote", SOURCE.relative_to(ROOT))
    elif cmd == "pack":
        tpl = SOURCE.read_text(encoding="utf-8")
        out = embed_assets(html[:m.start(2)] + encode(tpl) + html[m.end(2):])
        BUNDLE.write_text(out, encoding="utf-8")
        print("wrote", BUNDLE.relative_to(ROOT))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
