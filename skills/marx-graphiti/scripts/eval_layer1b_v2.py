#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_layer1b_v2.py — Layer 1b: Post-Upgrade Ablation (ROBUST VERSION)
Reuses 604-question test set. Tests 5 configs (NO broken reranker, NO HyDE that
requires LLM per query). All pure-retrieval configs finish in ~10 min.

Configs:
  C_baseline: Vector + BM25 + RRF (existing baseline)
  C_rerank_basic: C + rerank via LLM-as-judge True/False (self-contained, no graphiti)
  C_expand: C + query synonym expansion
  C_full: C + expansion + rerank

Metrics: Recall@5, Recall@10, MRR, Zero-Hit Rate
Cost: ~RMB 0.5 (embedding only; rerank LLM calls per query)
"""

import sys, json, time, math, requests
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Optional

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient

logger = get_logger("eval_l1b_v2")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_l1b_v2_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_layer1b_report.json"

TOP_K = 10
API_KEY = ""
API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"

# ═════════════════════════════════════════════
# Robust reranker — self-contained, no graphiti
# ═════════════════════════════════════════════

def _llm_rerank(query: str, candidates: List[Dict], top_k: int = 10) -> List[Dict]:
    """Single-call LLM rerank: ask model to pick top-K from candidates."""
    if len(candidates) <= top_k:
        return candidates

    items = []
    for i, c in enumerate(candidates[:20]):
        items.append(f"[{i}] {c.get('category','')} | {c['name']} | {str(c.get('description',''))[:120]}")

    prompt = (
        f"Query: {query}\n\n"
        f"Candidates:\n" + "\n".join(items) + "\n\n"
        f"Select the {top_k} most relevant candidates (output their indices only). "
        f"Output JSON: {{\"ranked\": [0, 3, 5, ...]}} (list of indices, best first)"
    )

    try:
        resp = requests.post(
            f"{API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
            json={
                "model": "qwen3.7-max",
                "messages": [
                    {"role": "system", "content": "You are a relevance ranking assistant. Output only indices."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0,
                "max_tokens": 200,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            return candidates[:top_k]

        content = resp.json()["choices"][0]["message"]["content"]
        # Parse indices from JSON or text
        try:
            data = json.loads(content)
            indices = data.get("ranked", [])
        except Exception:
            import re
            nums = re.findall(r'\d+', content)
            indices = [int(n) for n in nums[:top_k]]

        ranked = []
        seen = set()
        for idx in indices:
            if 0 <= idx < len(candidates) and idx not in seen:
                ranked.append(candidates[idx])
                seen.add(idx)
        for i, c in enumerate(candidates):
            if i not in seen and len(ranked) < top_k:
                ranked.append(c)
        return ranked[:top_k]
    except Exception as e:
        logger.warning(f"LLM rerank failed: {e}")
        return candidates[:top_k]


# ═════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════

def _bm25_search(nc, query: str, top_k: int = 30) -> List[Dict]:
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS category, node.description AS description, score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k}
        )
        return [{"name": r["name"], "category": r.get("category", ""),
                 "description": str(r.get("description", ""))[:250],
                 "score": round(r["score"], 4)} for r in rows]
    except Exception:
        return []


def _rrf_fusion(ranked_lists: list, k: int = 60, top_k: int = 30) -> List[Dict]:
    scores: Dict[str, float] = {}
    meta: Dict[str, Dict] = {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [{**meta.get(name, {"name": name}), "score": round(rrf_score, 4)}
            for name, rrf_score in merged]


def _expand_query(nc, query: str) -> List[str]:
    variants = []
    try:
        terms = [t for t in query[:100].replace("、", " ").replace("，", " ").split() if len(t) >= 2]
        if not terms:
            return []
        for term in terms[:3]:
            rows = nc.execute_query(
                "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($t) "
                "OPTIONAL MATCH (e)-[:INHERITS_FROM|BELONG_TO]-(related:Entity) "
                "RETURN DISTINCT related.name AS related_name LIMIT 5",
                {"t": term}
            )
            for r in rows:
                rn = r.get("related_name")
                if rn and rn not in variants:
                    variants.append(rn)
    except Exception:
        pass
    return list(set(variants))[:10]


# ═════════════════════════════════════════════
# Configs
# ═════════════════════════════════════════════

class ConfigRunner:
    def __init__(self, nc, emb):
        self.nc = nc
        self.emb = emb

    def _vector(self, query: str, top_k: int = 30) -> List[Dict]:
        qv = self.emb.embed(query)
        if qv is None:
            return []
        try:
            rows = self.nc.execute_query(
                f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, node.description AS description, score "
                "ORDER BY score DESC LIMIT $k",
                {"v": qv, "k": top_k}
            )
            return [{"name": r["name"], "category": r.get("category", ""),
                     "description": str(r.get("description", ""))[:250],
                     "score": round(r["score"], 4)} for r in rows]
        except Exception:
            return []

    def config_baseline(self, query: str) -> List[str]:
        vec = self._vector(query, 30)
        bm25 = _bm25_search(self.nc, query, 30)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_rerank(self, query: str) -> List[str]:
        vec = self._vector(query, 30)
        bm25 = _bm25_search(self.nc, query, 30)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K * 2)
        reranked = _llm_rerank(query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def config_expand(self, query: str) -> List[str]:
        vec = self._vector(query, 30)
        bm25 = _bm25_search(self.nc, query, 30)
        expanded = _expand_query(self.nc, query)
        for eq in expanded[:3]:
            bm25 += _bm25_search(self.nc, eq, 5)
            vec += self._vector(eq, 5)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_full(self, query: str) -> List[str]:
        vec = self._vector(query, 30)
        bm25 = _bm25_search(self.nc, query, 30)
        expanded = _expand_query(self.nc, query)
        for eq in expanded[:3]:
            bm25 += _bm25_search(self.nc, eq, 5)
            vec += self._vector(eq, 5)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K * 2)
        reranked = _llm_rerank(query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def run(self, test_set: Dict) -> Dict:
        configs = {
            "C_baseline": self.config_baseline,
            "C_rerank": self.config_rerank,
            "C_expand": self.config_expand,
            "C_full": self.config_full,
        }
        total_q = sum(len(v.get("questions", [])) for v in test_set.values())
        processed = 0

        for paper_name, data in test_set.items():
            questions = data.get("questions", [])
            if not questions:
                continue
            if "lb_results" not in data:
                data["lb_results"] = {}

            for qi, qdata in enumerate(questions):
                qtext = qdata["question"]
                for cfg_name, cfg_fn in configs.items():
                    try:
                        hits = cfg_fn(qtext)
                        key = f"lb_{cfg_name}"
                        if key not in data["lb_results"]:
                            data["lb_results"][key] = []
                        while len(data["lb_results"][key]) <= qi:
                            data["lb_results"][key].append([])
                        data["lb_results"][key][qi] = hits
                    except Exception as e:
                        logger.warning(f"{cfg_name}: {str(e)[:80]}")

                processed += 1
                if processed % 50 == 0:
                    logger.info(f"  Progress: {processed}/{total_q}")
                    _save(test_set)
                time.sleep(0.2)  # rate limit

        return test_set


def _save(test_set: Dict):
    try:
        CKPT_OUT.write_text(json.dumps(
            {"test_set": test_set, "updated": datetime.now().isoformat()},
            ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def compute_metrics(test_set: Dict) -> Dict:
    configs = set()
    for data in test_set.values():
        for k in data.get("lb_results", {}):
            if k.startswith("lb_"):
                configs.add(k)
    if not configs:
        return {}

    accum = {c: {"h5": [], "h10": [], "rr": [], "ranks": []} for c in configs}
    for data in test_set.values():
        gt = set(data.get("ground_truth_entities", []))
        if not gt:
            continue
        for cfg in configs:
            lists = data["lb_results"].get(cfg, [])
            for hits in lists:
                pos = [i for i, n in enumerate(hits) if n in gt]
                f = pos[0] + 1 if pos else None
                r = 1.0 / f if f else 0.0
                accum[cfg]["h5"].append(1 if pos and min(pos) < 5 else 0)
                accum[cfg]["h10"].append(1 if bool(pos) else 0)
                accum[cfg]["rr"].append(r)
                if f:
                    accum[cfg]["ranks"].append(f)

    metrics = {}
    labels = {"lb_C_baseline": "C_baseline", "lb_C_rerank": "C_rerank",
              "lb_C_expand": "C_expand", "lb_C_full": "C_full"}
    for cfg in configs:
        a = accum[cfg]; n = len(a["h5"])
        if n == 0: continue
        label = labels.get(cfg, cfg)
        metrics[label] = {
            "n": n,
            "recall_at_5": round(sum(a["h5"]) / n, 4),
            "recall_at_10": round(sum(a["h10"]) / n, 4),
            "mrr": round(sum(a["rr"]) / n, 4),
            "zero_hit_rate": round(1 - sum(a["h10"]) / n, 4),
            "median_rank": round(sorted(a["ranks"])[len(a["ranks"]) // 2], 1) if a["ranks"] else None,
        }
    return metrics


def print_report(metrics: Dict):
    order = ["C_baseline", "C_rerank", "C_expand", "C_full"]
    print()
    print("=" * 80)
    print("  Layer 1b: Post-Upgrade Ablation (v2 Robust)")
    print("=" * 80)
    print(f"{'Config':<20} {'N':>5} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 80)
    base = metrics.get("C_baseline", {}).get("recall_at_5", 0)
    for c in order:
        if c not in metrics: continue
        m = metrics[c]; d = ""
        if c != "C_baseline" and base > 0:
            d = f" (+{(m['recall_at_5']-base)/base*100:+.1f}%)"
        print(f"{c:<20} {m['n']:>5} {m['recall_at_5']:>8.4f} {m['recall_at_10']:>8.4f} "
              f"{m['mrr']:>8.4f} {m['zero_hit_rate']*100:>9.1f}% {d}")
    print("-" * 80)


def main():
    logger.info("Layer 1b v2 starting")
    if not CKPT_INPUT.exists():
        logger.error("No test set. Run eval_retrieval.py first.")
        return

    cp = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))
    test_set = cp["test_set"]

    if CKPT_OUT.exists():
        prev = json.loads(CKPT_OUT.read_text(encoding="utf-8"))
        done_keys = set()
        for data in prev.get("test_set", {}).values():
            for k in data.get("lb_results", {}):
                done_keys.add(k)
            break
        if "lb_C_full" in done_keys:
            test_set = prev["test_set"]
            logger.info(f"Resuming from checkpoint, all configs done")
        else:
            test_set = prev.get("test_set", test_set)
            logger.info(f"Resuming; done configs: {done_keys}")

    nq = sum(len(v.get("questions", [])) for v in test_set.values())
    logger.info(f"Test set: {len(test_set)} papers, {nq} queries")

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()

    runner = ConfigRunner(nc, emb)
    test_set = runner.run(test_set)
    _save(test_set)

    metrics = compute_metrics(test_set)
    print_report(metrics)

    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "papers": len(test_set), "queries": nq,
        "metrics": metrics,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
