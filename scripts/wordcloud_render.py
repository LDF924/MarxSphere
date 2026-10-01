# -*- coding: utf-8 -*-
"""wordcloud_render.py — 词云出图器(关键词词频 → PNG)
用法: python wordcloud_render.py <task_dir>
      python wordcloud_render.py --selfcheck        # 自检: wordcloud 装没装 / 用哪个中文字体
  task_dir/input.json : {
      frequencies: [{ word, count }],   # 必填; 空 → 报错, 不画空图
      width, height,                    # 像素, 默认 900×600(有上限, 见下)
      maxWords,                         # 最多画几个词, 默认 120
      background,                       # 背景色, 默认 #ffffff
      colormap,                         # matplotlib 配色名, 默认 viridis
      colors: [..],                     # 自定义调色板(给了就优先于 colormap)
      fontPath,                         # 显式指定字体文件; 不给则按平台找中文字体
      randomState, preferHorizontal, minFontSize, maxFontSize
  }
  task_dir/output.png  : 产物
  task_dir/result.json : { ok, width, height, fontUsed, words: [{word, count, size, x, y, rotation}] }

设计说明
--------
* **字体**: 词云库**不会**自动处理中文 —— 不给 font_path 时它用默认英文字体, 中文全部变成
  豆腐块(□)。这是"图出来了但是废的"的典型: 不报错、不抛异常、看着还挺像回事。所以这里
  按平台找一遍中文字体, 找不到就**直接报错**, 不出一张全是方块的图。
  候选顺序与 project 既有约定一致(scripts/empirical_figures.py 的 Microsoft YaHei/SimHei/SimSun)。
* **坐标回传**: 词云库会把每个词的位置画在 canvas 上, 但**不**返回坐标。这里用
  `generate_from_frequencies` 的 layout 之后从 `.layout_` 读 —— 前端要能拿文字位置做点击/悬停,
  只给一张 PNG 的话那些词就是死的。读不到 layout 时降级为只回词频(size 用字号), 不报错。
* 出图尺寸有上限(2000×2000): 请求体直通, 超大画布会让进程申请巨量内存。
"""
import json
import os
import re
import sys

task_dir = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else None

MAX_SIDE = 2000

# 中文字体候选。找不到就报错 —— 宁可不出图, 也别出一张全是豆腐块的图
CJK_FONT_CANDIDATES = [
    os.environ.get("SAG_WORDCLOUD_FONT", ""),
    "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhl.ttc", "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/Deng.ttf",
    "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
]


_CJK_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")

# 判断"这个字体有没有汉字"用的字符。挑生僻一点的: 常见字连日文/韩文字体都有,
# 而生僻字能把"只有拉丁字形"的字体挡在外面。
_CJK_PROBE = "乡"   # 乡


def font_has_cjk(path: str) -> bool:
    """字体里真有汉字字形吗?

    ⚠ 这一条不是洁癖: 路径存在**不等于**字体能画中文。把 font_path 指到 arial.ttf
      这类纯拉丁字体时, 词云库会照常出图 —— 每个汉字的字形都是空的, 图上是空白/方框,
      不报错。实测 arial 渲染 "乡" 与渲染不存在字符得到的是同一张位图, 判据就取这个相等关系。
    判据用的是"渲染该字 vs 渲染一个必定不存在的字符", 两者位图相同 ⇒ 没有这个字形。
    fontTools 装了就直接问 cmap(更准), 没装就走渲染对比(不引依赖)。
    """
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(path, fontNumber=0)
        for table in f["cmap"].tables:
            if ord(_CJK_PROBE) in table.cmap:
                return True
        return False
    except Exception:
        pass
    try:
        from PIL import Image, ImageDraw, ImageFont
        font = ImageFont.truetype(path, 32)

        def render(ch: str) -> bytes:
            im = Image.new("L", (48, 48), 0)
            ImageDraw.Draw(im).text((4, 4), ch, font=font, fill=255)
            return im.tobytes()

        return render(_CJK_PROBE) != render("￿")
    except Exception:
        return False


