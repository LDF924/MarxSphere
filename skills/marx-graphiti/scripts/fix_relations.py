#!/usr/bin/env python3
"""
用 Qwen3.7-Max 重跑关系抽取：针对之前无关系的3篇论文单独补抽
同时修复 prompt 以提高关系产出率
"""
import sys, json, os
from pathlib import Path
from collections import Counter
sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("fix_relations")
neo4j = Neo4jConnection()
llm = QwenMaxClient()

# ── 找出没有关系的论文 ──
no_rel = neo4j.execute_query("""
    MATCH (ep:Episode)
    WHERE NOT EXISTS { (e:Entity)-[:EXTRACTED_FROM]->(ep) WHERE EXISTS { (e)-[r]->(:Entity) } }
       OR NOT EXISTS { MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep)
                       WHERE EXISTS { MATCH (e)-[r]->(:Entity) WHERE type(r) <> 'EXTRACTED_FROM'
                                      AND type(r) <> 'BELONGS_TO_COMMUNITY'
                                      AND type(r) <> 'HAS_CONFLICT' } }
    RETURN ep.source_folder as f
""")

# Fallback: just check all papers
papers = neo4j.execute_query("MATCH (ep:Episode) RETURN ep.source_folder as f")

relation_stats = Counter()

for row in papers:
    fname = row['f']
    # 获取这篇论文的实体
    entities = neo4j.execute_query("""
        MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder: $f})
        RETURN e.name as name, e.category as cat
    """, {"f": fname})

    ent_names = [e['name'] for e in entities]
    logger.info(f"{fname}: {len(ent_names)} entities")

    if len(ent_names) < 2:
        logger.info(f"  skip (only {len(ent_names)} entity)")
        continue

    # 读取文献原文用于关系抽取
    BASE_DIR = Path(r"D:\Desktop\ov_import")
    folder = BASE_DIR / fname
    md_files = {f.name: f.read_text(encoding="utf-8")[:3000] for f in folder.glob("*.md")}
    abstract = ""
    for name, content in md_files.items():
        if "摘" in name:
            abstract = content[:1000]
            break

    # 强化的关系抽取 prompt
    prompt = f"""你是一位马克思主义理论关系抽取专家。请基于以下实体列表和文献内容，找出所有存在逻辑关系的实体对。

【实体列表】
{', '.join(ent_names[:20])}

【文献摘要】
{abstract}

【背景原文】
{md_files.get(list(md_files.keys())[0], '')[:1500]}

【任务要求】
请仔细分析，找出所有以下类型的关系：
- PROPOSED_BY（提出）：某理论由某人/某著作提出
- BELONG_TO（归属）：某概念/学派属于某更大范畴
- LEAD_TO（导致/带来）：某现象/行为导致某结果
- CONTRAST_WITH（对立）：两个概念/理论存在对立关系
- INHERITS_FROM（继承）：某理论继承自某前人理论
- DEVELOPS_INTO（发展为）：某理论后续发展为某新理论
- PUBLISHED_IN（载于）：某理论发表于某著作
- CRITIQUES（批判）：某人对某理论进行批判

【输出格式】
严格输出 JSON，每条关系必须包含 source/relation_type/target/confidence/description 五个字段。
即使只找到一条关系也要输出。

示例：
{{"relations": [{{"source":"资本下乡","relation_type":"LEAD_TO","target":"乡村社会重构","confidence":0.92,"description":"工商资本进入农村导致乡村原有的社会结构和利益格局发生根本性变化"}}]}}"""

    result = llm.call_json(prompt, max_retries=1, timeout=120,
                           system_prompt="你是马克思主义理论领域关系抽取专家。仔细分析每对实体间可能存在的逻辑关系。")

    relations = []
    if isinstance(result, dict) and result.get("relations"):
        relations = result["relations"]
    elif isinstance(result, list):
        relations = result

    for rel in relations:
        if not isinstance(rel, dict):
            continue
        src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
        if not src or not tgt or not rtype:
            continue
        # 验证实体存在
        src_check = neo4j.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) as c", {"n": src})
        tgt_check = neo4j.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) as c", {"n": tgt})
        if src_check[0]['c'] == 0 or tgt_check[0]['c'] == 0:
            continue

        try:
            with neo4j.driver.session() as s:
                s.run(f"""
                    MATCH (a:Entity {{name: $src}})
                    MATCH (b:Entity {{name: $tgt}})
                    MERGE (a)-[r:{rtype} {{source_folder: $f}}]->(b)
                    SET r.confidence = $conf, r.description = $desc, r.created_at = datetime()
                """, {"src": src, "tgt": tgt, "rtype": rtype, "f": fname,
                      "conf": rel.get("confidence", 0.8), "desc": rel.get("description","")})
            relation_stats[rtype] += 1
        except Exception as e:
            logger.warning(f"  Failed: {src} --[{rtype}]--> {tgt}: {e}")

    logger.info(f"  -> {len(relations)} relations found")

logger.info(f"\nDone! New relations added: {dict(relation_stats)}")

# ── 最终统计 ──
total_rels = neo4j.execute_query("""
    MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM'
    AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT'
    RETURN count(r) as c
""")[0]['c']
logger.info(f"Total content relations now: {total_rels}")

neo4j.close()
logger.info("Complete!")
