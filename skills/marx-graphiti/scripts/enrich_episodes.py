#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 模块2改进：Episode 元数据补充
============================================================
功能：
  1. 从文件名/摘要中自动提取发表年份、作者、文献类型
  2. 自动锚定 historical_period 字段
  3. 对已有 208 篇 Episode 批量回溯填充（增量更新）

操作:
  python enrich_episodes.py --dry-run    # 预览，不写入
  python enrich_episodes.py              # 执行填充
  python enrich_episodes.py --single <folder_name>  # 单篇填充
"""

import sys, json, re, argparse
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger

logger = get_logger("enrich_episodes")

BASE_DIR = Path(r"D:\Desktop\ov_import")

# ── 文献类型识别 ──
JOURNAL_KEYWORDS = ["期刊", "学报", "研究", "大学", "学院", "杂志"]
POLICY_KEYWORDS = ["政策", "通知", "意见", "办法", "条例", "法规", "规划"]
THESIS_KEYWORDS = ["硕士", "博士", "学位论文", "毕业论文", "Thesis", "Dissertation"]
CLASSIC_KEYWORDS = ["马克思", "恩格斯", "列宁", "毛泽东", "资本论", "共产党宣言",
                     "德意志意识形态", "1844", "手稿", "政治经济学批判"]

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


def extract_year(fname: str, abstract: str) -> int:
    """从文件名和摘要中提取发表年份"""
    # 文件名中找 4 位年份
    m = re.search(r'[12]\d{3}', fname)
    if m:
        y = int(m.group())
        if 1900 <= y <= 2026:
            return y
    # 摘要中找
    m = re.search(r'(?:发表于|刊于|出版于|发表时间|出版时间).*?([12]\d{3})', abstract)
    if m:
        y = int(m.group(1))
        if 1900 <= y <= 2026:
            return y
    # 摘要前 200 字中找
    m = re.search(r'[12]\d{3}', abstract[:200])
    if m:
        y = int(m.group())
        if 1990 <= y <= 2026:
            return y
    return 0


def extract_author(fname: str, abstract: str) -> str:
    """从文件名和摘要中提取作者"""
    # 文件名格式：标题_作者
    parts = fname.rsplit('_', 1)
    if len(parts) == 2 and len(parts[1]) <= 4 and all('一' <= c <= '鿿' or c in '·' for c in parts[1]):
        return parts[1]
    # 摘要中匹配
    m = re.search(r'(?:作者|著者)[：:]\s*([^\s,，。]{2,4})', abstract)
    if m:
        return m.group(1)
    # 第一人称暗示
    if "笔者" in abstract or "本文" in abstract:
        return "(省略:第一人称)"
    return ""


def extract_doc_type(fname: str, abstract: str, original_text: str) -> str:
    """识别文献类型"""
    combined = fname + abstract[:500] + original_text[:500]
    for kw in CLASSIC_KEYWORDS:
        if kw in combined:
            return "经典文本"
    for kw in THESIS_KEYWORDS:
        if kw in combined:
            return "学位论文"
    for kw in POLICY_KEYWORDS:
        if kw in combined:
            return "政策文件"
    for kw in JOURNAL_KEYWORDS:
        if kw in combined:
            return "期刊论文"
    if "会议" in combined:
        return "会议论文"
    if "专著" in combined or "出版社" in combined:
        return "专著"
    return "期刊论文"  # 默认


def get_historical_period(year: int) -> str:
    """根据年份映射历史阶段"""
    for yr_range, label in PERIOD_MAP:
        if year in yr_range:
            return label
    return "新时代"  # 默认


def enrich_one_episode(fname: str, dry_run: bool = False) -> dict:
    """对单篇 Episode 进行元数据提取"""
    folder = BASE_DIR / fname
    if not folder.exists():
        return {"folder": fname, "error": "folder not found"}

    # 读取文件
    abstract = ""
    original = ""
    for f in folder.glob("*.md"):
        n = f.name
        if "摘要" in n or "摘" in n:
            abstract = f.read_text(encoding="utf-8")
        elif "original" in n.lower() or (not any(k in n for k in ["摘要","术语","问答","original"])):
            if not original:
                original = f.read_text(encoding="utf-8")

    year = extract_year(fname, abstract)
    author = extract_author(fname, abstract)
    doc_type = extract_doc_type(fname, abstract, original)
    period = get_historical_period(year) if year > 0 else ""

    result = {
        "folder": fname,
        "year": year,
        "author": author,
        "doc_type": doc_type,
        "historical_period": period,
    }

    if not dry_run and (year or author or doc_type):
        try:
            nc = Neo4jConnection(uri="bolt://127.0.0.1:11001",
                                 user="neo4j", password="neo4j123")
            set_clauses = []
            params = {"f": fname}
            if year:
                set_clauses.append("ep.year = $year")
                params["year"] = year
            if author:
                set_clauses.append("ep.author = $author")
                params["author"] = author
            if doc_type:
                set_clauses.append("ep.doc_type = $doc_type")
                params["doc_type"] = doc_type
            if period:
                set_clauses.append("ep.historical_period = $period")
                params["period"] = period
            if set_clauses:
                nc.execute_write(
                    f"MATCH (ep:Episode {{source_folder: $f}}) SET {', '.join(set_clauses)}",
                    params)
            nc.close()
        except Exception as e:
            logger.warning(f"  Write failed for {fname[:30]}: {e}")

    return result


def main():
    parser = argparse.ArgumentParser(description="Episode metadata enrichment")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no write")
    parser.add_argument("--single", type=str, help="Process single folder")
    args = parser.parse_args()

    if args.single:
        result = enrich_one_episode(args.single, dry_run=args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    all_dirs = sorted([d.name for d in BASE_DIR.iterdir()
                       if d.is_dir() and not d.name.startswith('.')])
    logger.info(f"Processing {len(all_dirs)} episodes...")

    stats = {"year": 0, "author": 0, "doc_type": 0, "period": 0, "no_year": 0}
    samples = []

    for i, fname in enumerate(all_dirs):
        result = enrich_one_episode(fname, dry_run=args.dry_run)
        if result.get("year"):
            stats["year"] += 1
        else:
            stats["no_year"] += 1
        if result.get("author"):
            stats["author"] += 1
        if result.get("doc_type"):
            stats["doc_type"] += 1
        if result.get("historical_period"):
            stats["period"] += 1

        if i < 5 or i % 50 == 0:
            logger.info(f"  [{i+1}/{len(all_dirs)}] {fname[:40]} -> "
                         f"year={result.get('year',0)} author={result.get('author','')} "
                         f"type={result.get('doc_type','')} period={result.get('historical_period','')}")

    logger.info(f"\nResults:")
    logger.info(f"  With year:    {stats['year']}/{len(all_dirs)}")
    logger.info(f"  With author:  {stats['author']}/{len(all_dirs)}")
    logger.info(f"  With doc_type:{stats['doc_type']}/{len(all_dirs)}")
    logger.info(f"  With period:  {stats['period']}/{len(all_dirs)}")
    logger.info(f"  No year:      {stats['no_year']}/{len(all_dirs)}")

    if args.dry_run:
        logger.info("  DRY RUN — no changes written.")

    # ── 冲突校验：扫描全库，标记实质性冲突 ──
    logger.info("\n" + "=" * 55)
    logger.info("  Conflict Detection Scan")
    logger.info("=" * 55)
    detect_conflicts()


def detect_conflicts():
    """全库扫描矛盾关系，生成冲突标记"""
    from pipeline import DeepSeekClient
    ds = DeepSeekClient()

    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001",
                             user="neo4j", password="neo4j123")
    except Exception as e:
        logger.error(f"Neo4j connection failed: {e}")
        return

    # 找出所有有双向矛盾关系的实体对或有 CONTRAST_WITH 关系的实体
    candidates = nc.execute_query("""
        MATCH (a:Entity)-[r1]->(b:Entity)-[r2]->(a:Entity)
        WHERE type(r1) <> 'EXTRACTED_FROM' AND type(r2) <> 'EXTRACTED_FROM'
        AND type(r1) IN ['CONTRAST_WITH','CRITIQUES']
        RETURN a.name AS entity_a, b.name AS entity_b,
               type(r1) AS rel_type, a.context AS ctx_a, b.context AS ctx_b
        LIMIT 20
    """)

    if not candidates:
        logger.info("  No significant contradictions detected.")
    else:
        for cand in candidates:
            prompt = (
                f'请判断以下两个马理论概念是否存在实质性理论冲突：\n'
                f'概念A: {cand["entity_a"]} (语境: {cand.get("ctx_a","")})\n'
                f'概念B: {cand["entity_b"]} (语境: {cand.get("ctx_b","")})\n'
                f'关系类型: {cand["rel_type"]}\n'
                f'输出JSON: {{"is_real_conflict": true/false, "conflict_level": "核心分歧/表述差异/适用条件分歧/实践路径分歧", "description": "冲突简述"}}'
            )
            r = ds.call_json(prompt, max_retries=1, timeout=60)
            if r and r.get("is_real_conflict"):
                params = {
                    "a": cand["entity_a"], "b": cand["entity_b"],
                    "level": r.get("conflict_level", "表述差异"),
                    "desc": r.get("description", ""),
                    "rtype": cand["rel_type"]
                }
                nc.execute_write(
                    "MATCH (a:Entity {name: $a}) "
                    "CREATE (c:Conflict {concept: $a + ' vs ' + $b, "
                    "conflict_level: $level, description: $desc, "
                    "created_at: datetime()}) "
                    "MERGE (a)-[:HAS_CONFLICT]->(c)",
                    params)
            logger.info(f"    {cand['entity_a']} vs {cand['entity_b']}: "
                         f"{'conflict' if r.get('is_real_conflict') else 'no conflict'}")

    nc.close()


if __name__ == "__main__":
    main()
