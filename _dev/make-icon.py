# -*- coding: utf-8 -*-
# 应用图标生成:源图(浅灰实底)→ 角点泛洪抠底 → 方形画布居中加边 → 多尺寸产物
# 产物:build/icon.ico(exe/任务栏) + assets/icon.png(窗口/通知/brand-dot) + assets/tray.png(托盘 32)
# 用法:python _dev/make-icon.py <源图路径> [仓根1] [仓根2]
import os
import sys
from collections import deque
from PIL import Image

if len(sys.argv) < 2:
    sys.exit('用法: python _dev/make-icon.py <源图路径> [仓根1] [仓根2] ...')
SRC = sys.argv[1]
ROOTS = sys.argv[2:] or [os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]
TOL = 22  # 背景色容差:大了会从伞沿缺口漏进伞内,小了留灰边

img = Image.open(SRC).convert('RGBA')
W, H = img.size
px = img.load()
bg = px[2, 2][:3]
print(f'[icon] src {W}x{H}, corner bg={bg}, alpha={px[2, 2][3]}')

def close(c, ref):
    return abs(c[0] - ref[0]) <= TOL and abs(c[1] - ref[1]) <= TOL and abs(c[2] - ref[2]) <= TOL

if px[2, 2][3] < 8:  # 人工抠好的透明底:直接用,不做泛洪
    print('[icon] source already transparent, skip flood fill')
    n = 0
else:
    seen = bytearray(W * H)
    dq = deque()
    for x0, y0 in ((0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)):
        if close(px[x0, y0], bg) and not seen[y0 * W + x0]:
            seen[y0 * W + x0] = 1
            dq.append((x0, y0))
    n = 0
    while dq:
        x, y = dq.popleft()
        px[x, y] = (0, 0, 0, 0)
        n += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not seen[ny * W + nx] and close(px[nx, ny], bg):
                seen[ny * W + nx] = 1
                dq.append((nx, ny))
    print(f'[icon] cleared {n}px ({100.0 * n / (W * H):.1f}%)')

bbox = img.getbbox()
crop = img.crop(bbox)
side = int(max(crop.size) * 1.14)  # 四周 ~7% 呼吸边,防系统圆形裁切削到伞尖
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2), crop)
preview = os.path.join(ROOTS[0], '_dev', 'out', 'icon-cutout-preview.png')  # 抠底预览(_dev/out 已 ignore),人工检查有没有漏抠/漏吃
os.makedirs(os.path.dirname(preview), exist_ok=True)
canvas.save(preview)

for root in ROOTS:
    os.makedirs(f'{root}/build', exist_ok=True)
    ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    canvas.resize(ico_sizes[0], Image.LANCZOS).save(f'{root}/build/icon.ico', sizes=ico_sizes)
    canvas.resize((512, 512), Image.LANCZOS).save(f'{root}/assets/icon.png')
    canvas.resize((32, 32), Image.LANCZOS).save(f'{root}/assets/tray.png')
    print(f'[icon] -> {root}/build/icon.ico, assets/icon.png, assets/tray.png')
