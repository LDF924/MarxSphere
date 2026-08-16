#!/usr/bin/env python3
"""
修复 Obsidian 文献库中目录名、文件名与实际论文标题不一致的问题。

问题根因:
  pipeline 初始用 slugify(PDF文件名) 作为目录名，但 MinerU 提取的论文标题
  可能与文件名不同（如冒号变下划线、作者名混入、前缀等）。
  目录名和内部 6 个 md 文件的前缀应该与实际论文标题一致。

修复策略:
  1. 读取每篇 original.md 的 YAML frontmatter 中的 paperTitle（实际标题）
  2. 用 paperTitle 生成正确的 slug
  3. 如果 slug 与当前目录名不一致，重命名目录
  4. 更新目录内所有 md 文件的命名前缀
  5. 更新 index.md 和 original.md 中所有 [[wiki-link]] 引用
  6. 更新所有文件 YAML frontmatter 中的 indexNote 字段

用法:
  python3 fix_titles.py --md-dir "Markdown目录" --dry-run    # 预览不修改
  python3 fix_titles.py --md-dir "Markdown目录"               # 执行修复
"""

import argparse
import re
import sys
import time
from pathlib import Path
from typing import Optional


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


def slugify(title: str) -> str:
    """生成安全的目录/文件名 slug。"""
    name = str(title).strip()
    unsafe = r'[\\/:*?"<>|]'
    return re.sub(unsafe, "_", name)[:80]


def read_paper_title(orig_md: Path) -> Optional[str]:
    """从 original.md 的 YAML frontmatter 读取 paperTitle。"""
    try:
        content = orig_md.read_text(encoding="utf-8")[:3000]
        m = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
        if not m:
            return None
        fm = m.group(1)
        for key in ("paperTitle", "translatedTitle", "title"):
            m2 = re.search(rf'^{key}:\s*(.+)$', fm, re.MULTILINE)
            if m2:
                val = m2.group(1).strip()
                # 剥离 YAML 引号：单引号、双引号
                val = re.sub(r"^['\"]|['\"]$", "", val)
                # 过滤明显是文件名的 title（含 .pdf）
                if val and not val.endswith('.pdf') and len(val) > 3:
                    return val
        return None
    except Exception:
        return None


def fix_one_paper(md_dir_path: Path, dry_run: bool = True) -> dict:
    """修复单篇论文的命名一致性。

    返回: {old_name, new_name, success, message}
    """
    result = {
        "old_name": md_dir_path.name,
        "new_name": md_dir_path.name,
        "changed": False,
        "message": "OK",
    }

    orig_md = md_dir_path / (md_dir_path.name + ".original.md")
    if not orig_md.exists():
        result["message"] = "original.md not found"
        return result

    paper_title = read_paper_title(orig_md)
    if not paper_title:
        result["message"] = "cannot extract title from YAML"
        return result

    correct_slug = slugify(paper_title)
    if correct_slug == md_dir_path.name:
        result["message"] = "already correct"
        return result

    # 需要重命名
    result["new_name"] = correct_slug
    result["changed"] = True

    if dry_run:
        result["message"] = f"would rename: {md_dir_path.name} -> {correct_slug}"
        return result

    # 实际执行重命名
    new_dir = md_dir_path.parent / correct_slug

    old_name = md_dir_path.name

    # 1. 重命名目录
    try:
        md_dir_path.rename(new_dir)
    except OSError as e:
        result["message"] = f"rename failed: {e}"
        return result

    # 2. 更新目录内所有文件的内部引用
    file_patterns = {
        "original": f"{old_name}.original.md",
        "index": f"{old_name}.index.md",
        "info": f"{old_name}_信息.md",
    }
    optional = {
        "summary": "摘要.md",
        "glossary": "术语表.md",
        "qa": "问答.md",
    }

    for label, fname in {**file_patterns, **optional}.items():
        old_path = new_dir / fname
        if not old_path.exists():
            continue
        new_fname = fname.replace(old_name, correct_slug) if old_name in fname else fname
        new_path = new_dir / new_fname

        content = old_path.read_text(encoding="utf-8")

        # 替换所有 [[wiki-link]] 中的引用
        content = content.replace(f"[[{old_name}.", f"[[{correct_slug}.")
        content = content.replace(f"[[{old_name}_", f"[[{correct_slug}_")

        # 替换 YAML frontmatter 中的 indexNote
        content = re.sub(
            r'(indexNote:\s*)\[\[.*?\]\]',
            f'\\1[[{correct_slug}.index]]',
            content
        )

        # 替换 YAML 中的 title
        content = re.sub(
            rf'(title:\s*)"?{re.escape(old_name)}"?\s*$',
            f'\\1"{correct_slug}"',
            content,
            flags=re.MULTILINE
        )

        if new_path != old_path:
            old_path.rename(new_path)
            old_path = new_path

        old_path.write_text(content, encoding="utf-8")

    result["message"] = f"renamed: {old_name} -> {correct_slug}"
    return result


def main():
    parser = argparse.ArgumentParser(description="Fix paper title/directory name consistency")
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
        if not d.is_dir():
            continue
        if not (d / (d.name + ".original.md")).exists():
            continue

        r = fix_one_paper(d, dry_run=args.dry_run)
        results.append(r)

        if r["changed"]:
            safe_log("INFO", "[FIX] %s", r["message"])
        # 不输出 unchanged 的，减少噪音

    # 汇总
    changed = [r for r in results if r["changed"]]
    unchanged = [r for r in results if not r["changed"]]
    errors = [r for r in results if r["message"].startswith("cannot") or "failed" in r["message"]]

    safe_log("INFO", "")
    safe_log("INFO", "=" * 60)
    safe_log("INFO", "===== SUMMARY =====")
    safe_log("INFO", "Total papers: %d", len(results))
    safe_log("INFO", "Need rename: %d", len(changed))
    safe_log("INFO", "Already correct: %d", len(unchanged))
    safe_log("INFO", "Errors: %d", len(errors))

    if changed:
        safe_log("INFO", "")
        safe_log("INFO", "--- Changed ---")
        for r in changed[:20]:
            safe_log("INFO", "  %s", r["message"])
        if len(changed) > 20:
            safe_log("INFO", "  ... and %d more", len(changed) - 20)

    if errors:
        safe_log("INFO", "")
        safe_log("INFO", "--- Errors ---")
        for r in errors:
            safe_log("INFO", "  %s: %s", r["old_name"], r["message"])

    if args.dry_run:
        safe_log("INFO", "")
        safe_log("INFO", "This was a dry run. Run without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
