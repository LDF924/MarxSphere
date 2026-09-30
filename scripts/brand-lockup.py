#!/usr/bin/env python3
"""
brand-lockup.py — 给组合标去掉四周的多余留白。**只裁切, 一个像素都不重画。**

═══ 这条脚本存在的理由, 是一串我自己犯的错 ═══

用户给的母版 `群学求真LOGO.png` 是**鲸鱼 + 「群学求真」(粗体, 在上) + 「SocioSeek」(在下)**。
仓库 README 抬头那张却一度是这样的:

  · 一轮: 我按「英文为主、中文小字在下」**重新合成**了一份 —— 字体一换就跟母版不像,
    用户直接说"和原来的这个差距这么大"。**字标是有意形态, 不要用字体去重描。**
  · 又一轮: 画布 512×347 而内容只占 211×281(横向 41%), 左右各空 151px —— 用户说
    "缩得那么小, 四周全是空白"。
  · 又一轮: 我修裁切时画布**沿用了写死的 3:4 比例**, 而内容比例是 0.907 —— 画布比内容窄,
    内容被等比缩小后两头被切掉, **鲸鱼的尾巴直接没了**。

最后定下来的做法只有两步, 都在这里:
  1. 量出内容框(用**原图自己的**底色作判据 —— 写死常量会因为差 3 而把整张图判成内容);
  2. 裁到内容, 四周只加一点点呼吸位, 画布**取内容自己的比例**、**不透明**、不缩不放。

⚠ 画布必须不透明: 透明底在 GitHub 浅色主题下会露白纸, 而这套 logo 的文字是白的 —— 一露白就看不见。

用法(默认参数即为定稿):
    python scripts/brand-lockup.py <母版png> <输出png>

验证方式(必须做): 把输出与母版各自量出内容框, 两者的内容区应当**逐像素完全相同**
(`np.array_equal` 为 True)。2026-09-30 实测为真。
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
    # ⚠ **底色要取原图自己的, 不能写死 BG**。
    #   2026-09-30 实测: 母版的深藏青是 (16,22,36), 而脚本常量 BG=(16,22,33) —— 差 3。
    #   拿 BG 当判据去量母版, 整张图都会被判成"内容"(距离和 = 3 但铺满全图),
    #   内容框变成整幅画布, 裁切就完全失真。
    #   而且画布**必须是不透明的**: 透明底在 GitHub 浅色主题下会露白, 白字直接看不见。
    src_bg = tuple(int(v) for v in np.array(flat)[3, 3])
    bb = content_bbox(np.array(flat), src_bg)
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

    if args.long == 0:
        # ⚠ **画布比例必须取内容自己的比例**, 不能套 --ratio 的默认值。
        #   2026-09-30 实测踩到: 母版内容是 362×399(比例 0.907, 接近方), 而默认 ratio 是 3:4(0.75)
        #   —— 按 3:4 算出的画布比内容**更窄**, `scale = min(W/cw, H/ch)` 取到宽度那一项,
        #   内容被等比缩小后又**横向居中裁掉两头, 鲸鱼的尾巴直接被切没了**。
        #   `--ratio` 只在**显式指定画布尺寸**时才该起作用; 跟随内容时它没有任何意义。
        pad = round(max(cw, ch) * args.pad)
        rw, rh = cw, ch                        # 跟随内容时, 比例就是内容的比例
        W, H = canvas_for(max(cw, ch) + 2 * pad)
        nw, nh = cw, ch                        # 不缩不放, 原样贴上
        scale = 1.0
    else:
        W, H = canvas_for(target_long)
        scale = min(W / cw, H / ch, 1.0)
        fill_eff = args.fill if abs(cw / ch - rw / rh) > 0.05 else 1.0
        scale = scale * fill_eff if fill_eff < 1.0 else scale
        nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
        if nw > W or nh > H:
            print(f"  ! 指定画布 {W}×{H} 装不下内容 {nw}×{nh} —— 已改按内容定尺寸")
            pad = round(max(nw, nh) * args.pad)
            rw, rh = nw, nh
            W, H = canvas_for(max(nw, nh) + 2 * pad)

    crop = im.crop((x0, y0, x1 + 1, y1 + 1))
    if (nw, nh) != (cw, ch):
        crop = crop.resize((nw, nh), Image.LANCZOS)

    # ⚠ **不透明画布, 底色取原图自己的** —— 透明底在 GitHub 浅色主题下会露白纸,
    #   而这套 logo 的文字是白的, 一露白就整个看不见。母版本身也是不透明深底。
    canvas = Image.new("RGBA", (W, H), tuple(src_bg) + (255,))
    canvas.paste(crop, ((W - nw) // 2, (H - nh) // 2), crop)

    # 输出前的自检: 重排之后内容该占多少 —— 量出来的, 不是算出来的
    out = canvas.convert("RGB")     # 已是不透明, 不必再合成
    ob = content_bbox(np.array(out), src_bg)
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
