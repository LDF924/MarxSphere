#!/usr/bin/env python3
"""
修复 Obsidian 文献库中 YAML frontmatter 的引号残留问题。

问题: MinerU 标题提取后 YAML dump 用单引号包裹含冒号的中文标题，
     导致 paperTitle/title 字段值带有外层引号 → YAML 解析后值含引号。
     同时要求 original.md 的 title/paperTitle/authors 与 index.md、信息.md 完全一致。

修复:
  1. 剥离 paperTitle/title/translatedTitle 值的多余 YAML 引号
  2. 以 original.md 的 paperTitle/authors/year/doi 为准，同步写入 index.md 和 信息.md
  3. 更新 摘要.md/术语表.md/问答.md 中对应的 paperTitle/title

用法:
  python3 fix_frontmatter.py --md-dir "Markdown目录" --dry-run
  python3 fix_frontmatter.py --md-dir "Markdown目录"
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


def parse_yaml_fm(text: str) -> tuple[dict, str]:
    """解析 YAML frontmatter，返回 (dict, body_text)。"""
    m = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
    if not m:
        return {}, text
    fm = {}
    fm_raw = m.group(1)
    for line in fm_raw.splitlines():
        line = line.rstrip()
        if ':' in line:
            k, _, v = line.partition(':')
            k = k.strip()
            v = v.strip()
            # 剥离外层引号
            if (v.startswith("'") and v.endswith("'")) or (v.startswith('"') and v.endswith('"')):
                v = v[1:-1]
            fm[k] = v
    return fm, text[m.end():]


def clean_yaml_value(val: str) -> str:
    """剥离多余 YAML 引号。"""
    v = val.strip()
    if (v.startswith("'") and v.endswith("'")) or (v.startswith('"') and v.endswith('"')):
        v = v[1:-1]
    return v


def quote_if_needed(val: str) -> str:
    """如果值含冒号或特殊字符，用单引号包裹，否则裸写。"""
    if re.search(r'[:#{}&*!|>\'"@`\[\]]', val):
        return f"'{val}'"
    return val


def rebuild_frontmatter(fm: dict) -> str:
    """将 dict 重建为 YAML frontmatter 字符串。"""
    lines = ["---"]
    for k, v in fm.items():
        if v is None:
            lines.append(f"{k}:")
        elif isinstance(v, list):
            lines.append(f"{k}:")
            for item in v:
                lines.append(f"  - {quote_if_needed(str(item))}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        else:
            lines.append(f"{k}: {quote_if_needed(str(v))}")
    lines.append("---")
    return "\n".join(lines)


def fix_one_paper(paper_dir: Path, dry_run: bool = True) -> dict:
    """修复单篇论文的 frontmatter 一致性。

    返回: {name, fixed_fields, message}
    """
    dirname = paper_dir.name
    orig_file = paper_dir / (dirname + ".original.md")
    index_file = paper_dir / (dirname + ".index.md")
    info_file = paper_dir / (dirname + "_信息.md")

    if not orig_file.exists():
        return {"name": dirname, "fixed": [], "message": "no original.md"}

    result = {"name": dirname, "fixed": [], "message": "OK"}

    # 1. 读取并清理 original.md
    orig_text = orig_file.read_text(encoding="utf-8")
    orig_fm, orig_body = parse_yaml_fm(orig_text)

    # 清理标题字段中的引号
    title_fields = ["title", "paperTitle", "translatedTitle"]
    for field in title_fields:
        if field in orig_fm:
            cleaned = clean_yaml_value(orig_fm[field])
            if cleaned != orig_fm[field]:
                orig_fm[field] = cleaned
                result["fixed"].append(f"original.{field}")

    # 2. 以 original.md 为基准，同步 title/paperTitle/translatedTitle/year/doi/authors
    #    到 index.md 和 信息.md
    sync_fields = ["paperTitle", "title", "translatedTitle", "year", "doi", "authors",
                   "keywords", "journal"]

    for target_file, target_label in [(index_file, "index"), (info_file, "info")]:
        if not target_file.exists():
            continue

        target_text = target_file.read_text(encoding="utf-8")
        target_fm, target_body = parse_yaml_fm(target_text)

        changed = False
        for field in sync_fields:
            src_val = orig_fm.get(field)
            if src_val is None or src_val == "":
                continue

            # Normalize authors (string representation)
            if field == "authors":
                if isinstance(src_val, str):
                    src_val = [a.strip() for a in src_val.split(",") if a.strip()]
                tgt_val = target_fm.get(field)
                if isinstance(tgt_val, str):
                    tgt_val = [a.strip() for a in tgt_val.split(",") if a.strip()]
                if tgt_val != src_val:
                    target_fm[field] = src_val
                    changed = True
                    result["fixed"].append(f"{target_label}.{field}")
            else:
                tgt_val = target_fm.get(field, "")
                if clean_yaml_value(str(tgt_val))[:20] != clean_yaml_value(str(src_val))[:20]:
                    target_fm[field] = src_val
                    changed = True
                    result["fixed"].append(f"{target_label}.{field}")

        if changed and not dry_run:
            new_text = rebuild_frontmatter(target_fm) + "\n\n" + target_body
            target_file.write_text(new_text, encoding="utf-8")

    # 3. 写回 original.md（仅当有修改）
    if result["fixed"] and not dry_run:
        orig_new = rebuild_frontmatter(orig_fm) + "\n\n" + orig_body
        orig_file.write_text(orig_new, encoding="utf-8")

    # 4. 更新摘要.md / 术语表.md / 问答.md 中的 paperTitle
    for aux_file_name in ["摘要.md", "术语表.md", "问答.md"]:
        aux_file = paper_dir / aux_file_name
        if not aux_file.exists():
            continue

        aux_text = aux_file.read_text(encoding="utf-8")
        aux_fm, aux_body = parse_yaml_fm(aux_text)

        changed_aux = False
        for field in ["paperTitle", "title", "translatedTitle"]:
            src_val = orig_fm.get(field)
            if src_val is None:
                continue
            tgt_val = aux_fm.get(field, "")
            if clean_yaml_value(str(tgt_val))[:20] != clean_yaml_value(str(src_val))[:20]:
                aux_fm[field] = src_val
                changed_aux = True
                result["fixed"].append(f"{aux_file_name}.{field}")

        if changed_aux and not dry_run:
            aux_new = rebuild_frontmatter(aux_fm) + "\n\n" + aux_body
            aux_file.write_text(aux_new, encoding="utf-8")

    if result["fixed"]:
        result["message"] = f"fixed {len(result['fixed'])} fields: {', '.join(result['fixed'][:6])}"
    else:
        result["message"] = "already consistent"

    return result


def main():
    parser = argparse.ArgumentParser(description="Fix YAML frontmatter consistency across md files")
    parser.add_argument("--md-dir", required=True, help="Markdown output directory")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no changes")
    args = parser.parse_args()

    md_dir = Path(args.md_dir)
    if not md_dir.is_dir():
        safe_log("ERROR", "Directory not found: %s", md_dir)
        sys.exit(1)

    if args.dry_run:
        safe_log("INFO", "DRY RUN mode - no changes will be made")

    results = []
    for d in sorted(md_dir.iterdir()):
        if not d.is_dir() or d.name.startswith('.'):
            continue
        if not (d / (d.name + ".original.md")).exists():
            continue

        r = fix_one_paper(d, dry_run=args.dry_run)
        results.append(r)

        if r["fixed"]:
            safe_log("INFO", "[FIX] %s: %s", r["name"][:45], r["message"])

    fixed = [r for r in results if r["fixed"]]
    ok = [r for r in results if not r["fixed"]]

    safe_log("INFO", "")
    safe_log("INFO", "=" * 60)
    safe_log("INFO", "===== SUMMARY =====")
    safe_log("INFO", "Total: %d | Fixed: %d | Already OK: %d",
             len(results), len(fixed), len(ok))

    if fixed:
        safe_log("INFO", "")
        safe_log("INFO", "--- Fixed papers ---")
        for r in fixed:
            safe_log("INFO", "  %s", r["message"])

    if args.dry_run:
        safe_log("INFO", "")
        safe_log("INFO", "This was a dry run. Run without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
