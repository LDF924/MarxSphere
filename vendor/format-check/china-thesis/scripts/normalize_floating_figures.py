#!/usr/bin/env python3
"""Normalize OOXML floating-image anchors without changing image bytes or captions."""
from __future__ import annotations

import argparse
import shutil
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

NS = {"wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"}


def configure_anchor(anchor, horizontal: str, vertical: str, relative_to: str) -> None:
    anchor.set("simplePos", "0")
    anchor.set("behindDoc", "0")
    anchor.set("allowOverlap", "0")
    anchor.set("layoutInCell", "1")
    anchor.set("locked", "0")
    for tag, relative, alignment in (("wp:positionH", "column" if relative_to == "paragraph" else "margin", horizontal),
                                     ("wp:positionV", "paragraph" if relative_to == "paragraph" else "margin", vertical)):
        position = anchor.find(tag, NS)
        if position is None:
            position = etree.Element("{%s}%s" % (NS["wp"], tag.split(":")[1]))
            anchor.insert(0, position)
        position.set("relativeFrom", relative)
        for child in list(position):
            position.remove(child)
        align = etree.SubElement(position, "{%s}align" % NS["wp"])
        align.text = alignment


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--horizontal", choices=("left", "center", "right"), default="center")
    parser.add_argument("--vertical", choices=("top", "center", "bottom"), default="top")
    parser.add_argument("--relative-to", choices=("paragraph", "margin"), default="paragraph")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp_dir:
        work = Path(temp_dir)
        with zipfile.ZipFile(args.input_docx) as archive:
            archive.extractall(work)
        count = 0
        for xml_path in (work / "word").glob("*.xml"):
            tree = etree.parse(str(xml_path))
            anchors = tree.xpath("//wp:anchor", namespaces=NS)
            if not anchors:
                continue
            for anchor in anchors:
                configure_anchor(anchor, args.horizontal, args.vertical, args.relative_to)
                count += 1
            tree.write(str(xml_path), encoding="UTF-8", xml_declaration=True, standalone=True)
        with zipfile.ZipFile(args.output_docx, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in work.rglob("*"):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(work).as_posix())
    print(f"Normalized {count} floating image anchor(s): {args.output_docx}")


if __name__ == "__main__":
    main()
