#!/usr/bin/env python3
"""md_clean_cli.py — Markdown 清洗 CLI (V399: scansci-pdf md_export 提炼)
修复 pymupdf4llm/MinerU 产物的确定性瑕疵: 组合变音符号折叠、NFC 归一化、
替换字符/不可打印字符计数警告。

用法: python md_clean_cli.py <in.md>
  - 清洗后写入 <in.md 同目录>/out.md
  - stdout 输出 JSON { warnings: [...] }
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from md_export import clean_markdown_text, markdown_quality_scan


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"warnings": ["用法: md_clean_cli.py <in.md>"]}))
        return 1
    in_path = Path(sys.argv[1])
    if not in_path.exists():
        print(json.dumps({"warnings": [f"输入不存在: {in_path}"]}))
        return 1
    raw = in_path.read_text(encoding="utf-8", errors="replace")
    cleaned = clean_markdown_text(raw)
    warnings = markdown_quality_scan(raw)
    out_path = in_path.with_name("out.md")
    out_path.write_text(cleaned, encoding="utf-8")
    print(json.dumps({"warnings": warnings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
