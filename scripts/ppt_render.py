# ppt_render.py — PPT 生成工作台的 Python 侧(pptx 合成 / 配图生成 / 批注重绘)
#
# 由来: 旧项目 AItoolman 的 M9(全项目最大模块, 111 个函数)把"大纲→脚本→配图→导出"
#   全做在 Python 侧, 用的是 python-pptx 与图片合成。本项目此前只有
#   `paper-outline-service.exportOutlinePptx`(封面+每章一页), 没有独立的演示稿工作台。
#
# 契约(与本仓 scripts/*.py 一致 —— 入参走 **stdin JSON**, 产物写文件, 结果走 **stdout JSON**):
#   入: { "op": "probe" | "compose" | "image", ... }
#   出: { "ok": bool, "error"?: str, ... } —— 永远只往 stdout 打这一行 JSON
#
# ⚠ 为什么入参走 stdin 不走 argv: 本仓有明确教训 —— cmd 会把带 `=` 的参数吞掉,
#   而脚本内容/中文标题里有的是 `=`、空格、引号、换行。argv 传内容迟早会静默丢字。
#
# ⚠ 为什么 stdout 必须干净: 调用方(ppt-render-service)只认 stdout 那一行 JSON。
#   `print` 任何调试信息都会把 JSON 切碎 → 表现为"Python 执行无结果", 极难定位。
#
# 三件事:
#   ① compose  —— 页面数组 → .pptx。两种模式: editable(文本框+图片, 可编辑) /
#      image(每页先画成 png 再整页贴, 不可编辑 —— 防字体/版式在别人机器上跑版)
#   ② image    —— 生图降级链的**本地那一环**: 拿不到外部生图服务时用 PIL 画
#      纯色/渐变背景与示意图, 以及把批注区域重绘出来。调用方必须据实标 `placeholder`
#   ③ probe    —— 依赖自检(装了哪些库/有没有中文字体), 让上层能提前说清"缺什么"
import sys
import os
import json
import re

IN = json.loads(sys.stdin.read() or "{}")

# ── 幻灯片尺寸: 16:9 (与 paper-outline-service 的导出同一档, 免得同一份稿子两处不一样宽)
SLIDE_W = 13.333
SLIDE_H = 7.5

_DEFAULT_THEME = {
    "bg": "#FFFFFF",
    "band": "#1A3A6B",          # 封面/章节/结束页的底色
    "bandText": "#FFFFFF",
    "title": "#1A3A6B",
    "body": "#2B2B2B",
    "accent": "#C8102E",
    "footer": "#8A8F98",
    "titleFont": "微软雅黑",
    "bodyFont": "微软雅黑",
    "latinFont": "Arial",
}

# CJK 判定: 折行与溢出估算都要用(汉字逐字可断, 拉丁词整词不拆)
_CJK_RE = re.compile(r"[⺀-鿿＀-￯　-〿]")

_THEME_COLOR_KEYS = ("bg", "band", "bandText", "title", "body", "accent", "footer")


def _die(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:400]}, ensure_ascii=False))
    sys.exit(0)


def _ok(**kw):
    kw["ok"] = True
    print(json.dumps(kw, ensure_ascii=False))


def sanitize_text(s):
    """
    去掉 XML 1.0 **不允许**的控制字符。

    为什么必须有: `ppt_jobs.title` 这类字段来自用户输入/LLM 输出, 里面混一个
    垂直制表符(XML 非法)时 lxml 会直接抛 ValueError —— 表现出来是"导出失败",
    而用户看到的标题里根本看不出那个字符。文本层面清掉比冒泡上去好。
    """
    s = str(s if s is not None else "")
    s = s.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    # 允许 \n(段落分隔在下面处理), 其余 C0/C1 控制字符一律清掉
    return re.sub(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]", "", s)


