#!/usr/bin/env python3
"""Extract a reusable thesis-format rules profile from an official DOCX template."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def qn(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def attrs(element: ET.Element | None) -> dict[str, str]:
    if element is None:
        return {}
    return {key.rsplit("}", 1)[-1]: value for key, value in element.attrib.items()}


def default_style_id(styles_root: ET.Element) -> str:
    for style in styles_root.findall("w:style", NS):
        if style.get(qn("type")) == "paragraph" and style.get(qn("default")) == "1":
            return style.get(qn("styleId"), "Normal")
    return "Normal"


def style_config(style: ET.Element) -> dict:
    ppr = style.find("w:pPr", NS)
    rpr = style.find("w:rPr", NS)
    name = attrs(style.find("w:name", NS)).get("val", style.get(qn("styleId"), ""))
    config = {
        "style_name": name,
        "alignment": attrs(ppr.find("w:jc", NS) if ppr is not None else None).get("val"),
        "spacing": attrs(ppr.find("w:spacing", NS) if ppr is not None else None),
        "indent": attrs(ppr.find("w:ind", NS) if ppr is not None else None),
        "fonts": attrs(rpr.find("w:rFonts", NS) if rpr is not None else None),
        "size_half_points": attrs(rpr.find("w:sz", NS) if rpr is not None else None).get("val"),
        "bold": rpr is not None and rpr.find("w:b", NS) is not None,
    }
    heading = re.match(r"^(?:heading|标题)\s*(\d+)", name, re.IGNORECASE)
    if heading:
        config["heading_level"] = int(heading.group(1))
    return config


def section_config(section: ET.Element) -> dict:
    return {
        "page_size": attrs(section.find("w:pgSz", NS)),
        "margins": attrs(section.find("w:pgMar", NS)),
        "page_number": attrs(section.find("w:pgNumType", NS)),
        "title_page": section.find("w:titlePg", NS) is not None,
    }


def extract(template: Path) -> dict:
    with zipfile.ZipFile(template, "r") as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        styles = ET.fromstring(archive.read("word/styles.xml"))
    default = default_style_id(styles)
    used_styles = Counter()
    for paragraph in document.findall(".//w:body/w:p", NS):
        text = "".join(node.text or "" for node in paragraph.findall(".//w:t", NS)).strip()
        if not text:
            continue
        pstyle = paragraph.find("w:pPr/w:pStyle", NS)
        used_styles[pstyle.get(qn("val"), default) if pstyle is not None else default] += 1
    styles_by_id = {style.get(qn("styleId")): style for style in styles.findall("w:style", NS)}
    return {
        "profile": {"source_template": template.name},
        "document": {
            "require_toc": True,
            "sections": [section_config(section) for section in document.findall(".//w:sectPr", NS)],
        },
        "styles": {
            style_id: style_config(styles_by_id[style_id])
            for style_id in sorted(used_styles)
            if style_id in styles_by_id
        },
        "manual_review": [
            "Compare the result against the university's official thesis specification.",
            "Verify cover page, declaration pages, abstracts, keywords, and student metadata manually.",
            "Update the table of contents and other generated fields in Word.",
            "Verify page numbering, headers, footers, section breaks, citations, figures, tables, equations, footnotes, and appendices manually."
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", help="Path to the official university DOCX template")
    parser.add_argument("--output", required=True, help="Write extracted JSON rules here")
    args = parser.parse_args()
    template = Path(args.template).expanduser()
    output = Path(args.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(extract(template), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
