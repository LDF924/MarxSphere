#!/usr/bin/env python3
"""Apply reference-entry formatting without changing bibliography content."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from docx import Document

from docx_rules import apply_format, paragraph_role, read_rules, role_format


def format_references(document: Document, rules: dict) -> int:
    entry_rule = role_format(rules, rules.get("reference_rules", {}).get("entry_role", "reference_entry"))
    if not entry_rule:
        return 0
    in_references = False
    count = 0
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if paragraph_role(paragraph, rules) == "reference_heading":
            in_references = True
            continue
        if in_references and re.match(r"^\s*(?:[\[［]\d+[\]］]|\d+[.、])", text):
            apply_format(paragraph, entry_rule)
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--rules", required=True, type=Path)
    args = parser.parse_args()
    document = Document(args.input_docx)
    count = format_references(document, read_rules(args.rules))
    document.save(args.output_docx)
    print(f"Formatted {count} reference entry/entries: {args.output_docx}")


if __name__ == "__main__":
    main()