def parse_color(v, fallback):
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(v or "").strip())
    if not m:
        m2 = re.match(r"^#?([0-9a-fA-F]{3})$", str(v or "").strip())
        if m2:
            h = m2.group(1)
            return tuple(int(c * 2, 16) for c in h)
        return fallback
    h = m.group(1)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def theme_of(raw):
    """
    用户/参考图给的 theme 覆盖值 → 完整主题。

    ⚠ 颜色**一律在出口处归一成 RGB 三元组**。踩过: 先写的是"raw 里有这个键才转换",
      于是只传一个 `{"band": ...}` 时其余键仍是缺省里的**字符串** `"#FFFFFF"`,
      到 `RGBColor(*"#FFFFFF")` 就把字符串展开成 7 个参数 → 报
      "takes 4 positional arguments but 8 were given" —— 报错点在用色的地方,
      根因却在解析的地方。
    """
    t = dict(_DEFAULT_THEME)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in ("bg", "band", "bandText", "title", "body", "accent", "footer"):
                t[k] = parse_color(v, parse_color(_DEFAULT_THEME[k], (0, 0, 0)))
            elif k in ("titleFont", "bodyFont", "latinFont"):
                t[k] = str(v or t[k])
    # 出口归一: 无论走哪条分支, 六个颜色键都必须是三元组(缺省值是 `#RRGGBB` 字符串)
    for k in _THEME_COLOR_KEYS:
        t[k] = parse_color(t[k], parse_color(_DEFAULT_THEME[k], (0, 0, 0)))
    return t


# ─────────────────────────── op: probe ───────────────────────────
def op_probe():
    out = {"pptx": False, "pil": False, "numpy": False, "fonts": []}
    try:
        import pptx  # noqa: F401
        out["pptx"] = True
        out["pptxVersion"] = getattr(__import__("pptx"), "__version__", "")
    except Exception as e:
        out["pptxError"] = str(e)[:160]
    try:
        import PIL  # noqa: F401
        out["pil"] = True
        out["pilVersion"] = getattr(PIL, "__version__", "")
    except Exception as e:
        out["pilError"] = str(e)[:160]
    try:
        import numpy  # noqa: F401
        out["numpy"] = True
    except Exception:
        pass
    out["fonts"] = [p for p, _ in font_candidates()]
    out["python"] = sys.version.split()[0]
    # 缺省主题由 Python 侧给出 —— 免得 TS 再抄一份色值, 两边迟早不一致
    t = theme_of(None)
    out["theme"] = {k: "#%02X%02X%02X" % t[k] for k in _THEME_COLOR_KEYS}
    _ok(**out)


# ─────────────────────────── 字体 ───────────────────────────
_FONT_CACHE = {}


def font_candidates():
    """
    中文字体候选(路径, 显示名)。**Windows 优先, 但不止 Windows** ——
    缺字体会让中文变成一串方框, 而"方框"在导出成功的返回值里看不出来。
    """
    win = os.environ.get("WINDIR", r"C:\Windows")
    cands = [
        (os.path.join(win, "Fonts", "msyhbd.ttc"), "微软雅黑 Bold"),
        (os.path.join(win, "Fonts", "msyh.ttc"), "微软雅黑"),
        (os.path.join(win, "Fonts", "simhei.ttf"), "黑体"),
        (os.path.join(win, "Fonts", "simsun.ttc"), "宋体"),
        (os.path.join(win, "Fonts", "Deng.ttf"), "等线"),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK"),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "文泉驿正黑"),
        ("/System/Library/Fonts/PingFang.ttc", "PingFang"),
    ]
    out = []
    for p, n in cands:
        try:
            if os.path.isfile(p):
                out.append((p, n))
        except OSError:
            continue
    return out


def load_font(size, bold=False):
    from PIL import ImageFont
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    cands = font_candidates()
    if bold:
        bold_c = [c for c in cands if "Bold" in c[1]]
        cands = bold_c + cands
    for path, _ in cands:
        try:
            # .ttc 需要 index; PIL 默认 0 = 第一个面
            _FONT_CACHE[key] = ImageFont.truetype(path, size)
            return _FONT_CACHE[key]
        except Exception:
            continue
    try:
        _FONT_CACHE[key] = ImageFont.load_default(size=size)
    except Exception:
        _FONT_CACHE[key] = ImageFont.load_default()
    return _FONT_CACHE[key]


def text_w(draw, s, font):
    try:
        return float(draw.textlength(s, font=font))
    except Exception:
        return float(len(s)) * 0.5 * font.size


