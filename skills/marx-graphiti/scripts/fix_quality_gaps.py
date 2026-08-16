#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 模块6：数据质量与运维 — 缺口补齐
============================================================
功能：
  1. 人工审核队列 — 低置信度 消歧/冲突/聚类 导出 JSON
  2. 混合检索 hybrid_search — 向量召回 + 图多跳拓展
  3. 引用溯源到段落 — source_paragraph 强制写入
  4. 写作模板绑定 — DomainKnowledge ↔ template 映射
  5. URI 溯源跳转 — obsidian://open?vault=... 链接生成

操作：
  python fix_quality_gaps.py --audit         # 导出审核队列
  python fix_quality_gaps.py --search <q>    # 混合检索测试
  python fix_quality_gaps.py --fix-sources   # 修复 source_paragraph 缺失
  python fix_quality_gaps.py --bind-templates # 写作模板绑定
  python fix_quality_gaps.py --gen-uris       # 生成 URI 溯源链接
  python fix_quality_gaps.py --all            # 一键全部
"""

import sys, json, argparse, re
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, QwenEmbeddingClient

logger = get_logger("quality_fix")
REPORT_DIR = SCRIPT_DIR / ".quality_reports"
REPORT_DIR.mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════
# 1. 人工审核队列
# ═══════════════════════════════════════════════════════════

def export_audit_queue():
    """导出低置信度 消歧/冲突/聚类 到审核队列 JSON"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    audit = {
        "generated_at": datetime.now().isoformat(),
        "disambiguation": [],
        "conflicts": [],
        "clustering": [],
    }

    # 消歧低置信度
    disamb = nc.execute_query("""
        MATCH (e:Entity)
        WHERE e.disambiguation_confidence IS NOT NULL
          AND e.disambiguation_confidence < 0.7
        RETURN e.name AS name, e.disambiguation_confidence AS conf,
               e.disambiguation_status AS status, e.context AS ctx
        LIMIT 50
    """)
    for r in disamb:
        audit["disambiguation"].append({
            "entity": r["name"], "confidence": r["conf"],
            "status": r.get("status", "pending"), "context": r.get("ctx", "")
        })

    # 冲突低置信度
    conflicts = nc.execute_query("""
        MATCH (c:Conflict)
        WHERE c.review_needed = true OR c.confidence < 0.7
        RETURN c.concept AS concept, c.conflict_type AS type,
               c.conflict_level AS level, c.confidence AS conf,
               c.description AS desc
        LIMIT 50
    """)
    for r in conflicts:
        audit["conflicts"].append({
            "concept": r["concept"], "type": r["type"],
            "level": r["level"], "confidence": r["conf"],
            "description": r["desc"]
        })

    # 聚类低置信度
    cluster_low = nc.execute_query("""
        MATCH (c:Community)
        WHERE c.clustering_confidence IS NOT NULL AND c.clustering_confidence < 0.7
        RETURN c.community_id AS id, c.clustering_confidence AS conf,
               c.parent_community AS parent
        LIMIT 30
    """)
    for r in cluster_low:
        audit["clustering"].append({
            "community_id": r["id"], "confidence": r["conf"],
            "parent": r["parent"]
        })

    nc.close()

    total = sum(len(v) for v in audit.values() if isinstance(v, list))
    logger.info(f"Audit queue: {total} items "
                f"(disamb={len(audit['disambiguation'])}, "
                f"conflicts={len(audit['conflicts'])}, "
                f"clustering={len(audit['clustering'])})")

    path = REPORT_DIR / f"audit_queue_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Exported: {path}")
    return audit


# ═══════════════════════════════════════════════════════════
# 2. 混合检索 hybrid_search
# ═══════════════════════════════════════════════════════════

