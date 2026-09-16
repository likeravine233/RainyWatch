# -*- coding: utf-8 -*-
# 底片带两角贴纸:高分辨率重切 + 烤入白色介裁描边(die-cut sticker)
# 描边烘焙进 PNG 而非用 CSS drop-shadow 叠加:一次合成,任何缩放都锐利,无逐帧滤镜开销
# 原图素材在仓库外(版权素材不入库),本机位置用环境变量 RW_ICON_SRC 指定,例:
#   RW_ICON_SRC="D:/某目录/新补icon" python _dev/sticker-outline.py
from PIL import Image, ImageFilter
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = Path(os.environ["RW_ICON_SRC"]) if os.environ.get("RW_ICON_SRC") else None

CANVAS = 384      # 输出画布:192px 显示位 ×2 DPR 余量
ART = 336         # 原画缩放尺寸:四周留 24px 描边生长空间
GROW = 11         # 描边厚度(画布像素):192 显示下约 5.5px

JOBS = [
    ("截图集左上角.png", "docs/band-tl.png"),
    ("截图集右下角.png", "docs/band-br.png"),
]

if SRC is None or not SRC.is_dir():
    raise SystemExit("请先设置环境变量 RW_ICON_SRC 指向仓库外的原图素材目录(含 截图集左上角.png / 截图集右下角.png)")

for name, rel in JOBS:
    im = Image.open(SRC / name).convert("RGBA").resize((ART, ART), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS - ART) // 2, (CANVAS - ART) // 2))
    ring = canvas.getchannel("A").filter(ImageFilter.MaxFilter(GROW * 2 + 1))
    white = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 255))
    white.putalpha(ring)
    out = Image.alpha_composite(white, canvas)
    dst = REPO / rel
    out.save(dst, optimize=True)
    print(os.path.basename(dst), out.size, dst.stat().st_size // 1024, "KB")
