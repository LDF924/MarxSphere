#!/usr/bin/env python3
"""docx_extra_rules.py — 补充 Word 级检查规则(2026-09-03 自写实现)

规则清单参考以下开源项目的功能描述(未复制代码, 仅按功能点自写):
- word-format-checker(hjbjltnc, 无许可证): 纸张尺寸/段距/对齐/空格/禁用字符/
  加粗斜体下划线/表格样式/图片对齐/敏感信息/页数上限
- dut-thesis-format-checker(jackeyloveseven, 无许可证): 封面题目字数/图表编号格式/
  正文总字数
输出统一 Finding 结构(与 thesis_format_checker.standard.rules 对齐)。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH


@dataclass
class Finding:
    rule_id: str
    message: str
    severity: str = "warning"  # error | warning | info
    expected: Any = None
    actual: Any = None
    location: str = ""
    fixable: bool = False


CJK_RE = __import__("re").compile(r"[㐀-鿿぀-ヿ]")
HALF_SPACE_RE = __import__("re").compile(r"[  ]")
FULL_SPACE_RE = __import__("re").compile(r"[　]")


def _count_cjk(text: str) -> int:
    return len(CJK_RE.findall(text))


def run_extra_rules(docx_path: Path, preset: dict) -> list[Finding]:
    """执行补充规则: 返回 findings 列表。"""
    doc = Document(docx_path)
    findings: list[Finding] = []
    page_cfg = preset.get("page", {})
    expected_size = str(page_cfg.get("size", "A4")).upper()

    # ── 1. 纸张尺寸 ──
    for sec_idx, sec in enumerate(doc.sections):
        w_cm = round(sec.page_width.cm, 1)
        h_cm = round(sec.page_height.cm, 1)
        if expected_size == "A4" and not (abs(w_cm - 21.0) < 0.2 and abs(h_cm - 29.7) < 0.2):
            findings.append(Finding(
                rule_id="paper-size",
                message=f"纸张尺寸 {w_cm}x{h_cm}cm, 应为 A4(21x29.7cm)",
                severity="error", expected="A4", actual=f"{w_cm}x{h_cm}cm",
                location=f"Section {sec_idx}", fixable=True))

    # ── 2. 段前/段后间距 / 对齐 / 段首空格 / 禁用字符 / 全半角空格 ──
    body_cfg = preset.get("body", {})
    expected_spacing_after = body_cfg.get("spacing_after_pt")
    expected_align = body_cfg.get("align")
    for i, p in enumerate(doc.paragraphs):
        text = p.text or ""
        # 段首空格(正文段不应以空格开头)
        if text and text[0] in (" ", "　") and len(text) > 10:
            findings.append(Finding(
                rule_id="para-leading-space",
                message=f"段落以空格开头: '{text[:20]}…'",
                severity="warning",
                actual=repr(text[0]), location=f"Para {i + 1}", fixable=True))
        # 全角空格混用
        if FULL_SPACE_RE.search(text) and HALF_SPACE_RE.search(text):
            findings.append(Finding(
                rule_id="space-mixed",
                message="全角与半角空格混用",
                severity="warning", location=f"Para {i + 1}"))
        # 禁用字符(控制字符/替换符)
        bad = [c for c in text if ord(c) < 32 and c not in ("\t", "\n") or c == "�"]
        if bad:
            findings.append(Finding(
                rule_id="forbidden-chars",
                message=f"段落含禁用字符 {len(bad)} 个",
                severity="error", location=f"Para {i + 1}"))
        # 左对齐(正文默认两端/左对齐)
        if expected_align and p.alignment is not None:
            align_name = p.alignment
            if align_name not in (WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.JUSTIFY):
                # 标题段跳过
                style = (p.style.name if p.style is not None else "") or ""
                if "Heading" not in style and "标题" not in style:
                    findings.append(Finding(
                        rule_id="para-align",
                        message=f"段落对齐为 {align_name}, 正文应为左对齐/两端对齐",
                        severity="info", location=f"Para {i + 1}"))
        # 段前/段后间距
        if expected_spacing_after is not None:
            try:
                actual_after = p.paragraph_format.space_after.pt if p.paragraph_format.space_after else 0
                if p.text and actual_after > expected_spacing_after * 1.6:
                    findings.append(Finding(
                        rule_id="para-spacing-after",
                        message=f"段后间距 {round(actual_after, 1)}pt 偏大(期望 ≤{expected_spacing_after}pt)",
                        severity="info", location=f"Para {i + 1}"))
            except (TypeError, AttributeError):
                pass

    # ── 3. 加粗/斜体/下划线(正文应常态无装饰) ──
    for i, p in enumerate(doc.paragraphs):
        style = (p.style.name if p.style is not None else "") or ""
        if "Heading" in style or "标题" in style:
            continue
        for r in p.runs:
            if r.underline and (r.text or "").strip():
                findings.append(Finding(
                    rule_id="run-underline",
                    message=f"正文含下划线文字: '{r.text[:20]}…'",
                    severity="info", location=f"Para {i + 1}"))
            if r.italic and (r.text or "").strip():
                findings.append(Finding(
                    rule_id="run-italic",
                    message=f"正文含斜体文字: '{r.text[:20]}…'",
                    severity="info", location=f"Para {i + 1}"))

    # ── 4. 封面题目字数 ≤25 ──
    cover_limit = preset.get("cover", {}).get("title_max_chars")
    if cover_limit:
        first_paras = [p.text.strip() for p in doc.paragraphs[:8] if p.text.strip()]
        # 封面标题通常在前几段且为最大字号
        biggest: str | None = None
        biggest_size = 0.0
        for p in doc.paragraphs[:10]:
            for r in p.runs:
                try:
                    sz = r.font.size.pt if r.font.size else 0
                except (TypeError, AttributeError):
                    sz = 0
                if sz > biggest_size and len((p.text or "").strip()) > 3:
                    biggest_size = sz
                    biggest = p.text.strip()
        if biggest:
            cnt = _count_cjk(biggest)
            if cnt > cover_limit:
                findings.append(Finding(
                    rule_id="cover-title-length",
                    message=f"封面题目 {cnt} 个汉字, 超出上限 {cover_limit}",
                    severity="error", expected=cover_limit, actual=cnt, fixable=False))

    # ── 5. 正文总字数(≥min_body_chars, 默认 20000 参考 dut) ──
    min_chars = preset.get("body", {}).get("min_total_chars", 20000)
    total = sum(_count_cjk(p.text or "") for p in doc.paragraphs)
    # 表格文字也计入
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                total += _count_cjk(cell.text or "")
    if 0 < total < min_chars:
        findings.append(Finding(
            rule_id="body-total-chars",
            message=f"正文总字数约 {total} 字, 低于 {min_chars} 字要求",
            severity="error", expected=min_chars, actual=total))

    # ── 6. 图表编号格式: 图N.M(禁图N-M) ──
    all_text = "\n".join(p.text or "" for p in doc.paragraphs)
    dash_hits = __import__("re").findall(r"[图表]\s*\d+\s*[-–—]\s*\d+", all_text)
    if dash_hits:
        findings.append(Finding(
            rule_id="caption-dash-format",
            message=f"图表编号使用连字符: {dash_hits[:3]}, 应为 X.Y 格式(如 图3.1)",
            severity="error", actual=dash_hits[:3]))

    # ── 7. 图片段落对齐 ──
    for i, p in enumerate(doc.paragraphs):
        if not p._p.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            continue
        if p.alignment not in (WD_ALIGN_PARAGRAPH.CENTER, None):
            findings.append(Finding(
                rule_id="image-align",
                message="图片段落未居中",
                severity="warning", location=f"Para {i + 1}"))

    # ── 8. 敏感信息(参考 word-format-checker 功能: 手机/邮箱/身份证) ──
    phone_re = __import__("re").compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
    id_re = __import__("re").compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
    email_re = __import__("re").compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
    for kind, re_obj in (("手机号", phone_re), ("身份证", id_re), ("邮箱", email_re)):
        hits = re_obj.findall(all_text)
        if hits:
            findings.append(Finding(
                rule_id=f"sensitive-{kind}",
                message=f"正文出现{kind}: {hits[:3]}",
                severity="warning", actual=hits[:3]))

    # ── 9. 页数上限估算(参考 word-format-checker) ──
    max_pages = preset.get("page", {}).get("max_pages")
    if max_pages:
        chars_per_page = 800
        est_pages = max(1, round(total / chars_per_page))
        if est_pages > max_pages:
            findings.append(Finding(
                rule_id="page-count-estimate",
                message=f"估算约 {est_pages} 页, 超出上限 {max_pages} 页",
                severity="info", expected=max_pages, actual=est_pages))

    return findings
