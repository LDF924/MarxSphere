#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_qe_shard.py — Script 2-shard: Query Enhancement (split execution)
═════════════════════════════════════════════════════════════════════
Run as --shard 0 or --shard 1 (40 queries each from a shared 80-query sample).
Shards share precomputed LLM rewrites/decompositions via eval_output/qe_precompute.json.
Merge both shard checkpoints: python eval_qe_shard.py --merge

Configs: C_baseline, C_rewrite_only, C_decompose_only, C_rewrite_decompose
Time: ~8 min per shard (within 10 min limit)
"""

import sys, json, time, random, re, argparse
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_qe_shard")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
PRECOMPUTE_FILE = SCRIPT_DIR / "eval_output" / "qe_precompute.json"
TOP_K = 10
N_SHARDS = 2
N_PER_SHARD = 40


# ═══════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════

def entity_vector(emb, nc, query: str, top_k: int = 30) -> List[Dict]:
    qv = emb.embed(query)
    if qv is None: return []
    rows = nc.execute_query(
        f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
        "YIELD node, score RETURN node.name AS name, node.category AS category, "
        "node.description AS description, score ORDER BY score DESC LIMIT $k",
        {"v": qv, "k": top_k})
    return [{"name": r["name"], "category": r.get("category",""),
             "description": str(r.get("description",""))[:200], "score": round(r["score"],4)} for r in rows]


def entity_bm25(nc, query: str, top_k: int = 30) -> List[Dict]:
    rows = nc.execute_query(
        "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) YIELD node, score "
        "RETURN node.name AS name, node.category AS category, node.description AS description, score "
        "ORDER BY score DESC LIMIT $k", {"q": query, "k": top_k})
    return [{"name": r["name"], "category": r.get("category",""),
             "description": str(r.get("description",""))[:200], "score": round(r["score"],4)} for r in rows]


def entity_search(emb, nc, query: str) -> List[str]:
    vec = entity_vector(emb, nc, query)
    bm25 = entity_bm25(nc, query)
    scores, meta = {}, {}
    for rlist in [vec, bm25]:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0/(60+rank)
            if name not in meta: meta[name] = item
    return [name for name,_ in sorted(scores.items(), key=lambda x:x[1], reverse=True)[:TOP_K]]


def llm_rewrite(llm, query: str) -> List[str]:
    try:
        r = llm.call_json(
            f'将以下学术查询改写为3种表述：\n\n{query}\n\n输出: {{"variants":["关键词","学术术语","同义改写"]}}\n只输出JSON。',
            max_retries=2, timeout=90, system_prompt="只输出JSON对象。")
        if r and isinstance(r, dict): return r.get("variants",[])[:3]
    except Exception: pass
    return []


def llm_decompose(llm, query: str) -> Optional[Dict]:
    try:
        r = llm.call_json(
            f'判断该查询是否为复合问题：\n\n{query}\n\n输出: {{"is_complex":true/false,"sub_queries":["..."]}}\n只输出JSON。',
            max_retries=2, timeout=90, system_prompt="只输出JSON对象。")
        if r and isinstance(r, dict) and r.get("is_complex"): return r
    except Exception: pass
    return None


# ═══════════════════════════════════════════════════════════════
# Phase 1: Precompute LLM data
# ═══════════════════════════════════════════════════════════════

def phase_precompute(llm, sampled: List[Tuple]) -> Dict:
    """Run all rewrite+decompose in parallel, save to disk."""
    logger.info(f"Precomputing {len(sampled)} rewrite+decompose in parallel (8 workers)...")
    t0 = time.time()
    results = {}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {}
        for idx, (_, qtext, _) in enumerate(sampled):
            futures[ex.submit(llm_rewrite, llm, qtext)] = ("rewrite", idx)
            futures[ex.submit(llm_decompose, llm, qtext)] = ("decompose", idx)

        for f in futures:
            kind, idx = futures[f]
            try:
                val = f.result()
                if idx not in results: results[idx] = {}
                results[idx][kind] = val
            except Exception as e:
                logger.warning(f"Precompute[{idx}] {kind}: {e}")

    elapsed = time.time() - t0
    logger.info(f"Precompute: {len(results)} queries in {elapsed:.0f}s")

    PRECOMPUTE_FILE.parent.mkdir(exist_ok=True)
    # Convert to serializable
    serializable = {}
    for idx, data in results.items():
        serializable[str(idx)] = {"rewrite": data.get("rewrite", []),
                                   "decompose": data.get("decompose")}
    PRECOMPUTE_FILE.write_text(json.dumps(serializable, ensure_ascii=False, indent=2), encoding="utf-8")
    return results


# ═══════════════════════════════════════════════════════════════
# Phase 2: Run retrieval
# ═══════════════════════════════════════════════════════════════

def raise_(ex): raise ex  # noqa

def phase_retrieval(emb, nc, sampled, precomputed, shard: int):
    """Run all 4 configs for this shard's queries. Returns results dict."""
    start = shard * N_PER_SHARD
    end = min(start + N_PER_SHARD, len(sampled))
    shard_queries = sampled[start:end]

    shard_results = {cfg: [] for cfg in ["C_baseline","C_rewrite_only","C_decompose_only","C_rewrite_decompose"]}

    t0 = time.time()
    for local_idx, (paper, qtext, qtype) in enumerate(shard_queries):
        global_idx = start + local_idx
        pre = precomputed.get(global_idx, {})
        variants = pre.get("rewrite", []) or []
        decomp = pre.get("decompose")

        # C_baseline
        shard_results["C_baseline"].append((qtext, entity_search(emb, nc, qtext)))

        # C_rewrite_only
        all_h = entity_search(emb, nc, qtext)
        for v in variants[:3]: all_h += entity_search(emb, nc, v)
        seen = set(); hits_rw = []
        for h in all_h:
            if h not in seen: hits_rw.append(h); seen.add(h)
        shard_results["C_rewrite_only"].append((qtext, hits_rw[:TOP_K]))

        # C_decompose_only
        all_h = entity_search(emb, nc, qtext)
        if decomp and decomp.get("sub_queries"):
            for sq in decomp["sub_queries"][:3]: all_h += entity_search(emb, nc, sq)
        seen = set(); hits_dc = []
        for h in all_h:
            if h not in seen: hits_dc.append(h); seen.add(h)
        shard_results["C_decompose_only"].append((qtext, hits_dc[:TOP_K]))

        # C_rewrite_decompose
        all_h = entity_search(emb, nc, qtext)
        for v in variants[:3]: all_h += entity_search(emb, nc, v)
        if decomp and decomp.get("sub_queries"):
            for sq in decomp["sub_queries"][:3]: all_h += entity_search(emb, nc, sq)
        seen = set(); hits_all = []
        for h in all_h:
            if h not in seen: hits_all.append(h); seen.add(h)
        shard_results["C_rewrite_decompose"].append((qtext, hits_all[:TOP_K]))

        if (local_idx + 1) % 10 == 0:
            elapsed = time.time() - t0
            rate = (local_idx + 1) / elapsed if elapsed > 0 else 0
            eta = (len(shard_queries) - local_idx - 1) / rate / 60 if rate > 0 else 0
            logger.info(f"  [shard{shard} {local_idx+1}/{len(shard_queries)}] {rate:.2f}q/s ETA {eta:.0f}min")

    # Save shard checkpoint
    ckpt_path = SCRIPT_DIR / f".eval_qe_shard{shard}.json"
    ckpt_path.write_text(json.dumps({f"shard{shard}": shard_results}, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Shard {shard} saved: {ckpt_path}")
    return shard_results


# ═══════════════════════════════════════════════════════════════
# Phase 3: Merge + Report
# ═══════════════════════════════════════════════════════════════

def merge_shards(test_set, sampled, n_shards: int = 2) -> Dict:
    """Load all shard checkpoints, merge into single results dict."""
    merged = {"C_baseline":[],"C_rewrite_only":[],"C_decompose_only":[],"C_rewrite_decompose":[]}
    for s in range(n_shards):
        ckpt = SCRIPT_DIR / f".eval_qe_shard{s}.json"
        if not ckpt.exists():
            logger.warning(f"Shard {s} checkpoint missing: {ckpt}")
            continue
        data = json.loads(ckpt.read_text(encoding="utf-8"))
        for cfg in merged:
            merged[cfg].extend(data[f"shard{s}"].get(cfg, []))
    return merged


def compute_metrics(results, gt_map):
    metrics = {}
    for cfg, data in results.items():
        r5,r10,rr_vals,ranks = [],[],[],[]
        for qtext, preds in data:
            gt = gt_map.get(qtext, set())
            if not gt: continue
            hit_pos = [i for i,n in enumerate(preds) if n in gt]
            first = hit_pos[0]+1 if hit_pos else None
            r5.append(1 if hit_pos and min(hit_pos)<5 else 0)
            r10.append(1 if bool(hit_pos) else 0)
            rr_vals.append(1.0/first if first else 0.0)
            if first: ranks.append(first)
        n = len(r5)
        if n==0: continue
        metrics[cfg] = {"n":n,"R@5":round(sum(r5)/n,4),"R@10":round(sum(r10)/n,4),
                        "MRR":round(sum(rr_vals)/n,4),"ZeroHit%":round((1-sum(r10)/n)*100,1)}
    bl = metrics.get("C_baseline",{})
    for cfg in ["C_rewrite_only","C_decompose_only","C_rewrite_decompose"]:
        if cfg in metrics and bl:
            for k in ["R@5","R@10","MRR"]:
                metrics[cfg][f"delta_{k}"] = round(metrics[cfg][k]-bl.get(k,0),4)
    return metrics


def print_report(metrics, n):
    labels = {"C_baseline":"C: Vec+BM25","C_rewrite_only":"C+Rewrite","C_decompose_only":"C+Decompose","C_rewrite_decompose":"C+All"}
    print("\n"+"="*70)
    print(f"  Query Enhancement ({n} queries)")
    print("="*70)
    print(f"{'Config':<25} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-"*70)
    for cfg in ["C_baseline","C_rewrite_only","C_decompose_only","C_rewrite_decompose"]:
        if cfg not in metrics: continue
        m=metrics[cfg]
        print(f"{labels[cfg]:<25} {m['R@5']:>8.4f} {m['R@10']:>8.4f} {m['MRR']:>8.4f} {m['ZeroHit%']:>9.1f}%")
    print("-"*70)
    print("\nDelta vs Baseline:")
    for cfg in ["C_rewrite_only","C_decompose_only","C_rewrite_decompose"]:
        if cfg not in metrics: continue
        m=metrics[cfg]
        print(f"  {labels[cfg]:<25} R@5 {m.get('delta_R@5',0):+.4f}  R@10 {m.get('delta_R@10',0):+.4f}  MRR {m.get('delta_MRR',0):+.4f}")


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, default=None, help="Shard index 0/1")
    parser.add_argument("--precompute", action="store_true", help="Run Phase 1 only")
    parser.add_argument("--merge", action="store_true", help="Merge shards and print report")
    args = parser.parse_args()

    if not CKPT_INPUT.exists():
        logger.error("No test set")
        return

    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]

    # Build GT map
    gt_map = {}
    for paper, data in test_set.items():
        gt_entities = set(data.get("ground_truth_entities", []))
        for qdata in data.get("questions", []):
            gt_map[qdata["question"]] = gt_entities

    # Sample
    all_queries = []
    for paper, data in test_set.items():
        for qi, qdata in enumerate(data.get("questions", [])):
            all_queries.append((paper, qdata["question"], qdata.get("type","")))
    random.seed(42)
    sampled = random.sample(all_queries, min(N_SHARDS * N_PER_SHARD, len(all_queries)))
    logger.info(f"Sample: {len(sampled)} queries, {N_SHARDS} shards of {N_PER_SHARD}")

    if args.merge:
        merged = merge_shards(test_set, sampled)
        metrics = compute_metrics(merged, gt_map)
        print_report(metrics, len(sampled))
        (SCRIPT_DIR / "eval_query_enhancement_report.json").write_text(json.dumps({
            "timestamp": datetime.now().isoformat(),
            "sample": len(sampled), "metrics": metrics,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Report: eval_query_enhancement_report.json")
        return

    # Init
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    # Phase 1: Precompute (once)
    precomputed = {}
    if PRECOMPUTE_FILE.exists():
        raw = json.loads(PRECOMPUTE_FILE.read_text(encoding="utf-8"))
        precomputed = {int(k): v for k, v in raw.items()}
        logger.info(f"Loaded precompute: {len(precomputed)} queries")
    else:
        precomputed = phase_precompute(llm, sampled)

    if args.precompute:
        logger.info("Precompute done, exiting")
        nc.close()
        return

    # Phase 2: Run retrieval for shard
    if args.shard is None:
        logger.error("Specify --shard 0 or --shard 1")
        nc.close()
        return

    phase_retrieval(emb, nc, sampled, precomputed, args.shard)
    nc.close()
    logger.info(f"Shard {args.shard} done")


if __name__ == "__main__":
    main()
