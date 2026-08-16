#!/usr/bin/env python3
"""
修复 index.md 和 信息.md 中作者字段被副标题污染的问题。

问题根因: MinerU 将论文副标题（"基于XX的案例研究""基于XX数据"等）
        排在作者行之后、正文字段之前，metadata 提取时把副标题碎片
        误认为作者名 → index.md 的 authors 字段出现 "基于鲁西""村的案例"等。

修复:
  1. 从 original.md 正文提取真实作者名
  2. 清洗 original.md 正文 H1 下的内容，把副标题合并到 H1 标题后
  3. 同步写入 index.md / 信息.md 的正确 authors 和 title/paperTitle
  4. 同时修复 original.md 正文中 H1 与副标题分离的问题

用法:
  python3 fix_authors.py --md-dir "Markdown目录" --dry-run
  python3 fix_authors.py --md-dir "Markdown目录"
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


def parse_fm_and_body(text: str) -> tuple[dict, str]:
    """解析 YAML frontmatter，返回 (dict, body_text)。"""
    m = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        line = line.rstrip()
        if ':' in line:
            k, _, v = line.partition(':')
            fm[k.strip()] = v.strip()
    return fm, text[m.end():]


def extract_real_authors_from_body(body: str) -> list[str]:
    r"""从 original.md 正文提取真实作者名。

    中文学术论文的作者行模式：
      - "作者1， 作者2" （全角逗号）
      - "作者1, 作者2" （半角逗号）
      - 右上角可能有机构编号如 "李元元1， 曹聪敏2"

    作者行特征：紧接 H1 标题和可选副标题之后，在"摘 要"或"关键词"之前，
    由2-4个连续汉字组成，用逗号分隔。
    """
    # 提取 H1 后的前 800 字符
    h1_match = re.search(r'^#\s+.+\n', body, re.MULTILINE)
    if not h1_match:
        return []
    after_h1 = body[h1_match.end():h1_match.end() + 800]

    # 尝试匹配作者行：2-4个汉字后跟逗号，再2-4个汉字
    # 模式: 姓名(可能带数字上标), 姓名(可能带数字上标)
    # 移除机构标注数字
    author_line_match = re.search(
        r'^([一-鿿]{2,4}\d{0,2}(?:[，,]\s*[一-鿿]{2,4}\d{0,2})+(?:[；;]|\n|$))',
        after_h1, re.MULTILINE)

    if author_line_match:
        raw = author_line_match.group(1)
        # 清洗：去掉数字上标
        raw = re.sub(r'\d', '', raw)
        # 拆分
        authors = re.split(r'[，,；;]', raw)
        authors = [a.strip() for a in authors if re.match(r'^[一-鿿]{2,4}$', a.strip())]
        if len(authors) >= 1:
            return authors

    # 回退：找任何像人名的行（2-4汉字，逗号分隔）
    fallback = re.search(
        r'^([一-鿿]{2,4}\s*[，,]\s*[一-鿿]{2,4})',
        after_h1, re.MULTILINE)
    if fallback:
        raw = fallback.group(1)
        authors = re.split(r'[，,]', raw)
        return [a.strip() for a in authors if re.match(r'^[一-鿿]{2,4}$', a.strip())]

    return []


def rebuild_fm_block(fm: dict) -> str:
    """将 dict 重建为 YAML frontmatter 块。"""
    lines = ["---"]
    for k, v in fm.items():
        if v is None or v == "":
            lines.append(f"{k}:")
        elif isinstance(v, list):
            lines.append(f"{k}:")
            for item in v:
                lines.append(f"  - {item}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        else:
            # 值含冒号则加引号
            val = str(v)
            if re.search(r'[:\'\"#]', val):
                lines.append(f"{k}: '{val}'")
            else:
                lines.append(f"{k}: {val}")
    lines.append("---")
    return "\n".join(lines)


def fix_one_paper(paper_dir: Path, dry_run: bool = True) -> dict:
    """修复单篇论文。"""
    dirname = paper_dir.name
    result = {"name": dirname, "fixed": [], "message": "OK"}

    orig_file = paper_dir / (dirname + ".original.md")
    if not orig_file.exists():
        return result

    # --- 1. 解析 original.md ---
    orig_text = orig_file.read_text(encoding="utf-8")
    orig_fm, orig_body = parse_fm_and_body(orig_text)

    # 提取真实作者
    real_authors = extract_real_authors_from_body(orig_body)

    if not real_authors:
        return result  # 无法提取，跳过

    # --- 2. 修复 original.md 正文：合并 H1 和副标题 ---
    # 查找 H1 标题行行号
    body_lines = orig_body.split('\n')
    h1_idx = None
    for i, line in enumerate(body_lines):
        if re.match(r'^#\s+\S', line):
            h1_idx = i
            h1_line = line
            break

    if h1_idx is not None:
        # 在 H1 之后的数行中查找副标题（可跨空行和图片 markdown）
        # 副标题模式: "基于XXX的案例研究" 或 "——基于XXX" 或 "— 基于XXX"
        # 跳过空行和 markdown 图片行 (![...](...))
        for offset in range(1, min(8, len(body_lines) - h1_idx)):
            cand = body_lines[h1_idx + offset].strip()
            if not cand or cand.startswith('!['):
                continue
            subtitle_match = re.match(
                r'^(?:基于|——|—)\s*.+?(?:研究|调查|分析|考察|探讨|视角|视域|框架|为例|为例证)\s*$',
                cand)
            if subtitle_match:
                subtitle = cand
                merged_h1 = f"{h1_line} —— {subtitle}"
                new_lines = body_lines[:h1_idx] + [merged_h1] + body_lines[h1_idx + 1:h1_idx + offset] + body_lines[h1_idx + offset + 1:]
                new_body = '\n'.join(new_lines)
                result["fixed"].append("original.body-merge-subtitle")
                if orig_fm.get("paperTitle"):
                    if subtitle[:4] not in orig_fm["paperTitle"]:
                        new_title = f"{orig_fm['paperTitle']} —— {subtitle}"
                        orig_fm["paperTitle"] = new_title
                        result["fixed"].append("original.paperTitle")
                if orig_fm.get("title"):
                    if subtitle[:4] not in orig_fm["title"]:
                        orig_fm["title"] = f"{orig_fm['title']} —— {subtitle}"
                break
        else:
            new_body = orig_body
    else:
        new_body = orig_body

    # 写回 original.md
    if "original.body-merge-subtitle" in result["fixed"] or "original.paperTitle" in result["fixed"]:
        result["fixed"].append("original.authors")
        # 更新 YAML authors
        orig_fm["authors"] = real_authors
        if not dry_run:
            new_text = rebuild_fm_block(orig_fm) + "\n\n" + new_body
            orig_file.write_text(new_text, encoding="utf-8")

    # --- 3. 修复 index.md ---
    idx_file = paper_dir / (dirname + ".index.md")
    if idx_file.exists():
        idx_text = idx_file.read_text(encoding="utf-8")
        idx_fm, idx_body = parse_fm_and_body(idx_text)

        changed = False
        if idx_fm.get("authors") != real_authors:
            idx_fm["authors"] = real_authors
            changed = True
            result["fixed"].append("index.authors")

        # 同步 paperTitle
        if orig_fm.get("paperTitle") and idx_fm.get("paperTitle") != orig_fm["paperTitle"]:
            idx_fm["paperTitle"] = orig_fm["paperTitle"]
            idx_fm["title"] = orig_fm.get("title", orig_fm["paperTitle"])
            changed = True
            result["fixed"].append("index.title")

        if changed and not dry_run:
            new_idx = rebuild_fm_block(idx_fm) + "\n\n" + idx_body
            idx_file.write_text(new_idx, encoding="utf-8")

    # --- 4. 修复 信息.md ---
    info_file = paper_dir / (dirname + "_信息.md")
    if info_file.exists():
        info_text = info_file.read_text(encoding="utf-8")
        info_fm, info_body = parse_fm_and_body(info_text)

        changed = False

        # 修复 YAML authors
        if info_fm.get("authors") != real_authors:
            info_fm["authors"] = real_authors
            changed = True
            result["fixed"].append("info.authors")

        # 同步 paperTitle
        if orig_fm.get("paperTitle") and info_fm.get("paperTitle") != orig_fm["paperTitle"]:
            info_fm["paperTitle"] = orig_fm["paperTitle"]
            info_fm["title"] = f"{orig_fm['paperTitle']} - 信息"
            changed = True
            result["fixed"].append("info.title")

        # 修复正文中的作者行显示
        info_body = re.sub(
            r'^(## 作者\n).*',
            f'\\1{'、'.join(real_authors)}',
            info_body,
            flags=re.MULTILINE
        )

        if changed and not dry_run:
            new_info = rebuild_fm_block(info_fm) + "\n\n" + info_body
            info_file.write_text(new_info, encoding="utf-8")

    if result["fixed"]:
        result["message"] = f"fixed: {', '.join(result['fixed'][:6])}"

    return result


def main():
    parser = argparse.ArgumentParser(description="Fix author fields and subtitle merge")
    parser.add_argument("--md-dir", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    md_dir = Path(args.md_dir)
    if not md_dir.is_dir():
        safe_log("ERROR", "Dir not found: %s", md_dir)
        sys.exit(1)

    if args.dry_run:
        safe_log("INFO", "DRY RUN - no changes")

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
    safe_log("INFO", "Total: %d | Fixed: %d | No change: %d",
             len(results), len(fixed), len(ok))

    if args.dry_run:
        safe_log("INFO", "Run without --dry-run to apply.")


if __name__ == "__main__":
    main()
