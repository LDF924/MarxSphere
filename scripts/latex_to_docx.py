#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
"""latex_to_docx.py — 把含 LaTeX 公式的文本转成 Word(.docx)，公式是真 OMML 而非图片。

移植自旧项目 AItoolman 的明文源码(`client/tools/latex_to_docx.py`)，改动:
  · 删掉 8 处 `print('处理N:', ...)` 调试输出(原样搬会污染 stdout, 让调用方 JSON 解析崩)
  · 加 CLI 入口(读 JSON 入参 → 写 docx → stdout 出 JSON)，供 TS 侧 execFile 调用
  · 保留全部 OMML 转换逻辑(分数/根号/N元运算/矩阵/围栏/上下标/上下限)

为什么值得移植: 新项目原来**没有任何 LaTeX→OMML 能力**(grep OMML/latex2mathml = 0),
  导出的 Word 里公式要么是纯文本、要么是图片; 而 Word 的 `m:oMath` 是原生公式,
  可编辑、可重排、能被期刊排版系统正确识别。

依赖: python-docx, latex2mathml, lxml
用法:
  echo '{"content":"...$$E=mc^2$$...","output":"out.docx"}' | python latex_to_docx.py
"""

from __future__ import annotations

import json
import os
import re
import sys

from lxml import etree
import latex2mathml.converter
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt


# ════════════════════ 命名空间 & 常量 ════════════════════

_OMML = "http://schemas.openxmlformats.org/officeDocument/2006/math"
_NARY_OPS = set("∑∏∫∬∭∮⋂⋃⨁⨂⋁⋀")


# ════════════════════ OMML 工具函数 ════════════════════

def _om(tag, parent=None, **attrs):
    """创建 OMML 命名空间元素。"""
    ns_tag = f"{{{_OMML}}}{tag}"
    el = (etree.SubElement(parent, ns_tag)
          if parent is not None else etree.Element(ns_tag))
    for k, v in attrs.items():
        el.set(f"{{{_OMML}}}{k}", v)
    return el


def _run(text, parent):
    """<m:r><m:t>text</m:t></m:r>"""
    r = _om("r", parent)
    t = _om("t", r)
    t.text = text
    return r


def _tag(el):
    """获取本地标签名（去命名空间）。"""
    return el.tag.rpartition("}")[2] if "}" in el.tag else el.tag


def _is_nary(el):
    """判断是否为 N-ary 运算符（∑ ∏ ∫ …）。"""
    return _tag(el) == "mo" and (el.text or "").strip() in _NARY_OPS


# ════════════════════ MathML → OMML 转换器 ════════════════════