def wrap_cjk(draw, text, font, max_w):
    """
    中英混排折行。

    由来: PIL 没有折行, 而 `textwrap` 按**字符数**折 —— 中文一个字占两格宽,
    "每行 20 个字符"对中文是 20 个全角(超宽), 对英文是 20 个半角(嫌短)。
    这里按**实际像素宽**折: 拉丁词尽量整词不拆, 汉字逐字可断(与中文排版一致)。
    """
    if not text:
        return []
    lines, cur = [], ""
    last_space = -1
    for ch in text:
        trial = cur + ch
        if text_w(draw, trial, font) <= max_w or not cur:
            cur = trial
            if ch == " ":
                last_space = len(cur) - 1
            continue
        # 放不下了: 若这一行含空格且最后一个空格靠后 → 在空格处断(不劈开英文单词)
        if last_space > len(cur) * 0.6 and not _CJK_RE.search(cur[last_space:last_space + 2] or ""):
            lines.append(cur[:last_space].rstrip())
            cur = cur[last_space + 1:] + ch
        else:
            lines.append(cur.rstrip())
            cur = ch
        last_space = cur.rfind(" ")
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def draw_text_block(draw, text, font, xy, max_w, fill, line_gap=1.35, max_lines=None):
    """在 (x, y) 处画一段折行文本, 返回结束后的 y"""
    x, y = xy
    lines = wrap_cjk(draw, text, font, max_w)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
    asc, desc = font.getmetrics() if hasattr(font, "getmetrics") else (font.size, 0)
    step = (asc + desc) * line_gap
    for ln in lines:
        draw.text((x, y), ln, font=font, fill=fill)
        y += step
    return y


# ─────────────────────────── op: image ───────────────────────────
def _bg_image(size, t, gradient=True, page_no=None):
    from PIL import Image, ImageDraw
    w, h = size
    img = Image.new("RGB", (w, h), t["band"])
    if gradient:
        d = ImageDraw.Draw(img)
        # 竖向渐变: 从 band 到更深一档。逐行画 —— 1080 行, 几毫秒
        base = t["band"]
        deep = tuple(max(0, int(c * 0.55)) for c in base)
        for y in range(h):
            k = y / max(1, h - 1)
            d.line([(0, y), (w, y)], fill=tuple(int(base[i] + (deep[i] - base[i]) * k) for i in range(3)))
    return img


def _cover_crop_pil(img, size):
    """等比铺满 + 居中裁剪(cover)"""
    from PIL import Image
    tw, th = size
    sw, sh = img.size
    if sw <= 0 or sh <= 0:
        return img
    k = max(tw / sw, th / sh)
    nw, nh = max(1, int(sw * k + 0.5)), max(1, int(sh * k + 0.5))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - tw) // 2, (nh - th) // 2
    return img.crop((left, top, left + tw, top + th))


