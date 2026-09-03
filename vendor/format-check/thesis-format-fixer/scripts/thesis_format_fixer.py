#!/usr/bin/env python3
"""Audit and normalize common thesis formatting rules in DOCX files."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
ET.register_namespace("w", W_NS)


def qn(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def load_rules(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        return ET.fromstring(archive.read(name))
    except KeyError as exc:
        raise ValueError(f"Missing required DOCX component: {name}") from exc
    except ET.ParseError as exc:
        raise ValueError(f"Invalid XML in DOCX component: {name}") from exc


STYLE_ORDER = [
    "name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden", "uiPriority",
    "semiHidden", "unhideWhenUsed", "qFormat", "locked", "personal", "personalCompose",
    "personalReply", "rsid", "pPr", "rPr", "tblPr", "trPr", "tcPr",
]
PPR_ORDER = [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "widowControl", "numPr",
    "suppressLineNumbers", "pBdr", "shd", "tabs", "spacing", "ind", "jc",
    "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId",
    "cnfStyle", "rPr", "sectPr", "pPrChange",
]
RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid",
    "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz",
    "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign",
    "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
]
SECTPR_ORDER = [
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz",
    "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType", "cols", "formProt",
    "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter",
    "docGrid", "printerSettings", "sectPrChange",
]


def get_or_add(parent: ET.Element, name: str, order: list[str] | None = None) -> ET.Element:
    element = parent.find(f"w:{name}", NS)
    if element is None:
        element = ET.Element(qn(name))
        if order and name in order:
            target_position = order.index(name)
            for index, child in enumerate(parent):
                child_name = child.tag.rsplit("}", 1)[-1]
                if child_name in order and order.index(child_name) > target_position:
                    parent.insert(index, element)
                    break
            else:
                parent.append(element)
        else:
            parent.append(element)
    return element


def paragraph_text(paragraph: ET.Element) -> str:
    return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS)).strip()


def style_catalog(styles_root: ET.Element) -> tuple[dict[str, ET.Element], dict[str, str]]:
    by_id = {}
    names = {}
    for style in styles_root.findall("w:style", NS):
        style_id = style.get(qn("styleId"))
        if not style_id:
            continue
        by_id[style_id] = style
        name = style.find("w:name", NS)
        names[style_id] = name.get(qn("val"), style_id) if name is not None else style_id
    return by_id, names


def default_paragraph_style_id(styles_root: ET.Element) -> str:
    for style in styles_root.findall("w:style", NS):
        if style.get(qn("type")) == "paragraph" and style.get(qn("default")) == "1":
            return style.get(qn("styleId"), "Normal")
    return "Normal"


def paragraph_style_id(paragraph: ET.Element, default_style_id: str = "Normal") -> str:
    style = paragraph.find("w:pPr/w:pStyle", NS)
    return style.get(qn("val"), default_style_id) if style is not None else default_style_id


def element_attrs(element: ET.Element | None) -> dict[str, str]:
    if element is None:
        return {}
    return {key.rsplit("}", 1)[-1]: value for key, value in element.attrib.items()}


def style_snapshot(style: ET.Element) -> dict:
    ppr = style.find("w:pPr", NS)
    rpr = style.find("w:rPr", NS)
    return {
        "alignment": element_attrs(ppr.find("w:jc", NS) if ppr is not None else None).get("val"),
        "spacing": element_attrs(ppr.find("w:spacing", NS) if ppr is not None else None),
        "indent": element_attrs(ppr.find("w:ind", NS) if ppr is not None else None),
        "fonts": element_attrs(rpr.find("w:rFonts", NS) if rpr is not None else None),
        "size_half_points": element_attrs(rpr.find("w:sz", NS) if rpr is not None else None).get("val"),
        "bold": rpr is not None and rpr.find("w:b", NS) is not None,
    }


def expected_style_snapshot(config: dict) -> dict:
    spacing = config.get("spacing")
    if spacing is None:
        spacing = {
            key: config[key]
            for key in ("line", "before", "after")
            if key in config
        }
        if "line_rule" in config:
            spacing["lineRule"] = config["line_rule"]
    indent = config.get("indent")
    if indent is None:
        indent = {"firstLine": config["first_line"]} if "first_line" in config else {}
    fonts = config.get("fonts")
    if fonts is None:
        fonts = {}
        if "font_ascii" in config:
            fonts["ascii"] = config["font_ascii"]
            fonts["hAnsi"] = config["font_ascii"]
        if "font_east_asia" in config:
            fonts["eastAsia"] = config["font_east_asia"]
    return {
        "alignment": config.get("alignment"),
        "spacing": {str(key): str(value) for key, value in spacing.items()},
        "indent": {str(key): str(value) for key, value in indent.items()},
        "fonts": {str(key): str(value) for key, value in fonts.items()},
        "size_half_points": str(config["size_half_points"]) if config.get("size_half_points") is not None else None,
        "bold": bool(config.get("bold", False)),
    }


def section_snapshot(section: ET.Element) -> dict:
    return {
        "page_size": element_attrs(section.find("w:pgSz", NS)),
        "margins": element_attrs(section.find("w:pgMar", NS)),
        "page_number": element_attrs(section.find("w:pgNumType", NS)),
        "title_page": section.find("w:titlePg", NS) is not None,
    }


def add_issue(report: dict, severity: str, category: str, message: str) -> None:
    report["issues"].append(
        {"severity": severity, "category": category, "message": message}
    )


def analyze(document_root: ET.Element, styles_root: ET.Element, rules: dict) -> dict:
    by_id, style_names = style_catalog(styles_root)
    default_style_id = default_paragraph_style_id(styles_root)
    paragraphs = document_root.findall(".//w:body/w:p", NS)
    style_counts = Counter(paragraph_style_id(paragraph, default_style_id) for paragraph in paragraphs)
    text_paragraphs = [paragraph for paragraph in paragraphs if paragraph_text(paragraph)]
    report = {
        "summary": {
            "paragraphs": len(paragraphs),
            "non_empty_paragraphs": len(text_paragraphs),
            "tables": len(document_root.findall(".//w:tbl", NS)),
            "images": len(document_root.findall(".//w:drawing", NS)),
            "sections": len(document_root.findall(".//w:sectPr", NS)),
            "has_toc": any(
                "TOC" in (node.text or "")
                for node in document_root.findall(".//w:instrText", NS)
            ),
        },
        "style_counts": {
            style_names.get(style_id, style_id): count
            for style_id, count in sorted(style_counts.items())
        },
        "issues": [],
        "manual_review": list(rules.get("manual_review", [])),
        "changes": [],
    }

    for style_id in rules.get("styles", {}):
        if style_id not in by_id:
            add_issue(
                report,
                "warning",
                "style",
                f"Style '{style_id}' is not present in the document; it cannot be normalized automatically.",
            )
        elif style_snapshot(by_id[style_id]) != expected_style_snapshot(rules["styles"][style_id]):
            add_issue(
                report,
                "warning",
                "style",
                f"Style '{style_names.get(style_id, style_id)}' ({style_id}) differs from the selected rules profile.",
            )

    sections = document_root.findall(".//w:sectPr", NS)
    expected_sections = rules.get("document", {}).get("sections")
    if expected_sections is not None:
        if len(sections) != len(expected_sections):
            add_issue(
                report,
                "warning",
                "section",
                f"Document has {len(sections)} sections; rules profile expects {len(expected_sections)}.",
            )
        for index, (section, expected) in enumerate(zip(sections, expected_sections), start=1):
            if section_snapshot(section) != expected:
                add_issue(
                    report,
                    "warning",
                    "section",
                    f"Section {index} layout differs from the selected rules profile.",
                )

    heading_levels = {}
    for style_id, style in by_id.items():
        name = style_names.get(style_id, "")
        match = re.match(r"^(?:heading|标题)\s*(\d+)", name, re.IGNORECASE)
        if match:
            heading_levels[style_id] = int(match.group(1))
    for style_id, config in rules.get("styles", {}).items():
        if config.get("heading_level") is not None:
            heading_levels[style_id] = int(config["heading_level"])
    heading_sequence = []
    for index, paragraph in enumerate(paragraphs, start=1):
        text = paragraph_text(paragraph)
        style_id = paragraph_style_id(paragraph, default_style_id)
        if not text:
            continue
        if style_id in heading_levels:
            heading_sequence.append((index, heading_levels[style_id], text))

    previous_level = 0
    for index, level, text in heading_sequence:
        if previous_level and level > previous_level + 1:
            add_issue(
                report,
                "warning",
                "heading",
                f"Paragraph {index} jumps from heading level {previous_level} to {level}: {text[:50]}",
            )
        previous_level = level

    if rules.get("document", {}).get("require_toc") and not report["summary"]["has_toc"]:
        add_issue(report, "warning", "toc", "No automatic table of contents field was found.")
    if report["summary"]["images"]:
        report["manual_review"].append("Verify every figure caption, numbering sequence, and source note.")
    if report["summary"]["tables"]:
        report["manual_review"].append("Verify every table caption, numbering sequence, and page break.")
    report["manual_review"] = sorted(set(report["manual_review"]))
    return report


def set_style_properties(style: ET.Element, config: dict) -> None:
    ppr = get_or_add(style, "pPr", STYLE_ORDER)
    rpr = get_or_add(style, "rPr", STYLE_ORDER)

    if config.get("alignment") is not None:
        get_or_add(ppr, "jc", PPR_ORDER).set(qn("val"), config["alignment"])
    elif "alignment" in config:
        alignment = ppr.find("w:jc", NS)
        if alignment is not None:
            ppr.remove(alignment)
    if any(key in config for key in ("line", "line_rule", "before", "after")):
        spacing = get_or_add(ppr, "spacing", PPR_ORDER)
        for key in ("line", "before", "after"):
            if key in config:
                spacing.set(qn(key), str(config[key]))
        if "line_rule" in config:
            spacing.set(qn("lineRule"), config["line_rule"])
    if "first_line" in config:
        get_or_add(ppr, "ind", PPR_ORDER).set(qn("firstLine"), str(config["first_line"]))
    if "spacing" in config:
        spacing = ppr.find("w:spacing", NS)
        if config["spacing"]:
            spacing = spacing if spacing is not None else get_or_add(ppr, "spacing", PPR_ORDER)
            spacing.attrib.clear()
            for key, value in config["spacing"].items():
                spacing.set(qn(key), str(value))
        elif spacing is not None:
            ppr.remove(spacing)
    if "indent" in config:
        indent = ppr.find("w:ind", NS)
        if config["indent"]:
            indent = indent if indent is not None else get_or_add(ppr, "ind", PPR_ORDER)
            indent.attrib.clear()
            for key, value in config["indent"].items():
                indent.set(qn(key), str(value))
        elif indent is not None:
            ppr.remove(indent)

    if "fonts" in config:
        fonts = rpr.find("w:rFonts", NS)
        if config["fonts"]:
            fonts = fonts if fonts is not None else get_or_add(rpr, "rFonts", RPR_ORDER)
            fonts.attrib.clear()
            for key, value in config["fonts"].items():
                fonts.set(qn(key), str(value))
        elif fonts is not None:
            rpr.remove(fonts)
    elif any(key in config for key in ("font_ascii", "font_east_asia")):
        fonts = get_or_add(rpr, "rFonts", RPR_ORDER)
        if "font_ascii" in config:
            fonts.set(qn("ascii"), config["font_ascii"])
            fonts.set(qn("hAnsi"), config["font_ascii"])
        if "font_east_asia" in config:
            fonts.set(qn("eastAsia"), config["font_east_asia"])
    if config.get("size_half_points") is not None:
        size = str(config["size_half_points"])
        get_or_add(rpr, "sz", RPR_ORDER).set(qn("val"), size)
        get_or_add(rpr, "szCs", RPR_ORDER).set(qn("val"), size)
    elif "size_half_points" in config:
        for name in ("sz", "szCs"):
            size = rpr.find(f"w:{name}", NS)
            if size is not None:
                rpr.remove(size)
    if config.get("bold") is True:
        get_or_add(rpr, "b", RPR_ORDER)
    elif config.get("bold") is False:
        bold = rpr.find("w:b", NS)
        if bold is not None:
            rpr.remove(bold)


def apply_fixes(document_root: ET.Element, styles_root: ET.Element, rules: dict, report: dict) -> None:
    by_id, _ = style_catalog(styles_root)
    for style_id, config in rules.get("styles", {}).items():
        style = by_id.get(style_id)
        if style is None:
            continue
        set_style_properties(style, config)
        report["changes"].append(f"Normalized style '{style_id}'.")

    sections = document_root.findall(".//w:sectPr", NS)
    expected_sections = rules.get("document", {}).get("sections")
    if expected_sections is not None and len(sections) == len(expected_sections):
        for section, expected in zip(sections, expected_sections):
            for name, key in (("pgSz", "page_size"), ("pgMar", "margins"), ("pgNumType", "page_number")):
                element = get_or_add(section, name, SECTPR_ORDER)
                element.attrib.clear()
                for attr, value in expected.get(key, {}).items():
                    element.set(qn(attr), str(value))
            title_page = section.find("w:titlePg", NS)
            if expected.get("title_page") and title_page is None:
                get_or_add(section, "titlePg", SECTPR_ORDER)
            elif not expected.get("title_page") and title_page is not None:
                section.remove(title_page)
        report["changes"].append("Normalized layout for every section from the rules profile.")
    elif expected_sections is not None:
        report["manual_review"].append("Section count differs from the rules profile; section layouts were not modified.")
    margins = rules.get("document", {}).get("margins_twips", {})
    for section in sections:
        page_margin = get_or_add(section, "pgMar", SECTPR_ORDER)
        for side in ("top", "right", "bottom", "left", "header", "footer", "gutter"):
            if side in margins:
                page_margin.set(qn(side), str(margins[side]))
    if margins:
        report["changes"].append("Normalized page margins for every section.")


def format_report(source: Path, report: dict, mode: str, output: Path | None = None) -> str:
    summary = report["summary"]
    lines = [
        "# Thesis Format Report",
        "",
        f"- Source: `{source}`",
        f"- Mode: `{mode}`",
    ]
    if output:
        lines.append(f"- Formatted copy: `{output}`")
    lines.extend(
        [
            f"- Paragraphs: {summary['paragraphs']} ({summary['non_empty_paragraphs']} non-empty)",
            f"- Tables: {summary['tables']}",
            f"- Images: {summary['images']}",
            f"- Sections: {summary['sections']}",
            f"- Automatic TOC detected: {'yes' if summary['has_toc'] else 'no'}",
            "",
            "## Style Usage",
            "",
        ]
    )
    for style_name, count in report["style_counts"].items():
        lines.append(f"- `{style_name}`: {count}")
    lines.extend(["", "## Issues", ""])
    if report["issues"]:
        for issue in report["issues"]:
            lines.append(
                f"- **{issue['severity'].upper()}** `{issue['category']}`: {issue['message']}"
            )
    else:
        lines.append("- No automatically detectable issues found.")
    lines.extend(["", "## Applied Changes", ""])
    if report["changes"]:
        lines.extend(f"- {change}" for change in report["changes"])
    else:
        lines.append("- No changes applied.")
    lines.extend(["", "## Manual Review Checklist", ""])
    lines.extend(f"- [ ] {item}" for item in report["manual_review"])
    lines.append("")
    return "\n".join(lines)


def write_fixed_docx(source: Path, output: Path, document_root: ET.Element, styles_root: ET.Element) -> None:
    if source.resolve() == output.resolve():
        raise ValueError("Refusing to overwrite the source file; choose a separate output path.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as source_archive:
        with zipfile.ZipFile(output, "w") as output_archive:
            for item in source_archive.infolist():
                payload = source_archive.read(item.filename)
                if item.filename == "word/document.xml":
                    payload = ET.tostring(document_root, encoding="utf-8", xml_declaration=True)
                elif item.filename == "word/styles.xml":
                    payload = ET.tostring(styles_root, encoding="utf-8", xml_declaration=True)
                output_archive.writestr(copy.copy(item), payload)


def run(args: argparse.Namespace) -> int:
    source = Path(args.input).expanduser()
    rules_path = Path(args.rules).expanduser()
    if not source.is_file():
        raise ValueError(f"Input DOCX does not exist: {source}")
    if source.suffix.lower() != ".docx":
        raise ValueError("Input must be a .docx file.")

    with zipfile.ZipFile(source, "r") as archive:
        document_root = read_xml(archive, "word/document.xml")
        styles_root = read_xml(archive, "word/styles.xml")
    rules = load_rules(rules_path)
    report = analyze(document_root, styles_root, rules)

    output = None
    if args.command == "fix":
        output = Path(args.output).expanduser()
        apply_fixes(document_root, styles_root, rules, report)
        write_fixed_docx(source, output, document_root, styles_root)

    markdown = format_report(source, report, args.command, output)
    if args.report:
        report_path = Path(args.report).expanduser()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(markdown, encoding="utf-8")
    else:
        print(markdown)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    default_rules = Path(__file__).resolve().parents[1] / "references" / "default-rules.json"
    for command in ("audit", "fix"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("input", help="Path to the source DOCX file")
        subparser.add_argument("--rules", default=str(default_rules), help="Path to rules JSON")
        subparser.add_argument("--report", help="Write Markdown report to this path")
        if command == "fix":
            subparser.add_argument("--output", required=True, help="Write formatted DOCX copy here")
    return parser


if __name__ == "__main__":
    try:
        raise SystemExit(run(build_parser().parse_args()))
    except (ValueError, OSError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
