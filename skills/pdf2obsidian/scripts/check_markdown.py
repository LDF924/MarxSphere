#!/usr/bin/env python3
"""
PDF -> Markdown 转化质量检查脚本 v3

使用 PyMuPDF (fitz) 提取 PDF 文字（中文支持优秀），
与 MinerU 解析的 Markdown 做逐篇对比。

检查维度:
  1. 字符级: PDF 字符数 vs MD 字符数，SequenceMatcher 相似度
  2. 句子级: PDF 句子在 MD 中的匹配率
  3. 关键词: PDF 高频词在 MD 中是否出现
  4. 截断检测: MD 尾部是否正常结束
  5. 结构检测: 参考文献/表格是否完整

用法:
  python3 check_markdown.py --pdf-dir "PDF目录" --md-dir "Markdown目录"
  python3 check_markdown.py --pdf-dir "PDF目录" --md-dir "Markdown目录" --report-json report.json
  python3 check_markdown.py --pdf-dir "PDF目录" --md-dir "Markdown目录" --low-only

分级: 优秀(>=90) / 良好(80-89) / 需复查(65-79) / 严重缺失(<65)
"""

import argparse
import json
import re
import sys
import time
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

import fitz


def safe_print(*args, **kwargs):
    text = " ".join(str(a) for a in args)
    try:
        print(text, **kwargs)
    except UnicodeEncodeError:
        cleaned = text.encode("gbk", errors="replace").decode("gbk", errors="replace")
        print(cleaned, **kwargs)


def safe_log(level: str, msg: str, *fmt_args):
    timestamp = time.strftime("%H:%M:%S")
    if fmt_args:
        try:
            msg = msg % fmt_args
        except TypeError:
            pass
    safe_print(f"[{timestamp}] {level} {msg}")


# ============================================================
# PDF 文本提取 (PyMuPDF)
# ============================================================

def extract_pdf_text(pdf_path: Path) -> Optional[str]:
    """PyMuPDF 提取 PDF 全文。"""
    try:
        doc = fitz.open(str(pdf_path))
        pages = []
        for page in doc:
            text = page.get_text()
            if text:
                pages.append(text)
        doc.close()
        return "\n".join(pages)
    except Exception as e:
        safe_log("WARN", "PDF extract failed %s: %s", pdf_path.name, str(e)[:80])
        return None


def count_pdf_pages(pdf_path: Path) -> Optional[int]:
    try:
        doc = fitz.open(str(pdf_path))
        n = doc.page_count
        doc.close()
        return n
    except Exception:
        return None


# ============================================================
# 文本清洗
# ============================================================

def normalize(text: str) -> str:
    """归一化，消除格式差异。"""
    # 折叠空白
    text = re.sub(r'\s+', ' ', text)
    # 页码
    text = re.sub(r'\d{1,3}\s*/\s*\d{1,3}', ' ', text)
    # 零宽字符
    text = re.sub(r'[​‌‍‎‏﻿]', '', text)
    # MinerU 图片/表格占位符
    text = re.sub(r'!\[.*?\]\(.*?\)', ' ', text)
    text = re.sub(r'<!--\s*IMAGE\s*\d+\s*-->', ' ', text)
    # 全角空格
    text = text.replace('　', ' ')
    return text.strip()


def normalize_chars(text: str) -> str:
    """仅保留中英文字母数字。"""
    return re.sub(r'[^一-鿿㐀-䶿a-zA-Z0-9]', '', text)


def split_sentences(text: str) -> list[str]:
    """按中文标点分句。"""
    raw = re.split(r'[。！？；\n](?![」』）\)\]\}])', text)
    return [s.strip() for s in raw if len(s.strip()) >= 6]


# ============================================================
# 核心对比
# ============================================================

