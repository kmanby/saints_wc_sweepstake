#!/usr/bin/env python3
"""Regenerate site/favicon.png — the Saints crest composited onto brand maroon.

The crest is embedded (transparent RGBA PNG) in index.html's .crest-wrap; we
pull it from there so there's a single source of the logo. Run from repo root:

    python3 tools/make-favicon.py

Needs Pillow (`python3 -m pip install Pillow`).
"""
import base64, io, re, sys
from PIL import Image

MAROON = (0x5C, 0x12, 0x24, 255)   # --maroon brand primary
SS = 256                            # supersample, then downscale for crisp edges
PAD_FRAC = 0.12                     # padding each side, as a fraction of the icon

def main():
    html = open("site/index.html", encoding="utf-8").read()
    m = re.search(r'crest-wrap.*?<img src="data:image/png;base64,([^"]+)"', html, re.S)
    if not m:
        sys.exit("Could not find the crest image in site/index.html")
    crest = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGBA")

    bg = Image.new("RGBA", (SS, SS), MAROON)
    avail = int(SS * (1 - PAD_FRAC * 2))
    w, h = crest.size
    scale = avail / max(w, h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    bg.alpha_composite(crest.resize((nw, nh), Image.LANCZOS), ((SS - nw) // 2, (SS - nh) // 2))

    bg.resize((64, 64), Image.LANCZOS).save("site/favicon.png", optimize=True)
    print("wrote site/favicon.png")

if __name__ == "__main__":
    main()