class _MML2OMML:
    """将 latex2mathml 产生的 MathML 元素树转换为 OMML。"""

    def convert(self, latex_str: str, display: bool = False):
        """LaTeX → OMML lxml Element。

        Args:
            latex_str: LaTeX 公式（不含定界符）。
            display:   True → 包裹 <m:oMathPara>（居中行间公式）。
        """
        mml_str = latex2mathml.converter.convert(latex_str)
        mml_root = etree.fromstring(mml_str.encode("utf-8"))

        if display:
            wrapper = _om("oMathPara")
            omath = _om("oMath", wrapper)
        else:
            omath = _om("oMath")
            wrapper = None

        self._children(list(mml_root), omath)
        return wrapper if wrapper is not None else omath

    # ── 子节点列表处理（含 N-ary 检测）──────────────────────

    def _children(self, kids, parent):
        i = 0
        while i < len(kids):
            child = kids[i]
            tg = _tag(child)
            # 检测 N-ary 模式
            if tg in ("msubsup", "msub", "munder", "munderover"):
                gc = list(child)
                if gc and _is_nary(gc[0]):
                    self._nary(tg, gc, kids[i + 1:], parent)
                    return
            self._one(child, parent)
            i += 1

    def _nary(self, tg, gc, remaining, parent):
        """构建 <m:nary>。"""
        nary = _om("nary", parent)
        pr = _om("naryPr", nary)
        _om("chr", pr, val=(gc[0].text or "").strip())
        _om("limLoc", pr, val="undOvr")

        sub_e = _om("sub", nary)
        sup_e = _om("sup", nary)
        if tg == "msubsup" and len(gc) >= 3:
            self._one(gc[1], sub_e)
            self._one(gc[2], sup_e)
        elif tg in ("msub", "munder") and len(gc) >= 2:
            self._one(gc[1], sub_e)
        elif tg == "munderover" and len(gc) >= 3:
            self._one(gc[1], sub_e)
            self._one(gc[2], sup_e)

        body = _om("e", nary)
        self._children(remaining, body)

    # ── 单元素转换 ─────────────────────────────────────────

    def _one(self, el, parent):
        handler = getattr(self, f"_do_{_tag(el)}", None)
        if handler:
            handler(el, parent)
        else:
            self._children(list(el), parent)

    # -- 透传容器 --
    def _do_math(self, el, p):    self._children(list(el), p)
    def _do_mrow(self, el, p):    self._children(list(el), p)
    def _do_mstyle(self, el, p):  self._children(list(el), p)
    def _do_mpadded(self, el, p): self._children(list(el), p)

    # -- 叶子节点 --
    def _do_mi(self, el, p):
        t = (el.text or "").strip()
        if t: _run(t, p)

    def _do_mo(self, el, p):
        t = (el.text or "").strip()
        if t: _run(t, p)

    def _do_mn(self, el, p):
        t = (el.text or "").strip()
        if t: _run(t, p)

    def _do_mtext(self, el, p):
        t = (el.text or "").strip()
        if t:
            r = _om("r", p)
            rpr = _om("rPr", r)
            _om("nor", rpr)
            tt = _om("t", r)
            tt.text = t

    def _do_mspace(self, el, p):
        _run(" ", p)

    # -- 上下标 --
    def _do_msub(self, el, p):
        gc = list(el)
        if len(gc) < 2: return
        s = _om("sSub", p); _om("sSubPr", s)
        e = _om("e", s);   self._one(gc[0], e)
        sub = _om("sub", s); self._one(gc[1], sub)

    def _do_msup(self, el, p):
        gc = list(el)
        if len(gc) < 2: return
        s = _om("sSup", p); _om("sSupPr", s)
        e = _om("e", s);   self._one(gc[0], e)
        sup = _om("sup", s); self._one(gc[1], sup)

    def _do_msubsup(self, el, p):
        gc = list(el)
        if len(gc) < 3: return
        s = _om("sSubSup", p); _om("sSubSupPr", s)
        e = _om("e", s);      self._one(gc[0], e)
        sub = _om("sub", s);  self._one(gc[1], sub)
        sup = _om("sup", s);  self._one(gc[2], sup)

    # -- 分数 --
    def _do_mfrac(self, el, p):
        gc = list(el)
        if len(gc) < 2: return
        f = _om("f", p); _om("fPr", f)
        num = _om("num", f); self._one(gc[0], num)
        den = _om("den", f); self._one(gc[1], den)

    # -- 根号 --
    def _do_msqrt(self, el, p):
        rad = _om("rad", p)
        rpr = _om("radPr", rad); _om("degHide", rpr, val="1")
        _om("deg", rad)
        e = _om("e", rad); self._children(list(el), e)

    def _do_mroot(self, el, p):
        gc = list(el)
        rad = _om("rad", p); _om("radPr", rad)
        deg = _om("deg", rad)
        if len(gc) >= 2: self._one(gc[1], deg)
        e = _om("e", rad)
        if gc: self._one(gc[0], e)

    # -- 上/下装饰 (非 N-ary 情况) --
    def _do_mover(self, el, p):
        gc = list(el)
        if len(gc) < 2: return
        acc = _om("acc", p)
        accpr = _om("accPr", acc)
        ch = (gc[1].text or "").strip()
        if ch: _om("chr", accpr, val=ch)
        e = _om("e", acc); self._one(gc[0], e)

    def _do_munder(self, el, p):
        gc = list(el)
        if len(gc) < 2: return
        lim = _om("limLow", p); _om("limLowPr", lim)
        e = _om("e", lim);  self._one(gc[0], e)
        l = _om("lim", lim); self._one(gc[1], l)

    def _do_munderover(self, el, p):
        gc = list(el)
        if len(gc) < 3: return
        lo = _om("limLow", p); _om("limLowPr", lo)
        e1 = _om("e", lo)
        up = _om("limUpp", e1); _om("limUppPr", up)
        e2 = _om("e", up);  self._one(gc[0], e2)
        lu = _om("lim", up); self._one(gc[2], lu)
        ll = _om("lim", lo); self._one(gc[1], ll)

    # -- 围栏 / 定界符 --
    def _do_mfenced(self, el, p):
        d = _om("d", p); dpr = _om("dPr", d)
        _om("begChr", dpr, val=el.get("open", "("))
        _om("endChr", dpr, val=el.get("close", ")"))
        e = _om("e", d); self._children(list(el), e)

    # -- 矩阵 / 表格 --
    def _do_mtable(self, el, p):
        m = _om("m", p); mpr = _om("mPr", m)
        rows = [c for c in el if _tag(c) == "mtr"]
        if rows:
            mc = _om("mc", mpr); mcpr = _om("mcPr", mc)
            cols = max(sum(1 for c in r if _tag(c) == "mtd") for r in rows)
            _om("count", mcpr, val=str(cols))
        for r in rows: self._do_mtr(r, m)

    def _do_mtr(self, el, p):
        mr = _om("mr", p)
        for td in el:
            if _tag(td) == "mtd": self._do_mtd(td, mr)

    def _do_mtd(self, el, p):
        e = _om("e", p); self._children(list(el), e)


_converter = _MML2OMML()


# ════════════════════ 公开接口 ════════════════════

