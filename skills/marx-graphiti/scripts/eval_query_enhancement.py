#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_query_enhancement.py — Script 2: Query Rewrite + Decomposition Evaluation (P0)
══════════════════════════════════════════════════════════════════════════════════
Tests the two most architecturally significant new query-processing capabilities:
  - LLM query rewriting (3 academic variants)
  - Complex query decomposition (sub-query split)

Configs on 200 stratified queries:
  C_baseline:          entity Vector+BM25+RRF (from existing checkpoint)
  C_rewrite_only:      LLM rewrite 3 variants -> vector each -> pool -> RRF with BM25
  C_decompose_only:    LLM detect complexity -> if complex, parallel sub-search -> merge
  C_rewrite_decompose: both enabled (production default)

Metrics: Delta-R@5/R@10/MRR vs baseline, ZeroHit% reduction, decomposition rate

Cost: ~RMB 0.51 (200 rewrite + 200 decompose LLM calls)
Time: ~25 minutes
"""

import sys, json, time, random, re
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_qe")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_qe_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_query_enhancement_report.json"

SAMPLE = 80  # 80 queries ~13 min
TOP_K = 10

# ═══════════════════════════════════════════════════════════════
# Entity search (reused from existing evals)
# ═══════════════════════════════════════════════════════════════

def entity_vector(emb: QwenEmbeddingClient, nc: Neo4jConnection,
                  query: str, top_k: int = 30) -> List[Dict]:
    qv = emb.embed(query)
    if qv is None:
        return []
    try:
        rows = nc.execute_query(
            f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS category, node.description AS description, score "
            "ORDER BY score DESC LIMIT $k",
            {"v": qv, "k": top_k})
        return [{"name": r["name"], "category": r.get("category",""),
                 "description": str(r.get("description",""))[:200],
                 "score": round(r["score"],4)} for r in rows]
    except Exception:
        return []


def entity_bm25(nc: Neo4jConnection, query: str, top_k: int = 30) -> List[Dict]:
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS category, node.description AS description, score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k})
        return [{"name": r["name"], "category": r.get("category",""),
                 "description": str(r.get("description",""))[:200],
                 "score": round(r["score"],4)} for r in rows]
    except Exception:
        return []


def rrf(lists: List[List[Dict]], top_k: int = 30) -> List[str]:
    scores, meta = {}, {}
    for rlist in lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (60 + rank)
            if name not in meta:
                meta[name] = item
    return [name for name, _ in sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]]


def entity_search(emb, nc, query: str) -> List[str]:
    vec = entity_vector(emb, nc, query)
    bm25 = entity_bm25(nc, query)
    return rrf([vec, bm25], top_k=TOP_K)


# ═══════════════════════════════════════════════════════════════
# LLM query enhancement (inline from mcp_server/server.py)
# ═══════════════════════════════════════════════════════════════

def llm_rewrite(llm: QwenMaxClient, query: str) -> List[str]:
    """Generate 3 query variants: keywords, academic, synonym."""
    try:
        prompt = (
            "将以下学术查询改写为3种不同表述形式，用于增强信息检索：\n\n"
            f"原始查询：{query}\n\n"
            "输出JSON：{\"variants\": [\"关键词形式\", \"学术术语标准化形式\", \"同义改写形式\"]}\n"
            "只输出JSON。"
        )
        result = llm.call_json(prompt, max_retries=2, timeout=90,
                               system_prompt="只输出JSON对象。")
        if result and isinstance(result, dict):
            return result.get("variants", [])[:3]
    except Exception as e:
        logger.warning(f"Rewrite failed: {e}")
    return []


def llm_decompose(llm: QwenMaxClient, query: str) -> Optional[Dict]:
    """Detect multi-faceted queries and generate sub-queries."""
    try:
        prompt = (
            "判断以下学术查询是否为复合问题（包含多个可独立检索的子问题）。\n\n"
            f"查询：{query}\n\n"
            "如果是简单问题，输出 {\"is_complex\": false}\n"
            "如果是复合问题，输出：{\"is_complex\": true, \"sub_queries\": [\"子问题1\", \"子问题2\"], \"strategy\": \"parallel\"}\n"
            "子问题应该各自独立、可单独检索。最多3个子问题。\n"
            "只输出JSON。"
        )
        result = llm.call_json(prompt, max_retries=2, timeout=90,
                               system_prompt="只输出JSON对象。")
        if result and isinstance(result, dict) and result.get("is_complex"):
            return result
    except Exception as e:
        logger.warning(f"Decompose failed: {e}")
    return None


# ═══════════════════════════════════════════════════════════════
# 4 Configurations
# ═══════════════════════════════════════════════════════════════

def config_baseline(emb, nc, query: str) -> List[str]:
    return entity_search(emb, nc, query)


def config_rewrite(emb, nc, llm, query: str) -> List[str]:
    variants = llm_rewrite(llm, query)
    all_vec, all_bm25 = [], entity_bm25(nc, query)
    for v in variants[:3]:
        all_vec += entity_vector(emb, nc, v)
    return rrf([entity_vector(emb, nc, query) + all_vec, all_bm25], top_k=TOP_K)


def config_decompose(emb, nc, llm, query: str) -> List[str]:
    decomp = llm_decompose(llm, query)
    if decomp is None:
        return entity_search(emb, nc, query)

    sub_queries = decomp.get("sub_queries", [])[:3]
    if not sub_queries:
        return entity_search(emb, nc, query)

    all_hits = []
    for sq in sub_queries:
        all_hits += entity_search(emb, nc, sq)
    # Deduplicate preserving order
    seen = set()
    result = []
    for h in all_hits:
        if h not in seen:
            result.append(h)
            seen.add(h)
    return result[:TOP_K]


def config_combined(emb, nc, llm, query: str) -> List[str]:
    """Rewrite + decompose combined."""
    variants = llm_rewrite(llm, query)
    decomp = llm_decompose(llm, query)

    all_hits = entity_search(emb, nc, query)  # original query

    for v in variants[:3]:
        all_hits += entity_search(emb, nc, v)

    if decomp and decomp.get("sub_queries"):
        for sq in decomp["sub_queries"][:3]:
            all_hits += entity_search(emb, nc, sq)

    seen = set()
    result = []
    for h in all_hits:
        if h not in seen:
            result.append(h)
            seen.add(h)
    return result[:TOP_K]


# ═══════════════════════════════════════════════════════════════
# Metrics
# ═══════════════════════════════════════════════════════════════

def compute_metrics(config_results: Dict[str, List[Tuple[str,List[str]]]],
                    gt_map: Dict[str, set]) -> Dict:
    """Each config: list of (query, [entity_names]). gt_map: query -> set(GT entity names)."""
    metrics = {}
    for cfg, results in config_results.items():
        r5, r10, rr_vals, ranks = [], [], [], []
        for qtext, preds in results:
            gt = gt_map.get(qtext, set())
            if not gt:
                continue
            hit_pos = [i for i, n in enumerate(preds) if n in gt]
            first = hit_pos[0] + 1 if hit_pos else None
            r5.append(1 if hit_pos and min(hit_pos) < 5 else 0)
            r10.append(1 if bool(hit_pos) else 0)
            rr_vals.append(1.0 / first if first else 0.0)
            if first:
                ranks.append(first)
        n = len(r5)
        if n == 0:
            metrics[cfg] = {"n": 0, "error": "no data"}
            continue
        metrics[cfg] = {
            "n": n, "R@5": round(sum(r5)/n,4), "R@10": round(sum(r10)/n,4),
            "MRR": round(sum(rr_vals)/n,4), "ZeroHit%": round((1-sum(r10)/n)*100,1),
            "median_rank": round(sorted(ranks)[len(ranks)//2],1) if ranks else None,
        }

    # Deltas
    bl = metrics.get("C_baseline", {})
    for cfg in ["C_rewrite_only", "C_decompose_only", "C_rewrite_decompose"]:
        if cfg in metrics and bl:
            m = metrics[cfg]
            for k in ["R@5", "R@10", "MRR"]:
                m[f"delta_{k}"] = round(m[k] - bl.get(k,0), 4)
    return metrics


def print_report(metrics: Dict, decomp_stats: Dict):
    labels = {
        "C_baseline": "C: Vec+BM25 (baseline)",
        "C_rewrite_only": "C+Rewrite",
        "C_decompose_only": "C+Decompose",
        "C_rewrite_decompose": "C+Rewrite+Decomp",
    }
    print()
    print("=" * 70)
    print("  Query Enhancement Evaluation")
    print("=" * 70)
    print(f"  Decomposition rate: {decomp_stats.get('complex_pct',0):.0f}% of queries classed as complex")
    print(f"{'Config':<25} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 70)
    for cfg in ["C_baseline", "C_rewrite_only", "C_decompose_only", "C_rewrite_decompose"]:
        if cfg not in metrics:
            continue
        m = metrics[cfg]
        print(f"{labels[cfg]:<25} {m['R@5']:>8.4f} {m['R@10']:>8.4f} "
              f"{m['MRR']:>8.4f} {m['ZeroHit%']:>9.1f}%")
    print("-" * 70)

    print()
    print("Delta vs Baseline:")
    for cfg in ["C_rewrite_only", "C_decompose_only", "C_rewrite_decompose"]:
        if cfg not in metrics:
            continue
        m = metrics[cfg]
        print(f"  {labels[cfg]:<25} R@5 {m.get('delta_R@5',0):+.4f}  R@10 {m.get('delta_R@10',0):+.4f}  MRR {m.get('delta_MRR',0):+.4f}")


def main():
    logger.info("=" * 60)
    logger.info("Script 2: Query Enhancement Evaluation")
    logger.info("=" * 60)

    if not CKPT_INPUT.exists():
        logger.error("No test set.")
        return
    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]

    # Sample 200 stratified queries
    all_queries = []
    for paper, data in test_set.items():
        for qi, qdata in enumerate(data.get("questions", [])):
            all_queries.append((paper, qdata["question"], qdata.get("type","")))
    random.seed(42)
    sampled = random.sample(all_queries, min(SAMPLE, len(all_queries)))
    logger.info(f"Sampled {len(sampled)}/{len(all_queries)} queries")

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    # GT: query -> set of entity names
    gt_map = {}
    for paper, data in test_set.items():
        gt_entities = set(data.get("ground_truth_entities", []))
        for qdata in data.get("questions", []):
            gt_map[qdata["question"]] = gt_entities

    configs = {
        "C_baseline": lambda q: config_baseline(emb, nc, q),
        "C_rewrite_only": lambda q: config_rewrite(emb, nc, llm, q),
        "C_decompose_only": lambda q: config_decompose(emb, nc, llm, q),
        "C_rewrite_decompose": lambda q: config_combined(emb, nc, llm, q),
    }

    # Resume
    results = {cfg: [] for cfg in configs}
    start_idx = 0
    decomp_count = 0  # track decompositions
    if CKPT_OUT.exists():
        prev = json.loads(CKPT_OUT.read_text(encoding="utf-8"))
        for cfg in configs:
            if cfg in prev.get("results", {}):
                results[cfg] = prev["results"][cfg]
        start_idx = max(len(v) for v in results.values())
        logger.info(f"Resuming from query {start_idx}")

    processed = 0
    t0 = time.time()

    # Batch precompute: submit all rewrite + decompose calls concurrently via ThreadPoolExecutor
    from concurrent.futures import ThreadPoolExecutor, as_completed

    logger.info(f"Precomputing {len(sampled) - start_idx} rewrite + decompose calls in parallel...")
    future_map = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for idx in range(start_idx, len(sampled)):
            _, qtext, _ = sampled[idx]
            f_rewrite = ex.submit(llm_rewrite, llm, qtext)
            f_decomp = ex.submit(llm_decompose, llm, qtext)
            future_map[idx] = (f_rewrite, f_decomp)

        # Drain as they complete
        precomputed = {}
        for idx in range(start_idx, len(sampled)):
            f_r, f_d = future_map[idx]
            variants = f_r.result()
            decomp = f_d.result()
            precomputed[idx] = (variants or [], decomp)
            if decomp:
                decomp_count += 1
        logger.info(f"Precompute done: {len(precomputed)} queries, decomp={decomp_count}")

    for idx in range(start_idx, len(sampled)):
        paper, qtext, qtype = sampled[idx]
        variants, decomp = precomputed.get(idx, ([], None))

        time.sleep(0.3)  # minimal cooldown

        # --- Run all 4 configs with precomputed results ---
        for cfg_name in configs:
            try:
                if cfg_name == "C_baseline":
                    hits = entity_search(emb, nc, qtext)
                elif cfg_name == "C_rewrite_only":
                    all_vec = entity_vector(emb, nc, qtext)
                    all_bm25 = entity_bm25(nc, qtext)
                    for v in variants[:3]:
                        all_vec += entity_vector(emb, nc, v)
                        all_bm25 += entity_bm25(nc, v)
                    hits = rrf([all_vec, all_bm25], top_k=TOP_K)
                elif cfg_name == "C_decompose_only":
                    if decomp and decomp.get("sub_queries"):
                        all_h = entity_search(emb, nc, qtext)
                        for sq in decomp["sub_queries"][:3]:
                            all_h += entity_search(emb, nc, sq)
                        seen_s = set()
                        hits = []
                        for h in all_h:
                            if h not in seen_s:
                                hits.append(h); seen_s.add(h)
                        hits = hits[:TOP_K]
                    else:
                        hits = entity_search(emb, nc, qtext)
                elif cfg_name == "C_rewrite_decompose":
                    all_h = entity_search(emb, nc, qtext)
                    for v in variants[:3]:
                        all_h += entity_search(emb, nc, v)
                    if decomp and decomp.get("sub_queries"):
                        for sq in decomp["sub_queries"][:3]:
                            all_h += entity_search(emb, nc, sq)
                    seen_s = set()
                    hits = []
                    for h in all_h:
                        if h not in seen_s:
                            hits.append(h); seen_s.add(h)
                    hits = hits[:TOP_K]
                results[cfg_name].append((qtext, hits))
            except Exception as e:
                logger.warning(f"{cfg_name} failed: {e}")
                results[cfg_name].append((qtext, []))

        processed += 1
        elapsed = time.time() - t0
        rate = (idx + 1 - start_idx) / elapsed if elapsed > 0 else 0
        eta = (len(sampled) - idx - 1) / rate / 60 if rate > 0 else 0
        if (idx + 1) % 10 == 0:
            logger.info(f"  [{idx+1}/{len(sampled)}] {rate:.2f}q/s ETA {eta:.0f}min")

        if (idx + 1) % 30 == 0:
            CKPT_OUT.write_text(json.dumps(
                {"results": results, "updated": datetime.now().isoformat()},
                ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(1.5)

    decomp_pct = round(decomp_count / max(len(sampled), 1) * 100, 1)
    metrics = compute_metrics(results, gt_map)

    print_report(metrics, {"complex_pct": decomp_pct})

    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "sample": len(sampled),
        "decomposition_rate": decomp_pct,
        "metrics": metrics,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()


if __name__ == "__main__":
    main()