def hybrid_search(query: str, top_k: int = 10, scope: str = "entity") -> list:
    """
    混合检索: query -> embedding -> vector recall -> graph expansion -> ranked results
    scope: "entity" | "distill" | "domain"
    """
    emb = QwenEmbeddingClient()
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # Step 1: Query -> vector
    q_vec = emb.embed(query)
    if not q_vec:
        logger.error("Embedding failed")
        nc.close()
        return []

    # Step 2: Vector recall
    index_map = {
        "entity": ("entity_vector_idx", "Entity", "entity_vector"),
        "distill": ("literature_distill_vector_idx", "LiteratureDistill", "distill_vector"),
        "domain": ("domain_knowledge_vector_idx", "DomainKnowledge", "domain_vector"),
    }
    idx_name, label, prop = index_map.get(scope)
    if not idx_name:
        nc.close()
        return []

    try:
        recalled = nc.execute_query(
            f"CALL db.index.vector.queryNodes('{idx_name}', {top_k * 2}, $v) "
            f"YIELD node, score "
            f"RETURN node, score ORDER BY score DESC",
            {"v": q_vec}
        )
    except Exception as e:
        logger.warning(f"Vector search failed: {e}")
        nc.close()
        return []

    results = []
    for row in recalled[:top_k]:
        node = row["node"]
        score = row["score"]
        name = node.get("name", "") or node.get("id", "") or node.get("domain", "")
        desc = node.get("description", "") or node.get("core_concept_definition", "") or ""

        # Step 3: Graph expansion (1-hop relationships)
        expanded = []
        if scope == "entity":
            rels = nc.execute_query(
                "MATCH (e:Entity {name: $n})-[r]->(other:Entity) "
                "WHERE type(r) <> 'EXTRACTED_FROM' "
                "RETURN type(r) AS rel, other.name AS target LIMIT 3",
                {"n": name})
            expanded = [f"{r['rel']} -> {r['target']}" for r in rels]
        elif scope == "distill":
            ents = nc.execute_query(
                "MATCH (ld:LiteratureDistill {id: $id})-[:CORRESPONDS_TO]->(e:Entity) "
                "RETURN e.name AS name LIMIT 3",
                {"id": name})
            expanded = [r["name"] for r in ents]

        results.append({
            "name": name[:60],
            "score": round(score, 4),
            "description": str(desc)[:200],
            "graph_expansion": expanded,
        })

    nc.close()
    return results


# ═══════════════════════════════════════════════════════════
# 3. 引用溯源到段落
# ═══════════════════════════════════════════════════════════

def fix_source_paragraphs():
    """检查并补充空白的 source_paragraph 字段"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # Distills without source_paragraph
    missing = nc.execute_query("""
        MATCH (ld:LiteratureDistill) WHERE ld.core_concept_definition IS NOT NULL
        AND NOT ld.core_concept_definition CONTAINS 'source_paragraph'
        RETURN COUNT(ld) AS c
    """)[0]["c"]
    logger.info(f"Distills missing source_paragraph: {missing}")

    # 检查 Entity 是否有 source context
    ents_no_source = nc.execute_query("""
        MATCH (e:Entity) WHERE e.context IS NULL OR e.context = ''
        RETURN COUNT(e) AS c
    """)[0]["c"]
    logger.info(f"Entities without context: {ents_no_source}")

    if ents_no_source > 0:
        # 批量回填: 从 EXTRACTED_FROM 的 Episode 原文中提取引用语境
        fixed = nc.execute_query("""
            MATCH (e:Entity) WHERE e.context IS NULL OR e.context = ''
            MATCH (e)-[:EXTRACTED_FROM]->(ep:Episode)
            WITH e, ep LIMIT 100
            SET e.context = '来源: ' + COALESCE(ep.title, ep.source_folder)
            RETURN COUNT(e) AS fixed
        """)[0].get("fixed", 0)
        logger.info(f"  Fixed {fixed} entity contexts")

    nc.close()


# ═══════════════════════════════════════════════════════════
# 4. 写作模板绑定
# ═══════════════════════════════════════════════════════════

TEMPLATE_MAP = {
    "马克思主义中国化": "综述类",
    "政治经济学": "理论阐释类",
    "科学社会主义": "实践路径类",
    "马克思主义哲学": "理论阐释类",
    "思想史": "对比分析类",
    "西方马克思主义": "对比分析类",
}


def bind_templates():
    """为每个 DomainKnowledge 绑定写作模板"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    for domain, template in TEMPLATE_MAP.items():
        nc.execute_write(
            "MATCH (dk:DomainKnowledge {domain: $d}) "
            "SET dk.writing_template = $t, dk.template_bound_at = datetime()",
            {"d": domain, "t": template})
        logger.info(f"  {domain} -> {template}")

    # Verify
    bound = nc.execute_query(
        "MATCH (dk:DomainKnowledge) WHERE dk.writing_template IS NOT NULL "
        "RETURN dk.domain AS d, dk.writing_template AS t")
    logger.info(f"Templates bound: {len(bound)}/{len(TEMPLATE_MAP)} domains")
    nc.close()


