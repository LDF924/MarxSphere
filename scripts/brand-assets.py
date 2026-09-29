#!/usr/bin/env python3
"""
brand-assets.py — 从一张母版 logo 生成全套品牌资产。

由来(2026-09-29): 「群学求真 SocioSeek」换标时, 这一套流程是**在对话里手写 python - <<PY**
  一段段试出来的 —— 抠图失败一次、裁切切进文字一次、16px 糊掉两次。那些试错的价值不在
  结论(深底 #101621 + scale .88), 而在**每一步该量什么**, 所以固化成脚本:

    · 抠图用「与背景色的距离」做软边, 不用泛洪 —— 泛洪会把鲸鱼内部的暗部一起吃掉
      (实测: 白底上鲸鱼肚子被啃掉一块, 边缘全是噪点)
    · 裁切**必须靠墨迹剖面找断档**, 不能按图高比例硬切 —— 按 60% 切过一次,
      切进了中文字的顶部
    · alpha 要做**收紧**(阈值 60 以下归零), 否则白底上留一圈灰晕
    · 底与缩放系数要**压测选**, 不靠感觉 —— scale 0.72/0.80/0.88/0.95 四档比过才定 0.88;
      底色**取母版自己的**深藏青, 我一度改成白底, 品牌图立刻与母版不像了

用法:
    python scripts/brand-assets.py <母版png> [--out build/brand] [--yes]

输入要求(不满足会明确报错, 不猜):
    · 正方形或任意比例均可, 但鲸鱼/标记必须**位于图片上半部**、**下方是文字**(或有足够空白)
    · 背景必须**接近纯色**(四角色差 < 30); 复杂背景会拒绝处理
    · 无第三方水印 —— 脚本会检测右下角异常亮区并提示, 但**不保证**能抹干净
"""
import sys, os, argparse
from PIL import Image, ImageDraw
import numpy as np

BOLD = "\033[1m"; DIM = "\033[2m"; RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; RST = "\033[0m"
def say(msg, kind="info"):
    c = {"info": "", "ok": GRN, "warn": YEL, "err": RED}.get(kind, "")
    print(f"{c}{msg}{RST}")


