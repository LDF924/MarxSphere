#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补全缺失的 TimelineNode 时间线节点"""
import sys, json, time
sys.path.insert(0, r"D:\Desktop\执行流程")

from pipeline import Neo4jConnection, DeepSeekClient, get_logger

logger = get_logger("timeline_fixer")
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
ds = DeepSeekClient()

# 已有 Timeline 的领域
tl_domains = set(r["domain"] for r in nc.execute_query(
    "MATCH (tn:TimelineNode) RETURN DISTINCT tn.domain AS domain"
))
logger.info(f"Domains with timeline: {tl_domains}")

# 有 DomainKnowledge 但缺 Timeline 的领域
dk_domains = nc.execute_query(
    "MATCH (dk:DomainKnowledge) RETURN dk.domain AS d, dk.standard_concepts AS sc"
)
missing = [r for r in dk_domains if r["d"] not in tl_domains]
logger.info(f"Domains missing timeline: {[r['d'] for r in missing]}")

for row in missing:
    domain_name = row["d"]
    try:
        sc = json.loads(row["sc"]) if isinstance(row["sc"], str) else row["sc"]
    except:
        sc = {}
    class_core = sc.get("classical_core", []) if isinstance(sc, dict) else []
    concepts_str = json.dumps(class_core[:20], ensure_ascii=False) + json.dumps(sc, ensure_ascii=False)[:1000]

    prompt = (
        '你是马克思主义理论领域资深学者。请为这个领域构建理论演化时间线。\n'
        f'领域: {domain_name}\n'
        f'标准概念: {concepts_str}\n\n'
        '输出JSON（直接输出，不要额外文字）:\n'
        '{"timeline": ['
        '{"stage_name": "阶段名", "start_year": 1840, "end_year": 1900, '
        '"key_events": ["事件"], "core_theories": ["理论"], '
        '"representatives": ["人物"], '
        '"logic_relation": "继承发展|修正偏离|创新拓展|批判扬弃"}'
        ']}\n\n'
        '至少3个阶段。logic_relation 只用这四种之一。'
    )

    logger.info(f"  Generating timeline for: {domain_name}")
    start = time.time()
    r = ds.call_json(prompt, max_retries=1, timeout=180)

    if r and r.get("timeline"):
        count = 0
        for item in r["timeline"]:
            if not isinstance(item, dict):
                continue
            nc.execute_write(
                "CREATE (tn:TimelineNode {"
                "domain: $domain, stage_name: $stage, start_year: $start, end_year: $end, "
                "key_events: $events, core_theories: $theories, "
                "representatives: $reps, logic_relation: $rel, created_at: datetime()"
                "})",
                {
                    "domain": domain_name,
                    "stage": item.get("stage_name", ""),
                    "start": item.get("start_year", 0),
                    "end": item.get("end_year", 0),
                    "events": item.get("key_events", []),
                    "theories": item.get("core_theories", []),
                    "reps": item.get("representatives", []),
                    "rel": item.get("logic_relation", "继承发展"),
                }
            )
            count += 1
        elapsed = time.time() - start
        logger.info(f"    Created {count} nodes for {domain_name} ({elapsed:.0f}s)")
    else:
        logger.warning(f"    Failed: DeepSeek returned None for {domain_name}")

# 最终统计
tl_count = nc.execute_query("MATCH (tn:TimelineNode) RETURN COUNT(tn) AS c")[0]["c"]
logger.info(f"\nTotal TimelineNode: {tl_count}")
for d in nc.execute_query("MATCH (tn:TimelineNode) RETURN DISTINCT tn.domain AS domain, COUNT(tn) AS cnt"):
    logger.info(f"  {d['domain']}: {d['cnt']} nodes")

nc.close()
logger.info("Done")
