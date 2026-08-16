#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
  MD 文件完整性独立检测脚本
============================================================
功能：
  - 遍历 ov_import 每个文件夹，检测 4 类必需 MD 文件
  - 检测空/乱码文件（防止脏文献入库污染图谱）
  - 输出独立校验报告 JSON
  - 支持 --json 输出机器可读格式
  - 支持 --fix 自动修复建议

操作模式:
  python check_md_files.py              # 全检 + 终端报告
  python check_md_files.py --json       # 全检 + JSON 报告
  python check_md_files.py --fix        # 全检 + 自动修复（删除空文件）
"""

import sys, json, os, time, argparse
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

BASE_DIR = Path(r"D:\Desktop\ov_import")
REPORT_DIR = SCRIPT_DIR / ".md_reports"

# ── 常量 ──
MIN_FILE_SIZE = 50          # 低于此字节视为"短文件"
MAX_NON_PRINTABLE_RATIO = 0.3  # 不可打印字符比例超过此值视为乱码

REQUIRED_PATTERNS = [
    ("摘要", ["摘要"]),
    ("术语", ["术语"]),
    ("问答", ["问答", "問答"]),
    ("原文", ["original", "原文"]),
]


def scan_folder(folder: Path) -> dict:
    """扫描单个文件夹，返回完整性 + 质量报告"""
    md_files = list(folder.glob("*.md"))
    result = {
        "folder": folder.name,
        "total_md_files": len(md_files),
        "required": {},
        "issues": [],
    }

    # ── 4 类必需文件检测 ──
    for label, patterns in REQUIRED_PATTERNS:
        matched = [f for f in md_files if any(p in f.name for p in patterns)]
        if matched:
            f = matched[0]
            result["required"][label] = {
                "file": f.name,
                "size": f.stat().st_size,
            }
        else:
            result["required"][label] = None

    # ── 空 / 短文件检测 ──
    for f in md_files:
        size = f.stat().st_size
        if size == 0:
            result["issues"].append({"file": f.name, "type": "empty", "detail": "file is 0 bytes"})
        elif size < MIN_FILE_SIZE:
            try:
                content = f.read_text(encoding="utf-8")
                if len(content.strip()) == 0:
                    result["issues"].append({"file": f.name, "type": "empty", "detail": f"{size} bytes, whitespace only"})
                else:
                    result["issues"].append({"file": f.name, "type": "short", "detail": f"{size} bytes"})
            except Exception as e:
                result["issues"].append({"file": f.name, "type": "unreadable", "detail": str(e)[:100]})

    # ── 乱码检测 ──
    for f in md_files:
        if any(i["file"] == f.name for i in result["issues"]):
            continue
        try:
            content = f.read_text(encoding="utf-8")
            size = len(content)
            non_printable = sum(1 for c in content
                                if ord(c) < 32 and ord(c) not in (9, 10, 13))
            if non_printable / max(size, 1) > MAX_NON_PRINTABLE_RATIO:
                result["issues"].append({
                    "file": f.name,
                    "type": "corrupt",
                    "detail": f"non-printable ratio: {non_printable/size:.2%}"
                })
        except UnicodeDecodeError:
            result["issues"].append({"file": f.name, "type": "corrupt", "detail": "UnicodeDecodeError"})

    return result


def scan_all() -> dict:
    """扫描全部文件夹"""
    all_dirs = sorted([d for d in BASE_DIR.iterdir()
                       if d.is_dir() and not d.name.startswith('.')])
    if not all_dirs:
        return {"total_folders": 0, "folders": [], "summary": {}}

    folders = []
    complete_count = 0
    missing_count = 0
    issue_count = 0
    empty_count = 0
    corrupt_count = 0

    for folder in all_dirs:
        r = scan_folder(folder)
        folders.append(r)
        if all(v is not None for v in r["required"].values()):
            complete_count += 1
        else:
            missing_count += 1
        issue_count += len(r["issues"])
        empty_count += sum(1 for i in r["issues"] if i["type"] == "empty")
        corrupt_count += sum(1 for i in r["issues"] if i["type"] in ("corrupt", "unreadable"))

    return {
        "total_folders": len(all_dirs),
        "folders": folders,
        "summary": {
            "complete_4of4": complete_count,
            "missing_files": missing_count,
            "total_issues": issue_count,
            "empty_files": empty_count,
            "corrupt_files": corrupt_count,
        }
    }


def print_report(report: dict):
    """终端报告"""
    s = report["summary"]
    print("=" * 55)
    print("  MD File Integrity & Quality Report")
    print("=" * 55)
    print(f"  Total folders:     {report['total_folders']}")
    print(f"  Complete (4/4):    {s['complete_4of4']}")
    print(f"  Missing files:     {s['missing_files']}")
    print(f"  Empty/corrupt:     {s['empty_files']} / {s['corrupt_files']}")

    if s["missing_files"] > 0:
        print(f"\n  --- Missing files ---")
        for fld in report["folders"]:
            missing = [k for k, v in fld["required"].items() if v is None]
            if missing:
                print(f"    {fld['folder'][:50]} — missing: {', '.join(missing)}")

    if s["total_issues"] > 0:
        print(f"\n  --- File Quality Issues ---")
        for fld in report["folders"]:
            for iss in fld["issues"]:
                print(f"    [{iss['type'].upper()}] {fld['folder'][:30]}/{iss['file']} — {iss['detail']}")

    if s["missing_files"] == 0 and s["total_issues"] == 0:
        print("\n  VERDICT: ALL PASS — no missing or corrupt files")
    else:
        print(f"\n  VERDICT: {s['missing_files'] + s['total_issues']} issue(s) need attention")


def fix_issues(report: dict) -> int:
    """自动修复：删除空文件"""
    deleted = 0
    for fld in report["folders"]:
        for iss in fld["issues"]:
            if iss["type"] == "empty":
                file_path = BASE_DIR / fld["folder"] / iss["file"]
                if file_path.exists():
                    file_path.unlink()
                    print(f"  DELETED empty file: {file_path}")
                    deleted += 1
    if deleted == 0:
        print("  No empty files to delete.")
    return deleted


def main():
    parser = argparse.ArgumentParser(description="MD File Integrity & Quality Check")
    parser.add_argument("--json", action="store_true", help="Output JSON report")
    parser.add_argument("--fix", action="store_true", help="Auto-delete empty files")
    args = parser.parse_args()

    report = scan_all()

    if args.json:
        REPORT_DIR.mkdir(exist_ok=True)
        json_path = REPORT_DIR / f"md_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"\nReport saved to: {json_path}")
    else:
        print_report(report)

    if args.fix:
        print("\n  --- Auto-fix ---")
        fix_issues(report)

    # 有严重问题时 exit code 非零
    if report["summary"]["corrupt_files"] > 0:
        sys.exit(2)
    if report["summary"]["missing_files"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
