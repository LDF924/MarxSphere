#!/usr/bin/env python3
"""Inspect an existing rule JSON or generate one from a DOCX template."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from docx import Document

from docx_rules import extract_rules, read_rules, write_rules


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--rules", type=Path)
    source.add_argument("--template", type=Path)
    parser.add_argument("--output", "-o", type=Path, help="Required with --template.")
    args = parser.parse_args()
    if args.rules:
        print(json.dumps(read_rules(args.rules), ensure_ascii=False, indent=2))
        return
    if not args.output:
        parser.error("--output is required with --template")
    write_rules(extract_rules(Document(args.template), args.template.name), args.output)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
