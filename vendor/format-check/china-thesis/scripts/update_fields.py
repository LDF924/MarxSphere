#!/usr/bin/env python3
"""Request Word to update TOC, REF, and PAGEREF fields when opening a DOCX."""
from __future__ import annotations

import argparse
import shutil
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def field_counts(root) -> dict[str, int]:
    text = " ".join(root.xpath("//w:instrText/text() | //w:fldSimple/@w:instr", namespaces=NS)).upper()
    return {name.lower(): text.count(name) for name in ("TOC", "REF", "PAGEREF")}


def set_update_on_open(settings_path: Path) -> None:
    tree = etree.parse(str(settings_path))
    root = tree.getroot()
    element = root.find("w:updateFields", NS)
    if element is None:
        element = etree.SubElement(root, "{%s}updateFields" % W)
    element.set("{%s}val" % W, "true")
    tree.write(str(settings_path), encoding="UTF-8", xml_declaration=True, standalone=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp_dir:
        work = Path(temp_dir)
        with zipfile.ZipFile(args.input_docx) as archive:
            archive.extractall(work)
        counts = {"toc": 0, "ref": 0, "pageref": 0}
        for xml_path in (work / "word").glob("*.xml"):
            root = etree.parse(str(xml_path)).getroot()
            current = field_counts(root)
            counts = {key: counts[key] + current[key] for key in counts}
        set_update_on_open(work / "word" / "settings.xml")
        with zipfile.ZipFile(args.output_docx, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in work.rglob("*"):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(work).as_posix())
    print(f"Set fields to update on open (TOC={counts['toc']}, REF={counts['ref']}, PAGEREF={counts['pageref']}): {args.output_docx}")


if __name__ == "__main__":
    main()