def measure_bg(arr):
    """四角 + 顶边中位色, 用来判断背景是否均匀, 并给出抠图基准色"""
    H, W, _ = arr.shape
    corners = np.stack([arr[5, 5], arr[5, W-6], arr[H-6, 5], arr[H-6, W-6]]).astype(float)
    spread = float(np.abs(corners - corners.mean(axis=0)).sum(axis=1).max())
    top = np.array([np.median(arr[0:max(8, H//40), :, c]) for c in range(3)])
    return top, spread


def remove_watermark(arr):
    """右下角若存在明显亮于背景的水印像素, 用该区中位色填掉。返回处理后的数组与被抹像素数。"""
    H, W, _ = arr.shape
    y0, x0 = int(H*0.88), int(W*0.72)
    patch = arr[y0:H, x0:W]
    med = np.median(patch.reshape(-1, 3), axis=0)
    lum = patch.mean(axis=2)
    mask = lum > med.mean() + 25
    n = int(mask.sum())
    if n:
        patch[mask] = med
    return arr, n


def make_alpha(arr, bg):
    """软边 alpha: 与背景色的曼哈顿距离, LO..HI 之间线性羽化"""
    d = np.abs(arr.astype(np.int16) - bg.astype(np.int16)).sum(axis=2).astype(np.float32)
    LO, HI = 30.0, 90.0
    return np.clip((d - LO) / (HI - LO), 0, 1)


def tight_above_text(rgba):
    """靠墨迹剖面找「标记」与「下方文字」之间的空白带, 只取带宽以上的部分。"""
    a = np.array(rgba)[:, :, 3]
    rows = (a > 40).sum(axis=1)
    H = len(rows)
    # 从下往上找第一条足够长的空白带 —— 那下面就是文字区
    run, gaps = 0, []
    for y in range(H - 1, -1, -1):
        if rows[y] == 0:
            run += 1
        else:
            if run >= 12:
                gaps.append((y + 1, y + run))     # 空白带的起点与终点
            run = 0
    if not gaps:
        say("  ! 没找到「标记 | 文字」之间的空白带 —— 若整图只有标记本身, 这属正常", "warn")
        return rgba
    top_of_lowest = max(g[1] for g in gaps)           # 最下方那条空白带的终点
    # 取最下方空白带 *上面* 的内容
    cut = gaps[-1][0] if gaps[-1][0] > H * 0.3 else rgba.height
    out = rgba.crop((0, 0, rgba.width, cut))
    say(f"  空白带 {gaps[-1]} → 在 y={cut} 处裁断")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="母版 logo PNG")
    ap.add_argument("--out", default="build/brand", help="输出目录")
    ap.add_argument("--scale", type=float, default=0.88,
                    help="标记在图标底内的占比。0.72/0.80/0.88/0.95 四档压测过: "
                         "0.72 四周太空, 0.95 顶到边, **0.88 填满且留有边距** —— 别凭感觉调。")
    ap.add_argument("--bg", default="16,22,33",
                    help="图标底色 R,G,B。默认取母版自己的深藏青 #101621 —— "
                         "**别改成白底**: 2026-09-29 我改成白底, 结果品牌图与母版完全不像"
                         "(鲸身深蓝在白底上显得惨白), 用户一眼看出不对。")
    ap.add_argument("--radius", type=float, default=0.20, help="圆角比例")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        say(f"母版不存在: {args.src}", "err"); return 1
    os.makedirs(args.out, exist_ok=True)

    src = Image.open(args.src).convert("RGB")
    arr = np.array(src).astype(np.int16)
    H, W, _ = arr.shape
    say(f"{BOLD}母版{RST} {W}×{H}")

    bg, spread = measure_bg(arr)
    say(f"  背景色 {bg.astype(int)}  四角色差 {spread:.0f}")
    if spread > 30:
        say(f"  ✗ 背景不均匀(色差 {spread:.0f} > 30) —— 抠图会失败。请提供纯色背景的母版。", "err")
        return 2

    arr, wm = remove_watermark(arr)
    if wm:
        say(f"  抹掉右下角水印像素 {wm} 个", "warn")

    arr8 = arr.clip(0, 255).astype(np.uint8)
    alpha = make_alpha(arr8, bg)
    say(f"  前景占比 {100*alpha.mean():.1f}%  (双峰良好时约 5-20%)")
    if alpha.mean() > 0.6:
        say("  ✗ 前景占比过高 —— 背景可能被当成前景, 抠图不可信", "err")
        return 3

    rgba = Image.fromarray(np.dstack([arr8, (alpha*255).astype(np.uint8)]), "RGBA")
    # ── alpha 收紧 **必须在裁切之前** ──
    # ⚠ 2026-09-29 实测踩到: 第一版先 getbbox() 裁切、再收紧 alpha。而收紧会把标记周围
    #   那一圈柔光(alpha 60 以下)直接归零 —— 内容因此**缩小**了, 但画布还是按收紧前的
    #   bbox 定的, 于是四周留下大片空白。表现: mark 是 1440×789, 鲸鱼实际只占 749×482
    #   (52%×61%), 图标里 logo 显得特别小。**裁切要放在收紧之后**, 顺序反了就是白边。
    raw = tight_above_text(rgba)
    a = np.array(raw); al = a[:, :, 3].astype(np.float32)
    a[:, :, 3] = np.clip((al - 60) * (255 / 195), 0, 255).astype(np.uint8)
    mark = Image.fromarray(a, "RGBA")

    bb = mark.split()[-1].getbbox()
    if not bb:
        say("  ✗ 收紧 alpha 后没有内容了 —— 阈值可能太高", "err"); return 4
    before = raw.size
    mark = mark.crop(bb)
    say(f"  ✓ 标记 {mark.width}×{mark.height} (长宽比 {mark.width/mark.height:.2f})"
        f"{'  ← 收紧后重裁, 收掉 ' + str(before[0] - mark.width) + 'x' + str(before[1] - mark.height) + ' 空白' if before != mark.size else ''}")
    mark.save(f"{args.out}/mark-transparent.png")

    bgrgb = tuple(int(x) for x in args.bg.split(",")) + (255,)

    def icon(size):
        s = size * 4
        base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(base).rounded_rectangle([0, 0, s-1, s-1],
                                               radius=int(s*args.radius), fill=bgrgb)
        tw = int(s * args.scale)
        w = mark.resize((tw, int(tw*mark.height/mark.width)), Image.LANCZOS)
        base.paste(w, ((s-w.width)//2, (s-w.height)//2), w)
        return base.resize((size, size), Image.LANCZOS)

    for s in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        icon(s).save(f"{args.out}/icon-{s}.png")
    icon(256).save(f"{args.out}/icon.ico",
                   sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    icon(1024).save(f"{args.out}/icon-1024-mac.png")

    # 16px 压测图 —— 每次都必须看, 上次就是没看才翻车
    sizes, Z, PAD, GAP = [16, 24, 32, 48, 128], {16:6,24:4,32:3,48:2,128:1}, 16, 20
    WV = PAD*2 + sum(s*Z[s] for s in sizes) + GAP*(len(sizes)-1)
    cv = Image.new("RGB", (WV, PAD*2 + 130), (13, 19, 26))
    x = PAD
    for s in sizes:
        ic = Image.open(f"{args.out}/icon-{s}.png").convert("RGBA")
        z = ic.resize((s*Z[s], s*Z[s]), Image.NEAREST)
        cv.paste(z, (x, PAD), z); x += s*Z[s] + GAP
    cv.save(f"{args.out}/_scale-check.png")

    say(f"{BOLD}✓ 完成{RST} → {args.out}/", "ok")
    say(f"  {DIM}16/24/32/48/64/128/256/512/1024 PNG · icon.ico · icon-1024-mac.png{RST}")
    say(f"  {YEL}⚠ macOS 的 .icns 需在 macOS 上用 iconutil 生成 —— Linux/Windows 上 PIL 写不了。{RST}")
    say(f"  {YEL}⚠ 先看 _scale-check.png 确认 16px 能认, 再装到 build/。{RST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
