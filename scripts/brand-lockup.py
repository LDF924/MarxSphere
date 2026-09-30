#!/usr/bin/env python3
"""
brand-lockup.py — 从「已合成的组合标」重排四周留白。

由来(2026-09-30): 用户第二次说 logo 的问题 ——「仓库的 logo 的图, 没截好, 四周空白太多」。
  上一轮我只改了 `brand-assets.py`(管应用图标), 没动 README 抬头的组合标, 于是它的毛病原样留着:

    · 画布 512×347, 而内容(鲸鱼+字标)只占 **211×281**, 即横向 41% / 纵向 81%
    · 左右各留 151px 空白(占宽 29%), 顶上 60px、底下 7px
    · 结果在 README 里按 width=200 渲染时, 内容只有 82px 宽 —— 这就是"缩得那么小"

  ⚠ 别再"重新合成一份": 字标是上一轮按「英文为主、中文小字在下」重排过的**有意形态**,
    鲸鱼也是从母版定位裁下来的。重新用字体去描一遍, 字体一换(stranger 的形状)
    整张图就跟母版不像了 —— 那份教训在 `brand-assets.py` 的 --bg 注释里记着。
    这里只做**裁切与重排**, 像素一个不重画。

用法:
    python scripts/brand-lockup.py <输入png> <输出png> [--fill 0.88] [--canvas 384x512]
"""
import sys, os, argparse
import numpy as np
from PIL import Image

# 母版自己的深藏青 —— 与 brand-assets.py 的 --bg 同一个道理: 取母版的, 不另挑
BG = (16, 22, 33)
# 判断"是内容"的阈值。与背景的曼哈顿距离。
# ⚠ 不能太小: 母版带一层很淡的柔光(实测最亮处 RGB 255,255,255 但周边是渐变),
#   阈值 18 时柔光被算作内容, 会撑大 bbox 反而留白。
#   也不能太大: 会把鲸身深蓝(与底色只差 ~40)当成背景切掉。18 是实测的中间值。
THRESH = 18


def content_bbox(arr, bg):
    d = np.abs(arr.astype(np.int16) - np.array(bg, dtype=np.int16)).sum(axis=2)
    m = d > THRESH
    if not m.any():
        return None
    ys, xs = np.nonzero(m)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--fill", type=float, default=0.88,
                    help="内容占画布的比例(取长边)。默认 0.88 —— 与 brand-assets.py 的 --scale 同档, "
                         "四档压测过: 0.72 四周太空, 0.95 顶到边。")
    ap.add_argument("--ratio", default="3:4", help="画布长宽比 W:H。默认 3:4 **由内容自身的长宽比推出** —— "
                                                   "这一版内容实测 211×281 (0.751), 硬套别的比例就必然在某一向留白。"
                                                   "若内容比例变了, 这个默认值也要跟着量, 别照抄。")
    ap.add_argument("--pad", type=float, default=0.04,
                    help="四周留一点呼吸位, 取内容长边的比例。默认 0.04 —— "
                         "**0 太挤**(实测底边字标几乎贴边), 而原来的 29%% 横向留白就是被投诉的那个。")
    ap.add_argument("--long", type=int, default=0,
                    help="画布长边像素上限。**0(默认)= 按内容原生尺寸定, 不缩小也不放大** —— "
                         "放大只会变糊, 缩小浪费像素。需要固定尺寸时才显式给。")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        print(f"✗ 输入不存在: {args.src}"); return 1

    im = Image.open(args.src).convert("RGBA")
    a = np.array(im)
    # 用合成到纯底上的结果判内容 —— 原图可能是透明的
    flat = Image.alpha_composite(Image.new("RGBA", im.size, BG + (255,)), im).convert("RGB")
    bb = content_bbox(np.array(flat), BG)
    if not bb:
        print("✗ 整张图都是背景色 —— 阈值或输入有问题"); return 2
    x0, y0, x1, y1 = bb
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    print(f"输入 {im.width}×{im.height}  内容 {cw}×{ch} @ ({x0},{y0})")
    print(f"  原留白: 左{x0} 右{im.width-1-x1} 上{y0} 下{im.height-1-y1}"
          f"  →  内容占宽 {100*cw/im.width:.0f}% / 占高 {100*ch/im.height:.0f}%")

    rw, rh = (int(v) for v in args.ratio.split(":"))

    def canvas_for(long_edge: int) -> tuple[int, int]:
        if rh >= rw:
            H = long_edge; W = round(H * rw / rh)
        else:
            W = long_edge; H = round(W * rh / rw)
        return W, H

    # ── 只裁不缩 ──
    # ⚠ 2026-09-30: 第一版写的是"按长边填到 fill", 跑出来两个方向都只有 55%, 自检直接报错。
    #   原因是**内容的长宽比(0.751)与画布比例(0.75)几乎相等** —— 这种情况下两个方向同时受限,
    #   填满长边就等于填满短边, 再乘 fill 系数只会把内容缩到 88%。
    #   所以: 能填满就填满(fill=1.0), 只在长宽比**不匹配**时才用 fill 留边。
    #   另外**绝不放大** —— 放大只让像素变糊, 不会真的变清晰。
    target_long = args.long or max(cw, ch)
    W, H = canvas_for(target_long)
    scale = min(W / cw, H / ch, 1.0)
    fill_eff = args.fill if abs(cw / ch - rw / rh) > 0.05 else 1.0
    scale = min(scale, 1.0) * fill_eff if fill_eff < 1.0 else scale
    nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
    if args.long == 0:
        # 画布跟着内容走: 只加一点点呼吸位 —— 这就是"去掉四周空白"
        pad = round(max(nw, nh) * args.pad)
        W, H = canvas_for(max(nw, nh) + 2 * pad)
    else:
        if nw > W or nh > H:
            print(f"  ! 指定画布 {W}×{H} 装不下内容 {nw}×{nh} —— 已改按内容定尺寸")
            pad = round(max(nw, nh) * args.pad)
            W, H = canvas_for(max(nw, nh) + 2 * pad)

    crop = im.crop((x0, y0, x1 + 1, y1 + 1))
    if (nw, nh) != (cw, ch):
        crop = crop.resize((nw, nh), Image.LANCZOS)

    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.paste(crop, ((W - nw) // 2, (H - nh) // 2), crop)

    # 输出前的自检: 重排之后内容该占多少 —— 量出来的, 不是算出来的
    out = Image.alpha_composite(Image.new("RGBA", (W, H), BG + (255,)), canvas).convert("RGB")
    ob = content_bbox(np.array(out), BG)
    ow, oh = ob[2] - ob[0] + 1, ob[3] - ob[1] + 1
    print(f"输出 {W}×{H}  内容 {ow}×{oh}  →  占宽 {100*ow/W:.0f}% / 占高 {100*oh/H:.0f}%")
    print(f"  新留白: 左{ob[0]} 右{W-1-ob[2]} 上{ob[1]} 下{H-1-ob[3]}")
    if ow / W < 0.70 and oh / H < 0.70:
        print("  ✗ 两个方向都不到 70% —— 没达到'去掉空白'的目的"); return 3
    if max(ow / W, oh / H) < 0.85:
        print(f"  ✗ 长边只填到 {100*max(ow/W, oh/H):.0f}% —— 还是太空"); return 3

    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    canvas.save(args.dst)
    print(f"✓ {args.dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
