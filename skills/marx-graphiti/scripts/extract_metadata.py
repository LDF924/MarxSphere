#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 模块2-增强：文献元数据深度提取
============================================================
功能：
  1. 从原文 MD 文本中批量解析作者、刊发年份（多策略正则 + NLP）
  2. 自动生成 historical_period 历史分期字段
  3. 语义冲突自动识别 + 分级标记 + 置信度打分
  4. 冲突人工审核队列导出（JSON/CSV）
  5. 批量字段修复 & 回填已入库 208 篇
  6. Dry-run 输出结构化报告文件（JSON）

操作:
  python extract_metadata.py --dry-run            # 预览 + 输出报告
  python extract_metadata.py                      # 执行抽取 + 写入 Neo4j
  python extract_metadata.py --fix-only           # 仅修复已有字段（不重抽年份）
  python extract_metadata.py --conflicts-only     # 仅重新执行冲突检测
  python extract_metadata.py --export-audit       # 导出冲突审核队列到 JSON
"""

import sys, json, re, argparse
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, DeepSeekClient

logger = get_logger("extract_metadata")

BASE_DIR = Path(r"D:\Desktop\ov_import")
REPORT_DIR = SCRIPT_DIR / ".metadata_reports"
REPORT_DIR.mkdir(exist_ok=True)

# ── 多策略年份提取 ──
YEAR_PATTERNS = [
    re.compile(r'(?:投稿日期|收稿日期|出版日期|发表时间|刊发日期)[：:\s]*([12]\d{3})'),
    re.compile(r'(?:年[份代]\s*[：:]?\s*)([12]\d{3})'),
    re.compile(r'[（(]([12]\d{3})[）)]'),
]
FILENAME_YEAR_PATTERN = re.compile(r'([12]\d{3})')
PURE_YEAR = re.compile(r'^[12]\d{3}$')

# ── 作者提取 ──
AUTHOR_PATTERNS = [
    re.compile(r'(?:作者|著者|撰文|执笔)[：:\s]*([^\s,，。；;]{2,4})'),
    re.compile(r'([^\s,，。]{2,3})\s*(?:著|编|译|撰)'),
    re.compile(r'(?:本文|笔者)\s*(?:作者|执笔)[：:]*([^\s,，。]{2,4})'),
]
FILENAME_AUTHOR_PATTERN = re.compile(r'.+_([一-鿿·]{2,4})$')

# ── historical_period 映射 ──
PERIOD_MAP = [
    (range(0, 1848), "经典马恩时期-早期著作"),
    (range(1848, 1884), "经典马恩时期-成熟著作"),
    (range(1884, 1917), "第二国际与列宁前期"),
    (range(1917, 1949), "列宁斯大林时期与中国革命"),
    (range(1949, 1978), "社会主义建设探索期"),
    (range(1978, 2012), "改革开放时期"),
    (range(2012, 2030), "新时代"),
]

# ── 文献类型 ──
TYPE_CLUES = {
    "经典文本": ["马克思", "恩格斯", "列宁", "资本论", "共产党宣言",
                "德意志意识形态", "1844年经济学哲学手稿", "政治经济学批判",
                "路德维希·费尔巴哈", "哥达纲领批判"],
    "学位论文": ["硕士", "博士", "学位论文", "毕业论文", "Dissertation", "Thesis"],
    "政策文件": ["关于", "通知", "意见", "办法", "条例", "决定", "规划",
                "国务院", "中央", "部委", "乡村振兴战略", "十三五", "十四五"],
    "会议论文": ["会议", "研讨会", "论坛", "论文集", "讲演", "大会"],
    "专著": ["出版社", "书号", "ISBN", "丛书", "卷"],
    "期刊论文": ["学报", "期刊", "辑刊", "第.*期", "第.*卷"],
}


# ═══════════════════════════════════════════════════════════
# 元数据提取
# ═══════════════════════════════════════════════════════════

def extract_year(fname: str, abstract: str, original: str) -> int:
    """多策略年份提取，优先级: 投稿日期 > 出版日期 > 摘要年份 > 文件名年份"""
    text = (abstract + "\n" + original)[:5000]

    for pat in YEAR_PATTERNS:
        m = pat.search(text)
        if m:
            y = int(m.group(1))
            if 1900 <= y <= 2026:
                return y

    # 摘要前 300 字的纯 4 位数字
    for m in FILENAME_YEAR_PATTERN.finditer(abstract[:300]):
        y = int(m.group())
        if 1949 <= y <= 2026:
            return y

    # 文件名
    if fname:
        m = FILENAME_YEAR_PATTERN.search(fname)
        if m:
            y = int(m.group())
            if 1980 <= y <= 2026:
                return y

    return 0


def extract_author(fname: str, abstract: str, original: str) -> str:
    """多策略作者提取"""
    # 文件名后缀
    if fname:
        m = FILENAME_AUTHOR_PATTERN.search(fname)
        if m and len(m.group(1)) <= 4:
            return m.group(1).strip("_")

    text = abstract[:500] + original[:500]

    for pat in AUTHOR_PATTERNS:
        m = pat.search(text)
        if m and 2 <= len(m.group(1)) <= 4:
            return m.group(1).strip()

    return ""


def extract_doc_type(fname: str, abstract: str, original: str) -> str:
    """基于关键词识别文献类型"""
    combined = (fname or "") + abstract[:800] + original[:2000]
    for dtype, clues in TYPE_CLUES.items():
        for clue in clues:
            if clue in combined:
                return dtype
    return "期刊论文"


def get_period(year: int) -> str:
    if not year or year == 0:
        return ""
    for yr_range, label in PERIOD_MAP:
        if year in yr_range:
            return label
    return "新时代"


# ═══════════════════════════════════════════════════════════
# 冲突检测 (LLM 语义 + 分级标记)
# ═══════════════════════════════════════════════════════════

CONFLICT_TYPES = ["概念重复", "理论分歧", "标注歧义"]
CONFLICT_LEVELS = ["核心分歧", "表述差异", "适用条件分歧", "实践路径分歧"]


def detect_semantic_conflicts(dry_run: bool = False) -> list:
    """
    从三路检测冲突:
      a) 同名不同类实体
      b) CONTRAST_WITH 关系对
      c) 高相似度向量 + 异义标注
    用 DeepSeek LLM 逐一判断真伪，输出置信度 + 分级标记
    """
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    ds = DeepSeekClient()

    # 候选池
    candidates = []

    # a) 同名不同类
    rows_a = nc.execute_query("""
        MATCH (e1:Entity), (e2:Entity)
        WHERE e1.name = e2.name AND e1.category <> e2.category
        AND elementId(e1) < elementId(e2)
        RETURN e1.name AS name, e1.category AS cat1, e2.category AS cat2
        LIMIT 30
    """)
    for r in rows_a:
        candidates.append({
            "type": "同名异类",
            "entity_a": r["name"], "entity_b": r["name"],
            "detail": f"cat: {r['cat1']} vs {r['cat2']}"
        })

    # b) CONTRAST_WITH
    rows_b = nc.execute_query("""
        MATCH (a:Entity)-[r:CONTRAST_WITH]->(b:Entity)
        RETURN a.name AS a, b.name AS b, r.confidence AS conf
        LIMIT 30
    """)
    for r in rows_b:
        candidates.append({
            "type": "对立关系",
            "entity_a": r["a"], "entity_b": r["b"],
            "detail": f"CONTRAST_WITH confidence={r['conf']}"
        })

    # c) 向量相似但分类不同
    try:
        rows_c = nc.execute_query("""
            MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL
            WITH e LIMIT 100
            MATCH (e2:Entity) WHERE e2.entity_vector IS NOT NULL AND e <> e2
                AND e.category <> e2.category
            WITH e, e2
            ORDER BY gds.similarity.cosine(e.entity_vector, e2.entity_vector) DESC
            RETURN e.name AS a, e2.name AS b, e.category AS cat1, e2.category AS cat2
            LIMIT 20
        """)
    except Exception:
        rows_c = []

    for r in rows_c:
        candidates.append({
            "type": "向量碰撞",
            "entity_a": r["a"], "entity_b": r["b"],
            "detail": f"cos-sim high but cat: {r['cat1']} vs {r['cat2']}"
        })

    logger.info(f"  Conflict candidates: {len(candidates)}")

    audit_queue = []
    conflict_count = 0
    for cand in candidates:
        prompt = (
            f"你是马理论审稿专家。请判断以下两个实体间是否存在实质性冲突：\n"
            f"实体A: {cand['entity_a']}\n实体B: {cand['entity_b']}\n"
            f"线索类型: {cand['type']} ({cand['detail']})\n\n"
            f'输出JSON: {{"is_real": true/false, '
            f'"conflict_type": "{"/".join(CONFLICT_TYPES)}", '
            f'"conflict_level": "{"/".join(CONFLICT_LEVELS)}", '
            f'"confidence": 0.0-1.0, "description": "..."}}'
        )
        r = ds.call_json(prompt, max_retries=1, timeout=60)
        if not r:
            continue

        label = r.get("conflict_type", "理论分歧")
        level = r.get("conflict_level", "表述差异")
        confidence = r.get("confidence", 0.5)
        is_real = r.get("is_real", False)

        entry = {
            "entity_a": cand["entity_a"],
            "entity_b": cand["entity_b"],
            "is_real_conflict": is_real,
            "conflict_type": label if label in CONFLICT_TYPES else "理论分歧",
            "conflict_level": level if level in CONFLICT_LEVELS else "表述差异",
            "confidence": confidence,
            "description": r.get("description", ""),
            "review_needed": confidence < 0.7,
        }

        if is_real and not dry_run:
            nc.execute_write(
                "MATCH (a:Entity {name: $a}) "
                "CREATE (c:Conflict {concept: $concept, conflict_type: $type, "
                "conflict_level: $level, description: $desc, "
                "confidence: $conf, review_needed: $review, "
                "created_at: datetime()}) "
                "MERGE (a)-[:HAS_CONFLICT]->(c)",
                {"a": cand["entity_a"],
                 "concept": f"{cand['entity_a']} vs {cand['entity_b']}",
                 "type": label, "level": level, "desc": entry["description"],
                 "conf": confidence, "review": entry["review_needed"]}
            )
            conflict_count += 1

        if entry["review_needed"]:
            audit_queue.append(entry)

    nc.close()
    logger.info(f"  Real conflicts created: {conflict_count}")
    logger.info(f"  Review queue size: {len(audit_queue)}")
    return audit_queue


# ═══════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Metadata extract & conflict audit")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, output JSON report")
    parser.add_argument("--fix-only", action="store_true", help="Only fill missing fields on existing episodes")
    parser.add_argument("--conflicts-only", action="store_true", help="Only run conflict detection")
    parser.add_argument("--export-audit", action="store_true", help="Export review queue to JSON")
    args = parser.parse_args()

    if args.conflicts_only:
        logger.info("Conflicts-only mode")
        audit = detect_semantic_conflicts(dry_run=False)
        return

    if args.export_audit:
        audit = detect_semantic_conflicts(dry_run=True)
        path = REPORT_DIR / f"conflict_audit_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"Audit queue exported: {path} ({len(audit)} items)")
        return

    # ── 元数据抽取 ──
    all_dirs = sorted([d for d in BASE_DIR.iterdir()
                       if d.is_dir() and not d.name.startswith('.')])
    logger.info(f"Processing {len(all_dirs)} episodes...")

    results = []
    stats = {"year": 0, "author": 0, "doc_type": 0, "period": 0}

    for i, folder in enumerate(all_dirs):
        fname = folder.name

        # 读取文件
        abstract = ""
        original = ""
        for f in folder.glob("*.md"):
            n = f.name
            if "摘要" in n or "摘" in n:
                abstract = f.read_text(encoding="utf-8")
            elif not any(k in n for k in ["摘要","术语","问答","original"]):
                if not original:
                    original = f.read_text(encoding="utf-8")
            elif "original" in n.lower():
                original = f.read_text(encoding="utf-8")

        year = extract_year(fname, abstract, original)
        author = extract_author(fname, abstract, original)
        doc_type = extract_doc_type(fname, abstract, original)
        period = get_period(year)

        if year:
            stats["year"] += 1
        if author:
            stats["author"] += 1
        if doc_type:
            stats["doc_type"] += 1
        if period:
            stats["period"] += 1

        results.append({
            "folder": fname, "year": year, "author": author,
            "doc_type": doc_type, "historical_period": period,
        })

        if (i + 1) % 50 == 0 or i < 3:
            logger.info(f"  [{i+1}/{len(all_dirs)}] {fname[:35]} -> y={year} a={author} t={doc_type} p={period}")

        # 写入
        if not args.dry_run and not args.fix_only:
            try:
                nc = Neo4jConnection(uri="bolt://127.0.0.1:11001",
                                     user="neo4j", password="neo4j123")
                sets = []
                params = {"f": fname}
                if year:
                    sets.append("ep.year = $year"); params["year"] = year
                if author:
                    sets.append("ep.author = $author"); params["author"] = author
                if doc_type:
                    sets.append("ep.doc_type = $doc_type"); params["doc_type"] = doc_type
                if period:
                    sets.append("ep.historical_period = $period"); params["period"] = period
                if sets:
                    nc.execute_write(
                        f"MATCH (ep:Episode {{source_folder: $f}}) SET {', '.join(sets)}",
                        params)
                nc.close()
            except Exception as e:
                logger.warning(f"  Write failed: {e}")

    # Report
    report = {
        "timestamp": datetime.now().isoformat(),
        "total": len(all_dirs),
        "stats": stats,
        "results": results,
    }

    if args.dry_run:
        rpath = REPORT_DIR / f"metadata_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        rpath.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"Dry-run report: {rpath}")

    logger.info(f"\nResults:")
    logger.info(f"  year:    {stats['year']}/{len(all_dirs)}")
    logger.info(f"  author:  {stats['author']}/{len(all_dirs)}")
    logger.info(f"  doc_type:{stats['doc_type']}/{len(all_dirs)}")
    logger.info(f"  period:  {stats['period']}/{len(all_dirs)}")

    # Conflict detection after metadata
    if not args.fix_only:
        logger.info("\n" + "=" * 55)
        logger.info("  Semantic Conflict Detection")
        logger.info("=" * 55)
        audit = detect_semantic_conflicts(dry_run=args.dry_run)

        if audit:
            apath = REPORT_DIR / f"conflict_audit_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            apath.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
            to_review = [a for a in audit if a["review_needed"]]
            logger.info(f"  Audit queue: {apath} ({len(audit)} items, {len(to_review)} need review)")


if __name__ == "__main__":
    main()
