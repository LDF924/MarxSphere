#!/usr/bin/env python3
"""Extract a reviewable formatting-rules JSON from a school DOCX template."""
from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document

from docx_rules import extract_rules, write_rules


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path, help="School template; this file is never modified.")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Output JSON rule file.")
    parser.add_argument("--degree", choices=("auto", "undergraduate", "master", "doctoral"), default="auto",
                        help="Add a Chinese degree-thesis structural review profile; never substitutes for the template.")
    args = parser.parse_args()
    if args.template.suffix.lower() != ".docx":
        raise SystemExit("The template must be a .docx file.")
    rules = extract_rules(Document(args.template), args.template.name, args.degree)
    write_rules(rules, args.output)
    print(f"Wrote {args.output} with {len(rules['styles'])} observed styles.")
    if rules["extraction_warnings"]:
        print(f"Manual review required: {len(rules['extraction_warnings'])} warning(s).")


if __name__ == "__main__":
    main()