def op_image():
    from PIL import Image, ImageDraw
    kind = str(IN.get("kind") or "backdrop")
    t = theme_of(IN.get("theme"))
    out_path = str(IN.get("out") or "")
    if not out_path:
        _die("image op 缺 out")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    W, H = int(IN.get("width") or 1280), int(IN.get("height") or 720)
    title = sanitize_text(IN.get("title"))
    bullets = [sanitize_text(b) for b in (IN.get("bullets") or []) if str(b).strip()]
    page_no = IN.get("pageNo")

    if kind == "backdrop":
        img = _bg_image((W, H), t, gradient=bool(IN.get("gradient", True)))
        d = ImageDraw.Draw(img)
        f = load_font(int(H * 0.075), bold=True)
        y = draw_text_block(d, title, f, (int(W * 0.08), int(H * 0.30)), int(W * 0.84), t["bandText"], max_lines=3)
        if bullets:
            fb = load_font(int(H * 0.042))
            y += int(H * 0.03)
            for b in bullets[:3]:
                d.ellipse([int(W * 0.085), y + int(H * 0.018), int(W * 0.085) + 8, y + int(H * 0.018) + 8], fill=t["accent"])
                y = draw_text_block(d, b, fb, (int(W * 0.11), y), int(W * 0.80), t["bandText"], max_lines=2)

    elif kind == "diagram":
        # 示意图: 标题 + 要点分块。这是**降级路径**, 不是"AI 画的图" ——
        #   上层据实标 imageSource=placeholder。做的是"有版面感的示意图", 不假装是插画。
        img = Image.new("RGB", (W, H), t["bg"])
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, int(H * 0.14)], fill=t["band"])
        f = load_font(int(H * 0.062), bold=True)
        d.text((int(W * 0.05), int(H * 0.032)), title[:28], font=f, fill=t["bandText"])
        n = max(1, len(bullets))
        top, bot = int(H * 0.19), int(H * 0.92)
        gap = int(H * 0.02)
        bh = max(24, (bot - top - gap * (n - 1)) // n)
        fb = load_font(int(min(H * 0.045, bh * 0.42)))
        for i, b in enumerate(bullets):
            y0 = top + i * (bh + gap)
            d.rounded_rectangle([int(W * 0.05), y0, int(W * 0.95), y0 + bh], radius=8,
                                fill=(245, 247, 250), outline=t["band"], width=2)
            d.rectangle([int(W * 0.05), y0, int(W * 0.05) + 6, y0 + bh], fill=t["accent"])
            draw_text_block(d, b, fb, (int(W * 0.085), y0 + int(bh * 0.22)), int(W * 0.83), t["body"], max_lines=2)
        if isinstance(page_no, int):
            fp = load_font(int(H * 0.030))
            d.text((int(W * 0.94), int(H * 0.955)), str(page_no), font=fp, fill=t["footer"])

    elif kind == "slide":
        # 整页位图 —— **不可编辑导出**的每一页。
        #   与 editable 导出共用同一套版面规则(标题带/正文列/右侧图/背景图),
        #   差别只在"渲染成像素"而不是"生成形状": 这样在别人的机器上打开时,
        #   字体不会回落、版式不会重排。代价是文字不能再改(这正是"不可编辑"的含义)。
        img = Image.new("RGB", (W, H), t["bg"])
        d = ImageDraw.Draw(img)
        layout = str(IN.get("imageLayout") or "none")
        base_rel = str(IN.get("baseImage") or "")
        band_slide = str(IN.get("pageKind") or "content") in ("cover", "section", "end")
        has_base = bool(base_rel) and os.path.isfile(base_rel)
        if has_base:
            bgimg = Image.open(base_rel).convert("RGB")
            img = _cover_crop_pil(bgimg, (W, H))
            # 压一层半透明底: 背景图上直接写字会花(与 pptx 侧的 _scrim 同一考虑)。
            #   封面/章节页压的是**主色**而不是底色 —— 压白底再写白字直接看不见。
            ov = Image.new("RGB", (W, H), t["band"] if band_slide else t["bg"])
            img = Image.blend(img, ov, 0.55 if band_slide else 0.72)
            d = ImageDraw.Draw(img)
        elif band_slide:
            img = _bg_image((W, H), t, gradient=True)
            d = ImageDraw.Draw(img)

        if band_slide:
            f = load_font(int(H * 0.085), bold=True)
            draw_text_block(d, title, f, (int(W * 0.09), int(H * 0.36)), int(W * 0.82),
                            t["bandText"], max_lines=3)
        else:
            # 顶部标题带
            d.rectangle([0, 0, W, int(H * 0.155)], fill=t["band"])
            f = load_font(int(H * 0.062), bold=True)
            d.text((int(W * 0.065), int(H * 0.045)), title[:30], font=f, fill=t["bandText"])
            col_w = int(W * 0.52) if (has_base and layout == "right") else int(W * 0.87)
            fb = load_font(int(H * 0.043))
            y = int(H * 0.23)
            for b in bullets:
                r = int(H * 0.011)
                d.ellipse([int(W * 0.07), y + int(H * 0.014), int(W * 0.07) + 2 * r, y + int(H * 0.014) + 2 * r],
                          fill=t["accent"])
                y = draw_text_block(d, b, fb, (int(W * 0.095), y), col_w - int(W * 0.05), t["body"],
                                    line_gap=1.25, max_lines=2) + int(H * 0.022)
                if y > int(H * 0.90):
                    break
            if has_base and layout == "right":
                art = Image.open(base_rel).convert("RGB")
                box = (int(W * 0.60), int(H * 0.24), int(W * 0.95), int(H * 0.85))
                bw, bh = box[2] - box[0], box[3] - box[1]
                aw, ah = art.size
                k = min(bw / max(1, aw), bh / max(1, ah))
                art = art.resize((max(1, int(aw * k)), max(1, int(ah * k))), Image.LANCZOS)
                img.paste(art, (box[0] + (bw - art.size[0]) // 2, box[1] + (bh - art.size[1]) // 2))
                d = ImageDraw.Draw(img)
        if isinstance(page_no, int) and not band_slide:
            fp = load_font(int(H * 0.028))
            d.text((int(W * 0.93), int(H * 0.955)), str(page_no), font=fp, fill=t["footer"])

    elif kind == "annotate":
        # 批注重绘(**局部**): 只动用户框出来的区域, 其余像素原样保留。
        #   没有真生图/修补服务时, 局部重绘只能是"按批注指令重画这一块" ——
        #   所以这里画的是带批注文字的补丁 + 一圈侧重边框, 并在 mask.png 里
        #   留下机器可用的掩膜(将来接上 inpaint 服务时, 掩膜就是它的输入)。
        #   `prompt` 原样回传, 让上层把"想要什么"记进版本记录, 而不是丢在内存里。
        base_rel = str(IN.get("baseImage") or "")
        mask_path = str(IN.get("maskOut") or (os.path.splitext(out_path)[0] + "-mask.png"))
        if base_rel and os.path.isfile(base_rel):
            img = Image.open(base_rel).convert("RGB")
            if img.size != (W, H):
                img = _cover_crop_pil(img, (W, H))
        else:
            img = _bg_image((W, H), t, gradient=True)
        d = ImageDraw.Draw(img)
        mask = Image.new("L", (W, H), 0)
        md = ImageDraw.Draw(mask)
        rects = IN.get("rects") or []
        drawn = 0
        for r in rects:
            # 归一化坐标(0-1): 前端在任意缩放比例的预览上框选都传得进来,
            #   写死像素坐标的话换个预览宽度就画到别处去了
            x = int(float(r.get("x", 0)) * W)
            y = int(float(r.get("y", 0)) * H)
            w = int(float(r.get("w", 0)) * W)
            h = int(float(r.get("h", 0)) * H)
            if w < 4 or h < 4:
                continue
            x2, y2 = min(W, x + w), min(H, y + h)
            md.rectangle([x, y, x2, y2], fill=255)
            patch = Image.new("RGB", (max(1, x2 - x), max(1, y2 - y)), (255, 255, 255))
            img.paste(patch, (x, y))
            d.rectangle([x, y, x2, y2], outline=t["accent"], width=3)
            note = sanitize_text(r.get("label") or r.get("note") or "")
            if note:
                fs = load_font(max(14, int(min(x2 - x, y2 - y) * 0.18)))
                draw_text_block(d, note, fs, (x + 10, y + 8), max(20, x2 - x - 20), t["body"])
            drawn += 1
        if drawn == 0:
            _die("annotate 至少需要一个有效矩形(w/h > 0)")
        mask.save(mask_path)
    else:
        _die("未知 image kind: %s" % kind)

    img.save(out_path)
    _ok(path=out_path, width=img.size[0], height=img.size[1],
        mask=(mask_path if kind == "annotate" else ""))


# ─────────────────────────── op: compose ───────────────────────────
def _set_run_font(run, size_pt, bold, color_hex, theme):
    """
    给一个 run 设字体。

    ⚠ **必须显式写 ea(东亚字体)** —— python-pptx 的 `font.name` 只设 `a:latin`,
      中文会落到主题的东亚字体上(模板默认常常是宋体/等线, 与用户选的"微软雅黑"不同)。
      表现出来是"设置了的字号生效了, 字体没生效", 在返回里看不出来。
    """
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    from pptx.oxml.ns import qn
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls
    f = run.font
    f.size = Pt(size_pt)
    f.bold = bool(bold)
    f.name = theme["latinFont"]
    f.color.rgb = RGBColor(*color_hex)
    rPr = run._r.get_or_add_rPr()
    for tag, tf in (("a:ea", theme["bodyFont"]), ("a:cs", theme["latinFont"])):
        el = rPr.find(qn(tag))
        if el is None:
            el = parse_xml('<%s %s typeface="%s"/>' % (tag, nsdecls("a"), tf))
            rPr.append(el)
        else:
            el.set("typeface", tf)


def _txbox(slide, x, y, w, h, wrap=True):
    from pptx.util import Inches
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = wrap
    return box, tf


def _fill_lines(tf, lines, theme):
    """lines: [(text, size_pt, bold, color, indent_level, space_after_pt)]"""
    from pptx.util import Pt
    first = True
    for (text, size, bold, color, level, sp) in lines:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.level = min(4, max(0, int(level)))
        p.space_after = Pt(sp)
        run = p.add_run()
        run.text = text
        _set_run_font(run, size, bold, color, theme)
        if level > 0:
            # 项目符号: 二级用 "·" 兜底 —— 模板里的自动项目符号在空白版式下不出现,
            #   手写一个比"要点变成没符号的裸行"更清楚
            run.text = "· " + text
    return tf


def _cover_crop_picture(pic, box_w_in, box_h_in):
    """
    等比铺满 + 居中裁剪(**用 python-pptx 自带裁剪, 不引入 PIL**)。

    为什么不用 PIL 预处理: compose 的依赖应当只有 python-pptx —— 出图那一步
    (PIL/matplotlib)可能没装, 而"把已经生成好的图贴进 pptx"不该因此失败。
    """
    from pptx.util import Inches
    iw, ih = pic.image.size
    if iw <= 0 or ih <= 0:
        return
    k = max(box_w_in / iw, box_h_in / ih)
    pic.width = Inches(iw * k)
    pic.height = Inches(ih * k)
    # 裁掉溢出的部分: crop_left/right/top/bottom 是 0-1 的比例
    ox = (iw * k - box_w_in) / (iw * k)
    oy = (ih * k - box_h_in) / (ih * k)
    pic.crop_left = ox / 2
    pic.crop_right = ox / 2
    pic.crop_top = oy / 2
    pic.crop_bottom = oy / 2
    pic.left = Inches(0)
    pic.top = Inches(0)


def _contain_picture(pic, x_in, y_in, box_w_in, box_h_in):
    """等比缩放放进框里(不裁剪), 在框内居中"""
    from pptx.util import Inches
    iw, ih = pic.image.size
    if iw <= 0 or ih <= 0:
        return
    k = min(box_w_in / iw, box_h_in / ih)
    w, h = iw * k, ih * k
    pic.width = Inches(w)
    pic.height = Inches(h)
    pic.left = Inches(x_in + (box_w_in - w) / 2)
    pic.top = Inches(y_in + (box_h_in - h) / 2)


def _scrim(slide, x_in, y_in, w_in, h_in, color_hex, alpha_pct):
    """
    半透明色块(背景图上压一层, 保证字读得清)。

    python-pptx 没有透明度 API —— 得往 solidFill 的 srgbClr 里塞一个 <a:alpha>。
    这是"把图片当背景"那一刻的必需项: 不压这一层, 图一花正文就废了。
    """
    from pptx.util import Inches
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.oxml.ns import qn, nsdecls
    from pptx.oxml import parse_xml
    sh = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x_in), Inches(y_in), Inches(w_in), Inches(h_in))
    sh.fill.solid()
    sh.fill.fore_color.rgb = RGBColor(*color_hex)
    sh.line.fill.background()
    sh.shadow.inherit = False
    solid = sh.fill._xPr.find(qn("a:solidFill"))
    if solid is not None:
        srgb = solid.find(qn("a:srgbClr"))
        if srgb is not None:
            srgb.append(parse_xml('<a:alpha %s val="%d"/>' % (nsdecls("a"), int(alpha_pct * 1000))))
    return sh


def _estimate_overflow(page, theme):
    """
    版面溢出估算 —— **用真实折行量出来**, 不是按字符数猜。

    由来(实测): 先写的版本按"每行放得下多少个 em"折算, 对一份 12 条、
      每条 30 字的中文页面算出 overBy < 0(判成"不溢出")—— 而它显然溢出。
      真正的原因是估算的分行粒度与渲染不一致(估的是整数行数, 渲染会因标点与
      西文词整词不断而多出好几行)。现在直接复用 `wrap_cjk` 折一遍, 数行数。

    单位换算: 投影尺寸 1600px = 13.333in ⇒ 120 px/in。
      字号 pt → 像素 px = pt * 120/72; 行高 = 字号 * 1.35 (与 `_fill_lines` 的
      space_after 同一量级), 换回英寸 = px/120。
    """
    from PIL import Image, ImageDraw
    kind = str(page.get("kind") or "content")
    if kind in ("cover", "section", "end"):
        return -99.0   # 这几页是整页大字版式, 不按正文列算
    size_pt = float(page.get("bodySize") or 18)
    px_per_in = 120.0
    font_px = max(8, int(round(size_pt * px_per_in / 72.0)))
    font = load_font(font_px, bold=False)
    d = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    # 正文列宽: 有右侧配图时 6.4in, 否则 11.6in(与 op_compose 的 _txbox 保持一致)
    col_w_in = 6.4 if page.get("_hasImage") else 11.6
    avail_h_in = 4.9
    total_lines = 0
    for b in page.get("bullets") or []:
        total_lines += max(1, len(wrap_cjk(d, sanitize_text(b), font, col_w_in * px_per_in)))
    # 备注(notes)进演示者视图, 不占版面, 因此不参与溢出估算
    used_in = total_lines * (font_px * 1.35 / px_per_in) + 0.25 * max(0, total_lines - 1)
    return used_in - avail_h_in


def op_compose():
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
    except Exception as e:
        _die("python-pptx 未安装: %s (pip install python-pptx)" % str(e)[:120])

    pages = IN.get("pages") or []
    if not pages:
        _die("compose 页面为空")
    out_path = str(IN.get("out") or "")
    if not out_path:
        _die("compose 缺 out")
    mode = str(IN.get("mode") or "editable")
    if mode not in ("editable", "image"):
        _die("未知导出模式: %s (editable|image)" % mode)
    t = theme_of(IN.get("theme"))
    prs = Presentation()
    prs.slide_width = Inches(SLIDE_W)
    prs.slide_height = Inches(SLIDE_H)
    blank = prs.slide_layouts[6]  # 空白版式: 版面全部自己画, 不依赖模板占位符

    warnings = []
    overflows = []
    missing_images = []

    for idx, pg in enumerate(pages):
        kind = str(pg.get("kind") or "content")
        title = sanitize_text(pg.get("title"))
        bullets = [sanitize_text(b) for b in (pg.get("bullets") or []) if sanitize_text(b).strip()]
        notes = sanitize_text(pg.get("notes"))
        layout = str(pg.get("imageLayout") or "none")
        img_path = str(pg.get("imagePath") or "")
        has_img = bool(img_path) and os.path.isfile(img_path)
        if img_path and not has_img:
            # 库里指着图但磁盘上没有: 不能静默当无图(上层会以为导出的是完整稿)
            missing_images.append(idx + 1)

        pg = dict(pg)
        pg["_hasImage"] = has_img
        ov = _estimate_overflow(pg, t)
        if ov > 0:
            overflows.append({"seq": pg.get("seq"), "overBy": round(ov, 2)})

        slide = prs.slides.add_slide(blank)

        if mode == "image":
            # ── 不可编辑导出: 每页已由 image op 画成 png, 这里整页贴 ──
            #    价值: 字体/版式在任何机器上都是你在预览里看到的那一份
            png = str(pg.get("imagePath") or "")
            if not png or not os.path.isfile(png):
                warnings.append("第 %d 页缺整页图, 用底色兜底" % (idx + 1))
                box = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)  # 1=RECTANGLE
                box.fill.solid()
                from pptx.dml.color import RGBColor
                box.fill.fore_color.rgb = RGBColor(*t["bg"])
                box.line.fill.background()
            else:
                pic = slide.shapes.add_picture(png, 0, 0)
                _cover_crop_picture(pic, SLIDE_W, SLIDE_H)
        else:
            # ── 可编辑导出: 文本框 + 图片形状, 用户在 PowerPoint 里能继续改 ──
            bg_band = kind in ("cover", "section", "end")
            if has_img and layout == "background":
                pic = slide.shapes.add_picture(img_path, 0, 0)
                _cover_crop_picture(pic, SLIDE_W, SLIDE_H)
                # 压一层半透明白/深色: 背景图上直接写字会花
                _scrim(slide, 0, 0, SLIDE_W, SLIDE_H, t["bg"], 72 if not bg_band else 55)
            elif bg_band:
                _scrim(slide, 0, 0, SLIDE_W, SLIDE_H, t["band"], 100)

            if bg_band:
                # 封面/章节/结束: 居中大字
                _, tf = _txbox(slide, 1.2, 2.5, 10.9, 2.2)
                _fill_lines(tf, [(title, 40 if kind == "cover" else 34, True, t["bandText"], 0, 0)], t)
                if kind == "cover" and bullets:
                    _, tf2 = _txbox(slide, 1.2, 4.7, 10.9, 1.4)
                    _fill_lines(tf2, [(b, 18, False, t["bandText"], 0, 6) for b in bullets[:4]], t)
            else:
                img_right = has_img and layout == "right"
                text_w_in = 6.4 if img_right else 11.6
                # 标题
                _, tf = _txbox(slide, 0.87, 0.62, text_w_in, 1.1)
                _fill_lines(tf, [(title, 28, True, t["title"], 0, 0)], t)
                # 要点
                _, tfb = _txbox(slide, 0.87, 1.95, text_w_in, 4.9)
                _fill_lines(tfb, [(b, 18, False, t["body"], 0, 12) for b in bullets], t)
                if img_right:
                    pic = slide.shapes.add_picture(img_path, 0, 0)
                    _contain_picture(pic, 7.6, 1.6, 5.1, 4.6)
            # 页脚
            if kind not in ("cover",):
                _, tff = _txbox(slide, 11.9, 6.95, 1.0, 0.4)
                _fill_lines(tff, [(str(idx + 1), 11, False, t["footer"], 0, 0)], t)

        # ── 讲稿备注: 进 notes(演示者视图), 与屏幕上的要点互不覆盖 ──
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    prs.save(out_path)
    _ok(path=out_path, mode=mode, slides=len(pages),
        warnings=warnings, overflows=overflows, missingImages=missing_images)