def content_to_docx(content: str, output_path: str = "output.docx",
                    title: str = "", font_name: str = "宋体",
                    body_size: float = 12) -> str:
    """将含 LaTeX 公式的纯文本转换为 .docx 文件。

    支持的公式定界符
    ─────────────────
    行间（display）公式:  $$...$$
    行内（inline）公式 :  \\(...\\)

    Parameters
    ----------
    content : str
        含 LaTeX 公式的文本。
    output_path : str
        输出 .docx 路径，默认 ``"output.docx"``。
    title : str
        可选的文档标题，非空时作为居中大标题插入在最前。
    font_name : str
        中文字体（写入 w:eastAsia）。
    body_size : float
        正文字号(pt)。

    Returns
    -------
    str
        生成文件的绝对路径。
    """
    doc = Document()

    if title.strip():
        h = doc.add_paragraph()
        _add_run_with_superscript(h, title.strip())
        for r in h.runs:
            r.font.size = Pt(16)
            r.bold = True

    # 预处理：将字面量 \n 转为真正换行
    # 1) 先处理 $$ 边界的 \n（如 $$\nR(t)… 中 \n 是分隔符而非 LaTeX 命令）
    content = re.sub(r"\$\$\\n", "$$\n", content)
    content = re.sub(r"\\n\$\$", "\n$$", content)
    # 2) 再处理文本中的 \n（不影响 \nu \nabla 等 LaTeX 命令）
    content = re.sub(r"\\n(?![a-zA-Z])", "\n", content)

    # 按 display math $$...$$ 拆分
    parts = re.split(r"(\$\$.*?\$\$)", content, flags=re.DOTALL)

    for part in parts:
        if part.startswith("$$") and part.endswith("$$"):
            latex = part[2:-2].strip()
            if latex:
                p = doc.add_paragraph()
                try:
                    omml = _converter.convert(latex, display=True)
                    p._element.append(omml)
                except Exception:
                    p.add_run(f"[公式解析失败: {latex}]")
        else:
            lines = [l.strip() for l in part.split("\n") if l.strip()]
            for line in lines:
                p = doc.add_paragraph()
                _add_inline_math(p, line)

    _apply_cjk_fonts(doc, font_name, body_size)

    abs_out = os.path.abspath(output_path)
    doc.save(abs_out)
    return abs_out


# ════════════════════ 内部工具 ════════════════════
def _add_run_with_superscript(paragraph, text):
    pattern = r'\[\d+\]'
    parts = re.split(f'({pattern})', text)
    for part in parts:
        if re.match(pattern, part):
            # 添加引用编号并设置为右上角标
            run = paragraph.add_run(part.replace('\n', ''))
            run.font.superscript = True
        else:
            paragraph.add_run(part.replace('\n', ''))


def _add_inline_math(paragraph, text):
    """将文本中的 \\(...\\) 解析为行内公式，其余为普通文本。"""
    segments = re.split(r"\\\((.+?)\\\)", text)
    for i, seg in enumerate(segments):
        if i % 2 == 0:
            if seg:
                _add_run_with_superscript(paragraph, seg)
        else:
            try:
                omml = _converter.convert(seg.strip(), display=False)
                paragraph._element.append(omml)
            except Exception:
                paragraph.add_run(f"[{seg}]")


def _apply_cjk_fonts(doc, font_name: str = "宋体", body_size: float = 12):
    """设置中文兼容字体（西文 Times New Roman + 中文可配）。"""
    style = doc.styles["Normal"]
    style.font.size = Pt(body_size)

    rpr = style.element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)

    rf.set(qn("w:ascii"), "Times New Roman")
    rf.set(qn("w:hAnsi"), "Times New Roman")
    rf.set(qn("w:eastAsia"), font_name)


# ════════════════════ CLI ════════════════════

def main() -> int:
    """从 stdin 读 JSON 入参, 写出 docx, stdout 出 JSON 结果。

    入参: {"content": str, "output": str, "title"?: str, "fontName"?: str, "fontSize"?: number}
    出参: {"ok": true, "output": str, "bytes": int, "formulas": int}
      失败: {"ok": false, "error": str}
    """
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"入参 JSON 解析失败: {e}"}), flush=True)
        return 2

    content = req.get("content") or ""
    output = req.get("output") or ""
    if not content.strip():
        print(json.dumps({"ok": False, "error": "content 为空"}), flush=True)
        return 2
    if not output.strip():
        print(json.dumps({"ok": False, "error": "output 路径为空"}), flush=True)
        return 2

    try:
        out = content_to_docx(
            content,
            output,
            title=str(req.get("title") or ""),
            font_name=str(req.get("fontName") or "宋体"),
            body_size=float(req.get("fontSize") or 12),
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)
        return 1

    # 公式条数 = display($$) + inline(\(\)) 的定界符对数, 供调用方核对"没白干"
    n_display = len(re.findall(r"\$\$.+?\$\$", content, flags=re.DOTALL))
    n_inline = len(re.findall(r"\\\(.+?\\\)", content, flags=re.DOTALL))
    print(json.dumps({
        "ok": True,
        "output": out,
        "bytes": os.path.getsize(out),
        "formulas": n_display + n_inline,
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
