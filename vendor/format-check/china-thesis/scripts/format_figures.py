#!/usr/bin/env python3
"""Apply the extracted caption rule to figure and table captions."""
from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document

from docx_rules import apply_format, paragraph_role, read_rules, role_format


def format_figures(document: Document, rules: dict) -> int:
    rule = role_format(rules, rules.get("figure_rules", {}).get("caption_role", "caption"))
    if not rule:
        return 0
    count = 0
    for paragraph in document.paragraphs:
        if paragraph_role(paragraph, rules) == "caption":
            apply_format(paragraph, rule)
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--rules", required=True, type=Path)
    args = parser.parse_args()
    document = Document(args.input_docx)
    count = format_figures(document, read_rules(args.rules))
    document.save(args.output_docx)
    print(f"Formatted {count} caption(s): {args.output_docx}")


if __name__ == "__main__":
    main()