# ─────────────────────────── op: inspect(把 pptx 读回来) ───────────────────────────
def op_inspect():
    """
    用 python-pptx **重新打开**一个文件并报出里面的东西。

    为什么要有这个 op: "生成成功"与"真的能被打开"是两件事 —— compose 返回 ok
    只说明 save() 没抛异常。把读回能力放进同一个脚本里, 是为了让**验证**
    用的是与**生成**同一套依赖(否则验证会因为别处的 python 环境而假失败)。
    """
    from pptx import Presentation
    src = str(IN.get("path") or "")
    if not src or not os.path.isfile(src):
        _die("文件不存在: %s" % src)
    prs = Presentation(src)   # 打不开会在这里抛 → 外层转成 ok:false
    slides = []
    for s in prs.slides:
        texts, pictures = [], 0
        for sh in s.shapes:
            if sh.shape_type == 13 or sh.__class__.__name__ == "Picture":   # 13 = PICTURE
                pictures += 1
            if sh.has_text_frame and sh.text_frame.text.strip():
                texts.append(sh.text_frame.text)
        notes = s.notes_slide.notes_text_frame.text if s.has_notes_slide else ""
        slides.append({"texts": texts, "pictures": pictures, "notes": notes})
    _ok(slides=len(slides),
        widthEmu=int(prs.slide_width), heightEmu=int(prs.slide_height),
        detail=slides)


