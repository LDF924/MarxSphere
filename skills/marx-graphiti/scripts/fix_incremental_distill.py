#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 增量知识蒸馏补全脚本
============================================================
功能:
  1. 测试增量蒸馏 — 新增文献后自动 AGGREGATED_INTO 对应 DomainKnowledge
  2. 西方马克思主义 DomainKnowledge — 通过概念扩散链接解决 0 distills 问题
  3. 蒸馏节点去重 & 向量覆盖率修复

操作:
  python fix_incremental_distill.py --dry-run      # 预览
  python fix_incremental_distill.py                # 执行补全
"""

import sys, json, time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, DeepSeekClient, QwenEmbeddingClient

logger = get_logger("incremental_fix")


# ═══════════════════════════════════════════════════════════
# 1. 增量蒸馏验证
# ═══════════════════════════════════════════════════════════

def test_incremental_distill(dry_run: bool = False):
    """
    查找有 LiteratureDistill 但无 AGGREGATED_INTO 的文献，
    自动将其扩散到对应 parent domain 的 DomainKnowledge 中
    """
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # 未聚合的蒸馏节点
    unmerged = nc.execute_query("""
        MATCH (ld:LiteratureDistill)
        WHERE NOT (ld)-[:AGGREGATED_INTO]->(:DomainKnowledge)
        RETURN ld.id AS id, ld.source_folder AS f
    """)

    logger.info(f"Unmerged distills: {len(unmerged)}")

    if len(unmerged) == 0:
        logger.info("Incremental distillation is up-to-date — all distills have AGGREGATED_INTO")
        nc.close()
        return

    for row in unmerged:
        distill_id = row["id"]
        # 通过 CORRESPONDS_TO → Entity → Community → parent_community 找到目标 DomainKnowledge
        targets = nc.execute_query("""
            MATCH (ld:LiteratureDistill {id: $id})-[:CORRESPONDS_TO]->(e:Entity)
                  -[:BELONGS_TO_COMMUNITY]->(c:Community)
            WHERE c.parent_community IS NOT NULL
            RETURN DISTINCT c.parent_community AS domain
            LIMIT 5
        """, {"id": distill_id})

        for t in targets:
            domain = t["domain"]
            dk = nc.execute_query(
                "MATCH (dk:DomainKnowledge {domain: $d}) RETURN dk.id AS id",
                {"d": domain})
            if dk and not dry_run:
                nc.execute_write(
                    "MATCH (ld:LiteratureDistill {id: $lid}) "
                    "MATCH (dk:DomainKnowledge {id: $did}) "
                    "MERGE (ld)-[:AGGREGATED_INTO]->(dk)",
                    {"lid": distill_id, "did": dk[0]["id"]}
                )
                logger.info(f"  {distill_id[:40]} -> {domain}")

    nc.close()
    logger.info(f"Linked {len(unmerged)} distills to their domain DomainKnowledge nodes")


# ═══════════════════════════════════════════════════════════
# 2. 西方马克思主义 DomainKnowledge — 概念扩散链接
# ═══════════════════════════════════════════════════════════

def build_western_marxism_dk(dry_run: bool = False):
    """
    西方马克思主义只有 3 个实体且无 distills 直接链接。
    策略：从邻近概念（政治经济学、马克思主义哲学中的相关概念）
    扩散匹配，构建 DomainKnowledge 节点
    """
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # 已有 DK 的 domain
    existing = set(r["d"] for r in nc.execute_query(
        "MATCH (dk:DomainKnowledge) RETURN dk.domain AS d"))

    target = "西方马克思主义"
    if target in existing:
        logger.info(f"{target} DomainKnowledge already exists")
        nc.close()
        return

    # 策略: 从 西方马克思主义 的 3 个实体出发，查找概念上关联的 distills
    wm_entities = nc.execute_query(
        "MATCH (e)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: $p}) "
        "RETURN e.name AS name, e.description AS desc, e.category AS cat",
        {"p": target})

    logger.info(f"Western Marxism entities: {[r['name'] for r in wm_entities]}")

    # 在这些实体的名称上做模糊匹配，查找 distills
    found_distills = []
    for ent in wm_entities:
        name = ent["name"]
        # 通过 name 匹配或 alias 匹配查找 distills
        rows = nc.execute_query(
            "MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e:Entity) "
            "WHERE e.name CONTAINS $name OR $name CONTAINS e.name "
            "RETURN DISTINCT ld.id AS id, ld.source_folder AS f "
            "LIMIT 10",
            {"name": name})
        found_distills.extend(rows)

    # 如果直接匹配不到，从邻近 parent domain 借用 distills
    if len(found_distills) < 2:
        logger.info("  Direct match insufficient, borrowing from neighbor domains...")
        neighbor_distills = nc.execute_query("""
            MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e:Entity)
                  -[:BELONGS_TO_COMMUNITY]->(c:Community)
            WHERE c.parent_community IN ['政治经济学', '马克思主义哲学', '思想史']
            RETURN DISTINCT ld.id AS id, ld.core_concept_definition AS ccd,
                   ld.theoretical_system_and_innovation AS tsi,
                   ld.analysis_paradigm_and_interpretation AS api,
                   ld.dialectical_logic_chain AS dlc
            LIMIT 10
        """)
        found_distills = neighbor_distills

    logger.info(f"  Distills available for WM domain: {len(found_distills)}")

    if len(found_distills) < 2:
        logger.info("  Still insufficient distills — skip")
        nc.close()
        return

    # 调用 DeepSeek 构建 DomainKnowledge
    ds = DeepSeekClient()
    emb = QwenEmbeddingClient()

    # Consolidate distills
    distills_text = ""
    for i, d in enumerate(found_distills):
        distills_text += (
            f"### distill {i+1}\n"
            f"core_concepts: {d.get('ccd', '')}\n"
            f"theory: {d.get('tsi', '')}\n"
        )

    prompt = (
        f"你是一位马理论领域资深学者。请构建 {target} 领域的全局知识蒸馏。\n\n"
        f"可用文献蒸馏片段:\n{distills_text}\n\n"
        f"输出四层结构JSON:\n"
        f'{{"standard_concepts": {{"classical_core": [], "school_derivatives": [], '
        f'"era_practice_concepts": [], "dialectical_pairs": []}}, '
        f'"timeline": [{{"stage_name": "...", "start_year": 0, "end_year": 0, '
        f'"key_events": [], "core_theories": [], "representatives": [], '
        f'"logic_relation": "继承发展"}}], '
        f'"common_paradigm": {{"analysis_paradigms": [], "practice_paths": [], "critique_paths": []}}, '
        f'"consensus_and_controversy": {{"consensus": [], "controversies": []}}}}\n\n'
        f"直接输出JSON，不要额外文字。"
    )

    logger.info(f"  Calling DeepSeek to build {target} DomainKnowledge...")
    start = time.time()
    domain_data = ds.call_json(prompt, max_retries=1, timeout=180)

    if not domain_data:
        logger.warning(f"  Failed to generate {target} DomainKnowledge")
        nc.close()
        return

    # Write
    if not dry_run:
        domain_id = f"domain_{target}_{int(time.time())}"
        nc.execute_write(
            "CREATE (dk:DomainKnowledge {id: $id, domain: $d, "
            "standard_concepts: $sc, timeline: $tl, "
            "common_paradigm: $cp, consensus_and_controversy: $cc, "
            "source_distill_ids: $sids, distilled_count: $cnt, "
            "vectorized: false, created_at: datetime()})",
            {
                "id": domain_id, "d": target,
                "sc": json.dumps(domain_data.get("standard_concepts", {}), ensure_ascii=False),
                "tl": json.dumps(domain_data.get("timeline", []), ensure_ascii=False),
                "cp": json.dumps(domain_data.get("common_paradigm", {}), ensure_ascii=False),
                "cc": json.dumps(domain_data.get("consensus_and_controversy", {}), ensure_ascii=False),
                "sids": [d["id"] for d in found_distills if d.get("id")],
                "cnt": len(found_distills),
            }
        )

        # Link distills
        for d in found_distills:
            if d.get("id"):
                nc.execute_write(
                    "MATCH (ld:LiteratureDistill {id: $lid}) "
                    "MATCH (dk:DomainKnowledge {id: $did}) "
                    "MERGE (ld)-[:AGGREGATED_INTO]->(dk)",
                    {"lid": d["id"], "did": domain_id}
                )

        # Timeline nodes
        for item in domain_data.get("timeline", []):
            if not isinstance(item, dict):
                continue
            nc.execute_write(
                "CREATE (tn:TimelineNode {"
                "domain: $domain, stage_name: $stage, start_year: $start, end_year: $end, "
                "key_events: $events, core_theories: $theories, "
                "representatives: $reps, logic_relation: $rel, created_at: datetime()"
                "})",
                {
                    "domain": target,
                    "stage": item.get("stage_name", ""),
                    "start": item.get("start_year", 0),
                    "end": item.get("end_year", 0),
                    "events": item.get("key_events", []),
                    "theories": item.get("core_theories", []),
                    "reps": item.get("representatives", []),
                    "rel": item.get("logic_relation", "继承发展"),
                }
            )

        # Vectorize
        dt = f"domain: {target} concepts: {domain_data['standard_concepts']['classical_core']}"
        vec = emb.embed(dt)
        if vec:
            nc.execute_write(
                "MATCH (dk:DomainKnowledge {id: $id}) "
                "SET dk.domain_vector = $v, dk.vectorized = true",
                {"id": domain_id, "v": json.dumps(vec)}
            )

        elapsed = time.time() - start
        logger.info(f"  Created {target} DomainKnowledge ({elapsed:.0f}s)")

    nc.close()


# ═══════════════════════════════════════════════════════════
# 3. Distill 去重 & 向量修补
# ═══════════════════════════════════════════════════════════

def clean_and_repair():
    """去重 + 补全缺失向量"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # 去重
    dup = nc.execute_query(
        "MATCH (a:LiteratureDistill), (b:LiteratureDistill) "
        "WHERE a.source_folder = b.source_folder AND a.id > b.id "
        "RETURN count(DISTINCT a) AS c"
    )[0]["c"]
    if dup > 0:
        d = nc.execute_query(
            "MATCH (a:LiteratureDistill), (b:LiteratureDistill) "
            "WHERE a.source_folder = b.source_folder AND a.id > b.id "
            "DETACH DELETE a RETURN count(a) AS c"
        )[0]["c"]
        logger.info(f"Cleaned {d} duplicate distills")

    # 向量修补
    emb = QwenEmbeddingClient()
    missing = nc.execute_query(
        "MATCH (ld:LiteratureDistill) WHERE ld.distill_vector IS NULL "
        "RETURN ld.id AS id, ld.core_concept_definition AS ccd, ld.source_folder AS f"
    )
    logger.info(f"Distills missing vectors: {len(missing)}")

    fixed = 0
    for row in missing:
        try:
            ccd = json.loads(row["ccd"]) if isinstance(row["ccd"], str) else row["ccd"]
        except:
            ccd = []
        cnames = [c.get("concept_name", "") for c in ccd if isinstance(c, dict)][:5]
        text = f"distill: {row['f']} core: {cnames}"
        vec = emb.embed(text)
        if vec:
            nc.execute_write(
                "MATCH (ld:LiteratureDistill {id: $id}) "
                "SET ld.distill_vector = $v, ld.vectorized = true",
                {"id": row["id"], "v": json.dumps(vec)}
            )
            fixed += 1

    logger.info(f"Fixed {fixed} missing vectors")

    nc.close()


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

def main():
    logger.info("=" * 55)
    logger.info("  Incremental Distillation Fix")
    logger.info("=" * 55)

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # 1. 增量蒸馏验证
    test_incremental_distill(dry_run=args.dry_run)

    # 2. 西方马克思主义 DomainKnowledge
    build_western_marxism_dk(dry_run=args.dry_run)

    # 3. 去重 + 向量修补
    clean_and_repair()

    # Report
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    dk = nc.execute_query("MATCH (dk:DomainKnowledge) RETURN dk.domain AS d, dk.distilled_count AS cnt")
    tl = nc.execute_query("MATCH (tn:TimelineNode) RETURN tn.domain AS d, COUNT(tn) AS cnt")
    nc.close()

    logger.info("\nFinal State:")
    logger.info("DomainKnowledge:")
    for r in dk:
        logger.info(f"  {r['d']}: {r['cnt']} distills")
    logger.info("TimelineNode:")
    for r in tl:
        logger.info(f"  {r['d']}: {r['cnt']} nodes")


if __name__ == "__main__":
    main()
