#!/usr/bin/env python3
"""
修复 YAML frontmatter 中的多层引号转义问题。

问题根因:
  rebuild_frontmatter() 对已有单引号包裹的值再次加单引号，导致:
    indexNote: '''[[xxx.index]]'''
    sourceHash: '''sha256:xxx'''
    createdAt: '''2026-...'''

修复:
  1. 清除所有 YAML 值上嵌套的多余单引号
  2. 确保每行的值最多只有一层引号

用法:
  python3 fix_quotes.py --md-dir "Markdown目录" --dry-run
  python3 fix_quotes.py --md-dir "Markdown目录"
"""

import argparse
import re
import sys
import time
from pathlib import Path


def safe_print(*args, **kwargs):
    text = " ".join(str(a) for a in args)
    try:
        print(text, **kwargs)
    except UnicodeEncodeError:
        print(text.encode("gbk", errors="replace").decode("gbk", errors="replace"), **kwargs)


def safe_log(level: str, msg: str, *fmt_args):
    timestamp = time.strftime("%H:%M:%S")
    if fmt_args:
        try:
            msg = msg % fmt_args
        except TypeError:
            pass
    safe_print(f"[{timestamp}] {level} {msg}")


def fix_fm_quotes(text: str) -> tuple[str, int]:
    """修复 YAML frontmatter 中的多重引号。

    返回 (fixed_text, fix_count)
    """
    fix_count = 0

    # 匹配 frontmatter 块
    m = re.match(r'^(---\s*\n)(.*?)(\n---)', text, re.DOTALL)
    if not m:
        return text, 0

    before = m.group(1)
    fm_body = m.group(2)
    after = m.group(3)

    fixed_lines = []
    for line in fm_body.splitlines():
        if ':' not in line:
            fixed_lines.append(line)
            continue

        # 找到第一个冒号分隔 key 和 value
        idx = line.index(':')
        key = line[:idx].strip()
        value = line[idx+1:].rstrip()

        # 清洗多重引号
        if value:
            # 去多余前后空白
            v = value.strip()
            # 递归去外层单引号，直到稳定
            while (v.startswith("''") and v.endswith("''")) or (v.startswith("'''") and v.endswith("'''")):
                v = v[1:-1]
                fix_count += 1
            # 如果只剩一层引号，保持不变；否则不加引号
            fixed_lines.append(f"{key}: {v}")
        else:
            fixed_lines.append(line)

    new_text = before + '\n'.join(fixed_lines) + after
    if fix_count > 0:
        # 追加 body 部分
        new_text += text[m.end():]
    return new_text, fix_count


def main():
    parser = argparse.ArgumentParser(description="Fix YAML frontmatter quote escaping")
    parser.add_argument("--md-dir", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    md_dir = Path(args.md_dir)
    if not md_dir.is_dir():
        safe_log("ERROR", "Dir not found: %s", md_dir)
        sys.exit(1)

    if args.dry_run:
        safe_log("INFO", "DRY RUN - no changes")

    total_fixes = 0
    files_fixed = 0

    for d in sorted(md_dir.iterdir()):
        if not d.is_dir() or d.name.startswith('.') or d.name.startswith('_'):
            continue

        for suffix in ['.original.md', '.index.md', '_信息.md', '摘要.md', '术语表.md', '问答.md']:
            fpath = d / (d.name + suffix)
            if not fpath.exists():
                continue

            text = fpath.read_text(encoding="utf-8")
            new_text, fix_count = fix_fm_quotes(text)

            if fix_count > 0:
                total_fixes += fix_count
                files_fixed += 1
                if not args.dry_run:
                    fpath.write_text(new_text, encoding="utf-8")
                safe_log("INFO", "[FIX] %d quotes in %s/%s", fix_count, d.name[:35], suffix)

    safe_log("INFO", "")
    safe_log("INFO", "===== SUMMARY =====")
    safe_log("INFO", "Files fixed: %d | Quote fixes: %d", files_fixed, total_fixes)

    if args.dry_run:
        safe_log("INFO", "Run without --dry-run to apply.")


if __name__ == "__main__":
    main()
