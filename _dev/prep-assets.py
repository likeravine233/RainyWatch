# -*- coding: utf-8 -*-
# 一次性素材工序:把 2048² 原图缩到界面展示尺寸(保留透明通道,LANCZOS)
# 原图素材在仓库外(版权素材不入库),本机位置用环境变量 RW_ICON_SRC 指定,例:
#   RW_ICON_SRC="D:/某目录/新补icon" python _dev/prep-assets.py
from PIL import Image
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = Path(os.environ["RW_ICON_SRC"]) if os.environ.get("RW_ICON_SRC") else None

JOBS = [
    ("托盘菜单点star.png",   "assets/tray-star.png", 96),
    ("更新提醒补充icon.png", "assets/shuiyue2.png",  256),
    # band 两张已改由 sticker-outline.py 生成(384px + 烤入白描边),此处不再产出,防覆盖
]

if SRC is None or not SRC.is_dir():
    raise SystemExit("请先设置环境变量 RW_ICON_SRC 指向仓库外的原图素材目录(含 托盘菜单点star.png / 更新提醒补充icon.png)")

for name, rel, size in JOBS:
    im = Image.open(SRC / name).convert("RGBA")
    im = im.resize((size, size), Image.LANCZOS)
    dst = REPO / rel
    im.save(dst, optimize=True)
    print(dst.name, im.size, dst.stat().st_size // 1024, "KB")
