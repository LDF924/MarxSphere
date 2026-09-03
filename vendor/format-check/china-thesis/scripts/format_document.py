#!/usr/bin/env python3
"""Format a thesis copy using rules extracted from a school DOCX template."""
from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document

from docx_rules import apply_format, apply_page_rule, paragraph_role, read_rules, role_format
from format_figures import format_figures
from format_heading import format_headings
from format_references import format_references
from format_tables import format_tables


def format_document(document: Document, rules: dict) -> dict[str, int]:
    """Apply only rules observed in the template or explicitly added to JSON."""
    apply_page_rule(document, rules.get("page", {}))
    body_count = 0
    for paragraph in document.paragraphs:
        if paragraph_role(paragraph, rules) == "body":
            apply_format(paragraph, role_format(rules, "body"))
            body_count += 1
    return {
        "body": body_count,
        "headings": format_headings(document, rules),
        "tables": format_tables(document, rules),
        "captions": format_figures(document, rules),
        "references": format_references(document, rules),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_docx", type=Path, help="Thesis source copy; never modified in place.")
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--rules", required=True, type=Path, help="JSON generated from the school template.")
    args = parser.parse_args()
    if args.input_docx.resolve() == args.output_docx.resolve():
        raise SystemExit("Use a different output path to preserve the thesis source file.")
    document = Document(args.input_docx)
    counts = format_document(document, read_rules(args.rules))
    document.save(args.output_docx)
    print("Formatted " + ", ".join(f"{key}={value}" for key, value in counts.items()) + f": {args.output_docx}")


if __name__ == "__main__":
    main()
