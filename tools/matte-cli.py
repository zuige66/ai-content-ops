#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/matte-cli.py —— 白底泛洪抠图 + 表情图对齐

为什么要有这个：AI 生成的表情图是白底不透明的，而且每张角色大小/位置
都会差一点。直接叠在视频里，切表情的时候整只鱼会跳。

做两件事：
  1. 从四边泛洪吃掉连到画布边缘的白，角色内部的白色（围裙、头饰）保留
     —— 和 zhibo/tools/matte.py 同一套算法，那个脚本路径写死了，不能复用。
  2. 按 alpha 包围盒裁剪后，统一缩放到同一个画布、底部对齐、水平居中，
     这样三张图在模板里 `width:100%` 显示出来是同一个大小、同一个位置。

用法：
  python tools/matte-cli.py in.png out.png --ref 676x693
"""
import sys
import argparse
from collections import deque

from PIL import Image, ImageFilter

# 判「白」的阈值：三个通道都不低于 T，且互相差异不超过 S
T = 242
S = 10


def knockout(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()

    is_white = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b = px[x, y]
            if r >= T and g >= T and b >= T and max(r, g, b) - min(r, g, b) <= S:
                is_white[row + x] = 1

    bg = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if is_white[i] and not bg[i]:
            bg[i] = 1
            q.append(i)

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        i = q.popleft()
        x, y = i % w, i // w
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)

    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if bg[row + x]:
                ap[x, y] = 0

    # 边缘半透明：贴着背景的那一圈前景像素按「有多白」给 alpha，
    # 深色描边保持不透明，AI 图常见的白边几乎消失
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if bg[i]:
                continue
            near = False
            if x > 0 and bg[i - 1]:
                near = True
            elif x < w - 1 and bg[i + 1]:
                near = True
            elif y > 0 and bg[i - w]:
                near = True
            elif y < h - 1 and bg[i + w]:
                near = True
            if not near:
                continue
            r, g, b = px[x, y]
            wness = min(r, g, b) / 255.0
            if wness > 0.86:
                ap[x, y] = int(255 * max(0.0, (1.0 - wness) / 0.14) * 0.75)

    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    out = img.convert("RGBA")
    out.putalpha(alpha)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--ref", default="", help="画布尺寸 WxH，给了就统一对齐")
    ap.add_argument("--pad", type=int, default=6)
    a = ap.parse_args()

    src = Image.open(a.src)
    cut = knockout(src)
    # 🔴 最后那道 GaussianBlur 会把边缘的 0 渗成 1~3，getbbox() 认为整张
    # 画布都「不透明」，裁出来还是 1024×1024，后面按高度对齐就全错了。
    # 先把这点噪声削掉再取包围盒。
    cut.putalpha(cut.getchannel("A").point(lambda v: 0 if v < 8 else v))
    bbox = cut.getbbox()
    if not bbox:
        print("抠完是空的，检查输入图", file=sys.stderr)
        sys.exit(1)
    x0, y0, x1, y1 = bbox
    p = a.pad
    cut = cut.crop((max(0, x0 - p), max(0, y0 - p),
                    min(cut.width, x1 + p), min(cut.height, y1 + p)))
    print("抠图", src.size, "→ 角色", cut.size, file=sys.stderr)

    if a.ref:
        RW, RH = (int(v) for v in a.ref.lower().split("x"))
        # 统一到「高度等于画布高度」再水平居中 —— 三张表情图大小才一致。
        # 按高度而不是按宽度对齐：角色变的是表情，身高不该变。
        scale = RH / cut.height
        nw = max(1, round(cut.width * scale))
        if nw > RW:
            # 宽了说明这张图角色画胖了，改按宽度收敛
            scale = RW / cut.width
            nw, nh = RW, max(1, round(cut.height * scale))
        else:
            nh = RH
        cut = cut.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGBA", (RW, RH), (0, 0, 0, 0))
        canvas.paste(cut, ((RW - nw) // 2, RH - nh), cut)
        cut = canvas
        print("对齐到", (RW, RH), "角色框", (nw, nh), file=sys.stderr)

    cut.save(a.out)
    print("输出", a.out, cut.size, file=sys.stderr)


if __name__ == "__main__":
    main()
