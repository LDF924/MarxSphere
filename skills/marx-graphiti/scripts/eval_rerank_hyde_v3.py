#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_rerank_hyde_v3.py — Rerank + HyDE Ablation (FIXED)
══════════════════════════════════════════════════════════
Fixes:
  1. DashScope timeout: 90s for LLM calls (was 60s)
  2. Embedding cache: writes to eval_output/embedding_cache.db
  3. Output isolation: all artifacts in eval_output/

Evaluates 4 configs on 100 queries:
  C:      Vec + BM25 + RRF (baseline)
  C_RR:   C + LLM listwise rerank
  C_HD:   C + HyDE (vector searched with LLM-generated hypothetical answer)
  C_ALL:  C + rerank + hyde

Cost: ~RMB 1.0  |  Time: ~25 min
"""

from __future__ import annotations

import json, time, sys, sqlite3, hashlib, re, argparse
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from collections import OrderedDict

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

OUT_DIR = SCRIPT_DIR / "eval_output"
OUT_DIR.mkdir(exist_ok=True)

# ── Embedding cache ──────────────────────────────────────────
class EmbeddingCache:
    """SQLite-backed embedding cache to avoid re-embedding the same text."""
    def __init__(self, db_path: Path = OUT_DIR / "embedding_cache.db"):
        self.conn = sqlite3.connect(str(db_path))
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, vector TEXT, created_at TEXT)")
        self.conn.commit()
        self.hits = 0
        self.misses = 0

    def _key(self, text: str) -> str:
        return hashlib.md5(text.encode("utf-8")).hexdigest()

    def get(self, text: str) -> Optional[List[float]]:
        c = self.conn.execute("SELECT vector FROM cache WHERE key=?", (self._key(text),)).fetchone()
        if c:
            self.hits += 1
            return json.loads(c[0])
        self.misses += 1
        return None

    def set(self, text: str, vector: List[float]):
        self.conn.execute(
            "INSERT OR REPLACE INTO cache VALUES (?, ?, ?)",
            (self._key(text), json.dumps(vector), datetime.now().isoformat()))
        self.conn.commit()

    def stats(self) -> str:
        total = self.hits + self.misses
        return f"{self.hits}/{total} hits ({self.hits/total*100:.0f}%)" if total else "empty"


# ═══════════════════════════════════════════════════════════════
# CORE FUNCTIONS
# ═══════════════════════════════════════════════════════════════

API_KEY = ""
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen3.7-max"

# Central timeout — 90s for DashScope
TIMEOUT = 90

def vector_search(emb: QwenEmbeddingClient, ecache: EmbeddingCache,
                  nc, query: str, top_k: int = 30) -> List[dict]:
    """Vector search with embedding cache."""
    qv = ecache.get(query)
    if qv is None:
        qv = emb.embed(query)
        if qv is not None:
            ecache.set(query, qv)
    if qv is None:
        return []
    rows = nc.execute_query(
        f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
        "YIELD node, score "
        "RETURN node.name AS name, node.category AS category, node.description AS description, score "
        "ORDER BY score DESC LIMIT $k",
        {"v": qv, "k": top_k})
    return [{"name": r["name"], "category": r.get("category",""),
             "description": str(r.get("description",""))[:200],
             "score": round(r["score"],4)} for r in rows]


def bm25_search(nc, query: str, top_k: int = 30) -> List[dict]:
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


def rrf_fuse(ranked_lists: List[List[dict]], top_k: int = 10) -> List[str]:
    scores, meta = {}, {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (60 + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [name for name, _ in merged]


def llm_call(llm: QwenMaxClient, system: str, prompt: str) -> Optional[str]:
    """Single LLM call with 90s timeout."""
    result = llm.call(prompt, max_retries=3, timeout=TIMEOUT, system_prompt=system)
    if result is None:
        return None
    return result.get("content", "")


def llm_rerank(llm: QwenMaxClient, query: str, candidates: List[dict], top_k: int = 10) -> List[str]:
    if len(candidates) <= top_k:
        return [c["name"] for c in candidates]

    items = [f"[{i}] {c.get('category','')}|{c['name']}|{c.get('description','')[:100]}"
             for i, c in enumerate(candidates[:15])]

    prompt = (f"Query: {query}\n\nCandidates:\n" + "\n".join(items) +
              f"\n\nSelect the {top_k} most relevant. Output JSON: {{\"ranked\": [0,3,5,...]}}")

    content = llm_call(llm, "Rank candidates by relevance. Output only JSON.", prompt)
    if content is None:
        return [c["name"] for c in candidates[:top_k]]

    # Parse
    try:
        indices = json.loads(content).get("ranked", [])
    except Exception:
        nums = re.findall(r'\d+', content)
        indices = [int(n) for n in nums[:top_k]]

    ranked = []
    for i in indices:
        if 0 <= i < len(candidates):
            ranked.append(candidates[i]["name"])
    for c in candidates:
        if c["name"] not in ranked:
            ranked.append(c["name"])
    return ranked[:top_k]


def generate_hyde(llm: QwenMaxClient, query: str) -> Optional[str]:
    prompt = (
        "你是马克思主义理论学者。请用一段学术文字（100-200字）回答问题，"
        "使用正确的学术术语。这是假设性回答，用于增强检索，不需要完全准确。\n\n"
        f"问题：{query}\n\n假设性回答：")
    return llm_call(llm, "用学术中文回答。", prompt)


# ═══════════════════════════════════════════════════════════════
# 4 SEARCH CONFIGS
# ═══════════════════════════════════════════════════════════════

def config_baseline(emb, ecache, nc, query: str) -> List[str]:
    vec = vector_search(emb, ecache, nc, query)
    bm = bm25_search(nc, query)
    return rrf_fuse([vec, bm])


def config_rerank(emb, ecache, nc, llm, query: str) -> List[str]:
    vec = vector_search(emb, ecache, nc, query)
    bm = bm25_search(nc, query)
    # Merge into unique candidate pool
    seen = OrderedDict()
    for r in vec + bm:
        if r["name"] not in seen:
            seen[r["name"]] = r
    candidates = list(seen.values())[:20]
    return llm_rerank(llm, query, candidates)


def config_hyde(emb, ecache, nc, llm, query: str) -> List[str]:
    hyde_text = generate_hyde(llm, query)
    search_q = (hyde_text or query)[:2000]
    vec = vector_search(emb, ecache, nc, search_q)
    bm = bm25_search(nc, query)
    return rrf_fuse([vec, bm])


def config_all(emb, ecache, nc, llm, query: str) -> List[str]:
    hyde_text = generate_hyde(llm, query)
    search_q = (hyde_text or query)[:2000]
    vec = vector_search(emb, ecache, nc, search_q)
    bm = bm25_search(nc, query)
    seen = OrderedDict()
    for r in vec + bm:
        if r["name"] not in seen:
            seen[r["name"]] = r
    candidates = list(seen.values())[:20]
    return llm_rerank(llm, query, candidates)


# ═══════════════════════════════════════════════════════════════
# EVAL LOOP
# ═══════════════════════════════════════════════════════════════

def compute_metrics(pairs_gt: List[set], results: Dict[str, List[List[str]]]) -> Dict:
    metrics = {}
    for cfg_name, hit_lists in results.items():
        h5, h10, rr = [], [], []
        for hits, gt in zip(hit_lists, pairs_gt):
            pos = [i for i, n in enumerate(hits) if n in gt]
            first = pos[0] + 1 if pos else None
            h5.append(1 if pos and min(pos) < 5 else 0)
            h10.append(1 if bool(pos) else 0)
            rr.append(1.0 / first if first else 0.0)
        n = len(h5)
        metrics[cfg_name] = {
            "n": n, "R@5": round(sum(h5)/n,4), "R@10": round(sum(h10)/n,4),
            "MRR": round(sum(rr)/n,4), "ZeroHit%": round((1-sum(h10)/n)*100,1)}

    # Delta vs baseline
    bl = metrics.get("C", {})
    for cfg in ["C_RR", "C_HD", "C_ALL"]:
        if cfg in metrics and bl:
            for k in ["R@5", "R@10", "MRR"]:
                metrics[cfg][f"delta_{k}"] = round(metrics[cfg][k] - bl.get(k, 0), 4)
    return metrics


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=100, help="Number of queries (default 100)")
    parser.add_argument("--skip-hyde", action="store_true", help="Skip HyDE configs (faster)")
    args = parser.parse_args()

    print(f"\n{'='*60}")
    print(f"  Rerank + HyDE Ablation (v3)")
    print(f"{'='*60}")
    print(f"  Queries: {args.n}  |  Timeout: {TIMEOUT}s  |  Output: {OUT_DIR}")
    print(f"  Configs: C + C_RR + {'C_HD + C_ALL' if not args.skip_hyde else '(hyde skipped)'}")

    # ── Init ─────────────────────────────────────────────────
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    ecache = EmbeddingCache()
    qw = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw["api_key"], base_url=qw["base_url"], model=qw["model"])

    # ── Load queries ─────────────────────────────────────────
    test_set = json.loads((SCRIPT_DIR / ".eval_checkpoint.json").read_text(encoding="utf-8"))["test_set"]
    pairs = []
    for paper, data in test_set.items():
        for qi, qdata in enumerate(data.get("questions", [])):
            pairs.append((qdata["question"], set(data.get("ground_truth_entities", []))))
        if len(pairs) >= args.n:
            break
    print(f"  Loaded {len(pairs)} queries\n")

    # ── Run ──────────────────────────────────────────────────
    configs = {
        "C":     lambda q: config_baseline(emb, ecache, nc, q),
        "C_RR":  lambda q: config_rerank(emb, ecache, nc, llm, q),
    }
    if not args.skip_hyde:
        configs["C_HD"]  = lambda q: config_hyde(emb, ecache, nc, llm, q)
        configs["C_ALL"] = lambda q: config_all(emb, ecache, nc, llm, q)

    results: Dict[str, List[List[str]]] = {k: [] for k in configs}
    pairs_gt = []

    t0 = time.time()
    for idx, (query, gt) in enumerate(pairs):
        pairs_gt.append(gt)

        for cfg_name, cfg_fn in configs.items():
            try:
                hits = cfg_fn(query)
                results[cfg_name].append(hits)
            except Exception as e:
                print(f"  ! {cfg_name} error: {e}", flush=True)
                results[cfg_name].append([])

        # Progress
        elapsed = time.time() - t0
        rate = (idx + 1) / elapsed if elapsed > 0 else 0
        eta = (len(pairs) - idx - 1) / rate / 60 if rate > 0 else 0

        # Running R@5 for C and C_RR
        def _running_r5(cfg):
            if len(results[cfg]) < 3: return "?"
            h5 = sum(1 for hits, g in zip(results[cfg][:-1], pairs_gt[:-1])
                     if [i for i,n in enumerate(hits) if n in g] and min([i for i,n in enumerate(hits) if n in g]) < 5)
            return f"{h5/max(1,len(results[cfg])-1):.3f}"

        print(f"  [{idx+1:>3}/{len(pairs)}] "
              f"C_R@5={_running_r5('C')}  C_RR_R@5={_running_r5('C_RR')}  "
              f"{rate:.2f}q/s  ETA {eta:.0f}min  ecache={ecache.stats()}", flush=True)

        # Checkpoint every 20
        if (idx + 1) % 20 == 0:
            m = compute_metrics(pairs_gt, results)
            (OUT_DIR / "checkpoint.json").write_text(
                json.dumps({"n": idx+1, "metrics": m, "time": datetime.now().isoformat()},
                           ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  >>> checkpoint saved", flush=True)

    # ── Final Report ─────────────────────────────────────────
    metrics = compute_metrics(pairs_gt, results)
    labels = {"C": "C: Vec+BM25", "C_RR": "C+Rerank", "C_HD": "C+HyDE", "C_ALL": "C+All"}

    print(f"\n{'='*60}")
    print(f"  Rerank + HyDE Ablation Results")
    print(f"{'='*60}")
    print(f"{'Config':<20} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 60)
    for cfg in ["C", "C_RR", "C_HD", "C_ALL"]:
        if cfg not in metrics: continue
        m = metrics[cfg]
        print(f"{labels[cfg]:<20} {m['R@5']:>8.4f} {m['R@10']:>8.4f} {m['MRR']:>8.4f} {m['ZeroHit%']:>9.1f}%")
    print("-" * 60)

    # Deltas
    print(f"\n  Gain vs Baseline (C):")
    for cfg in ["C_RR", "C_HD", "C_ALL"]:
        if cfg not in metrics: continue
        m = metrics[cfg]
        print(f"  {labels[cfg]:<20} R@5 {m.get('delta_R@5',0):+.4f}  R@10 {m.get('delta_R@10',0):+.4f}  MRR {m.get('delta_MRR',0):+.4f}")

    # Save
    report = {
        "timestamp": datetime.now().isoformat(),
        "n": len(pairs),
        "embedding_cache": ecache.stats(),
        "metrics": metrics,
    }
    (OUT_DIR / "rerank_hyde_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  Report: {OUT_DIR / 'rerank_hyde_report.json'}")
    print(f"  Checkpoint: {OUT_DIR / 'checkpoint.json'}")

    nc.close()


if __name__ == "__main__":
    main()
