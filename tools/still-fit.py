#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把比例极端的静帧改成 16:9 背景版

横竖比 <1.2（竖长）或 >2.1（超宽）的图，直接 cover 会裁掉太多内容。
做法：整张图等比缩进 16:9 画布（占 94%），四周用同一张图的模糊放大版补满。
"""
import json
import os
from pathlib import Path

from PIL import Image, ImageFilter

OUT = os.environ.get("WE_STILLS", str(Path(__file__).resolve().parent.parent / "stills"))
META = os.path.join(OUT, "index.json")
W, H = 3840, 2160


def cover(im, w, h):
    scale = max(w / im.width, h / im.height)
    nw, nh = max(w, int(im.width * scale)), max(h, int(im.height * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    return im.crop(((nw - w) // 2, (nh - h) // 2, (nw - w) // 2 + w, (nh - h) // 2 + h))


def fit(im):
    bg = cover(im, W, H).filter(ImageFilter.GaussianBlur(44))
    bg = Image.blend(bg, Image.new("RGB", (W, H), (8, 10, 14)), 0.42)
    scale = min(W * 0.94 / im.width, H * 0.94 / im.height)
    fw, fh = int(im.width * scale), int(im.height * scale)
    fg = im.resize((fw, fh), Image.LANCZOS)
    canvas = bg.convert("RGBA")
    canvas.alpha_composite(fg.convert("RGBA"), ((W - fw) // 2, (H - fh) // 2))
    return canvas.convert("RGB")


def main():
    idx = json.load(open(META, encoding="utf-8"))
    changed = 0
    for wid, rec in list(idx.items()):
        if rec.get("fail"):
            continue
        ratio = rec["w"] / rec["h"]
        if 1.2 <= ratio <= 2.1:
            continue
        p = os.path.join(OUT, wid + ".jpg")
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGB")
        before = f"{rec['w']}x{rec['h']}"
        fit(im).save(p, "JPEG", quality=92, optimize=True)
        idx[wid] = {"w": W, "h": H, "layers": rec.get("layers", 1), "mode": "fit", "title": rec.get("title", "")}
        changed += 1
        print(f"{wid}  {before} -> {W}x{H}  {rec.get('title','')[:20]}")
    json.dump(idx, open(META, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"共处理 {changed} 张")


if __name__ == "__main__":
    main()
