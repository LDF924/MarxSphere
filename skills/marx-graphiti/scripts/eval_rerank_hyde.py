#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_rerank_hyde.py — Cross-Encoder Rerank + HyDE Ablation
===========================================================
Reuses 604-question test set. Uses pipeline's QwenMaxClient (rate-limited, retry).
Tests 4 configs:

  C:      Vector + BM25 + RRF (baseline)
  C+RR:   C + Cross-Encoder rerank
  C+HD:   C + HyDE hypothesis answer for vector search
  C+ALL:  C + rerank + HyDE

Metrics: Recall@5, Recall@10, MRR, Zero-Hit Rate

Cost estimate:
  - Rerank: 604 queries x 1 LLM rerank call = ~RMB 0.5
  - HyDE:   604 queries x 1 LLM hyde call = ~RMB 0.5
  - Total: ~RMB 1
  - Time: ~30 min (QPS=2, 604 x 2 LLM calls = ~1208 calls, ~2/s = 10 min + embedding overhead)
"""

import sys, json, time
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Optional

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_rr_hd")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_rr_hd_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_rerank_hyde_report.json"

TOP_K = 10


# ════════════════════════════════════════
# Helpers
# ════════════════════════════════════════

def _bm25(nc, query: str, top_k: int = 30) -> List[Dict]:
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


def _rrf(ranked_lists: list, k: int = 60, top_k: int = 30) -> List[Dict]:
    scores, meta = {}, {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [{**meta.get(name, {"name": name}), "score": round(rrf_score, 4)}
            for name, rrf_score in merged]


def _rerank(llm: QwenMaxClient, query: str, candidates: List[Dict], top_k: int = 10) -> List[Dict]:
    """LLM listwise rerank: pick top-K indices from candidates."""
    if len(candidates) <= top_k:
        return candidates

    items = [f"[{i}] {c.get('category','')}|{c['name']}|{str(c.get('description',''))[:120]}"
             for i, c in enumerate(candidates[:15])]

    prompt = (
        f"Query: {query}\n\nCandidates:\n" + "\n".join(items) + "\n\n"
        f"Select the {top_k} most relevant candidates. Output JSON: "
        f'{{"ranked": [0, 3, 5, ...]}} (best indices first)'
    )

    result = llm.call(prompt, max_retries=3, timeout=60,
                      system_prompt="Rank candidates by relevance. Output only JSON.")
    if result is None:
        return candidates[:top_k]

    content = result.get("content", "")
    try:
        data = json.loads(content)
        indices = data.get("ranked", [])
    except Exception:
        import re
        indices = [int(n) for n in re.findall(r'\d+', content)[:top_k]]

    ranked, seen = [], set()
    for idx in indices:
        if 0 <= idx < len(candidates) and idx not in seen:
            ranked.append(candidates[idx])
            seen.add(idx)
    for i, c in enumerate(candidates):
        if i not in seen and len(ranked) < top_k:
            ranked.append(c)
    return ranked[:top_k]


def _hyde(llm: QwenMaxClient, query: str) -> Optional[str]:
    """Generate hypothetical academic answer."""
    result = llm.call(
        "你是马克思主义理论学者。请用一段学术文字（100-200字）回答问题，"
        "使用正确的学术术语。这是假设性回答，用于增强检索，不需要完全准确。\n\n"
        f"问题：{query}\n\n假设性回答：",
        max_retries=2, timeout=60
    )
    if result:
        return result.get("content", "")[:2000]
    return None


# ════════════════════════════════════════
# Runner
# ════════════════════════════════════════

class Runner:
    def __init__(self, nc, emb, llm):
        self.nc = nc
        self.emb = emb
        self.llm = llm

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

    def config_C(self, query: str) -> List[str]:
        """Baseline: Vector + BM25"""
        vec = self._vector(query)
        bm25 = _bm25(self.nc, query)
        fused = _rrf([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_C_RR(self, query: str) -> List[str]:
        """C + Rerank"""
        vec = self._vector(query)
        bm25 = _bm25(self.nc, query)
        fused = _rrf([vec, bm25], top_k=TOP_K * 2)
        reranked = _rerank(self.llm, query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def config_C_HD(self, query: str) -> List[str]:
        """C + HyDE"""
        hyde_text = _hyde(self.llm, query)
        search_q = (hyde_text or query)[:2000]
        vec = self._vector(search_q)
        bm25 = _bm25(self.nc, query)  # BM25 on original query
        fused = _rrf([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_C_ALL(self, query: str) -> List[str]:
        """C + Rerank + HyDE"""
        hyde_text = _hyde(self.llm, query)
        search_q = (hyde_text or query)[:2000]
        vec = self._vector(search_q)
        bm25 = _bm25(self.nc, query)
        fused = _rrf([vec, bm25], top_k=TOP_K * 2)
        reranked = _rerank(self.llm, query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def run(self, test_set: Dict) -> Dict:
        configs = {
            "C": self.config_C,
            "C_RR": self.config_C_RR,
            "C_HD": self.config_C_HD,
            "C_ALL": self.config_C_ALL,
        }
        total_q = sum(len(v.get("questions", [])) for v in test_set.values())
        processed = 0

        for paper_name, data in test_set.items():
            questions = data.get("questions", [])
            if not questions:
                continue
            data["rr_hd_results"] = data.get("rr_hd_results", {})

            for qi, qdata in enumerate(questions):
                qtext = qdata["question"]
                for cfg_name, cfg_fn in configs.items():
                    try:
                        hits = cfg_fn(qtext)
                        data["rr_hd_results"].setdefault(cfg_name, [])
                        while len(data["rr_hd_results"][cfg_name]) <= qi:
                            data["rr_hd_results"][cfg_name].append([])
                        data["rr_hd_results"][cfg_name][qi] = hits
                    except Exception as e:
                        logger.warning(f"{cfg_name}: {str(e)[:80]}")

                processed += 1
                if processed % 50 == 0:
                    logger.info(f"  Progress: {processed}/{total_q}")
                    _save(test_set)

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
        for k in data.get("rr_hd_results", {}):
            configs.add(k)
    if not configs:
        return {}

    accum = {c: {"h5": [], "h10": [], "rr": [], "ranks": []} for c in configs}
    for data in test_set.values():
        gt = set(data.get("ground_truth_entities", []))
        if not gt:
            continue
        for cfg in configs:
            lists = data["rr_hd_results"].get(cfg, [])
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
    for cfg in configs:
        a = accum[cfg]; n = len(a["h5"])
        if n == 0: continue
        metrics[cfg] = {
            "n": n,
            "recall_at_5": round(sum(a["h5"]) / n, 4),
            "recall_at_10": round(sum(a["h10"]) / n, 4),
            "mrr": round(sum(a["rr"]) / n, 4),
            "zero_hit_rate": round(1 - sum(a["h10"]) / n, 4),
        }
    return metrics


def print_report(metrics: Dict):
    labels = {"C": "C: Vec+BM25", "C_RR": "C+Rerank", "C_HD": "C+HyDE", "C_ALL": "C+All"}
    print()
    print("=" * 70)
    print("  Rerank + HyDE Ablation Report")
    print("=" * 70)
    print(f"  Queries: {metrics.get('C',{}).get('n','?')}")
    print(f"{'Config':<20} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 60)
    for cfg in ["C", "C_RR", "C_HD", "C_ALL"]:
        if cfg not in metrics: continue
        m = metrics[cfg]
        print(f"{labels[cfg]:<20} {m['recall_at_5']:>8.4f} {m['recall_at_10']:>8.4f} "
              f"{m['mrr']:>8.4f} {m['zero_hit_rate']*100:>9.1f}%")
    print("-" * 60)


def main():
    logger.info("Rerank + HyDE ablation starting")

    cp = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))
    test_set = cp["test_set"]
    nq = sum(len(v.get("questions", [])) for v in test_set.values())
    logger.info(f"Test set: {len(test_set)} papers, {nq} queries")

    # Resume
    if CKPT_OUT.exists():
        prev = json.loads(CKPT_OUT.read_text(encoding="utf-8"))
        done = set()
        for data in prev.get("test_set", {}).values():
            for k in data.get("rr_hd_results", {}):
                done.add(k)
            break
        if "C_ALL" in done:
            logger.info("All configs already done, computing report...")
        else:
            test_set = prev.get("test_set", test_set)
            logger.info(f"Resuming; done: {done}")

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    runner = Runner(nc, emb, llm)
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


if __name__ == "__main__":
    main()
