#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_3way_rrf.py — 三路 RRF 混合检索 604 查询量化
═══════════════════════════════════════════════════════
Evaluates the 3-way RRF fusion:
  Path 1: entity vector via entity_vector_idx
  Path 2: entity BM25 via entity_name_ft
  Path 3: chunk bridge via chunk_text_ft -> CHUNK_OF -> Episode -> EXTRACTED_FROM -> entity

RRF(1, 2, 3) -> paper-level match against ground truth paper.

Compare vs:
  - C_baseline: entity Vec+BM25 only (R@10=0.8245, paper-level)
  - CHUNK_HYBRID: chunk Vec+BM25 only (R@10=0.9354)
  - 3_WAY: all 3 paths (target: 0.98-0.99)

Cost: RMB 0 (embeddings cached, no LLM calls)
Time: ~90s
"""

import sys, json, time
from pathlib import Path
from datetime import datetime
from typing import Dict, List

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient

logger = get_logger("eval_3way")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CACHE_DB = SCRIPT_DIR / "eval_output" / "embedding_cache.db"
REPORT_FILE = SCRIPT_DIR / "eval_3way_rrf_report.json"
TOP_K = 10


def entity_vector_search(emb, nc, query, top_k=30):
    qv = emb.embed(query)
    if qv is None: return []
    rows = nc.execute_query(
        f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
        "YIELD node, score MATCH (node)-[:EXTRACTED_FROM]->(ep:Episode) "
        "RETURN node.name AS name, ep.source_folder AS paper, score ORDER BY score DESC LIMIT $k",
        {"v": qv, "k": top_k})
    return [{"name": r["name"], "paper": r["paper"], "score": round(r["score"],4)} for r in rows]


def entity_bm25_search(nc, query, top_k=30):
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) YIELD node, score "
            "MATCH (node)-[:EXTRACTED_FROM]->(ep:Episode) "
            "RETURN node.name AS name, ep.source_folder AS paper, score ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k})
        return [{"name": r["name"], "paper": r["paper"], "score": round(r["score"],4)} for r in rows]
    except Exception:
        return []


def chunk_bridge_search(nc, query, top_k=30):
    """Path 3: chunk_text_ft -> paper DIRECTLY (not through entity)."""
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('chunk_text_ft', $q) YIELD node, score "
            "MATCH (node)-[:CHUNK_OF]->(ep:Episode) "
            "RETURN ep.source_folder AS paper, max(score) AS score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k})
        return [{"name": "", "paper": r["paper"], "score": round(r["score"],4)} for r in rows]
    except Exception:
        return []


def rrf_fuse(lists, k=60, top_k=30):
    scores = {}
    for rlist in lists:
        for rank, item in enumerate(rlist, start=1):
            key = item["paper"]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank)
    return [paper for paper, _ in sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]]


def compute_metrics(results: Dict[str, List[List[str]]]) -> Dict:
    """Each entry: [gt_paper, pred1, pred2, ...]"""
    m = {}
    for cfg, data in results.items():
        r5, r10, rr_vals, ranks = [], [], [], []
        for row in data:
            gt = row[0]
            preds = row[1:]
            hit_pos = [i for i, p in enumerate(preds) if p == gt]
            first = hit_pos[0] + 1 if hit_pos else None
            r5.append(1 if hit_pos and min(hit_pos) < 5 else 0)
            r10.append(1 if bool(hit_pos) else 0)
            rr_vals.append(1.0 / first if first else 0.0)
            if first: ranks.append(first)
        n = len(r5)
        m[cfg] = {"n": n, "R@5": round(sum(r5)/n,4), "R@10": round(sum(r10)/n,4),
                  "MRR": round(sum(rr_vals)/n,4), "ZeroHit%": round((1-sum(r10)/n)*100,1),
                  "median_rank": round(sorted(ranks)[len(ranks)//2],1) if ranks else None}
    return m


def print_report(metrics):
    labels = {
        "C_entity": "C: Entity Vec+BM25",
        "CHUNK": "CHUNK: Chunk HYBRID",
        "3WAY": "3-WAY: entity+chunk RRF",
    }
    print()
    print("=" * 70)
    print("  3-Way RRF Evaluation (604 queries)")
    print("=" * 70)
    print(f"{'Config':<25} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 70)
    for cfg in ["C_entity", "CHUNK", "3WAY"]:
        if cfg not in metrics: continue
        d = metrics[cfg]
        print(f"{labels[cfg]:<25} {d['R@5']:>8.4f} {d['R@10']:>8.4f} {d['MRR']:>8.4f} {d['ZeroHit%']:>9.1f}%")
    print("-" * 70)

    if "C_entity" in metrics and "3WAY" in metrics:
        base = metrics["C_entity"]["R@10"]
        new = metrics["3WAY"]["R@10"]
        print(f"\n  Delta 3WAY vs entity baseline: R@10 {new-base:+.4f} ({(new-base)/base*100:+.1f}%)")
    if "CHUNK" in metrics and "3WAY" in metrics:
        base = metrics["CHUNK"]["R@10"]
        new = metrics["3WAY"]["R@10"]
        print(f"  Delta 3WAY vs chunk-only:      R@10 {new-base:+.4f}")


def main():
    logger.info("=" * 60)
    logger.info("3-Way RRF Evaluation (604 queries)")
    logger.info("=" * 60)

    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]
    nq = sum(len(v.get("questions",[])) for v in test_set.values())
    logger.info(f"Test set: {len(test_set)} papers, {nq} queries")

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()

    results = {"C_entity": [], "CHUNK": [], "3WAY": []}

    processed = 0
    t0 = time.time()

    for paper_name, data in test_set.items():
        gt_paper = paper_name
        for qdata in data.get("questions", []):
            qtext = qdata["question"]

            # Path 1: entity vector
            ev = entity_vector_search(emb, nc, qtext, 30)

            # Path 2: entity BM25
            eb = entity_bm25_search(nc, qtext, 30)

            # Path 3: chunk bridge
            cb = chunk_bridge_search(nc, qtext, 30)

            # C_entity (paths 1+2 only)
            c_entity = rrf_fuse([ev, eb], top_k=TOP_K)
            results["C_entity"].append([gt_paper] + c_entity)

            # CHUNK (path 3 only = chunk BM25)
            chunk_only = rrf_fuse([cb], top_k=TOP_K)
            results["CHUNK"].append([gt_paper] + chunk_only)

            # 3-WAY (paths 1+2+3)
            three_way = rrf_fuse([ev, eb, cb], top_k=TOP_K)
            results["3WAY"].append([gt_paper] + three_way)

            processed += 1
            if processed % 100 == 0:
                elapsed = time.time() - t0
                rate = processed / elapsed if elapsed > 0 else 0
                eta = (nq - processed) / rate / 60 if rate > 0 else 0
                logger.info(f"  [{processed}/{nq}] {rate:.1f}q/s ETA {eta:.0f}min")

            if processed % 200 == 0:
                # Mid-eval summary
                m = compute_metrics(results)
                print(f"\n  [Mid-eval @ {processed}] C_entity R@10={m.get('C_entity',{}).get('R@10','?')}, CHUNK R@10={m.get('CHUNK',{}).get('R@10','?')}, 3WAY R@10={m.get('3WAY',{}).get('R@10','?')}")

    # Report
    elapsed = time.time() - t0
    logger.info(f"Eval complete: {nq} queries in {elapsed:.0f}s ({nq/elapsed:.1f} q/s)")

    metrics = compute_metrics(results)
    print_report(metrics)

    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "queries": nq,
        "duration_sec": round(elapsed, 1),
        "metrics": metrics,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()


if __name__ == "__main__":
    main()