# ─────────────────────────── op: theme(参考图 → 视觉规范) ───────────────────────────
def op_theme():
    """
    从用户投喂的**参考图**里提取一套视觉规范(旧项目的"风格模仿")。

    能做的事与不能做的事分清楚: 这里只做**可量化**的那部分 —— 主色/底色/深浅。
    真正的"版式风格"(留白比例/图形语言/字体气质)不是几个颜色能表达的, 所以
    调用方拿到的是 theme 覆盖值, 而不是"学会了这张图的风格"这种声明。
    """
    from PIL import Image
    src = str(IN.get("reference") or "")
    if not src or not os.path.isfile(src):
        _die("参考图不存在: %s" % src)
    img = Image.open(src).convert("RGB")
    img.thumbnail((160, 160))
    # 用 tobytes 而不是 getdata: 后者在 Pillow 12 已弃用(警告会打到 stderr, 污染诊断)
    raw = img.tobytes()
    px = [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, len(raw), 3)]
    if not px:
        _die("参考图读不出像素")
    # 量化到 4bit/通道再统计 —— 不量化的话照片会得到几千个"主色", 每个都是 1 个像素
    buckets = {}
    for (r, g, b) in px:
        k = (r >> 4, g >> 4, b >> 4)
        acc = buckets.setdefault(k, [0, 0, 0, 0])
        acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += 1
    top = sorted(buckets.values(), key=lambda a: -a[3])[:5]
    colors = [(int(a[0] / a[3]), int(a[1] / a[3]), int(a[2] / a[3])) for a in top]

    def lum(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    def hexs(c):
        return "#%02X%02X%02X" % c

    # 底色 = 出现最多的一色; 主色 = 与底色明暗差最大的那一色(通常就是品牌色)
    bg = colors[0]
    band = max(colors, key=lambda c: abs(lum(c) - lum(bg)))
    # 文字色: 底色深就用白, 浅就用近黑 —— 直接取"底色反色"会在中间灰上不可读
    on_band = (255, 255, 255) if lum(band) < 150 else (26, 26, 26)
    title = band if abs(lum(band) - lum(bg)) > 40 else ((26, 26, 26) if lum(bg) > 150 else (240, 240, 240))
    _ok(theme={
        "bg": hexs(bg), "band": hexs(band), "bandText": hexs(on_band),
        "title": hexs(title), "body": hexs((43, 43, 43) if lum(bg) > 150 else (232, 232, 232)),
        "accent": hexs(colors[1] if len(colors) > 1 else band),
        "footer": hexs((138, 143, 152) if lum(bg) > 150 else (176, 176, 176)),
    }, palette=[hexs(c) for c in colors])


# ─────────────────────────── 入口 ───────────────────────────
def main():
    op = str(IN.get("op") or "")
    try:
        if op == "probe":
            op_probe()
        elif op == "compose":
            op_compose()
        elif op == "image":
            op_image()
        elif op == "theme":
            op_theme()
        elif op == "inspect":
            op_inspect()
        else:
            _die("未知 op: %r" % op)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        # 任何异常都要变成**一行 JSON**, 而不是 traceback ——
        # 调用方从 stderr 里捡错误会捡到一堆无用的帧信息
        import traceback
        print(json.dumps({"ok": False,
                          "error": "%s: %s" % (type(e).__name__, str(e)[:300]),
                          "where": (traceback.extract_tb(e.__traceback__)[-1].name if e.__traceback__ else "")},
                         ensure_ascii=False))


main()
