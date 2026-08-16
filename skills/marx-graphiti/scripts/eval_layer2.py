#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_layer2.py — Layer 2: Knowledge Graph Quality Extension
════════════════════════════════════════════════════════════
Extends module 6's 10-point audit with 7 new KG quality checks.

New audits:
  1. Entity ambiguity rate (same-name different contexts)
  2. Vector cosine dispersion (within-community entity vectors)
  3. Community cohesion score
  4. Cross-domain bridge relations
  5. Entity category distribution balance
  6. Relation type completeness (missing expected relation types)
  7. Distill-to-domain mapping integrity

Cost: 0 (reads only, no API calls)
"""

import sys
import json
import math
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime
from collections import defaultdict, Counter

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger

logger = get_logger("eval_layer2")
REPORT_FILE = SCRIPT_DIR / "eval_layer2_report.json"


def cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na > 0 and nb > 0 else 0.0


def run(nc: Neo4jConnection) -> Dict:
    """Run all 7 extended quality audits. Returns structured results."""
    logger.info("=" * 60)
    logger.info("Layer 2: KG Quality Extended Audit")
    logger.info("=" * 60)

    audits = {}

    # ── 1. Entity ambiguity ────────────────────────────────────
    # Entities with same name but different descriptions/contexts
    logger.info("1/7: Entity ambiguity detection...")
    try:
        rows = nc.execute_query(
            "MATCH (e:Entity) WITH e.name AS n, count(*) AS cnt "
            "WHERE cnt > 1 RETURN n, cnt ORDER BY cnt DESC LIMIT 20"
        )
        duplicates = [{"name": r["n"], "count": r["cnt"]} for r in rows]
        # Measure vector distance between duplicate entities
        dup_detail = []
        for dup in duplicates[:5]:
            r2 = nc.execute_query(
                "MATCH (e:Entity {name: $n}) RETURN e.entity_vector AS v, e.description AS d LIMIT 2",
                {"n": dup["name"]}
            )
            if len(r2) == 2 and r2[0]["v"] and r2[1]["v"]:
                sim = cosine(r2[0]["v"], r2[1]["v"])
                dup_detail.append({"name": dup["name"], "cosine_sim": round(sim, 4)})
        audits["entity_ambiguity"] = {
            "duplicate_name_count": len(duplicates),
            "duplicates": duplicates,
            "top5_cosine_similarity": dup_detail,
            "status": "WARN" if duplicates else "PASS",
            "interpretation": f"{len(duplicates)} entities share names; vector similarity between duplicates reveals whether they are true duplicates or polysemous"
        }
    except Exception as e:
        audits["entity_ambiguity"] = {"error": str(e)}

    # ── 2. Vector cosine dispersion ───────────────────────────
    # Average pairwise cosine similarity within each category
    logger.info("2/7: Vector dispersion by category...")
    try:
        cats = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN DISTINCT e.category AS cat")
        cat_dispersion = []
        for row in cats[:12]:
            cat = row["cat"]
            if not cat:
                continue
            # Sample 20 entities per category
            ents = nc.execute_query(
                "MATCH (e:Entity) WHERE e.category = $c AND e.entity_vector IS NOT NULL "
                "RETURN e.entity_vector AS v LIMIT 20",
                {"c": cat}
            )
            if len(ents) < 3:
                continue
            vectors = [e["v"] for e in ents]
            sims = []
            for i in range(len(vectors)):
                for j in range(i + 1, len(vectors)):
                    sims.append(cosine(vectors[i], vectors[j]))
            avg_sim = sum(sims) / len(sims) if sims else 0
            cat_dispersion.append({"category": cat, "n": len(ents), "avg_pairwise_cosine": round(avg_sim, 4)})
        cat_dispersion.sort(key=lambda x: x["avg_pairwise_cosine"], reverse=True)
        low_dispersion = [c for c in cat_dispersion if c["avg_pairwise_cosine"] > 0.95]
        audits["vector_dispersion"] = {
            "by_category": cat_dispersion,
            "high_similarity_categories": low_dispersion,
            "status": "WARN" if low_dispersion else "PASS",
            "interpretation": "Categories with avg cosine > 0.95 indicate weak embedding differentiation for those concepts"
        }
    except Exception as e:
        audits["vector_dispersion"] = {"error": str(e)}

    # ── 3. Community cohesion ──────────────────────────────────
    logger.info("3/7: Community cohesion...")
    try:
        communities = nc.execute_query(
            "MATCH (c:Community)<-[:BELONGS_TO_COMMUNITY]-(e:Entity) "
            "WHERE e.entity_vector IS NOT NULL "
            "RETURN c.community_id AS cid, count(e) AS cnt, COLLECT(e.entity_vector)[..15] AS vectors "
            "ORDER BY cnt DESC LIMIT 30"
        )
        cohesion = []
        for com in communities:
            vecs = [v for v in com["vectors"] if v]
            if len(vecs) < 3:
                continue
            sims = []
            for i in range(len(vecs)):
                for j in range(i + 1, len(vecs)):
                    sims.append(cosine(vecs[i], vecs[j]))
            avg = sum(sims) / len(sims) if sims else 0
            cohesion.append({"community": com["cid"], "entities": com["cnt"], "avg_cosine": round(avg, 4)})
        cohesion.sort(key=lambda x: x["avg_cosine"])
        weak = [c for c in cohesion if c["avg_cosine"] < 0.5]
        audits["community_cohesion"] = {
            "communities": len(communities),
            "cohesion_scores": cohesion[:10],
            "weak_communities": weak,
            "status": "INFO",
            "interpretation": f"Communities with avg cosine < 0.5 may contain unrelated entities; {len(weak)} flagged"
        }
    except Exception as e:
        audits["community_cohesion"] = {"error": str(e)}

    # ── 4. Cross-domain bridge relations ───────────────────────
    logger.info("4/7: Cross-domain bridges...")
    try:
        bridges = nc.execute_query(
            "MATCH (e1:Entity)-[:BELONGS_TO_COMMUNITY]->(c1:Community) "
            "MATCH (e2:Entity)-[:BELONGS_TO_COMMUNITY]->(c2:Community) "
            "WHERE c1.parent_community <> c2.parent_community "
            "AND c1.parent_community IS NOT NULL AND c2.parent_community IS NOT NULL "
            "MATCH (e1)-[r]->(e2) WHERE type(r) IN ['INHERITS_FROM','CRITIQUES','DEVELOPS_INTO','CONTRAST_WITH','LEAD_TO'] "
            "RETURN c1.parent_community AS domain1, c2.parent_community AS domain2, "
            "type(r) AS rel_type, count(r) AS cnt "
            "ORDER BY cnt DESC LIMIT 30"
        )
        bridge_summary = defaultdict(int)
        for b in bridges:
            pair = f"{b['domain1']} <-> {b['domain2']}"
            bridge_summary[pair] += b["cnt"]
        top_bridges = sorted(bridge_summary.items(), key=lambda x: x[1], reverse=True)[:15]
        audits["cross_domain_bridges"] = {
            "bridge_count": sum(bridge_summary.values()),
            "top_bridges": [{"pair": p, "relations": c} for p, c in top_bridges],
            "status": "INFO",
            "interpretation": "Cross-domain relations indicate interdisciplinary theoretical connections"
        }
    except Exception as e:
        audits["cross_domain_bridges"] = {"error": str(e)}

    # ── 5. Entity category distribution balance ────────────────
    logger.info("5/7: Category distribution...")
    try:
        dist = nc.execute_query(
            "MATCH (e:Entity) RETURN e.category AS cat, count(e) AS cnt ORDER BY cnt DESC"
        )
        total_ent = sum(r["cnt"] for r in dist)
        category_dist = [{"category": r["cat"] or "NULL", "count": r["cnt"],
                          "pct": round(r["cnt"] / total_ent * 100, 1)} for r in dist]
        dominant = category_dist[0] if category_dist else {}
        audits["category_distribution"] = {
            "total": total_ent,
            "distribution": category_dist,
            "dominant_category": dominant.get("category"),
            "dominant_pct": dominant.get("pct"),
            "gini_estimate": "NOT_IMPLEMENTED",
            "status": "INFO",
            "interpretation": f"10 entity categories; largest ({dominant.get('category','?')}) accounts for {dominant.get('pct','?')}%"
        }
    except Exception as e:
        audits["category_distribution"] = {"error": str(e)}

    # ── 6. Relation type completeness ──────────────────────────
    logger.info("6/7: Relation type completeness...")
    try:
        rel_counts = nc.execute_query(
            "MATCH ()-[r]->() WHERE type(r) IN ['PROPOSED_BY','INHERITS_FROM','CRITIQUES','DEVELOPS_INTO',"
            "'LEAD_TO','CONTRAST_WITH','BELONG_TO','PUBLISHED_IN'] "
            "RETURN type(r) AS t, count(r) AS cnt ORDER BY cnt ASC"
        )
        rel_stats = [{"type": r["t"], "count": r["cnt"]} for r in rel_counts]
        rare = [r for r in rel_stats if r["count"] < 10]
        audits["relation_completeness"] = {
            "relation_types": rel_stats,
            "rare_relations": rare,
            "status": "WARN" if rare else "PASS",
            "interpretation": f"{len(rare)} relation types have <10 instances — may indicate underspecified relationships"
        }
    except Exception as e:
        audits["relation_completeness"] = {"error": str(e)}

    # ── 7. Distill-to-domain mapping integrity ────────────────
    logger.info("7/7: Distill-domain mapping...")
    try:
        mapped = nc.execute_query(
            "MATCH (ld:LiteratureDistill)-[:AGGREGATED_INTO]->(dk:DomainKnowledge) "
            "RETURN count(ld) AS mapped"
        )[0]["mapped"]
        total_ld = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"]
        unmapped = total_ld - mapped
        audits["distill_domain_integrity"] = {
            "total_distills": total_ld,
            "mapped_to_domains": mapped,
            "unmapped": unmapped,
            "coverage_pct": round(mapped / total_ld * 100, 1) if total_ld else 0,
            "status": "PASS" if unmapped == 0 else "WARN",
            "interpretation": "All 208 distills should be mapped to exactly 1 domain via AGGREGATED_INTO"
        }
    except Exception as e:
        audits["distill_domain_integrity"] = {"error": str(e)}

    return audits


def print_report(audits: Dict):
    print()
    print("=" * 80)
    print("  Layer 2: KG Quality Extended Audit Report")
    print("=" * 80)

    for name, a in audits.items():
        status = a.get("status", "?")
        icon = ">>" if status == "WARN" else "OK" if status == "PASS" else "??"
        interpretation = a.get("interpretation", str(a)[:200])
        print(f"\n  [{icon}] {name}: {interpretation}")

    # Summary
    warns = sum(1 for a in audits.values() if a.get("status") == "WARN")
    passes = sum(1 for a in audits.values() if a.get("status") == "PASS")
    print(f"\n  Summary: {passes} PASS, {warns} WARN, {len(audits) - passes - warns} INFO")


def main():
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    audits = run(nc)

    print_report(audits)

    report = {"timestamp": datetime.now().isoformat(), "audits": audits}
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report saved: {REPORT_FILE}")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
