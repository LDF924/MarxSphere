#!/usr/bin/env python3
"""Extract page-cited, reviewable thesis-format requirements from a PDF guide."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pdfplumber

KEYWORDS = ("字体", "字号", "宋体", "黑体", "楷体", "仿宋", "页边距", "上边距", "下边距", "左边距", "右边距", "行距", "段前", "段后", "目录", "参考文献", "图", "表", "页码", "摘要", "关键词", "本科", "硕士", "博士", "学位论文", "原创性声明", "授权书", "致谢", "附录", "攻读学位期间", "font", "margin", "line spacing", "table of contents", "reference")


def classify(line: str) -> list[str]:
    lowered = line.lower()
    return [keyword for keyword in KEYWORDS if keyword in line or keyword in lowered]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("guide_pdf", type=Path)
    parser.add_argument("--output", "-o", required=True, type=Path)
    args = parser.parse_args()
    requirements, warnings, pages = [], [], []
    with pdfplumber.open(args.guide_pdf) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            pages.append({"page": number, "characters": len(text)})
            if not text.strip():
                warnings.append(f"Page {number} has no extractable text; render/OCR it before relying on this guide.")
            for line in text.splitlines():
                topics = classify(line)
                if topics:
                    requirements.append({"page": number, "topics": topics, "evidence": line.strip()})
    payload = {"schema_version": "1.0", "source": {"guide_filename": args.guide_pdf.name, "type": "pdf"},
               "pages": pages, "requirements": requirements,
               "extraction_warnings": warnings + ["Review each evidence line before merging it into DOCX rules; PDF text alone cannot prove visual layout."]}
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(requirements)} page-cited requirement(s): {args.output}")


if __name__ == "__main__":
    main()