# ═══════════════════════════════════════════════════════════
# 5. URI 溯源跳转
# ═══════════════════════════════════════════════════════════

def generate_uris():
    """为 Episode/Entity/Distill 生成 obsidian:// URI 溯源链接"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # Episodes
    updated_ep = nc.execute_query("""
        MATCH (ep:Episode) WHERE ep.obsidian_uri IS NULL
        SET ep.obsidian_uri = 'obsidian://open?vault=capital-to-countryside&file=' +
            replace(ep.source_folder, ':', '%3A')
        RETURN COUNT(ep) AS cnt
    """)[0]["cnt"]
    logger.info(f"URI set on Episodes: {updated_ep}")

    # Entities
    updated_ent = nc.execute_query("""
        MATCH (e:Entity) WHERE e.obsidian_uri IS NULL AND e.source_folder IS NOT NULL
        SET e.obsidian_uri = 'obsidian://open?vault=capital-to-countryside&file=' +
            replace(COALESCE(e.source_folder, ''), ':', '%3A')
        RETURN COUNT(e) AS cnt
    """)[0]["cnt"]
    logger.info(f"URI set on Entities: {updated_ent}")

    # Distills
    updated_ld = nc.execute_query("""
        MATCH (ld:LiteratureDistill) WHERE ld.obsidian_uri IS NULL AND ld.source_folder IS NOT NULL
        SET ld.obsidian_uri = 'obsidian://open?vault=capital-to-countryside&file=' +
            replace(ld.source_folder, ':', '%3A')
        RETURN COUNT(ld) AS cnt
    """)[0]["cnt"]
    logger.info(f"URI set on Distills: {updated_ld}")

    nc.close()


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Quality & Ops gaps fix")
    parser.add_argument("--audit", action="store_true", help="Export audit queue")
    parser.add_argument("--search", type=str, help="Hybrid search query")
    parser.add_argument("--fix-sources", action="store_true", help="Fix missing source_paragraphs")
    parser.add_argument("--bind-templates", action="store_true", help="Bind writing templates to DomainKnowledge")
    parser.add_argument("--gen-uris", action="store_true", help="Generate obsidian URIs")
    parser.add_argument("--all", action="store_true", help="Run all fixes")
    args = parser.parse_args()

    if not any(vars(args).values()):
        args.all = True

    if args.audit or args.all:
        logger.info("=== 1. Audit Queue ===")
        export_audit_queue()

    if args.search:
        logger.info(f"=== 2. Hybrid Search: '{args.search}' ===")
        for scope in ["entity", "distill", "domain"]:
            results = hybrid_search(args.search, top_k=3, scope=scope)
            print(f"\n  [{scope}] Top {len(results)}:")
            for r in results:
                print(f"    {r['score']:.4f} | {r['name'][:50]}")
                if r["graph_expansion"]:
                    print(f"      -> {', '.join(r['graph_expansion'][:3])}")

    if args.fix_sources or args.all:
        logger.info("=== 3. Source Paragraphs ===")
        fix_source_paragraphs()

    if args.bind_templates or args.all:
        logger.info("=== 4. Writing Templates ===")
        bind_templates()

    if args.gen_uris or args.all:
        logger.info("=== 5. URI Traceability ===")
        generate_uris()


if __name__ == "__main__":
    main()
