#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
module_enrich_episode.py — 补齐 Episode 元数据
══════════════════════════════════════════════════════════════
利用已分块论文内容，LLM 批量补齐：
  1. year (127/208 已填，81缺失)
  2. historical_period (127/208 已填，81缺失)
  3. keywords (78/208 已填，130缺失)
  4. research_methods (1/208 已填，207缺失)

策略选项：
  A) LLM 批量抽取（成本 ~RMB 2, ~20min）
  B) 规则从摘要提取 year（零成本、秒级），LLM 提取 3/4 其余字段

默认选择 B —— year 从摘要标题正则匹配，其余用 LLM 批量。

每次取 20 篇待补论文，合并 chunk 摘要文本，单次 LLM 批量返回结构 JSON。
"""

import sys, re, json, time
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional, Tuple

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("enrich_episode")

BATCH = 20
MODEL = "qwen3.7-max"


def load_missing(nc: Neo4jConnection) -> Dict[str, Dict]:
    """Get papers missing any of: year, historical_period, keywords, research_methods."""
    rows = nc.execute_query("""
        MATCH (ep:Episode)
        OPTIONAL MATCH (ep)<-[:CHUNK_OF]-(c:Chunk)
        WHERE c.chunk_type IN ['abstract', 'original']
        WITH ep, c
        ORDER BY c.chunk_index
        WITH ep, collect(c.text) AS chunks
        RETURN ep.source_folder AS sf,
               ep.year AS year,
               ep.historical_period AS period,
               ep.keywords AS keywords,
               ep.research_methods AS methods,
               ep.doc_type AS doc_type,
               ep.author AS author,
               ep.title AS title,
               chunks
        ORDER BY sf
    """)
    missing = []
    for row in rows:
        missing_fields = []
        if row["year"] is None: missing_fields.append("year")
        if row["period"] is None: missing_fields.append("historical_period")
        if row["keywords"] is None or len(row["keywords"]) == 0: missing_fields.append("keywords")
        if row["methods"] is None: missing_fields.append("research_methods")
        # Join chunks in Python (first 10, max 3000 chars total)
        chunks = row.get("chunks", []) or []
        context = " ".join(chunks[:10])[:3000]
        if missing_fields:
            missing.append({
                "sf": row["sf"],
                "missing": missing_fields,
                "year_old": row["year"],
                "period_old": row["period"],
                "keywords_old": row["keywords"],
                "methods_old": row["methods"],
                "doc_type": row["doc_type"],
                "author": row["author"],
                "title": row["title"],
                "context": context,
            })
    return missing


def rule_extract_year(record: Dict) -> Optional[int]:
    """Extract year from title or source_folder name via regex (cost: 0)."""
    text = f"{record['title']} {record['sf']} {record['context'][:500]}"
    # Match 4-digit year within reasonable range
    matches = re.findall(r'(?:19[89]\d|20[0-2]\d)', text)
    for m in matches:
        y = int(m)
        if 1900 <= y <= 2026:
            return y
    return None


def llm_extract_batch(llm: QwenMaxClient, batch: List[Dict]) -> Optional[Dict]:
    """Single LLM call to extract metadata for 20 papers."""
    items = []
    for i, rec in enumerate(batch):
        missing_str = "/".join(rec["missing"])
        context = rec["context"][:2000] if rec["context"] else ""
        items.append(
            f"[{i}] 标题:{rec['title'][:60]} | 缺失:{missing_str}\n  摘要片段:{context[:500]}")

    prompt = (
        "你是马克思主义理论元数据提取专家。为以下论文批量提取元数据：\n\n"
        + "\n".join(items) + "\n\n"
        "提取规则：\n"
        "- year: 论文发表年份（4位数字），从标题、引用格式、年份数字中推断。若无法确定填 null\n"
        "- historical_period: 所属历史时期，严格限定：改革开放时期(1978-2000)|21世纪初(2001-2012)|新时代(2013至今)。根据年份映射，无年份则 null\n"
        "- keywords: 3-5个学术关键词（从摘要中提取核心概念术语）\n"
        "- research_methods: 研究方法（如：文献分析|实证研究|案例研究|政策分析|理论分析|计量分析|田野调查|定性研究|定量研究）\n\n"
        "输出严格JSON数组，每个元素对应一行：\n"
        '[{"index":0,"year":2020,"historical_period":"新时代","keywords":["资本下乡","乡村振兴"],"research_methods":"案例研究"},...]\n'
        "只输出JSON数组，不要额外文本。"
    )

    result = llm.call(prompt, max_retries=3, timeout=120,
                      system_prompt="只输出精确的JSON数组。")
    if result is None:
        return None

    content = result.get("content", "")
    # Strip markdown wrapping
    content = re.sub(r'^```(?:json)?\s*', '', content)
    content = re.sub(r'\s*```$', '', content)

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        logger.warning(f"JSON parse failed, raw: {content[:200]}")
        return None


def apply_results(nc: Neo4jConnection, batch: List[Dict], extracted: List[Dict]):
    """Write extracted metadata back to Episode nodes."""
    by_idx = {item.get("index", i): item for i, item in enumerate(extracted)}
    count = 0
    for i, rec in enumerate(batch):
        item = by_idx.get(i, {})
        updates = []
        params = {"sf": rec["sf"]}

        if "year" in rec["missing"] and item.get("year") and isinstance(item["year"], int) and 1900 <= item["year"] <= 2026:
            updates.append("ep.year = $year")
            params["year"] = item["year"]

        if "historical_period" in rec["missing"] and item.get("historical_period") and isinstance(item["historical_period"], str) and len(item["historical_period"]) > 1:
            updates.append("ep.historical_period = $period")
            params["period"] = item["historical_period"]

        if "keywords" in rec["missing"] and item.get("keywords") and isinstance(item["keywords"], list) and len(item["keywords"]) > 0:
            updates.append("ep.keywords = $kw")
            params["kw"] = item["keywords"]

        if "research_methods" in rec["missing"] and item.get("research_methods") and isinstance(item["research_methods"], str) and len(item["research_methods"]) > 1:
            updates.append("ep.research_methods = $rm")
            params["rm"] = item["research_methods"]

        if updates:
            set_clause = ", ".join(updates)
            try:
                nc.execute_write(f"MATCH (ep:Episode {{source_folder: $sf}}) SET {set_clause}", params)
                count += 1
            except Exception as e:
                logger.warning(f"Write failed for {rec['sf'][:40]}: {e}")

    return count


def main():
    logger.info("=" * 60)
    logger.info("Episode Metadata Enrichment")
    logger.info("=" * 60)

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    all_missing = load_missing(nc)
    logger.info(f"Papers missing metadata: {len(all_missing)}")
    if not all_missing:
        logger.info("All metadata complete!")
        nc.close()
        return

    # ── Step 1: Rule-based year extraction (zero cost) ───────
    year_filled = 0
    for rec in all_missing:
        if "year" in rec["missing"]:
            y = rule_extract_year(rec)
            if y:
                nc.execute_write(
                    "MATCH (ep:Episode {source_folder: $sf}) SET ep.year = $y",
                    {"sf": rec["sf"], "y": y})
                rec["missing"].remove("year")
                year_filled += 1

    logger.info(f"Step 1 (rule): {year_filled} years filled from title/regex")

    # ── Step 2: LLM batch extraction for remaining fields ───
    still_missing = [r for r in all_missing if r["missing"]]
    logger.info(f"Step 2 (LLM): {len(still_missing)} papers still need metadata")
    logger.info(f"Estimated cost: ~{(len(still_missing) // BATCH + 1) * 0.01:.2f} RMB, {len(still_missing) // BATCH + 1} batches")

    total_updated = 0
    for batch_start in range(0, len(still_missing), BATCH):
        batch = still_missing[batch_start:batch_start + BATCH]
        logger.info(f"  Batch {batch_start//BATCH + 1}: {len(batch)} papers")

        extracted = llm_extract_batch(llm, batch)
        if extracted is None:
            logger.warning(f"  Batch {batch_start//BATCH + 1}: LLM failed, skipping")
            continue

        n = apply_results(nc, batch, extracted)
        total_updated += n
        logger.info(f"  Updated {n}/{len(batch)} papers")
        time.sleep(1)  # Rate limit

    # ── Final stats ──────────────────────────────────────────
    final_rows = nc.execute_query("""
        MATCH (ep:Episode)
        RETURN count(ep) AS total,
               count(ep.year) AS with_year,
               count(ep.historical_period) AS with_period,
               count(ep.keywords) AS with_keywords,
               count(ep.research_methods) AS with_methods
    """)
    r = final_rows[0]
    print()
    print("=" * 50)
    print("  Metadata Coverage (Final)")
    print("=" * 50)
    for field, val in r.items():
        pct = round(val / 208 * 100, 1)
        print(f"  {field}: {val}/208 ({pct}%)")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
