#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""兜底合成：给"提取不出不透明背景层"的场景壁纸做一张 4K 16:9 静帧

思路：
  1) 解包 scene.pkg
  2) 取面积最大的图当主体（通常是带透明通道的人物层）
  3) 用主体自身放大 + 高斯模糊 + 压暗作为背景（颜色协调、不突兀）
  4) 主体按比例贴回中央 —— 输出 3840x2160 JPEG
如果连主体都没有，就退回 preview 图放大 + 锐化。

用法：python still-compose.py <id> [<id> ...]
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageFilter

WS = os.environ.get("WE_WORKSHOP", r"C:\Program Files (x86)\Steam\steamapps\workshop\content\431960")
OUT = os.environ.get("WE_STILLS", str(Path(__file__).resolve().parent.parent / "stills"))
TMP = os.path.join(OUT, "_tmp2")
REPKG = os.environ.get("REPKG_EXE", str(Path(__file__).resolve().parent / "repkg" / "RePKG.exe"))
META = os.path.join(OUT, "index.json")
W, H = 3840, 2160


def images(root):
    out = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if not f.lower().endswith((".png", ".jpg", ".jpeg")):
                continue
            p = os.path.join(dirpath, f)
            try:
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                continue
            if w < 320:
                continue
            out.append({"path": p, "w": w, "h": h, "area": w * h, "bytes": os.path.getsize(p)})
    return out


def cover(im, w, h):
    scale = max(w / im.width, h / im.height)
    nw, nh = max(w, int(im.width * scale)), max(h, int(im.height * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return im.crop((left, top, left + w, top + h))


def compose(subject_path, preview_path, out_path, cov=0.0):
    """把最大的一张铺满 16:9；透明区域用同一张图的模糊版垫底，不会有黑边/贴纸感"""
    if subject_path:
        im = Image.open(subject_path).convert("RGBA")
        filled = cover(im, W, H)
        under = filled.convert("RGB").filter(ImageFilter.GaussianBlur(46))
        under = Image.blend(under, Image.new("RGB", (W, H), (8, 10, 14)), 0.32)
        out = Image.alpha_composite(under.convert("RGBA"), filled)
        out.convert("RGB").save(out_path, "JPEG", quality=92, optimize=True)
        return {"w": W, "h": H, "mode": "cover"}

    if preview_path:
        im = Image.open(preview_path).convert("RGB")
        big = cover(im, W, H)
        big = big.filter(ImageFilter.UnsharpMask(radius=2.2, percent=85, threshold=3))
        big.save(out_path, "JPEG", quality=90, optimize=True)
        return {"w": W, "h": H, "mode": "preview-upscale"}

    return None

def main():
    ids = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not ids:
        print("需要至少一个 workshop id")
        return
    os.makedirs(TMP, exist_ok=True)
    idx = {}
    if os.path.exists(META):
        try:
            idx = json.load(open(META, encoding="utf-8"))
        except Exception:
            idx = {}

    for wid in ids:
        d = os.path.join(WS, wid)
        pkg = os.path.join(d, "scene.pkg")
        pj = os.path.join(d, "project.json")
        if not os.path.exists(pj):
            print(f"{wid}: 目录不存在，跳过")
            continue
        title = ""
        try:
            title = json.load(open(pj, encoding="utf-8")).get("title", "")
        except Exception:
            pass

        preview = None
        for ext in ("jpg", "png", "jpeg", "gif"):
            p = os.path.join(d, "preview." + ext)
            if os.path.exists(p):
                preview = p
                break

        subject = None
        cov_of_subject = 0.0
        tmp = os.path.join(TMP, wid)
        if os.path.exists(pkg):
            shutil.rmtree(tmp, ignore_errors=True)
            os.makedirs(tmp, exist_ok=True)
            try:
                subprocess.run([REPKG, "extract", "-o", tmp, pkg],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=300, creationflags=0x08000000)
                cands = images(tmp)
                # 优先选"有透明通道且面积最大"的（人物层）；否则选最大的
                cands.sort(key=lambda c: (c["area"], c["bytes"]), reverse=True)
                if cands:
                    subject = cands[0]["path"]
                    with Image.open(subject) as im:
                        a = im.convert("RGBA").getchannel("A")
                        hist = a.histogram()
                        cov_of_subject = sum(hist[250:]) / (im.width * im.height)
            except Exception as e:
                print(f"{wid}: 解包失败 {e}")

        out = os.path.join(OUT, wid + ".jpg")
        info = compose(subject, preview, out, cov_of_subject)
        shutil.rmtree(tmp, ignore_errors=True)

        if info:
            idx[wid] = {"w": info["w"], "h": info["h"], "layers": 1, "mode": info["mode"], "title": title}
            json.dump(idx, open(META, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print(f"OK  {wid}  {title[:24]}  {info['mode']}  {info['w']}x{info['h']}")
        else:
            print(f"--  {wid}  {title[:24]}  确实没有可用素材")


if __name__ == "__main__":
    main()
