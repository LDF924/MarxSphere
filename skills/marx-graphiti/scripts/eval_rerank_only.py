#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_rerank_only.py — Reranker Ablation (MINIMAL, SINGLE-THREAD, PRINT EVERY STEP)
Runs C (baseline) vs C_RR (reranked) on 100 queries from the test set.
Uses QwenMaxClient for rate limiting + retry.
"""

import json, time, sys
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
emb = QwenEmbeddingClient()
qw = get_qwen_max_config()
llm = QwenMaxClient(api_key=qw["api_key"], base_url=qw["base_url"], model=qw["model"])

# Load test set
test_set = json.loads(Path(".eval_checkpoint.json").read_text(encoding="utf-8"))["test_set"]

# Collect 100 query pairs
pairs = []
for paper, data in test_set.items():
    for qi, qdata in enumerate(data.get("questions", [])):
        pairs.append((paper, data, qi, qdata["question"], data.get("ground_truth_entities", [])))
    if len(pairs) >= 100:
        break

print(f"Running reranker ablation on {len(pairs)} queries")
print()

def vector_search(query, top_k=30):
    qv = emb.embed(query)
    if qv is None: return []
    rows = nc.execute_query(
        f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
        "YIELD node, score RETURN node.name AS name, node.category AS category, "
        "node.description AS description, score ORDER BY score DESC LIMIT $k",
        {"v": qv, "k": top_k})
    return [{"name": r["name"], "category": r.get("category",""),
             "description": str(r.get("description",""))[:200], "score": round(r["score"],4)} for r in rows]

def bm25_search(query, top_k=30):
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
            "YIELD node, score RETURN node.name AS name, node.category AS category, "
            "node.description AS description, score ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k})
        return [{"name": r["name"], "category": r.get("category",""),
                 "description": str(r.get("description",""))[:200], "score": round(r["score"],4)} for r in rows]
    except: return []

def rrf(ranked_lists, top_k=10):
    scores, meta = {}, {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (60 + rank)
            if name not in meta: meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [meta.get(name, {"name":name})["name"] for name, _ in merged]

def rerank(query, candidates, top_k=10):
    if len(candidates) <= top_k: return [c["name"] for c in candidates]
    items = [f"[{i}] {c.get('category','')}|{c['name']}|{c.get('description','')[:100]}"
             for i, c in enumerate(candidates[:15])]
    prompt = (f"Query: {query}\n\nCandidates:\n" + "\n".join(items) +
              f"\n\nSelect the {top_k} most relevant. Output JSON: {{\"ranked\": [0,3,5,...]}}")
    result = llm.call(prompt, max_retries=3, timeout=60,
                      system_prompt="Rank by relevance. Output only JSON.")
    if result is None: return [c["name"] for c in candidates[:top_k]]
    try:
        indices = json.loads(result["content"]).get("ranked", [])
    except:
        import re
        indices = [int(n) for n in re.findall(r'\d+', result["content"])[:top_k]]
    ranked = []
    for i in indices:
        if 0 <= i < len(candidates): ranked.append(candidates[i]["name"])
    for c in candidates:
        if c["name"] not in ranked: ranked.append(c["name"])
    return ranked[:top_k]

def baseline(query):
    vec = vector_search(query)
    bm = bm25_search(query)
    return rrf([vec, bm])

def with_rerank(query):
    vec = vector_search(query)
    bm = bm25_search(query)
    fused = []
    sv, sb = {}, {}
    for r in vec: sv[r["name"]] = r
    for r in bm: sb[r["name"]] = r
    rank_vec = [{"name": sorted(sv.keys(), key=lambda n: sv[n]["score"], reverse=True)[i],
                 "category": sv[n]["category"], "description": sv[n]["description"],
                 "score": sv[n]["score"]}
                for i, n in enumerate(sv) if i < 30]
    rank_bm = [{"name": sorted(sb.keys(), key=lambda n: sb[n]["score"], reverse=True)[i],
                "category": sb[n]["category"], "description": sb[n]["description"],
                "score": sb[n]["score"]}
               for i, n in enumerate(sb) if i < 30]
    all_cands = []
    seen = set()
    for r in rank_vec + rank_bm:
        if r["name"] not in seen:
            all_cands.append(r)
            seen.add(r["name"])
    return rerank(query, all_cands[:20])

# Run
baseline_h5, baseline_h10, baseline_rr = [], [], []
rerank_h5, rerank_h10, rerank_rr = [], [], []

t0 = time.time()
for idx, (paper, data, qi, query, gt) in enumerate(pairs):
    gt_set = set(gt)
    if not gt_set: continue

    # Baseline
    bl = baseline(query)
    bl_hits = [i for i, n in enumerate(bl) if n in gt_set]
    bl_first = bl_hits[0] + 1 if bl_hits else None
    baseline_h5.append(1 if bl_hits and min(bl_hits) < 5 else 0)
    baseline_h10.append(1 if bl_hits else 0)
    baseline_rr.append(1.0 / bl_first if bl_first else 0.0)

    # Rerank
    rr = with_rerank(query)
    rr_hits = [i for i, n in enumerate(rr) if n in gt_set]
    rr_first = rr_hits[0] + 1 if rr_hits else None
    rerank_h5.append(1 if rr_hits and min(rr_hits) < 5 else 0)
    rerank_h10.append(1 if rr_hits else 0)
    rerank_rr.append(1.0 / rr_first if rr_first else 0.0)

    elapsed = time.time() - t0
    rate = (idx + 1) / elapsed if elapsed > 0 else 0
    eta = (len(pairs) - idx - 1) / rate / 60 if rate > 0 else 0
    print(f"[{idx+1}/{len(pairs)}] bl_hit={bool(bl_hits)} rr_hit={bool(rr_hits)} "
          f"bl_r1={bl_first} rr_r1={rr_first} | {rate:.2f}/s ETA {eta:.0f}min")

# Print report
n = len(baseline_h5)
print()
print("=" * 50)
print("  Reranker Ablation Results")
print("=" * 50)
print(f"  Queries: {n}")
print(f"{'Config':<20} {'R@5':>8} {'R@10':>8} {'MRR':>8}")
print("-" * 50)
print(f"{'Baseline (Vec+BM25)':<20} {sum(baseline_h5)/n:>8.4f} {sum(baseline_h10)/n:>8.4f} {sum(baseline_rr)/n:>8.4f}")
print(f"{'+Rerank':<20} {sum(rerank_h5)/n:>8.4f} {sum(rerank_h10)/n:>8.4f} {sum(rerank_rr)/n:>8.4f}")
delta_h5 = (sum(rerank_h5) - sum(baseline_h5)) / sum(baseline_h5) * 100 if sum(baseline_h5) > 0 else 0
delta_h10 = (sum(rerank_h10) - sum(baseline_h10)) / sum(baseline_h10) * 100 if sum(baseline_h10) > 0 else 0
print(f"{'Delta':<20} {delta_h5:>+7.1f}% {delta_h10:>+7.1f}%")
print("-" * 50)

# Save
Path("eval_rerank_report.json").write_text(json.dumps({
    "timestamp": datetime.now().isoformat(), "n": n,
    "baseline": {"R@5": round(sum(baseline_h5)/n,4), "R@10": round(sum(baseline_h10)/n,4), "MRR": round(sum(baseline_rr)/n,4)},
    "rerank": {"R@5": round(sum(rerank_h5)/n,4), "R@10": round(sum(rerank_h10)/n,4), "MRR": round(sum(rerank_rr)/n,4)},
    "delta_R@5_pct": round(delta_h5, 1),
}, ensure_ascii=False, indent=2), encoding="utf-8")

nc.close()
print("Done.")