def find_font() -> str:
    for p in CJK_FONT_CANDIDATES:
        if p and os.path.isfile(p) and font_has_cjk(p):
            return p
    return ""


def selfcheck() -> dict:
    """能不能出图: 库装没装 + 有没有中文字体。测试用 `--selfcheck` 决定跳过与否。"""
    out = {"ok": False, "wordcloud": False, "version": "", "font": "", "matplotlib": False}
    try:
        import wordcloud  # noqa: F401
        out["wordcloud"] = True
        out["version"] = getattr(wordcloud, "__version__", "?")
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    try:
        import matplotlib  # noqa: F401
        out["matplotlib"] = True
    except Exception:
        pass
    out["font"] = find_font()
    out["ok"] = bool(out["wordcloud"] and out["matplotlib"] and out["font"])
    if out["ok"]:
        out.pop("error", None)
    elif "error" not in out and not out["font"]:
        out["error"] = "找不到中文字体(可用 SAG_WORDCLOUD_FONT 指定)"
    return out


def fail(msg: str, code: str = "") -> dict:
    d = {"ok": False, "error": msg}
    if code:
        d["code"] = code
    return d


def write_result(d: dict) -> None:
    path = os.path.join(task_dir, "result.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, path)  # 原子写


def clamp_int(v, default: int, lo: int, hi: int) -> int:
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def main() -> dict:
    with open(os.path.join(task_dir, "input.json"), encoding="utf-8") as f:
        inp = json.load(f)

    freqs = inp.get("frequencies") or []
    # 清洗: 词云库对空词/非正数会静默丢词甚至抛异常, 这里先归一
    clean = {}
    for item in freqs:
        if not isinstance(item, dict):
            continue
        w = str(item.get("word") or "").strip()
        try:
            c = float(item.get("count") or 0)
        except (TypeError, ValueError):
            c = 0.0
        if not w or c <= 0:
            continue
        clean[w] = clean.get(w, 0.0) + c
    if not clean:
        return fail("词频为空: 没有可画的词(语料太短或全被停用词过滤)", "EMPTY_FREQUENCIES")

    max_words = clamp_int(inp.get("maxWords"), 120, 1, 1000)
    width = clamp_int(inp.get("width"), 900, 120, MAX_SIDE)
    height = clamp_int(inp.get("height"), 600, 120, MAX_SIDE)
    random_state = clamp_int(inp.get("randomState"), 42, 0, 1 << 30)
    min_font = clamp_int(inp.get("minFontSize"), 8, 4, 200)
    max_font = clamp_int(inp.get("maxFontSize"), 0, 0, 400)
    prefer_h = inp.get("preferHorizontal")
    try:
        prefer_h = max(0.0, min(1.0, float(prefer_h)))
    except (TypeError, ValueError):
        prefer_h = 0.9

    try:
        from wordcloud import WordCloud
    except Exception as e:
        return fail("未安装 wordcloud 库(%s): pip install wordcloud" % type(e).__name__,
                    "MISSING_WORDCLOUD")

    # 词里**真有汉字**时才要求中文字体。纯英文词云在没装中文字体的机器上也该能用 ——
    # 无差别地要求"必须有中文字体"会把 Linux CI 上的英文用例一起误杀。
    needs_cjk = any(_CJK_RE.search(w) for w in clean)
    font = str(inp.get("fontPath") or "").strip()
    if font:
        if not os.path.isfile(font):
            return fail("指定的字体文件不存在: %s" % font, "MISSING_CJK_FONT")
        if needs_cjk and not font_has_cjk(font):
            # 显式指到纯拉丁字体时不报错、只出空白图 —— 那正是这里要拦的
            return fail("指定的字体不含汉字字形, 画中文会是一片空白: %s" % font, "MISSING_CJK_FONT")
    elif needs_cjk:
        font = find_font()
        if not font:
            return fail("找不到中文字体: 词云库不会自动处理中文, 不给 font_path 会把汉字画成方框/空白, "
                        "所以这里直接失败而不是出一张废图。可用 fontPath 参数或 SAG_WORDCLOUD_FONT 指定",
                        "MISSING_CJK_FONT")
    else:
        font = find_font()   # 英文词云: 有就顺手用(字形更全), 没有就让词云库用自带字体

    try:
        wc = WordCloud(
            font_path=font,
            width=width, height=height,
            max_words=max_words,
            background_color=str(inp.get("background") or "#ffffff"),
            prefer_horizontal=prefer_h,
            min_font_size=min_font,
            random_state=random_state,
            **({"max_font_size": max_font} if max_font else {}),
        )
        colors = inp.get("colors")
        if isinstance(colors, list) and colors:
            palette = [str(c) for c in colors if str(c).strip()]
            if palette:
                # 按词序循环取色: 同一张图两次跑颜色一致(随机取色会让"配色"参数变得不可复现)
                seq = {w: palette[i % len(palette)] for i, w in enumerate(sorted(clean))}
                wc.color_func = lambda word, *a, **k: seq.get(word, palette[0])  # noqa: E731
        else:
            cmap = str(inp.get("colormap") or "").strip()
            if cmap:
                wc.colormap = cmap

        wc.generate_from_frequencies(clean)
        png = os.path.join(task_dir, "output.png")
        wc.to_file(png)
    except Exception as e:
        return fail("词云渲染失败: %s: %s" % (type(e).__name__, e), "RENDER_FAILED")

    # 回传每个词的位置/字号 —— 前端要拿它做点击与悬停; 读不到就只回词频
    #
    # ⚠ layout_ 的结构**不是**眼见的那种四元组。wordcloud 1.9.6 里每项是:
    #     (('词', 权重), 字号, (x, y), 旋转, 'rgb(...)')
    #   第一项本身是二元组。按 `for word, (x,y,size,rot) in layout_` 解包会在换版本时炸成
    #   `too many values to unpack` —— 而那正好落在 try 之外, 表现为"图生成了但结果是失败"
    #   (实测踩过)。这里逐项按位置取 + 逐个 try, 结构变了最差也只是不回坐标, 不影响出图。
    def as_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    words = []
    layout = getattr(wc, "layout_", None) or []
    for item in layout:
        try:
            head = item[0]
            word = head[0] if isinstance(head, (tuple, list)) else head
            pos = item[2] if len(item) > 2 else None
            x, y = (as_int(pos[0]), as_int(pos[1])) if isinstance(pos, (tuple, list)) else (None, None)
            words.append({
                "word": str(word),
                "count": clean.get(str(word), 0),
                "size": as_int(item[1]) if len(item) > 1 else None,
                "x": x, "y": y,
                # 旋转是"四分之一圈"的倍数(0/1/2/3), None 表示横排
                "rotation": (as_int(item[3]) or 0) * 90 if len(item) > 3 else 0,
            })
        except (TypeError, ValueError, IndexError):
            continue
    if not words:
        for word, cnt in sorted(clean.items(), key=lambda kv: -kv[1])[:max_words]:
            words.append({"word": word, "count": cnt})

    return {"ok": True, "width": width, "height": height, "fontUsed": font, "words": words}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        print(json.dumps(selfcheck(), ensure_ascii=False))
        sys.exit(0)
    if not task_dir:
        print(json.dumps({"ok": False, "error": "用法: wordcloud_render.py <task_dir> | --selfcheck"},
                         ensure_ascii=False))
        sys.exit(2)
    try:
        out = main()
    except Exception as e:  # 兜底: 保证 result.json 一定写出来, 不然调用方只能看到"超时/崩溃"
        out = fail("%s: %s" % (type(e).__name__, e), "UNEXPECTED")
    write_result(out)
