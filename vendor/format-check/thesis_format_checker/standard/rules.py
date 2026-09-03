"""Rule definitions and evaluation engine.

Each rule is a function decorated with @rule() that takes
(docx_result, content_result, preset) and returns findings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class Finding:
    rule_id: str
    message: str
    severity: str = "error"  # error | warning | info
    expected: Any = None
    actual: Any = None
    location: str = ""
    fixable: bool = False


@dataclass
class RuleSpec:
    id: str
    fn: Callable
    default_severity: str = "error"
    default_enabled: bool = True


RULES: dict[str, RuleSpec] = {}


def rule(id: str, default_severity: str = "error", default_enabled: bool = True):
    def decorator(fn):
        RULES[id] = RuleSpec(id=id, fn=fn, default_severity=default_severity, default_enabled=default_enabled)
        return fn
    return decorator


def _get_rule_config(preset: dict, rule_id: str) -> tuple[str, bool]:
    """Get severity and enabled status for a rule from preset overrides."""
    for r in preset.get("rules", []):
        if r.get("id") == rule_id:
            return r.get("severity", "error"), r.get("enabled", True)
    return "error", True


def evaluate_all(docx_result, content_result, preset: dict) -> list[Finding]:
    """Run all enabled rules and collect findings."""
    findings = []
    for rule_id, spec in RULES.items():
        severity, enabled = _get_rule_config(preset, rule_id)
        if not enabled:
            continue
        results = spec.fn(docx_result, content_result, preset)
        for f in results:
            f.severity = severity
        findings.extend(results)
    return findings


# --- Rule implementations ---

@rule("page-margins")
def check_page_margins(docx, content, preset) -> list[Finding]:
    findings = []
    expected = preset.get("page", {}).get("margin_cm", {})
    if not expected:
        return findings
    for sec in docx.sections:
        for side in ("top", "bottom", "left", "right"):
            exp = expected.get(side)
            if exp is None:
                continue
            actual = getattr(sec, f"{side}_margin_cm")
            if abs(actual - exp) > 0.15:
                findings.append(Finding(
                    rule_id="page-margins",
                    message=f"Section {sec.index}: {side} margin {actual:.2f}cm, expected {exp}cm",
                    expected=exp, actual=round(actual, 2),
                    location=f"Section {sec.index}",
                    fixable=True,
                ))
    return findings


@rule("header-text-match", default_severity="warning")
def check_header_text(docx, content, preset) -> list[Finding]:
    expected = preset.get("page", {}).get("header_text", "")
    if not expected:
        return []
    findings = []
    for sec in docx.sections:
        if sec.header_text and expected not in sec.header_text:
            findings.append(Finding(
                rule_id="header-text-match",
                message=f"Section {sec.index} 页眉为 {sec.header_text!r}，应包含 {expected!r}",
                expected=expected, actual=sec.header_text,
                location=f"Section {sec.index}", fixable=True,
            ))
    return findings


@rule("header-on-all-sections", default_severity="warning")
def check_header_on_all_sections(docx, content, preset) -> list[Finding]:
    findings = []
    has_any_header = any(s.header_text for s in docx.sections)
    if not has_any_header:
        return findings
    # NCWU template only requires the body text to carry the thesis header.
    # Front matter sections such as cover, declarations, TOC and abstracts are
    # intentionally headerless, so only require headers from the first section
    # that already has a body header onward.
    first_header_idx = next((s.index for s in docx.sections if s.header_text), 0)
    for sec in docx.sections:
        if sec.index < first_header_idx:
            continue
        if not sec.header_text and not sec.header_linked_to_previous:
            findings.append(Finding(
                rule_id="header-on-all-sections",
                message=f"Section {sec.index} 缺少页眉且未链接到前一节",
                location=f"Section {sec.index}", fixable=False,
            ))
    return findings


@rule("body-font-size")
def check_body_font_size(docx, content, preset) -> list[Finding]:
    expected = preset.get("styles", {}).get("body", {}).get("size_pt")
    if expected is None:
        return []
    normal = docx.styles.get("Normal")
    if normal is None:
        return []
    actual = normal.size_pt
    if actual is not None and abs(actual - expected) > 0.1:
        return [Finding(
            rule_id="body-font-size",
            message=f"正文字号应为 {expected}pt（小四），Normal 样式实际 {actual}pt",
            expected=expected, actual=actual,
            location="Style: Normal", fixable=True,
        )]
    return []


@rule("body-east-asia-font")
def check_body_east_asia_font(docx, content, preset) -> list[Finding]:
    expected = preset.get("styles", {}).get("body", {}).get("east_asia")
    if not expected:
        return []
    normal = docx.styles.get("Normal")
    if normal is None or normal.east_asia is None:
        return []
    if normal.east_asia != expected:
        return [Finding(
            rule_id="body-east-asia-font",
            message=f"正文中文字体应为 {expected}，Normal 样式实际 {normal.east_asia}",
            expected=expected, actual=normal.east_asia,
            location="Style: Normal", fixable=True,
        )]
    return []


@rule("text-color-consistency", default_severity="warning")
def check_text_color_consistency(docx, content, preset) -> list[Finding]:
    """Visible thesis text should not inherit colored styles or direct colors."""
    non_black_styles = []
    for name, style in docx.styles.items():
        color = getattr(style, "color", None)
        theme_color = getattr(style, "theme_color", None)
        if theme_color or (color is not None and str(color).lower() not in {"000000", "auto"}):
            non_black_styles.append((name, color, theme_color))

    non_black_runs = getattr(docx, "non_black_runs", [])
    if not non_black_styles and not non_black_runs:
        return []

    style_preview = ", ".join(
        f"{name}={color or ''}/{theme or ''}"
        for name, color, theme in non_black_styles[:8]
    )
    run_preview = "; ".join(
        f"{item.source}: {item.text}"
        for item in non_black_runs[:3]
    )
    detail = []
    if non_black_styles:
        detail.append(f"非黑色样式 {len(non_black_styles)} 个: {style_preview}")
    if non_black_runs:
        detail.append(f"非黑色直接 run {len(non_black_runs)} 个: {run_preview}")

    return [Finding(
        rule_id="text-color-consistency",
        message="正文可见文字颜色应统一为黑色；" + "；".join(detail),
        expected="#000000",
        actual={"styles": len(non_black_styles), "runs": len(non_black_runs)},
        location="styles.xml / document.xml",
        fixable=True,
    )]


@rule("body-line-spacing", default_severity="warning")
def check_body_line_spacing(docx, content, preset) -> list[Finding]:
    expected = preset.get("styles", {}).get("body", {}).get("line_spacing")
    if expected is None:
        return []
    normal = docx.styles.get("Normal")
    if normal is None or normal.line_spacing is None:
        return []
    if abs(normal.line_spacing - expected) > 0.05:
        return [Finding(
            rule_id="body-line-spacing",
            message=f"正文行距应为 {expected}，Normal 样式实际 {normal.line_spacing}",
            expected=expected, actual=normal.line_spacing,
            location="Style: Normal", fixable=True,
        )]
    return []


def _check_heading(docx, preset, level: int, style_name: str) -> list[Finding]:
    cfg = preset.get("styles", {}).get(f"heading{level}")
    if not cfg:
        return []
    style = docx.styles.get(style_name)
    if style is None:
        return [Finding(
            rule_id=f"heading{level}-style",
            message=f"样式 {style_name} 不存在",
            location=f"Style: {style_name}", fixable=False,
        )]
    findings = []
    if cfg.get("east_asia") and style.east_asia and style.east_asia != cfg["east_asia"]:
        findings.append(Finding(
            rule_id=f"heading{level}-style",
            message=f"{style_name} 中文字体应为 {cfg['east_asia']}，实际 {style.east_asia}",
            expected=cfg["east_asia"], actual=style.east_asia,
            location=f"Style: {style_name}", fixable=True,
        ))
    if cfg.get("size_pt") and style.size_pt is not None and abs(style.size_pt - cfg["size_pt"]) > 0.1:
        findings.append(Finding(
            rule_id=f"heading{level}-style",
            message=f"{style_name} 字号应为 {cfg['size_pt']}pt，实际 {style.size_pt}pt",
            expected=cfg["size_pt"], actual=style.size_pt,
            location=f"Style: {style_name}", fixable=True,
        ))
    return findings


@rule("heading1-style")
def check_heading1(docx, content, preset) -> list[Finding]:
    return _check_heading(docx, preset, 1, "Heading 1")


@rule("heading2-style")
def check_heading2(docx, content, preset) -> list[Finding]:
    return _check_heading(docx, preset, 2, "Heading 2")


@rule("heading3-style", default_severity="warning")
def check_heading3(docx, content, preset) -> list[Finding]:
    return _check_heading(docx, preset, 3, "Heading 3")


CHAPTER_TEXT_RE = re.compile(r"^第\d+章\s+\S+")
SECTION_TEXT_RE = re.compile(r"^\d+\.\d+\s+\S+")
SUBSECTION_TEXT_RE = re.compile(r"^\d+\.\d+\.\d+\s+\S+")


@rule("heading-style-applied")
def check_heading_style_applied(docx, content, preset) -> list[Finding]:
    findings = []
    for p in docx.paragraphs:
        text = p.text.strip()
        if not text:
            continue
        if CHAPTER_TEXT_RE.match(text) and p.style_name != "Heading 1":
            findings.append(Finding(
                rule_id="heading-style-applied",
                message=f"段落 {p.index} 章标题 {text[:30]!r} 应使用 Heading 1，实际 {p.style_name}",
                expected="Heading 1", actual=p.style_name,
                location=f"Paragraph {p.index}", fixable=True,
            ))
        elif SUBSECTION_TEXT_RE.match(text) and p.style_name != "Heading 3":
            findings.append(Finding(
                rule_id="heading-style-applied",
                message=f"段落 {p.index} 三级标题 {text[:30]!r} 应使用 Heading 3，实际 {p.style_name}",
                expected="Heading 3", actual=p.style_name,
                location=f"Paragraph {p.index}", fixable=True,
            ))
        elif SECTION_TEXT_RE.match(text) and p.style_name != "Heading 2" and not SUBSECTION_TEXT_RE.match(text):
            findings.append(Finding(
                rule_id="heading-style-applied",
                message=f"段落 {p.index} 二级标题 {text[:30]!r} 应使用 Heading 2，实际 {p.style_name}",
                expected="Heading 2", actual=p.style_name,
                location=f"Paragraph {p.index}", fixable=True,
            ))
    return findings


@rule("chapter-page-break", default_severity="warning")
def check_chapter_page_break(docx, content, preset) -> list[Finding]:
    if not preset.get("structure", {}).get("chapter_page_break", True):
        return []
    findings = []
    chapter_paras = [p for p in docx.paragraphs if CHAPTER_TEXT_RE.match(p.text.strip())]
    for i, p in enumerate(chapter_paras):
        if i == 0:
            continue
        if not (p.page_break_before or p.has_page_break_run):
            prev_idx = p.index - 1
            prev_has_break = False
            if prev_idx >= 0:
                prev = docx.paragraphs[prev_idx]
                prev_has_break = prev.has_page_break_run
            if not prev_has_break:
                findings.append(Finding(
                    rule_id="chapter-page-break",
                    message=f"章 {p.text.strip()[:20]!r} 前缺少分页符",
                    location=f"Paragraph {p.index}", fixable=False,
                ))
    return findings


@rule("abstract-zh-length")
def check_abstract_zh_length(docx, content, preset) -> list[Finding]:
    min_chars = preset.get("content", {}).get("abstract_zh", {}).get("min_chars", 0)
    if min_chars == 0:
        return []
    if content.abstract_zh_chars < min_chars:
        return [Finding(
            rule_id="abstract-zh-length",
            message=f"中文摘要 {content.abstract_zh_chars} 个汉字，应不少于 {min_chars}",
            expected=min_chars, actual=content.abstract_zh_chars,
            location="中文摘要", fixable=False,
        )]
    return []


@rule("abstract-en-length", default_severity="warning")
def check_abstract_en_length(docx, content, preset) -> list[Finding]:
    min_words = preset.get("content", {}).get("abstract_en", {}).get("min_words", 0)
    if min_words == 0:
        return []
    if content.abstract_en_words < min_words:
        return [Finding(
            rule_id="abstract-en-length",
            message=f"英文摘要 {content.abstract_en_words} 词，应不少于 {min_words}",
            expected=min_words, actual=content.abstract_en_words,
            location="ABSTRACT", fixable=False,
        )]
    return []


@rule("foreign-translation-length")
def check_foreign_translation_length(docx, content, preset) -> list[Finding]:
    min_chars = preset.get("content", {}).get("foreign_translation", {}).get("min_chars", 0)
    if min_chars == 0:
        return []
    if content.foreign_translation_chars < min_chars:
        return [Finding(
            rule_id="foreign-translation-length",
            message=f"外文译文 {content.foreign_translation_chars} 个汉字，应不少于 {min_chars}",
            expected=min_chars, actual=content.foreign_translation_chars,
            location="附录二 外文译文", fixable=False,
        )]
    return []


@rule("toc-present")
def check_toc_present(docx, content, preset) -> list[Finding]:
    if not preset.get("content", {}).get("toc", {}).get("required", True):
        return []
    if not content.toc_present:
        return [Finding(
            rule_id="toc-present",
            message="未检测到目录页",
            location="目录", fixable=False,
        )]
    return []


@rule("cover-fields")
def check_cover_fields(docx, content, preset) -> list[Finding]:
    required = preset.get("content", {}).get("cover_fields", {}).get("required", [])
    if not required:
        return []
    found = set(content.cover_fields_found)
    # Pandoc can split cover table labels and values, but the raw full text still
    # contains the labels. Accept labels that appear in the first page/front
    # matter text so table-based school covers are not false failures.
    cover_text = content.full_text[:3000]
    compact_cover_text = re.sub(r"\s+", "", cover_text)
    for field in required:
        if field in cover_text or field in compact_cover_text:
            found.add(field)
    missing = [f for f in required if f not in found]
    if missing:
        return [Finding(
            rule_id="cover-fields",
            message=f"封面缺少字段: {'、'.join(missing)}",
            expected=required, actual=sorted(found),
            location="封面", fixable=False,
        )]
    return []


# --- NEW RULES: from 9-thesis analysis (2026-06-05) ---


BODY_STYLE_NAMES = {"Normal", "Body Text"}


def _expected_indent_twips(chars: int | float) -> int:
    # The current NCWU delivery contract uses 420 twips for a 2-character first-line indent.
    return int(round(float(chars) * 210))


def _effective_first_line_indent_twips(docx, paragraph) -> int | None:
    if paragraph.first_line_indent_twips is not None:
        return paragraph.first_line_indent_twips
    style = docx.styles.get(paragraph.style_name)
    return getattr(style, "first_line_indent_twips", None) if style else None


def _standard_figure_caption(text: str) -> bool:
    return bool(FIGURE_CAPTION_RE_RULE.match(text.strip()))


def _standard_table_caption(text: str) -> bool:
    return bool(TABLE_CAPTION_RE_RULE.match(text.strip()))


def _media_block_indices(docx) -> set[int]:
    blocks = {
        p.block_index for p in docx.paragraphs
        if p.block_index is not None and p.has_drawing
    }
    blocks.update(t.block_index for t in docx.tables if t.block_index is not None)
    return blocks


@rule("body-first-line-indent", default_severity="warning")
def check_body_first_line_indent(docx, content, preset) -> list[Finding]:
    expected_chars = preset.get("styles", {}).get("body", {}).get("first_line_indent_chars")
    if expected_chars is None:
        return []
    expected_twips = _expected_indent_twips(expected_chars)
    min_twips = int(expected_twips * 0.85)
    body_style = docx.styles.get("Body Text") or docx.styles.get("Normal")
    style_indent = getattr(body_style, "first_line_indent_twips", None) if body_style else None
    if style_indent is not None and style_indent >= min_twips:
        return []

    body_paragraphs = [
        p for p in docx.paragraphs
        if p.style_name in BODY_STYLE_NAMES
        and len(p.text.strip()) >= 20
        and not p.has_drawing
        and not _standard_figure_caption(p.text)
        and not _standard_table_caption(p.text)
    ][:80]
    missing = [
        p for p in body_paragraphs
        if (_effective_first_line_indent_twips(docx, p) or 0) < min_twips
    ]
    if body_paragraphs and len(missing) / len(body_paragraphs) > 0.2:
        return [Finding(
            rule_id="body-first-line-indent",
            message=f"正文首行缩进应约为 {expected_chars} 字符；抽样 {len(missing)}/{len(body_paragraphs)} 段不足",
            expected=f">={min_twips} twips",
            actual=f"style={style_indent}",
            location="Body Text / 正文段落",
            fixable=True,
        )]
    return []


@rule("page-number-format", default_severity="warning")
def check_page_number_format(docx, content, preset) -> list[Finding]:
    """正文页码应为阿拉伯数字居中底部。"""
    expected = preset.get("page", {}).get("page_number", {})
    if not expected:
        return []
    findings = []
    body_format = expected.get("body_format", "arabic")
    body_position = expected.get("body_position", "center_bottom")
    if not docx.sections:
        return []
    body_section = next((sec for sec in reversed(docx.sections) if sec.header_text), docx.sections[-1])
    expected_xml_format = "decimal" if body_format == "arabic" else body_format
    actual_format = body_section.page_number_format or "decimal"
    if actual_format != expected_xml_format:
        findings.append(Finding(
            rule_id="page-number-format",
            message=f"正文页码格式应为 {expected_xml_format}，实际 {actual_format}",
            expected=expected_xml_format,
            actual=actual_format,
            location=f"Section {body_section.index}",
            fixable=True,
        ))
    if body_section.page_number_start not in (1, None):
        findings.append(Finding(
            rule_id="page-number-format",
            message=f"正文页码应从 1 开始，实际 start={body_section.page_number_start}",
            expected=1,
            actual=body_section.page_number_start,
            location=f"Section {body_section.index}",
            fixable=True,
        ))
    if not body_section.footer_has_page_number:
        findings.append(Finding(
            rule_id="page-number-format",
            message="正文页脚未检测到页码域或页码文本",
            expected="footer PAGE",
            actual=body_section.footer_text,
            location=f"Section {body_section.index}",
            fixable=True,
        ))
    if body_position == "center_bottom" and body_section.footer_align != "center":
        findings.append(Finding(
            rule_id="page-number-format",
            message=f"正文页码应在页脚居中，实际对齐 {body_section.footer_align}",
            expected="center",
            actual=body_section.footer_align,
            location=f"Section {body_section.index}",
            fixable=True,
        ))
    return findings


@rule("page-number-roman-frontmatter", default_severity="warning")
def check_page_number_roman_frontmatter(docx, content, preset) -> list[Finding]:
    """前置部分（摘要/目录）应使用罗马数字页码。"""
    expected = preset.get("page", {}).get("page_number", {})
    if not expected.get("frontmatter_roman", False):
        return []
    roman_sections = [
        sec for sec in docx.sections
        if sec.page_number_format in {"lowerRoman", "upperRoman"}
    ]
    if not roman_sections:
        return [Finding(
            rule_id="page-number-roman-frontmatter",
            message="前置部分未检测到罗马数字页码节",
            expected="lowerRoman",
            actual=[s.page_number_format for s in docx.sections],
            location="Sections",
            fixable=True,
        )]
    bad = [
        sec for sec in roman_sections
        if sec.page_number_format != "lowerRoman" or sec.page_number_start not in (1, None)
    ]
    return [
        Finding(
            rule_id="page-number-roman-frontmatter",
            message=f"前置页码应为小写罗马数字并从 1 开始，Section {sec.index} 实际 fmt={sec.page_number_format}, start={sec.page_number_start}",
            expected={"fmt": "lowerRoman", "start": 1},
            actual={"fmt": sec.page_number_format, "start": sec.page_number_start},
            location=f"Section {sec.index}",
            fixable=True,
        )
        for sec in bad
    ]


@rule("header-underline", default_severity="warning")
def check_header_underline(docx, content, preset) -> list[Finding]:
    """页眉下方应有细横线。"""
    if not preset.get("page", {}).get("header_underline", False):
        return []
    findings = []
    for sec in docx.sections:
        if sec.header_text and not sec.header_has_bottom_border:
            findings.append(Finding(
                rule_id="header-underline",
                message=f"Section {sec.index} 页眉缺少下划线/底边框",
                expected="header paragraph bottom border",
                actual=False,
                location=f"Section {sec.index}",
                fixable=True,
            ))
    return findings


@rule("header-frontmatter-excluded", default_severity="warning")
def check_header_frontmatter_excluded(docx, content, preset) -> list[Finding]:
    """摘要/目录页不应有页眉（仅正文起有）。"""
    if not preset.get("page", {}).get("header_frontmatter_excluded", True):
        return []
    findings = []
    # First sections (cover + abstract + toc) should NOT have header text
    # Last section (body) should have header text
    if len(docx.sections) >= 2:
        for sec in docx.sections[:-1]:
            if sec.header_text and not sec.header_linked_to_previous:
                findings.append(Finding(
                    rule_id="header-frontmatter-excluded",
                    message=f"Section {sec.index}（前置部分）不应有页眉，实际有 {sec.header_text!r}",
                    location=f"Section {sec.index}", fixable=False,
                ))
    return findings


@rule("abstract-page-title", default_severity="warning")
def check_abstract_page_title(docx, content, preset) -> list[Finding]:
    """摘要页顶部应有论文中文题目（居中）。"""
    if not preset.get("content", {}).get("abstract_zh", {}).get("title_above", False):
        return []
    # Check paragraphs before the "摘  要" heading for a title-like paragraph
    for p in docx.paragraphs[:50]:
        text = p.text.strip()
        if "摘" in text and "要" in text and len(text) < 10:
            # Found abstract title - check if preceding para has thesis title
            idx = p.index
            if idx > 0:
                prev = docx.paragraphs[idx - 1]
                if len(prev.text.strip()) > 5:
                    return []  # There's content above abstract heading - likely title
            return [Finding(
                rule_id="abstract-page-title",
                message="摘要页上方缺少论文中文题目",
                location="摘要页", fixable=False,
            )]
    return []


@rule("abstract-title-spacing", default_severity="info")
def check_abstract_title_spacing(docx, content, preset) -> list[Finding]:
    """'摘  要'标题字间应空2格。"""
    if not preset.get("content", {}).get("abstract_zh", {}).get("title_spacing", False):
        return []
    for p in docx.paragraphs[:50]:
        text = p.text.strip()
        if text in ("摘要", "摘 要"):
            return [Finding(
                rule_id="abstract-title-spacing",
                message=f"摘要标题 {text!r} 字间距不足，应为 '摘  要'（中间空2格）",
                expected="摘  要", actual=text,
                location=f"Paragraph {p.index}", fixable=True,
            )]
        if "摘" in text and "要" in text and len(text) <= 5:
            break
    return []


@rule("keywords-bold", default_severity="info")
def check_keywords_bold(docx, content, preset) -> list[Finding]:
    """'关键词'三字应加粗。"""
    if not preset.get("content", {}).get("abstract_zh", {}).get("keywords_bold", False):
        return []
    for p in docx.paragraphs[:80]:
        if "关键词" in p.text:
            if not p.first_run_bold:
                return [Finding(
                    rule_id="keywords-bold",
                    message="'关键词'三字应加粗",
                    location=f"Paragraph {p.index}", fixable=True,
                )]
            break
    return []


@rule("classification-number", default_severity="info")
def check_classification_number(docx, content, preset) -> list[Finding]:
    """摘要末尾应有中图分类号。"""
    if not preset.get("content", {}).get("abstract_zh", {}).get("classification_number", False):
        return []
    # Search in pandoc text around abstract area
    if "中图分类号" not in content.full_text[:10000]:
        return [Finding(
            rule_id="classification-number",
            message="摘要区域未发现中图分类号（应有 '中图分类号：TPxxx'）",
            location="中文摘要", fixable=False,
        )]
    return []


@rule("toc-title-spacing", default_severity="info")
def check_toc_title_spacing(docx, content, preset) -> list[Finding]:
    """'目  录'标题字间应双空格。"""
    if not preset.get("content", {}).get("toc", {}).get("title_spacing", False):
        return []
    for p in docx.paragraphs[:60]:
        text = p.text.strip()
        if text in ("目录", "目 录"):
            return [Finding(
                rule_id="toc-title-spacing",
                message=f"目录标题 {text!r} 字间距不足，应为 '目  录'（中间双空格）",
                expected="目  录", actual=text,
                location=f"Paragraph {p.index}", fixable=True,
            )]
        if "目" in text and "录" in text and len(text) <= 5:
            break
    return []


@rule("toc-dotline", default_severity="info")
def check_toc_dotline(docx, content, preset) -> list[Finding]:
    """目录条目应有点线连接页码。"""
    if not preset.get("content", {}).get("toc", {}).get("dotline", False):
        return []
    if content.toc_present and getattr(docx, "toc_dot_leader_count", 0) <= 0:
        return [Finding(
            rule_id="toc-dotline",
            message="目录存在，但未检测到 tab leader=dot 的点线连接",
            expected="w:tab w:leader='dot'",
            actual=getattr(docx, "toc_dot_leader_count", 0),
            location="word/document.xml",
            fixable=True,
        )]
    return []


FIGURE_CAPTION_RE_RULE = re.compile(r"^图\s*(\d+)[\.\-](\d+)\s+")
TABLE_CAPTION_RE_RULE = re.compile(r"^表\s*(\d+)[\.\-](\d+)\s+")


def _compact_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _figure_caption_ref(text: str) -> tuple[str, int, int] | None:
    match = FIGURE_CAPTION_RE_RULE.match((text or "").strip())
    if not match:
        return None
    chapter = int(match.group(1))
    number = int(match.group(2))
    return f"图{chapter}.{number}", chapter, number


def _is_heading_paragraph(paragraph) -> bool:
    text = paragraph.text.strip()
    return (
        paragraph.style_name in {"Heading 1", "Heading 2", "Heading 3"}
        or bool(CHAPTER_TEXT_RE.match(text))
        or bool(SECTION_TEXT_RE.match(text))
        or bool(SUBSECTION_TEXT_RE.match(text))
    )


def _is_body_scope_marker(text: str) -> str | None:
    stripped = text.strip()
    if CHAPTER_TEXT_RE.match(stripped):
        return "body-start"
    if re.match(r"^(参考文献|附录|致\s*谢|致谢)$", stripped):
        return "body-end"
    return None


def _body_scope_paragraphs(docx) -> list:
    """Return paragraphs that belong to thesis body chapters."""
    out = []
    in_body = False
    for paragraph in docx.paragraphs:
        marker = _is_body_scope_marker(paragraph.text)
        if marker == "body-start":
            in_body = True
        elif marker == "body-end" and in_body:
            break
        if in_body:
            out.append(paragraph)
    return out


def _is_plain_body_paragraph(paragraph, *, min_chars: int = 1) -> bool:
    text = paragraph.text.strip()
    if len(text) < min_chars:
        return False
    if paragraph.has_drawing or _is_heading_paragraph(paragraph):
        return False
    if _standard_figure_caption(text) or _standard_table_caption(text):
        return False
    if re.match(r"^\[\d+\]", text):
        return False
    if paragraph.style_name in {"Code", "Source Code", "HTML Code", "Listing"}:
        return False
    return True


def _text_references_figure(text: str, chapter: int, number: int) -> bool:
    compact = _compact_text(text)
    exact = f"图{chapter}.{number}"
    if exact in compact:
        return True
    range_re = re.compile(rf"图{chapter}\.(\d+)(?:至|到|—|-|~)图?{chapter}\.(\d+)")
    for match in range_re.finditer(compact):
        start = int(match.group(1))
        end = int(match.group(2))
        if start <= number <= end:
            return True
    return False


def _has_figure_lead_text(docx, caption, lookback: int) -> bool:
    ref = _figure_caption_ref(caption.text)
    if ref is None:
        return False
    _label, chapter, number = ref
    start = max(0, caption.index - lookback)
    for paragraph in reversed(docx.paragraphs[start:caption.index]):
        text = paragraph.text.strip()
        if not text or paragraph.has_drawing:
            continue
        if _standard_figure_caption(text) or _standard_table_caption(text) or _is_heading_paragraph(paragraph):
            continue
        if _text_references_figure(text, chapter, number):
            return True
        compact = _compact_text(text)
        if "图" in compact and any(term in compact for term in ("所示", "如下", "展示", "说明", "方式", "见")):
            return True
    return False


def _has_figure_followup_text(docx, caption, lookahead: int, min_chars: int) -> bool:
    end = min(len(docx.paragraphs), caption.index + lookahead + 1)
    for paragraph in docx.paragraphs[caption.index + 1:end]:
        if _is_body_scope_marker(paragraph.text) == "body-end":
            break
        if not _is_plain_body_paragraph(paragraph, min_chars=min_chars):
            continue
        return True
    return False


def _caption_run_has_group_explanation(run: list, after_paragraphs: list) -> bool:
    if not run:
        return True
    first = _figure_caption_ref(run[0].text)
    last = _figure_caption_ref(run[-1].text)
    if first is None or last is None:
        return False
    _first_label, first_chapter, first_number = first
    _last_label, last_chapter, last_number = last
    if first_chapter != last_chapter:
        return False
    nearby = "\n".join(p.text for p in after_paragraphs[:4] if _is_plain_body_paragraph(p, min_chars=20))
    if not nearby:
        return False
    return (
        _text_references_figure(nearby, first_chapter, first_number)
        and _text_references_figure(nearby, last_chapter, last_number)
    )


@rule("readability-paragraph-length", default_severity="warning")
def check_readability_paragraph_length(docx, content, preset) -> list[Finding]:
    """正文段落不应过长，避免一大块文字压住阅读节奏。"""
    cfg = preset.get("readability", {})
    max_chars = int(cfg.get("max_body_paragraph_chars", 360) or 0)
    if max_chars <= 0:
        return []

    findings = []
    for paragraph in _body_scope_paragraphs(docx):
        if not _is_plain_body_paragraph(paragraph, min_chars=max_chars + 1):
            continue
        findings.append(Finding(
            rule_id="readability-paragraph-length",
            message=f"正文段落 {paragraph.index} 长度为 {len(paragraph.text.strip())} 字符，阅读节奏过密",
            expected=f"≤{max_chars} 字符",
            actual=len(paragraph.text.strip()),
            location=f"Paragraph {paragraph.index}",
            fixable=False,
        ))
    return findings


@rule("figure-lead-text", default_severity="warning")
def check_figure_lead_text(docx, content, preset) -> list[Finding]:
    """图前应有引导文字，先告诉读者为什么看这张图。"""
    cfg = preset.get("readability", {})
    if not cfg.get("require_figure_lead_text", True):
        return []
    lookback = int(cfg.get("figure_lead_lookback_paragraphs", 8) or 8)
    findings = []
    for paragraph in _body_scope_paragraphs(docx):
        text = paragraph.text.strip()
        if not _standard_figure_caption(text):
            continue
        if _has_figure_lead_text(docx, paragraph, lookback):
            continue
        findings.append(Finding(
            rule_id="figure-lead-text",
            message=f"图题 {text[:30]!r} 前缺少引导说明，图片不应直接砸进正文",
            expected=f"前 {lookback} 段内有图号或图组说明",
            actual="未找到",
            location=f"Paragraph {paragraph.index}",
            fixable=False,
        ))
    return findings


@rule("figure-followup-text", default_severity="warning")
def check_figure_followup_text(docx, content, preset) -> list[Finding]:
    """图后应有解释段，说明图里信息如何支撑正文。"""
    cfg = preset.get("readability", {})
    min_chars = int(cfg.get("min_figure_followup_chars", 40) or 40)
    lookahead = int(cfg.get("figure_followup_lookahead_paragraphs", 8) or 8)
    findings = []
    for paragraph in _body_scope_paragraphs(docx):
        text = paragraph.text.strip()
        if not _standard_figure_caption(text):
            continue
        if _has_figure_followup_text(docx, paragraph, lookahead, min_chars):
            continue
        findings.append(Finding(
            rule_id="figure-followup-text",
            message=f"图题 {text[:30]!r} 后缺少解释段，题注后不能只有截图堆叠",
            expected=f"后 {lookahead} 段内有不少于 {min_chars} 字的说明",
            actual="未找到",
            location=f"Paragraph {paragraph.index}",
            fixable=False,
        ))
    return findings


@rule("figure-text-balance", default_severity="warning")
def check_figure_text_balance(docx, content, preset) -> list[Finding]:
    """连续图片数量应受控；截图组必须有总括解释。"""
    cfg = preset.get("readability", {})
    max_run = int(cfg.get("max_consecutive_figures_without_text", 3) or 0)
    if max_run <= 0:
        return []

    body_paragraphs = _body_scope_paragraphs(docx)
    findings = []
    run: list = []

    def close_run(after_index: int) -> None:
        nonlocal run
        if len(run) > max_run:
            after = [p for p in body_paragraphs if p.index >= after_index][:10]
            if not _caption_run_has_group_explanation(run, after):
                findings.append(Finding(
                    rule_id="figure-text-balance",
                    message=f"连续出现 {len(run)} 个图题但缺少图组解释，图片与正文比例失衡",
                    expected=f"≤{max_run} 个连续图题，或后文用图号范围总括说明",
                    actual=[p.text.strip() for p in run],
                    location=f"Paragraph {run[0].index}",
                    fixable=False,
                ))
        run = []

    for paragraph in body_paragraphs:
        text = paragraph.text.strip()
        if _standard_figure_caption(text):
            run.append(paragraph)
            continue
        if not text or paragraph.has_drawing or _is_heading_paragraph(paragraph):
            continue
        close_run(paragraph.index)
    if run:
        close_run(run[-1].index)
    return findings


@rule("module-visual-block", default_severity="warning")
def check_module_visual_block(docx, content, preset) -> list[Finding]:
    """关键模块图应形成“实物/说明或原理图/分段解释”的可读视觉块。"""
    cfg = preset.get("readability", {}).get("module_block", {})
    if not cfg.get("enabled", False):
        return []
    targets = cfg.get("target_captions", [])
    lead_terms = cfg.get("required_lead_terms", [])
    chain_terms = cfg.get("required_chain_terms", [])
    findings = []

    for target in targets:
        caption = next(
            (
                p for p in docx.paragraphs
                if _compact_text(target) in _compact_text(p.text)
            ),
            None,
        )
        if caption is None:
            findings.append(Finding(
                rule_id="module-visual-block",
                message=f"未找到目标模块图题 {target!r}",
                expected=target,
                actual="missing",
                location="正文",
                fixable=False,
            ))
            continue

        before = docx.paragraphs[max(0, caption.index - 8):caption.index]
        nearby = docx.paragraphs[max(0, caption.index - 8):min(len(docx.paragraphs), caption.index + 14)]
        before_text = _compact_text("\n".join(p.text for p in before))
        nearby_text = _compact_text("\n".join(p.text for p in nearby))
        missing_lead = [term for term in lead_terms if _compact_text(term) not in before_text]
        missing_chain = [term for term in chain_terms if _compact_text(term) not in nearby_text]
        if missing_lead or missing_chain:
            findings.append(Finding(
                rule_id="module-visual-block",
                message=f"{target} 附近缺少模块视觉块说明：前导缺 {missing_lead}，链路缺 {missing_chain}",
                expected={"lead_terms": lead_terms, "chain_terms": chain_terms},
                actual={"missing_lead": missing_lead, "missing_chain": missing_chain},
                location=f"Paragraph {caption.index}",
                fixable=False,
            ))
    return findings


@rule("caption-not-italic", default_severity="warning")
def check_caption_not_italic(docx, content, preset) -> list[Finding]:
    """图题、表题不应继承斜体样式，避免题注看起来像临时标注。"""
    cfg = preset.get("styles", {}).get("caption", {})
    if cfg.get("italic", False) is not False:
        return []

    findings = []
    for style_name in ("Caption", "caption"):
        style = docx.styles.get(style_name)
        if style is not None and getattr(style, "italic", None) is True:
            findings.append(Finding(
                rule_id="caption-not-italic",
                message=f"{style_name} 样式被设置为斜体，图表题应为常规字形",
                expected="italic=False",
                actual="italic=True",
                location=f"Style: {style_name}",
                fixable=True,
            ))

    for paragraph in docx.paragraphs:
        text = paragraph.text.strip()
        if not (_standard_figure_caption(text) or _standard_table_caption(text)):
            continue
        style = docx.styles.get(paragraph.style_name)
        style_italic = getattr(style, "italic", None) if style is not None else None
        if paragraph.first_run_italic is True or style_italic is True:
            findings.append(Finding(
                rule_id="caption-not-italic",
                message=f"图表题 {text[:30]!r} 存在斜体格式",
                expected="caption style/run italic=False",
                actual={"style": paragraph.style_name, "style_italic": style_italic, "run_italic": paragraph.first_run_italic},
                location=f"Paragraph {paragraph.index}",
                fixable=True,
            ))
            if len(findings) >= 8:
                break
    return findings


def _chapter_paragraphs(docx, chapter_prefix: str) -> list:
    paragraphs = []
    in_chapter = False
    for paragraph in docx.paragraphs:
        text = paragraph.text.strip()
        if text.startswith(chapter_prefix):
            in_chapter = True
        elif in_chapter and CHAPTER_TEXT_RE.match(text):
            break
        if in_chapter:
            paragraphs.append(paragraph)
    return paragraphs


@rule("engineering-evidence-chain", default_severity="warning")
def check_engineering_evidence_chain(docx, content, preset) -> list[Finding]:
    """硬件章节应把实物、原理图、PCB/接口、固件源码和测试验证连成证据链。"""
    cfg = preset.get("readability", {}).get("engineering_evidence_chain", {})
    if not cfg.get("enabled", False):
        return []

    chapter_prefix = cfg.get("chapter_prefix", "第3章")
    paragraphs = _chapter_paragraphs(docx, chapter_prefix)
    if not paragraphs:
        return [Finding(
            rule_id="engineering-evidence-chain",
            message=f"未找到工程证据链目标章节 {chapter_prefix}",
            expected=chapter_prefix,
            actual="missing",
            location="正文",
            fixable=False,
        )]

    chapter_text = "\n".join(p.text for p in paragraphs)
    compact = _compact_text(chapter_text)
    findings = []

    missing_captions = [
        caption for caption in cfg.get("required_captions", [])
        if _compact_text(caption) not in compact
    ]
    missing_groups = []
    for group in cfg.get("required_term_groups", []):
        name = group.get("name", "unnamed")
        terms = group.get("any_of", [])
        if terms and not any(_compact_text(term) in compact for term in terms):
            missing_groups.append({"name": name, "any_of": terms})

    if missing_captions or missing_groups:
        findings.append(Finding(
            rule_id="engineering-evidence-chain",
            message=(
                f"{chapter_prefix} 工程证据链不完整：缺少图题 {missing_captions}，"
                f"缺少证据组 {[group['name'] for group in missing_groups]}"
            ),
            expected={"captions": cfg.get("required_captions", []), "term_groups": cfg.get("required_term_groups", [])},
            actual={"missing_captions": missing_captions, "missing_groups": missing_groups},
            location=chapter_prefix,
            fixable=False,
        ))
    return findings


@rule("figure-caption-position", default_severity="warning")
def check_figure_caption_position(docx, content, preset) -> list[Finding]:
    """图题应在图下方（即图片段落之后）。"""
    if not preset.get("structure", {}).get("figure_caption_below", True):
        return []
    findings = []
    media_blocks = _media_block_indices(docx)
    for p in docx.paragraphs:
        text = p.text.strip()
        if not _standard_figure_caption(text) or p.block_index is None:
            continue
        previous_media = [
            block for block in media_blocks
            if 0 < p.block_index - block <= 4
        ]
        if previous_media:
            continue
        next_media = [
            block for block in media_blocks
            if 0 < block - p.block_index <= 3
        ]
        relation = "题注在图上方" if next_media else "题注附近未找到图片/图形表格"
        findings.append(Finding(
            rule_id="figure-caption-position",
            message=f"图题 {text[:30]!r} 应位于图下方，实际 {relation}",
            expected="image/table block before caption",
            actual={"caption_block": p.block_index, "near_next_media": next_media[:3]},
            location=f"Paragraph {p.index}",
            fixable=False,
        ))
    return findings


@rule("table-caption-position", default_severity="warning")
def check_table_caption_position(docx, content, preset) -> list[Finding]:
    """表题应在表上方（即表格之前）。"""
    if not preset.get("structure", {}).get("table_caption_above", True):
        return []
    table_blocks = {t.block_index for t in docx.tables if t.block_index is not None}
    findings = []
    for p in docx.paragraphs:
        text = p.text.strip()
        if not _standard_table_caption(text) or p.block_index is None:
            continue
        next_tables = [
            block for block in table_blocks
            if 0 < block - p.block_index <= 2
        ]
        if next_tables:
            continue
        previous_tables = [
            block for block in table_blocks
            if 0 < p.block_index - block <= 2
        ]
        relation = "表题在表格下方" if previous_tables else "表题后未紧跟表格"
        findings.append(Finding(
            rule_id="table-caption-position",
            message=f"表题 {text[:30]!r} 应位于表格上方，实际 {relation}",
            expected="table block immediately after caption",
            actual={"caption_block": p.block_index, "near_previous_tables": previous_tables[:3]},
            location=f"Paragraph {p.index}",
            fixable=False,
        ))
    return findings


@rule("figure-table-numbering", default_severity="warning")
def check_figure_table_numbering(docx, content, preset) -> list[Finding]:
    """图表编号应按章编号（图X.Y / 表X.Y 点号分隔）。"""
    numbering = preset.get("structure", {}).get("figure_table_numbering", "chapter_dot")
    if numbering != "chapter_dot":
        return []
    findings = []
    bad_patterns = []
    for p in docx.paragraphs:
        text = p.text.strip()
        # Check for dash-separated numbering like 图3-1 instead of 图3.1
        if re.match(r"^图\s*\d+\-\d+", text):
            bad_patterns.append((p.index, text[:20]))
        if re.match(r"^表\s*\d+\-\d+", text):
            bad_patterns.append((p.index, text[:20]))
        # Check for non-chapter numbering like 图1, 图2 (no dot)
        if re.match(r"^图\s*\d+\s+[^\.]", text) and not re.match(r"^图\s*\d+\.\d+", text):
            bad_patterns.append((p.index, text[:20]))
    if bad_patterns:
        for idx, txt in bad_patterns[:5]:
            findings.append(Finding(
                rule_id="figure-table-numbering",
                message=f"图表编号应为章号制点号分隔（图X.Y），实际 {txt!r}",
                expected="图X.Y / 表X.Y", actual=txt,
                location=f"Paragraph {idx}", fixable=False,
            ))
    return findings


@rule("reference-superscript", default_severity="warning")
def check_reference_superscript(docx, content, preset) -> list[Finding]:
    """正文引用应为上角标 [n] 格式。"""
    if not preset.get("structure", {}).get("reference_superscript", True):
        return []
    # Look for inline [n] references that are NOT superscript
    inline_ref_re = re.compile(r"\[\d+\]")
    non_super_refs = []
    for p in docx.paragraphs:
        text = p.text.strip()
        if not text or p.style_name in ("Heading 1", "Heading 2", "Heading 3"):
            continue
        # Skip paragraphs that ARE the reference list
        if text.startswith("[") and re.match(r"^\[\d+\]", text):
            continue
        matches = inline_ref_re.findall(text)
        if not matches:
            continue

        if getattr(p, "inline_ref_not_superscript_count", 0) > 0:
            non_super_refs.append((p.index, text[:40]))
    if len(non_super_refs) > 3:
        return [Finding(
            rule_id="reference-superscript",
            message=f"发现 {len(non_super_refs)} 处正文引用 [n] 未使用上角标格式",
            expected="上角标 [n]", actual=f"{len(non_super_refs)} 处内嵌引用",
            location="正文", fixable=False,
        )]
    return []


@rule("reference-format", default_severity="info")
def check_reference_format(docx, content, preset) -> list[Finding]:
    """参考文献列表应使用 [n] 顶格 GB/T 7714 格式。"""
    if not preset.get("structure", {}).get("reference_gbt7714", True):
        return []
    # Check reference section formatting
    in_refs = False
    bad_format = []
    for p in docx.paragraphs:
        text = p.text.strip()
        if "参考文献" in text and len(text) < 10:
            in_refs = True
            continue
        if in_refs:
            if not text:
                continue
            if re.match(r"^(附录|致\s*谢)", text):
                break
            # Each reference should start with [n]
            if text and not re.match(r"^\[\d+\]", text):
                bad_format.append((p.index, text[:30]))
    if bad_format:
        return [Finding(
            rule_id="reference-format",
            message=f"参考文献列表有 {len(bad_format)} 条未使用 [n] 编号格式",
            expected="[n] 顶格", actual=f"{len(bad_format)} 条格式异常",
            location="参考文献", fixable=False,
        )]
    return []


@rule("cover-no-page-number", default_severity="info")
def check_cover_no_page_number(docx, content, preset) -> list[Finding]:
    """封面/声明/授权页不应有页码。"""
    if not preset.get("page", {}).get("page_number", {}).get("cover_excluded", True):
        return []
    if not docx.sections:
        return []
    first_visible_number_idx = next(
        (
            sec.index for sec in docx.sections
            if sec.page_number_format in {"lowerRoman", "upperRoman", "decimal"}
            and sec.page_number_start != 0
        ),
        next((sec.index for sec in docx.sections if sec.header_text), 1),
    )
    findings = []
    for sec in docx.sections[:max(1, first_visible_number_idx)]:
        if sec.footer_has_page_number or sec.footer_text.strip():
            findings.append(Finding(
                rule_id="cover-no-page-number",
                message=f"封面/声明前置节不应显示页码，Section {sec.index} 页脚为 {sec.footer_text!r}",
                expected="no footer page number",
                actual={"footer_text": sec.footer_text, "has_page_number": sec.footer_has_page_number},
                location=f"Section {sec.index}",
                fixable=True,
            ))
    return findings


@rule("chapter-numbering-arabic", default_severity="info")
def check_chapter_numbering_arabic(docx, content, preset) -> list[Finding]:
    """章号应使用阿拉伯数字（'第1章' 而非 '第一章'）。"""
    if not preset.get("structure", {}).get("chapter_numbering_arabic", True):
        return []
    chinese_num_re = re.compile(r"^第[一二三四五六七八九十]+章")
    findings = []
    for p in docx.paragraphs:
        text = p.text.strip()
        if chinese_num_re.match(text):
            findings.append(Finding(
                rule_id="chapter-numbering-arabic",
                message=f"章号应使用阿拉伯数字，实际 {text[:15]!r}",
                expected="第N章 (阿拉伯)", actual=text[:15],
                location=f"Paragraph {p.index}", fixable=False,
            ))
    return findings


# --- Rules from 张晓华 checklist (2026-06-05) ---


@rule("keywords-separator", default_severity="warning")
def check_keywords_separator(docx, content, preset) -> list[Finding]:
    """关键词应使用中文分号'；'分隔，不是逗号或英文分号。"""
    if not preset.get("content", {}).get("abstract_zh", {}).get("keywords_separator", "；"):
        return []
    for p in docx.paragraphs[:80]:
        text = p.text.strip()
        if "关键词" in text and "：" in text:
            kw_part = text.split("：", 1)[-1] if "：" in text else text.split(":", 1)[-1]
            if "," in kw_part or "、" in kw_part:
                return [Finding(
                    rule_id="keywords-separator",
                    message=f"关键词应使用中文分号'；'分隔，实际包含逗号或顿号",
                    expected="关键词间用'；'", actual=kw_part[:40],
                    location=f"Paragraph {p.index}", fixable=True,
                )]
            if ";" in kw_part and "；" not in kw_part:
                return [Finding(
                    rule_id="keywords-separator",
                    message=f"关键词应使用中文分号'；'，实际用了英文分号';'",
                    expected="；", actual=";",
                    location=f"Paragraph {p.index}", fixable=True,
                )]
            break
    return []


@rule("figure-table-centered", default_severity="warning")
def check_figure_table_centered(docx, content, preset) -> list[Finding]:
    """图和表应居中对齐。"""
    if not preset.get("structure", {}).get("figure_table_centered", True):
        return []
    findings = []
    caption_re = re.compile(r"^(图|表)\s*\d+[\.\-]\d+")
    for p in docx.paragraphs:
        text = p.text.strip()
        if caption_re.match(text):
            if p.align and p.align not in ("center", "both"):
                findings.append(Finding(
                    rule_id="figure-table-centered",
                    message=f"图表题注 {text[:20]!r} 应居中，实际对齐 {p.align}",
                    expected="center", actual=p.align,
                    location=f"Paragraph {p.index}", fixable=True,
                ))
    if len(findings) > 5:
        return [Finding(
            rule_id="figure-table-centered",
            message=f"发现 {len(findings)} 处图表题注未居中",
            location="正文", fixable=True,
        )]
    return findings


@rule("excessive-whitespace", default_severity="warning")
def check_excessive_whitespace(docx, content, preset) -> list[Finding]:
    """正文不应出现连续多个空段落（大段空白）。"""
    if not preset.get("structure", {}).get("max_consecutive_empty", 3):
        return []
    max_empty = preset.get("structure", {}).get("max_consecutive_empty", 3)
    findings = []
    consecutive = 0
    in_body = False
    for p in docx.paragraphs:
        text = p.text.strip()
        if re.match(r"^第\d+章", text):
            in_body = True
        if not p.text.strip():
            consecutive += 1
        else:
            if in_body and consecutive > max_empty:
                findings.append(Finding(
                    rule_id="excessive-whitespace",
                    message=f"段落 {p.index} 前有 {consecutive} 个连续空段落，疑似大段空白",
                    expected=f"≤{max_empty} 个连续空段落",
                    actual=str(consecutive),
                    location=f"Paragraph {p.index}", fixable=False,
                ))
            consecutive = 0
    return findings


@rule("reference-all-cited", default_severity="warning")
def check_reference_all_cited(docx, content, preset) -> list[Finding]:
    """参考文献列表中的每条应在正文中被引用。"""
    if not preset.get("structure", {}).get("reference_all_cited", True):
        return []
    # Collect reference list numbers
    in_refs = False
    ref_nums: set[int] = set()
    for p in docx.paragraphs:
        text = p.text.strip()
        if "参考文献" in text and len(text) < 10:
            in_refs = True
            continue
        if in_refs:
            if re.match(r"^(附录|致\s*谢)", text):
                break
            m = re.match(r"^\[(\d+)\]", text)
            if m:
                ref_nums.add(int(m.group(1)))

    if not ref_nums:
        return []

    # Check which refs are cited in body
    cited: set[int] = set()
    for p in docx.paragraphs:
        text = p.text
        if "参考文献" in text and len(text.strip()) < 10:
            break
        for m in re.finditer(r"\[(\d+)\]", text):
            cited.add(int(m.group(1)))

    uncited = ref_nums - cited
    if uncited:
        return [Finding(
            rule_id="reference-all-cited",
            message=f"参考文献中 [{', '.join(str(n) for n in sorted(uncited))}] 未在正文引用",
            expected="全部被引用", actual=f"{len(uncited)} 条未引用",
            location="参考文献", fixable=False,
        )]
    return []


@rule("table-no-page-break", default_severity="info")
def check_table_no_page_break(docx, content, preset) -> list[Finding]:
    """正文表格行应设置不跨页断开。"""
    if not preset.get("structure", {}).get("table_three_line", True):
        return []
    caption_blocks = {
        p.block_index for p in docx.paragraphs
        if p.block_index is not None and _standard_table_caption(p.text)
    }
    findings = []
    for table in docx.tables:
        if table.block_index is None:
            continue
        has_standard_caption = any(
            0 < table.block_index - caption_block <= 2
            for caption_block in caption_blocks
        )
        if not has_standard_caption:
            continue
        if not table.all_rows_cant_split:
            findings.append(Finding(
                rule_id="table-no-page-break",
                message=f"表格 {table.index} 有 {len(table.rows_missing_cant_split)} 行缺少 w:cantSplit，可能被分页切断",
                expected="all rows w:cantSplit",
                actual=table.rows_missing_cant_split[:10],
                location=f"Table {table.index}",
                fixable=True,
            ))
    return findings


@rule("code-block-length", default_severity="info")
def check_code_block_length(docx, content, preset) -> list[Finding]:
    """正文中连续代码/资料段落不宜过长（避免大段粘贴）。"""
    max_lines = preset.get("structure", {}).get("max_code_block_lines", 30)
    if not max_lines:
        return []
    # Detect code-like paragraphs: monospace font or specific style names
    findings = []
    consecutive_code = 0
    code_start_idx = 0
    for p in docx.paragraphs:
        is_code = False
        if p.style_name in ("Code", "Source Code", "HTML Code", "Listing"):
            is_code = True
        elif p.first_run_latin and "Courier" in (p.first_run_latin or ""):
            is_code = True
        elif p.first_run_latin and "Consolas" in (p.first_run_latin or ""):
            is_code = True
        if is_code:
            if consecutive_code == 0:
                code_start_idx = p.index
            consecutive_code += 1
        else:
            if consecutive_code > max_lines:
                findings.append(Finding(
                    rule_id="code-block-length",
                    message=f"段落 {code_start_idx} 起连续 {consecutive_code} 行代码/资料，过长",
                    expected=f"≤{max_lines} 行", actual=str(consecutive_code),
                    location=f"Paragraph {code_start_idx}", fixable=False,
                ))
            consecutive_code = 0
    return findings


@rule("cover-advisor-consistency", default_severity="warning")
def check_cover_advisor_consistency(docx, content, preset) -> list[Finding]:
    """封面指导教师与致谢中提到的老师应一致。"""
    if not preset.get("content", {}).get("cover_advisor_consistency", True):
        return []
    # Extract advisor name from cover (pandoc output)
    advisor_name = ""
    cover_text = content.full_text[:3000]
    m = re.search(r"指导教师[^\n]*?[\*\s]+([^\*\s\n]{2,4})", cover_text)
    if m:
        advisor_name = m.group(1).strip()
    if not advisor_name:
        # Fallback for table-based school covers in plain extracted text.
        m = re.search(r"指导教师\s*([^\s\n]{2,4})", cover_text)
        if m:
            advisor_name = m.group(1).strip()

    if not advisor_name:
        return []

    # Check if advisor appears in 致谢 section
    thanks_start = content.full_text.find("致谢")
    if thanks_start < 0:
        thanks_start = content.full_text.find("致  谢")
    if thanks_start < 0:
        return []
    thanks_block = content.full_text[thanks_start:thanks_start + 2000]
    if advisor_name not in thanks_block:
        return [Finding(
            rule_id="cover-advisor-consistency",
            message=f"封面指导教师 {advisor_name!r} 未在致谢中出现，可能不一致",
            expected=advisor_name, actual="致谢中未提及",
            location="致谢", fixable=False,
        )]
    return []
