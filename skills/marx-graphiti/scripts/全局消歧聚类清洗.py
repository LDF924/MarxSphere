#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
  全局消歧 / 聚类 / 清洗 — 独立可调用脚本
  可单独运行任一阶段，也可一键顺序执行全部三阶段
============================================================

用法:
  python 全局消歧聚类清洗.py                          # 一键执行全部三阶段
  python 全局消歧聚类清洗.py --stage disambiguate     # 仅消歧
  python 全局消歧聚类清洗.py --stage cluster          # 仅聚类
  python 全局消歧聚类清洗.py --stage clean            # 仅一致性清洗
  python 全局消歧聚类清洗.py --stage disambiguate,clean  # 消歧+清洗
"""

import sys, json, os, time, argparse, re as _re
from pathlib import Path
from datetime import datetime
from collections import Counter

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR.parent))

from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("global_postprocess")

# ============================================================
# 配置
# ============================================================
NEO4J_URI      = "bolt://127.0.0.1:11001"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "neo4j123"
LLM_TIMEOUT    = 300

# ============================================================
# 连接
# ============================================================
def connect_neo4j():
    try:
        nc = Neo4jConnection(uri=NEO4J_URI, user=NEO4J_USER, password=NEO4J_PASSWORD)
        nc.execute_query("RETURN 1 AS t")
        return nc
    except Exception as e:
        logger.error(f"Neo4j 连接失败: {e}")
        sys.exit(1)

def connect_llm():
    try:
        llm = QwenMaxClient()
        r = llm.call("回复1", timeout=15)
        assert r is not None
        return llm
    except Exception as e:
        logger.error(f"LLM 连接失败: {e}")
        sys.exit(1)

# ============================================================
# 阶段 1: 实体消歧
# ============================================================
def stage_disambiguate(nc: Neo4jConnection, llm: QwenMaxClient):
    """
    实体消歧：同义合并 + 同名异义拆分
    - 从 Neo4j 读取全量实体
    - 分批送入 LLM 识别 merge_groups / split_groups
    - 合并组：选 canonical_name，转移关系，删除别名节点
    - 拆分组：为同名异义实体创建区分节点
    - 写入 disambiguation_confidence 字段
    """
    logger.info("=" * 60)
    logger.info("[阶段1] 实体消歧")
    logger.info("=" * 60)

    # 1. 获取全量实体
    all_entities = nc.execute_query(
        "MATCH (e:Entity) "
        "RETURN e.name AS n, e.description AS d, e.category AS c, e.level AS l, e.subcategory AS s "
        "ORDER BY e.name"
    )
    total = len(all_entities)
    logger.info(f"  全量实体: {total}")

    if total < 10:
        logger.info("  实体数量不足，跳过消歧")
        return {"merge_groups": 0, "split_groups": 0}

    # 2. 分批处理（每批 80 个实体，避免 prompt 过长）
    BATCH_SIZE = 80
    all_merges = []
    all_splits = []

    for batch_start in range(0, total, BATCH_SIZE):
        batch = all_entities[batch_start:batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE

        logger.info(f"  消歧批次 {batch_num}/{total_batches} ({len(batch)} 实体)")

        prompt = (
            f"对以下 {len(batch)} 个马克思主义理论领域实体执行消歧处理：\n\n"
            f"{json.dumps(batch, ensure_ascii=False, indent=1)}\n\n"
            f"规则：\n"
            f"1. 同义合并：识别名称不同但指向同一概念/人物/著作的实体，归入 merge_groups\n"
            f"2. 同名异义拆分：识别名称相同但范畴不同的实体，归入 split_groups\n"
            f"3. canonical_name 选学界最通用的标准名称\n"
            f"4. disambiguation_confidence 0-1，低于 0.7 标记 review_needed=true\n"
            f"5. 只标注你高度确信的，不确定的不标注\n\n"
            f'输出JSON: {{"merge_groups":[{{"canonical_name":"标准名","aliases":["别名1","别名2"],"disambiguation_confidence":0.95,"review_needed":false}}],"split_groups":[{{"original_name":"同名","distinct_entities":[{{"name":"区分名1","category":"...","description":"..."}}],"disambiguation_confidence":0.8}}]}}'
        )

        r = llm.call_json(
            prompt,
            system_prompt="你是马克思主义理论领域实体消歧专家。只标注高度确信的合并/拆分，不确定的不标注。严格输出JSON。",
            max_retries=1,
            timeout=LLM_TIMEOUT,
        )

        if isinstance(r, dict):
            merges = r.get("merge_groups", [])
            splits = r.get("split_groups", [])
            logger.info(f"    合并候选: {len(merges)}, 拆分候选: {len(splits)}")
            all_merges.extend(merges)
            all_splits.extend(splits)
        else:
            logger.warning(f"    批次 {batch_num} 返回无效结果: {type(r).__name__}")

    logger.info(f"  总计: {len(all_merges)} 组合并, {len(all_splits)} 组拆分")

    # 3. 执行合并
    merge_count = 0
    for g in all_merges:
        if not isinstance(g, dict):
            continue
        canonical = g.get("canonical_name", "")
        if not canonical:
            continue
        aliases = g.get("aliases", [])
        confidence = g.get("disambiguation_confidence", 0.8)
        needs_review = g.get("review_needed", False)

        # 确保 canonical 节点存在并标记
        nc.execute_write(
            "MERGE (e:Entity {name: $n}) "
            "SET e.is_canonical = true, "
            "    e.disambiguation_confidence = $conf, "
            "    e.disambiguation_status = $status",
            {"n": canonical, "conf": confidence,
             "status": "pending_review" if needs_review else "auto_approved"}
        )

        # 转移别名节点的关系到 canonical，然后删除别名
        for alias in aliases:
            if alias == canonical:
                continue
            # 转移入边
            nc.execute_write(
                "MATCH (a:Entity {name: $alias}) "
                "MATCH (c:Entity {name: $canonical}) "
                "OPTIONAL MATCH (x)-[r_in]->(a) WHERE type(r_in) <> 'EXTRACTED_FROM' "
                "FOREACH (_ IN CASE WHEN r_in IS NOT NULL THEN [1] ELSE [] END | "
                "  MERGE (x)-[nr:RELATION {type: type(r_in)}]->(c) "
                "  SET nr = properties(r_in)) "
                "WITH a, c "
                "OPTIONAL MATCH (a)-[r_out]->(y) WHERE type(r_out) <> 'EXTRACTED_FROM' "
                "FOREACH (_ IN CASE WHEN r_out IS NOT NULL THEN [1] ELSE [] END | "
                "  MERGE (c)-[nr2:RELATION {type: type(r_out)}]->(y) "
                "  SET nr2 = properties(r_out)) "
                "DETACH DELETE a",
                {"alias": alias, "canonical": canonical}
            )
            merge_count += 1

    # 4. 执行拆分
    split_count = 0
    for g in all_splits:
        if not isinstance(g, dict):
            continue
        original = g.get("original_name", "")
        confidence = g.get("disambiguation_confidence", 0.8)
        entities = g.get("distinct_entities", [])
        if not original or not entities:
            continue

        for ent in entities:
            if not isinstance(ent, dict):
                continue
            new_name = ent.get("name", "")
            if not new_name or new_name == original:
                continue
            # 创建新节点（不删除原始节点）
            nc.execute_write(
                "MERGE (e:Entity {name: $n}) "
                "SET e.category = COALESCE($cat, e.category), "
                "    e.description = COALESCE($desc, e.description), "
                "    e.disambiguation_confidence = $conf, "
                "    e.disambiguation_status = 'split', "
                "    e.split_from = $orig",
                {"n": new_name, "cat": ent.get("category", ""),
                 "desc": ent.get("description", ""),
                 "conf": confidence, "orig": original}
            )
            split_count += 1

    logger.info(f"  执行完成: {merge_count} 别名合并, {split_count} 实体拆分")

    # 5. 统计
    after_total = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    canonical_count = nc.execute_query(
        "MATCH (e:Entity) WHERE e.is_canonical = true RETURN COUNT(e) AS c"
    )[0]["c"]

    result = {
        "total_before": total,
        "total_after": after_total,
        "merge_groups": len(all_merges),
        "aliases_merged": merge_count,
        "split_groups": len(all_splits),
        "entities_split": split_count,
        "canonical_nodes": canonical_count,
    }
    logger.info(f"  消歧完成: {json.dumps(result, ensure_ascii=False)}")
    return result


# ============================================================
# 阶段 2: 社区聚类
# ============================================================
def stage_cluster(nc: Neo4jConnection, llm: QwenMaxClient):
    """
    实体社区聚类：二级体系
    - 从 Neo4j 读取有分类的实体
    - 分批送入 LLM，分配到六大领域及二级子社区
    - 写入 Community 节点并建立 BELONGS_TO_COMMUNITY 关系
    """
    logger.info("=" * 60)
    logger.info("[阶段2] 社区聚类")
    logger.info("=" * 60)

    # 1. 获取实体
    all_entities = nc.execute_query(
        "MATCH (e:Entity) "
        "WHERE e.category IS NOT NULL AND e.category <> '' "
        "RETURN e.name AS n, e.category AS c, e.description AS d, e.level AS l "
        "ORDER BY e.category, e.name"
    )
    total = len(all_entities)
    logger.info(f"  可聚类实体: {total}")

    if total < 10:
        logger.info("  实体数量不足，跳过聚类")
        return {"clusters": 0, "entities_assigned": 0}

    # 2. 清理旧聚类结果（可选，避免残留）
    nc.execute_query(
        "MATCH (e:Entity)-[r:BELONGS_TO_COMMUNITY]->(c:Community) DELETE r"
    )
    logger.info("  已清理旧的 BELONGS_TO_COMMUNITY 关系")

    # 3. 分批处理
    BATCH_SIZE = 100
    all_clusters = []

    for batch_start in range(0, total, BATCH_SIZE):
        batch = all_entities[batch_start:batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE

        logger.info(f"  聚类批次 {batch_num}/{total_batches} ({len(batch)} 实体)")

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
            logger.warning(f"    批次 {batch_num} 返回无效结果: {type(r).__name__}")

    logger.info(f"  总计: {len(all_clusters)} 个社区候选")

    # 4. 写入 Neo4j
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

        # 创建 Community 节点
        nc.execute_write(
            "MERGE (c:Community {community_id: $cid}) "
            "SET c.level = $level, "
            "    c.parent_community = $parent, "
            "    c.clustering_confidence = $conf, "
            "    c.created_at = COALESCE(c.created_at, datetime())",
            {"cid": cid, "level": level, "parent": parent, "conf": confidence}
        )
        cluster_count += 1

        # 建立实体 → 社区关系
        entities = cl.get("entities", [])
        for en in entities:
            if not en:
                continue
            nc.execute_write(
                "MATCH (e:Entity {name: $en}) "
                "MATCH (c:Community {community_id: $cid}) "
                "MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                {"en": en, "cid": cid}
            )
            assigned_count += 1

    logger.info(f"  写入完成: {cluster_count} 社区, {assigned_count} 实体归属")

    result = {
        "clusters": cluster_count,
        "entities_assigned": assigned_count,
        "coverage": f"{assigned_count}/{total} ({100*assigned_count/total:.1f}%)" if total > 0 else "N/A",
    }
    logger.info(f"  聚类完成: {json.dumps(result, ensure_ascii=False)}")
    return result


# ============================================================
# 阶段 3: 数据一致性清洗
# ============================================================
def stage_clean(nc: Neo4jConnection):
    """
    数据一致性清洗：
    - 修复 EXTRACTED_FROM 错配（e.source_folder ≠ ep.source_folder）
    - 修复孤儿实体（有 Entity 但无 EXTRACTED_FROM 关系）
    - 修复孤儿关系（关系缺少 source_folder 或 batch_run）
    - 检测并报告脏数据
    """
    logger.info("=" * 60)
    logger.info("[阶段3] 数据一致性清洗")
    logger.info("=" * 60)

    fixes = {}

    # 1. EXTRACTED_FROM 错配修复
    mismatches = nc.execute_query(
        "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) "
        "WHERE e.source_folder <> ep.source_folder "
        "RETURN COUNT(r) AS c"
    )[0]["c"]
    logger.info(f"  EXTRACTED_FROM 错配: {mismatches}")

    if mismatches > 0:
        nc.execute_query(
            "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) "
            "WHERE e.source_folder <> ep.source_folder DELETE r"
        )
        nc.execute_query(
            "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
            "MERGE (ep:Episode {source_folder: e.source_folder}) "
            "ON CREATE SET ep.title = e.source_folder, ep.created_at = datetime() "
            "MERGE (e)-[:EXTRACTED_FROM]->(ep)"
        )
        logger.info(f"    已修复 {mismatches} 条错配")

    fixes["mismatches_fixed"] = mismatches

    # 2. 孤儿实体修复
    orphans = nc.execute_query(
        "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    logger.info(f"  孤儿实体 (无 EXTRACTED_FROM): {orphans}")

    if orphans > 0:
        nc.execute_query(
            "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
            "WITH e WHERE e.source_folder IS NOT NULL "
            "MERGE (ep:Episode {source_folder: e.source_folder}) "
            "ON CREATE SET ep.title = e.source_folder, ep.created_at = datetime() "
            "MERGE (e)-[:EXTRACTED_FROM]->(ep)"
        )
        # 对 source_folder 也为 NULL 的，标记为待处理
        still_orphans = nc.execute_query(
            "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
            "RETURN COUNT(e) AS c"
        )[0]["c"]
        logger.info(f"    已修复, 仍剩余: {still_orphans}")

    fixes["orphans_before"] = orphans
    fixes["orphans_after"] = nc.execute_query(
        "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
        "RETURN COUNT(e) AS c"
    )[0]["c"]

    # 3. 关系缺 source_folder 修复
    bad_rels_source = nc.execute_query(
        "MATCH ()-[r]->() "
        "WHERE type(r) <> \"EXTRACTED_FROM\" "
        "  AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "  AND type(r) <> \"HAS_CONFLICT\" "
        "  AND (r.source_folder IS NULL OR r.source_folder = '') "
        "RETURN COUNT(r) AS c"
    )[0]["c"]
    logger.info(f"  关系缺 source_folder: {bad_rels_source}")

    # 4. 关系缺 batch_run 修复
    bad_rels_batch = nc.execute_query(
        "MATCH ()-[r]->() "
        "WHERE type(r) <> \"EXTRACTED_FROM\" "
        "  AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "  AND type(r) <> \"HAS_CONFLICT\" "
        "  AND (r.batch_run IS NULL OR r.batch_run = '') "
        "RETURN COUNT(r) AS c"
    )[0]["c"]
    logger.info(f"  关系缺 batch_run: {bad_rels_batch}")

    if bad_rels_batch > 0:
        nc.execute_query(
            "MATCH ()-[r]->() "
            "WHERE type(r) <> \"EXTRACTED_FROM\" "
            "  AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
            "  AND type(r) <> \"HAS_CONFLICT\" "
            "  AND (r.batch_run IS NULL OR r.batch_run = '') "
            "SET r.batch_run = 'v3_incremental_20260629'"
        )
        logger.info(f"    已修复 {bad_rels_batch} 条关系的 batch_run")

    fixes["relations_missing_source_folder"] = bad_rels_source
    fixes["relations_missing_batch_run"] = bad_rels_batch

    # 5. 数据质量统计
    total_ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    total_rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c"
    )[0]["c"]
    total_ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]

    # 空值检查
    null_desc = nc.execute_query(
        "MATCH (e:Entity) WHERE e.description IS NULL OR e.description = '' "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    null_cat = nc.execute_query(
        "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    null_level = nc.execute_query(
        "MATCH (e:Entity) WHERE e.level IS NULL OR e.level = '' "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    null_aliases = nc.execute_query(
        "MATCH (e:Entity) WHERE e.aliases IS NULL OR size(e.aliases) = 0 "
        "RETURN COUNT(e) AS c"
    )[0]["c"]

    quality = {
        "total_entities": total_ent,
        "total_relations": total_rel,
        "total_episodes": total_ep,
        "null_description": null_desc,
        "null_category": null_cat,
        "null_level": null_level,
        "empty_aliases": null_aliases,
        "desc_coverage": f"{total_ent - null_desc}/{total_ent} ({100*(total_ent-null_desc)/total_ent:.1f}%)" if total_ent > 0 else "N/A",
        "cat_coverage": f"{total_ent - null_cat}/{total_ent} ({100*(total_ent-null_cat)/total_ent:.1f}%)" if total_ent > 0 else "N/A",
        "level_coverage": f"{total_ent - null_level}/{total_ent} ({100*(total_ent-null_level)/total_ent:.1f}%)" if total_ent > 0 else "N/A",
    }

    logger.info(f"  数据质量:")
    for k, v in quality.items():
        logger.info(f"    {k}: {v}")

    fixes["quality"] = quality
    logger.info(f"  清洗完成: {json.dumps(fixes, ensure_ascii=False, indent=2)}")
    return fixes


# ============================================================
# 全量统计报告
# ============================================================
def print_summary(nc: Neo4jConnection):
    """输出当前图库全量统计"""
    ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" "
        "RETURN COUNT(r) AS c"
    )[0]["c"]
    comm = nc.execute_query("MATCH (c:Community) RETURN COUNT(c) AS c")[0]["c"]
    conflicts = nc.execute_query("MATCH (c:Conflict) RETURN COUNT(c) AS c")[0]["c"]
    orphans = nc.execute_query(
        "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) RETURN COUNT(e) AS c"
    )[0]["c"]
    papers_done = nc.execute_query(
        "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN COUNT(DISTINCT ep) AS c"
    )[0]["c"]

    print()
    print("=" * 55)
    print("  全图库最终统计")
    print("=" * 55)
    print(f"  Episode:      {ep:>6}")
    print(f"  Entity:       {ent:>6}")
    print(f"  Relation:     {rel:>6}")
    print(f"  Community:    {comm:>6}")
    print(f"  Conflict:     {conflicts:>6}")
    print(f"  Orphan:       {orphans:>6}")
    print(f"  Papers done:  {papers_done:>6}")
    print("=" * 55)

    # 社区列表
    if comm > 0:
        communities = nc.execute_query(
            "MATCH (c:Community) "
            "OPTIONAL MATCH (c)<-[r:BELONGS_TO_COMMUNITY]-(:Entity) "
            "RETURN c.community_id AS cid, c.level AS l, c.parent_community AS parent, COUNT(r) AS cnt "
            "ORDER BY cnt DESC"
        )
        print()
        print("  社区分布:")
        for cm in communities:
            print(f"    {cm['cid']} ({cm['l']}, parent={cm['parent']}): {cm['cnt']} entities")

    # 批次
    batches = nc.execute_query(
        "MATCH (e:Entity) WHERE e.batch_run IS NOT NULL "
        "RETURN DISTINCT e.batch_run AS bt, COUNT(e) AS cnt ORDER BY cnt DESC"
    )
    if batches:
        print()
        print("  批次分布:")
        for b in batches:
            print(f"    {b['bt']}: {b['cnt']} entities")


# ============================================================
# 主入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="全局消歧/聚类/清洗 — 独立后处理脚本"
    )
    parser.add_argument(
        "--stage",
        type=str,
        default="all",
        help="执行阶段: disambiguate, cluster, clean, all (默认all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅统计当前状态，不执行任何操作",
    )
    args = parser.parse_args()

    nc = connect_neo4j()

    if args.dry_run:
        print_summary(nc)
        nc.close()
        return

    # 解析 stage
    if args.stage == "all":
        stages = ["disambiguate", "cluster", "clean"]
    else:
        stages = [s.strip() for s in args.stage.split(",")]

    logger.info(f"执行阶段: {', '.join(stages)}")

    # 只在需要消歧或聚类时才连接 LLM
    llm = None
    if "disambiguate" in stages or "cluster" in stages:
        llm = connect_llm()

    start_time = time.time()

    results = {}
    for stage in stages:
        if stage == "disambiguate":
            results["disambiguate"] = stage_disambiguate(nc, llm)
        elif stage == "cluster":
            results["cluster"] = stage_cluster(nc, llm)
        elif stage == "clean":
            results["clean"] = stage_clean(nc)
        else:
            logger.error(f"未知阶段: {stage}")
            logger.info("可用: disambiguate, cluster, clean, all")

    elapsed = (time.time() - start_time) / 60

    # 最终统计
    print_summary(nc)

    # 保存结果
    report_path = SCRIPT_DIR / f"postprocess_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    report_path.write_text(
        json.dumps({
            "timestamp": datetime.now().isoformat(),
            "elapsed_min": round(elapsed, 1),
            "stages_executed": stages,
            "results": results,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(f"\n报告已保存: {report_path}")
    logger.info(f"全流程完成, 耗时 {elapsed:.1f} 分钟")

    nc.close()


if __name__ == "__main__":
    main()
