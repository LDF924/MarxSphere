#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
补聚未归属实体 — 复用全局消歧聚类清洗.py 的聚类逻辑
只处理 NOT EXISTS BELONGS_TO_COMMUNITY 的实体，100/批送 qwen3.7-max
"""
import sys, json, logging, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipeline.neo4j import Neo4jConnection
from pipeline.api_client import DeepSeekClient

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

nc = Neo4jConnection("bolt://127.0.0.1:11001", "neo4j", "neo4j123")
llm = DeepSeekClient()
LLM_TIMEOUT = 120

# 1. 获取未归属实体
all_entities = nc.execute_query(
    "MATCH (e:Entity) "
    "WHERE NOT EXISTS { MATCH (e)-[:BELONGS_TO_COMMUNITY]->(:Community) } "
    "AND e.category IS NOT NULL AND e.category <> '' "
    "RETURN e.name AS n, e.category AS c, e.description AS d, e.level AS l "
    "ORDER BY e.category, e.name"
)
total = len(all_entities)
logger.info(f"未归属实体: {total}")

if total == 0:
    logger.info("无未归属实体，跳过")
    sys.exit(0)

# 2. 分批聚类
BATCH_SIZE = 100
all_clusters = []
t_start = time.time()
fail_batches = 0

for batch_start in range(0, total, BATCH_SIZE):
    batch = all_entities[batch_start:batch_start + BATCH_SIZE]
    batch_num = batch_start // BATCH_SIZE + 1
    total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    logger.info(f"聚类批次 {batch_num}/{total_batches} ({len(batch)} 实体)")

    prompt = (
        f"将以下马克思主义理论领域实体分配到二级社区体系。\n\n"
        f"六大一级领域（必选其一）：\n"
        f"  1. 马克思主义哲学 — 唯物史观、辩证法、认识论、实践哲学等\n"
        f"  2. 政治经济学 — 剩余价值、资本积累、劳动价值论、经济危机等\n"
        f"  3. 科学社会主义 — 阶级斗争、无产阶级革命、国家理论、共产主义等\n"
        f"  4. 马克思主义中国化 — 中国特色社会主义、社会主义市场经济、乡村振兴等\n"
        f"  5. 西方马克思主义 — 法兰克福学派、结构主义马克思主义、后马克思主义等\n"
        f"  6. 思想史 — 马克思主义发展史、经典作家思想演变、理论传播等\n\n"
        f"每个二级社区 community_id 格式: \"一级领域-二级主题\"（如 \"政治经济学-资本积累\"）\n"
        f"level 填 \"二级\"，parent_community 填对应的一级领域名\n\n"
        f"实体列表:\n"
        f"{json.dumps(batch, ensure_ascii=False, indent=1)}\n\n"
        f'输出JSON: {{"clusters":[{{"community_id":"政治经济学-资本积累","level":"二级","parent_community":"政治经济学","entities":["实体名1","实体名2"],"clustering_confidence":0.9}}]}}'
    )

    r = llm.call_json(
        prompt,
        system_prompt="你是马克思主义理论领域聚类专家。严格按照六大领域分类，community_id 格式为'一级-二级'。每个实体只归属一个社区。",
        max_retries=1,
        timeout=LLM_TIMEOUT,
    )

    if isinstance(r, dict):
        clusters = r.get("clusters", [])
        logger.info(f"    社区候选: {len(clusters)}")
        all_clusters.extend(clusters)
    else:
        fail_batches += 1
        logger.warning(f"    批次 {batch_num} 返回无效结果: {type(r).__name__}")

    # 每批打印进度
    elapsed = (time.time() - t_start) / 60
    remain = total_batches - batch_num
    est = remain * (elapsed / batch_num) if batch_num > 0 else 0
    logger.info(f"    [{batch_num}/{total_batches}] {elapsed:.0f}min | ~{est:.1f}min left")

# 3. 写入 Neo4j（幂等 MERGE）
cluster_count = 0
assigned_count = 0
for cl in all_clusters:
    if not isinstance(cl, dict):
        continue
    cid = cl.get("community_id", "")
    if not cid:
        continue
    confidence = cl.get("clustering_confidence", 0.8)
    level = cl.get("level", "二级")
    parent = cl.get("parent_community", "")

    nc.execute_write(
        "MERGE (c:Community {community_id: $cid}) "
        "SET c.level = $level, c.parent_community = $parent, "
        "    c.clustering_confidence = $conf, c.created_at = COALESCE(c.created_at, datetime())",
        {"cid": cid, "level": level, "parent": parent, "conf": confidence}
    )
    cluster_count += 1

    for en in cl.get("entities", []):
        if not en:
            continue
        nc.execute_write(
            "MATCH (e:Entity {name: $en}) "
            "MATCH (c:Community {community_id: $cid}) "
            "MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
            {"en": en, "cid": cid}
        )
        assigned_count += 1

logger.info(f"写入完成: {cluster_count} 社区候选, {assigned_count} 实体归属, 失败批次 {fail_batches}")
result = {"clusters": cluster_count, "entities_assigned": assigned_count, "fail_batches": fail_batches}
with open(Path(__file__).parent / "cluster_refill_report.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False))