def compare_texts(pdf_text: str, md_text: str, pdf_pages: int = 0) -> dict:
    """对比 PDF 原文与 MD 解析结果。"""
    result = {
        "char_similarity": 0.0,
        "sent_match_rate": 0.0,
        "pdf_chars": 0, "md_chars": 0,
        "pdf_sents": 0, "md_sents": 0,
        "matched_sents": 0,
        "missing_sents": [],
        "missing_keywords": [],
        "truncation": 0.0,
        "score": 0.0,
        "grade": "严重缺失",
        "issues": [],
    }

    if not pdf_text or not md_text:
        result["issues"].append("PDF 或 MD 文本为空")
        return result

    pdf_norm = normalize(pdf_text)
    md_norm = normalize(md_text)

    if not pdf_norm or not md_norm:
        result["issues"].append("归一化后文本为空")
        return result

    result["pdf_chars"] = len(pdf_norm)
    result["md_chars"] = len(md_norm)

    # ---- 1. 中英文字符相似度 ----
    pdf_clean = normalize_chars(pdf_norm)
    md_clean = normalize_chars(md_norm)
    if pdf_clean:
        result["char_similarity"] = round(
            SequenceMatcher(None, pdf_clean, md_clean).ratio(), 4)
    else:
        result["char_similarity"] = 1.0

    # ---- 2. 句子匹配率 ----
    pdf_sents = split_sentences(pdf_norm)
    md_sents = split_sentences(md_norm)
    result["pdf_sents"] = len(pdf_sents)
    result["md_sents"] = len(md_sents)

    if pdf_sents and md_sents:
        matched = 0
        missing = []
        for ps in pdf_sents:
            best = max(
                (SequenceMatcher(None, ps, ms).ratio() for ms in md_sents),
                default=0)
            if best >= 0.55:
                matched += 1
            elif len(ps) >= 12:
                missing.append(ps)
        result["matched_sents"] = matched
        result["sent_match_rate"] = round(matched / len(pdf_sents), 4)
        result["missing_sents"] = missing[:8]

    # ---- 3. 字符量比例 ----
    if pdf_pages > 0:
        md_per_page = result["md_chars"] / pdf_pages
        pdf_per_page = result["pdf_chars"] / pdf_pages
    else:
        md_per_page = pdf_per_page = 1
    char_ratio = result["md_chars"] / max(result["pdf_chars"], 1)

    # ---- 4. 关键词 ----
    pdf_words = set(re.findall(r'[一-鿿]{2,}|[a-zA-Z]{4,}', pdf_clean.lower()))
    md_words = set(re.findall(r'[一-鿿]{2,}|[a-zA-Z]{4,}', md_clean.lower()))
    pdf_wc = Counter(re.findall(r'[一-鿿]{2,}|[a-zA-Z]{4,}', pdf_clean.lower()))
    pdf_highfreq = {w for w, c in pdf_wc.items() if c >= 3 and len(w) >= 2}
    noise = {"the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
             "have", "has", "been", "will", "can", "may", "also", "analysis", "based",
             "using", "data", "study", "results", "research", "figure", "table",
             "journal", "university", "press", "review", "science", "social"}
    missing_kw = sorted([w for w in (pdf_highfreq - md_words) if w not in noise])[:12]
    result["missing_keywords"] = missing_kw

    # ---- 5. 截断检测 ----
    md_tail = md_norm[-300:] if len(md_norm) > 300 else md_norm
    pdf_tail = pdf_norm[-300:] if len(pdf_norm) > 300 else pdf_norm
    if re.search(r'[。！？.!\?\"\"\)\]】」』\n]', md_tail[-5:]):
        result["truncation"] = max(0.3, SequenceMatcher(None, md_tail, pdf_tail).ratio())
    else:
        result["truncation"] = 0.1

    # ---- 6. 专项检测 ----
    issues = result["issues"]

    # 参考文献
    if bool(re.search(r'参考文[献獻]|References|REFERENCES', pdf_norm)):
        if not bool(re.search(r'参考文[献獻]|References|REFERENCES', md_norm)):
            ref_check = SequenceMatcher(
                None,
                pdf_norm[-1500:] if len(pdf_norm) > 1500 else pdf_norm,
                md_norm[-1500:] if len(md_norm) > 1500 else md_norm
            ).ratio()
            if ref_check < 0.3:
                issues.append("参考文献可能缺失")

    # 表格
    pdf_tables = len(re.findall(r'表\s*\d|Table\s*\d', pdf_norm))
    md_tables = len(re.findall(r'表\s*\d|Table\s*\d|\|.*\|.*\|', md_norm))
    if pdf_tables >= 3 and md_tables < pdf_tables * 0.5:
        issues.append(f"表格可能遗漏 (PDF:{pdf_tables} -> MD:{md_tables})")

    # 数字
    pdf_nums = set(re.findall(r'\d+\.?\d*%?', pdf_norm))
    md_nums = set(re.findall(r'\d+\.?\d*%?', md_norm))
    if pdf_nums and len(pdf_nums) > 20:
        ratio = len(pdf_nums & md_nums) / len(pdf_nums)
        if ratio < 0.65:
            issues.append(f"数字丢失率 {1-ratio:.0%}")

    # 字符量极度缩水
    if char_ratio < 0.4:
        issues.append(f"字符量仅原文 {char_ratio:.0%}")

    # 截断
    if result["truncation"] < 0.4:
        issues.append("MD 尾部可能截断")

    # ---- 7. 综合评分 (0-100) ----
    # 权重: 字符相似度 35%, 句子匹配率 30%, 截断 20%, 字符量比例 15%
    c_score = result["char_similarity"] * 35

    sent_score = result["sent_match_rate"] * 30

    trunc_score = min(result["truncation"], 1.0) * 20
    if result["truncation"] < 0.3:
        trunc_score = 0

    if 0.5 <= char_ratio <= 2.0:
        char_vol_score = 15
    elif 0.3 <= char_ratio < 0.5:
        char_vol_score = 8
    else:
        char_vol_score = 4

    total_score = c_score + sent_score + trunc_score + char_vol_score
    # 每个 issue 扣 3 分
    total_score = max(0, total_score - len(issues) * 3)
    result["score"] = round(total_score, 1)

    if total_score >= 90:
        result["grade"] = "优秀"
    elif total_score >= 80:
        result["grade"] = "良好"
    elif total_score >= 65:
        result["grade"] = "需复查"
    else:
        result["grade"] = "严重缺失"

    return result


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="PDF->Markdown quality checker v3")
    parser.add_argument("--pdf-dir", required=True)
    parser.add_argument("--md-dir", required=True)
    parser.add_argument("--report-json")
    parser.add_argument("--low-only", action="store_true")
    parser.add_argument("--max-files", type=int)
    args = parser.parse_args()

    pdf_dir = Path(args.pdf_dir)
    md_dir = Path(args.md_dir)

    if not pdf_dir.is_dir():
        safe_log("ERROR", "PDF dir not found: %s", pdf_dir)
        sys.exit(1)
    if not md_dir.is_dir():
        safe_log("ERROR", "MD dir not found: %s", md_dir)
        sys.exit(1)

    # 扫描 PDF
    raw = list(pdf_dir.rglob("*.pdf")) + list(pdf_dir.rglob("*.PDF"))
    seen, pdf_files = {}, []
    for p in raw:
        k = p.resolve()
        if k not in seen:
            seen[k] = True
            pdf_files.append(k)
    pdf_files.sort()

    safe_log("INFO", "PDF dir: %s (%d files)", pdf_dir, len(pdf_files))
    safe_log("INFO", "MD dir:  %s", md_dir)

    if args.max_files:
        pdf_files = pdf_files[:args.max_files]

    # 构建 MD 索引 (sourcePdf in original.md -> dir)
    md_map = {}
    for d in md_dir.iterdir():
        if not d.is_dir():
            continue
        orig = d / (d.name + ".original.md")
        if not orig.exists():
            continue
        try:
            text = orig.read_text(encoding="utf-8")[:3000]
            m = re.search(r'sourcePdf:\s*(.+)', text)
            if m:
                md_map[m.group(1).strip()] = d
        except Exception:
            pass

    safe_log("INFO", "MD index: %d papers\n", len(md_map))

    results = []
    grades_count = Counter()
    skipped = 0

    start = time.time()

    for i, pdf_path in enumerate(pdf_files, 1):
        pdf_name = pdf_path.name
        md_dir_path = md_map.get(pdf_name)

        if not md_dir_path:
            skipped += 1
            continue

        orig_md = md_dir_path / (md_dir_path.name + ".original.md")
        if not orig_md.exists():
            skipped += 1
            continue

        # 提取 PDF 文字 (PyMuPDF)
        pdf_text = extract_pdf_text(pdf_path)
        if not pdf_text:
            safe_log("WARN", "[%d/%d] %s -> PDF extract failed, skip",
                     i, len(pdf_files), pdf_name)
            skipped += 1
            continue

        pdf_pages = count_pdf_pages(pdf_path) or 0

        # 读取 MD
        md_content = orig_md.read_text(encoding="utf-8")
        md_body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', md_content, flags=re.DOTALL)

        # 对比
        check = compare_texts(pdf_text, md_body, pdf_pages)
        check["pdf_file"] = pdf_name

        if not args.low_only or check["grade"] in ("需复查", "严重缺失"):
            grade_sym = {"优秀": "[OK]", "良好": "[OK]", "需复查": "[??]", "严重缺失": "[!!]"}.get(check["grade"], "[?]")
            safe_log("INFO",
                "[%d/%d] %s %s score=%.0f | "
                "char-sim=%.0f%% sent-match=%.0f%% trunc=%.0f%% | "
                "pdf-chars=%d md-chars=%d pages=%d",
                i, len(pdf_files), grade_sym, check["grade"], check["score"],
                check["char_similarity"] * 100, check["sent_match_rate"] * 100,
                check["truncation"] * 100,
                check["pdf_chars"], check["md_chars"], pdf_pages)

            if check["issues"]:
                for issue in check["issues"]:
                    safe_log("WARN", "  [!] %s", issue)

            if check["missing_keywords"]:
                safe_log("INFO", "  missing keywords: %s", ", ".join(check["missing_keywords"][:8]))

            if check["missing_sents"]:
                s = check["missing_sents"][0][:70]
                safe_log("INFO", "  missing sentence: %s...", s)

        results.append(check)
        grades_count[check["grade"]] += 1

    elapsed = time.time() - start

    # ---- 汇总 ----
    safe_log("INFO", "")
    safe_log("INFO", "=" * 60)
    safe_log("INFO", "===== QUALITY CHECK SUMMARY =====")
    safe_log("INFO", "Time: %.0fs | PDF total: %d | Checked: %d | Skipped: %d",
             elapsed, len(pdf_files), len(results), skipped)
    safe_log("INFO", "优秀: %d | 良好: %d | 需复查: %d | 严重缺失: %d",
             grades_count.get("优秀", 0), grades_count.get("良好", 0),
             grades_count.get("需复查", 0), grades_count.get("严重缺失", 0))

    if results:
        avg_score = sum(r["score"] for r in results) / len(results)
        safe_log("INFO", "Average score: %.1f / 100", avg_score)

    # 最差的 10 篇
    results.sort(key=lambda r: r["score"])
    safe_log("INFO", "")
    safe_log("INFO", "--- Lowest Scoring 10 ---")
    for r in results[:10]:
        safe_log("INFO", "  %s [%s] score=%.0f | char=%.0f%% sent=%.0f%% -> %s",
                 r["pdf_file"][:55], r["grade"], r["score"],
                 r["char_similarity"] * 100, r["sent_match_rate"] * 100,
                 "; ".join(r["issues"][:3]) or "no issues")

    # 问题分类汇总
    all_issues = Counter()
    for r in results:
        for issue in r["issues"]:
            all_issues[issue] += 1
    if all_issues:
        safe_log("INFO", "")
        safe_log("INFO", "--- Issue Categories ---")
        for issue, count in all_issues.most_common():
            safe_log("INFO", "  x%d: %s", count, issue)

    # ================================================================
    # 新增：内部一致性检查（目录名/标题/作者/引号）
    # ================================================================
    safe_log("INFO", "")
    safe_log("INFO", "=" * 60)
    safe_log("INFO", "===== INTERNAL CONSISTENCY CHECK =====")

    h1_split = 0
    author_bad = 0
    info_author_bad = 0
    quote_bad = 0
    title_mismatch = 0
    bad_kw = ['基于', '村的案例', '研究', '调查', '实证', '数据', '经验']

    for d in sorted(md_dir.iterdir()):
        if not d.is_dir() or d.name.startswith('.') or d.name.startswith('_'): continue
        orig_f = d / (d.name + '.original.md')
        idx_f = d / (d.name + '.index.md')
        info_f = d / (d.name + '_信息.md')
        if not orig_f.exists() or not idx_f.exists(): continue

        # 1. H1/副标题分离
        orig_t = orig_f.read_text(encoding='utf-8')
        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', orig_t, flags=re.DOTALL)
        h1_m = re.search(r'^#\s+(.+)\n', body, re.MULTILINE)
        if h1_m:
            rest = body[h1_m.end():].lstrip()
            first_line = rest.split('\n')[0].strip()
            if first_line and re.match(r'^(?:基于|——).+?(?:研究|调查|分析|框架|考察)', first_line):
                h1_split += 1

        # 2. index.md 作者含非人名内容 (YAML + body table)
        idx_t = idx_f.read_text(encoding='utf-8')[:2000]
        m = re.search(r'^authors:\s*\n((?:\s+- .+\n)+)', idx_t, re.MULTILINE)
        if m:
            authors = [x.strip() for x in re.findall(r'- (.+)', m.group(1))]
            if any(any(kw in a for kw in bad_kw) for a in authors):
                author_bad += 1
        # 也检查 body 元数据表格中的作者行
        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', idx_t, flags=re.DOTALL)
        table_author = re.search(r'\| 作者\s*\|([^|]+)\|', body)
        if table_author:
            ta = table_author.group(1).strip()
            if any(kw in ta for kw in bad_kw):
                author_bad += 1

        # 3. 信息.md 作者含非人名内容
        if info_f.exists():
            info_t = info_f.read_text(encoding='utf-8')[:800]
            m2 = re.search(r'^authors:\s*\n((?:\s+- .+\n)+)', info_t, re.MULTILINE)
            if m2:
                ia = [x.strip() for x in re.findall(r'- (.+)', m2.group(1))]
                if any(any(kw in a for kw in bad_kw) for a in ia):
                    info_author_bad += 1

        # 4. YAML 多层引号
        for suffix in ['.original.md', '.index.md', '_信息.md', '摘要.md', '术语.md', '问答.md']:
            fpath = d / (d.name + suffix)
            if fpath.exists():
                text = fpath.read_text(encoding='utf-8')[:800]
                if "'''" in text:
                    quote_bad += 1

        # 5. original vs index 标题不一致
        def _get_fm_val(text, key):
            m0 = re.match(r'^---\s*\n.*?\n---', text, re.DOTALL)
            if not m0: return ''
            m1 = re.search(rf'^{key}:\s*(.+)$', m0.group(0), re.MULTILINE)
            return m1.group(1).strip().strip("'\"") if m1 else ''
        ot = _get_fm_val(orig_t, 'paperTitle') or _get_fm_val(orig_t, 'title')
        it = _get_fm_val(idx_t, 'paperTitle') or _get_fm_val(idx_t, 'title')
        if ot[:20] != it[:20] and len(ot) > 5 and len(it) > 5:
            title_mismatch += 1

    total_consistency = h1_split + author_bad + info_author_bad + quote_bad + title_mismatch
    safe_log("INFO", "H1/subtitle split:           %d", h1_split)
    safe_log("INFO", "index.md bad authors:        %d", author_bad)
    safe_log("INFO", "info.md bad authors:         %d", info_author_bad)
    safe_log("INFO", "YAML quote escaping issues:  %d", quote_bad)
    safe_log("INFO", "original vs index title mismatch: %d", title_mismatch)
    if total_consistency == 0:
        safe_log("INFO", "Internal consistency: CLEAN")
    else:
        safe_log("WARN", "Internal consistency: %d issues found", total_consistency)
        safe_log("INFO", "Run fix_quotes.py / fix_authors.py / fix_frontmatter.py to repair.")
    # ================================================================

    # JSON 报告
    if args.report_json:
        report = {
            "summary": {
                "total_pdfs": len(pdf_files),
                "checked": len(results),
                "skipped": skipped,
                "grades": dict(grades_count),
                "avg_score": round(avg_score, 1) if results else 0,
                "internal_consistency": {
                    "h1_subtitle_split": h1_split,
                    "index_bad_authors": author_bad,
                    "info_bad_authors": info_author_bad,
                    "quote_issues": quote_bad,
                    "title_mismatch": title_mismatch,
                    "clean": total_consistency == 0,
                },
            },
            "details": results,
        }
        Path(args.report_json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        safe_log("INFO", "")
        safe_log("INFO", "Report saved: %s", args.report_json)


if __name__ == "__main__":
    main()
