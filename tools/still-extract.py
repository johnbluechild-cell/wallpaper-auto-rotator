#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景型壁纸 → 4K 静帧

对每个 scene.pkg：
  1) 用 RePKG 解包（临时目录，处理完即删）
  2) 选「不透明且面积最大」的一层当作背景
  3) 把带透明通道的人物层按面积从大到小叠上去
  4) 存成 JPEG（最长边 ≤ 3840，质量 92）到 cache/stills/<id>.jpg

全部产物都在工作区内，不写 C 盘。
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image

WS = os.environ.get("WE_WORKSHOP", r"C:\Program Files (x86)\Steam\steamapps\workshop\content\431960")
OUT = os.environ.get("WE_STILLS", str(Path(__file__).resolve().parent.parent / "stills"))
TMP = os.path.join(OUT, "_tmp")
REPKG = os.environ.get("REPKG_EXE", str(Path(__file__).resolve().parent / "repkg" / "RePKG.exe"))
META = os.path.join(OUT, "index.json")

MIN_W = 1600          # 候选层最小宽度
MIN_BYTES = 200_000   # 过滤纯色遮罩
MAX_SIDE = 3840
FORCE = '--force' in sys.argv
LOCK = os.path.join(OUT, '.running')


def alpha_coverage(im):
    a = im.convert("RGBA").getchannel("A")
    hist = a.histogram()
    total = im.width * im.height
    return sum(hist[250:]) / total


def collect(root):
    found = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if not f.lower().endswith((".png", ".jpg", ".jpeg")):
                continue
            p = os.path.join(dirpath, f)
            size = os.path.getsize(p)
            if size < MIN_BYTES:
                continue
            try:
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                continue
            if w < MIN_W:
                continue
            found.append({"path": p, "w": w, "h": h, "bytes": size})
    return found


def build_still(entry, still_path):
    cands = collect(entry["tmp"])
    if not cands:
        return None

    scored = []
    for c in cands:
        try:
            with Image.open(c["path"]) as im:
                cov = alpha_coverage(im)
        except Exception:
            continue
        scored.append((c, cov))

    opaque = [(c, cov) for c, cov in scored if cov >= 0.99]
    if not opaque:
        return None
    base = max(opaque, key=lambda x: (x[0]["w"] * x[0]["h"], x[0]["bytes"]))[0]

    overlays = [(c, cov) for c, cov in scored if 0.03 <= cov <= 0.97 and c["path"] != base["path"]]
    overlays.sort(key=lambda x: (x[0]["w"] * x[0]["h"], x[0]["bytes"]), reverse=True)

    canvas = Image.open(base["path"]).convert("RGBA")
    for c, _cov in overlays[:2]:
        try:
            layer = Image.open(c["path"]).convert("RGBA")
            if layer.size != canvas.size:
                layer = layer.resize(canvas.size, Image.LANCZOS)
            canvas = Image.alpha_composite(canvas, layer)
        except Exception:
            continue

    rgb = canvas.convert("RGB")
    if max(rgb.size) > MAX_SIDE:
        scale = MAX_SIDE / max(rgb.size)
        rgb = rgb.resize((int(rgb.width * scale), int(rgb.height * scale)), Image.LANCZOS)
    rgb.save(still_path, "JPEG", quality=92, optimize=True)
    return {"w": rgb.width, "h": rgb.height, "layers": 1 + min(2, len(overlays))}


def acquire_lock():
    """防止两个实例同时跑（插件可能重复触发）"""
    try:
        if os.path.exists(LOCK):
            import time as _t
            if _t.time() - os.path.getmtime(LOCK) < 1800:
                return False
        open(LOCK, 'w', encoding='utf-8').write('1')
        return True
    except Exception:
        return True


def release_lock():
    try:
        os.remove(LOCK)
    except Exception:
        pass


def main():
    os.makedirs(OUT, exist_ok=True)
    if not acquire_lock():
        print('已有提取任务在跑，退出')
        return
    os.makedirs(TMP, exist_ok=True)
    index = {}
    if os.path.exists(META):
        try:
            index = json.load(open(META, encoding="utf-8"))
        except Exception:
            index = {}

    targets = []
    for name in os.listdir(WS):
        d = os.path.join(WS, name)
        if not os.path.isdir(d):
            continue
        pj = os.path.join(d, "project.json")
        pkg = os.path.join(d, "scene.pkg")
        if not (os.path.exists(pj) and os.path.exists(pkg)):
            continue
        try:
            meta = json.load(open(pj, encoding="utf-8"))
        except Exception:
            continue
        if str(meta.get("type", "")).lower() not in ("scene", "web"):
            continue
        targets.append({"id": name, "pkg": pkg, "title": meta.get("title", name)})

    total = len(targets)
    done = 0
    made = 0
    for i, t in enumerate(targets, 1):
        still = os.path.join(OUT, t["id"] + ".jpg")
        rec = index.get(t["id"])
        if os.path.exists(still) and rec and not rec.get("fail"):
            done += 1
            continue
        if rec and rec.get("fail") and not FORCE:
            done += 1
            continue
        tmp = os.path.join(TMP, t["id"])
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        try:
            subprocess.run(
                [REPKG, "extract", "-o", tmp, t["pkg"]],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=300,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
            info = build_still({"tmp": tmp}, still)
            if info:
                index[t["id"]] = {"w": info["w"], "h": info["h"], "layers": info["layers"], "title": t["title"]}
                made += 1
                print(f"[{i}/{total}] OK  {t['title'][:26]}  {info['w']}x{info['h']}  {info['layers']}层", flush=True)
            else:
                index[t['id']] = {'fail': True, 'title': t['title']}
                print(f"[{i}/{total}] --  {t['title'][:26]}  无合适图层，标记跳过", flush=True)
        except Exception as e:
            print(f"[{i}/{total}] !!  {t['title'][:26]}  {e}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            json.dump(index, open(META, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        done += 1

    print(f"\n完成：目标 {total}，生成 {made}，索引共 {len(index)} 条", flush=True)
    release_lock()


if __name__ == "__main__":
    main()
