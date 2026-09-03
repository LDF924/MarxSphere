#!/usr/bin/env python3
"""Apply title and heading rules from an extracted thesis-template JSON."""
from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document

from docx_rules import apply_format, paragraph_role, read_rules, role_format


def format_headings(document: Document, rules: dict) -> int:
    changed = 0
    for paragraph in document.paragraphs:
        role = paragraph_role(paragraph, rules)
        if role == "title" or (role and role.startswith("heading_")):
            rule = role_format(rules, role)
            if rule:
                apply_format(paragraph, rule)
                changed += 1
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--rules", required=True, type=Path)
    args = parser.parse_args()
    document = Document(args.input_docx)
    count = format_headings(document, read_rules(args.rules))
    document.save(args.output_docx)
    print(f"Formatted {count} title/heading paragraph(s): {args.output_docx}")


if __name__ == "__main__":
    main()
