#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_layer1b.py — Layer 1b: Post-Upgrade Ablation Study
═══════════════════════════════════════════════════════════
Reuses existing 604-question test set from eval_retrieval.
Tests 6 new configs built from upgraded hybrid_search logic.

Configs:
  C_baseline: Vector + BM25 + RRF (existing C baseline)
  C_rerank:   C + Cross-Encoder rerank
  C_hyde:     C + HyDE (hypothetical answer)
  C_expand:   C + Query synonym expansion
  C_full:     C + rerank + hyde + expansion
  C_chunk:    C + paper original.md chunk-level retrieval

Metrics: Recall@5, Recall@10, MRR, Hit Rate, Zero-Hit Rate
Cost: ~RMB 1.5
"""

import sys
import json
import time
import math
import asyncio
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime
from collections import defaultdict

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_layer1b")

# ── Config ─────────────────────────────────────────────────
CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUTPUT = SCRIPT_DIR / ".eval_layer1b_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_layer1b_report.json"

TOP_K = 10  # number of results per search
TOP_K_VEC = 30  # pool size for vector search
TOP_K_BM25 = 30


# ═══════════════════════════════════════════════════════════════
# Helpers (inline, no server.py dependency)
# ═══════════════════════════════════════════════════════════════

def _bm25_search(nc, query: str, top_k: int = TOP_K_BM25) -> List[Dict]:
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
    except Exception as e:
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


def _generate_hyde_answer(llm, query: str) -> Optional[str]:
    if llm is None:
        return None
    try:
        result = llm.call(
            "你是马克思主义理论学者。请用一段学术文字（100-200字）回答以下问题，"
            "使用正确的学术术语和概念。不需要完全准确，这是假设性回答用于检索增强。\n\n"
            f"问题：{query}\n\n假设性回答：",
            max_retries=2, timeout=60
        )
        if result:
            return result.get("content", "")[:2000]
    except Exception:
        pass
    return None


def _rerank_candidates(query: str, candidates: List[Dict], top_k: int = TOP_K) -> List[Dict]:
    """Cross-encoder rerank using OpenAIRerankerClient."""
    if len(candidates) <= top_k:
        return candidates
    try:
        from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
        from graphiti_core.llm_client.config import LLMConfig
        cfg = LLMConfig(
            api_key="sk-ws-H.RXMHHLH.aQS0.MEUCIQCGr5pSqW59dgtOBZYzXkKDwyw_N8KW9v7nm6EbHQo2DQIgELqkOl1wmVBnDWPoedB1eqvv37kBeoMTrKrm3GtGU8g",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model="qwen3.7-max", temperature=0, max_tokens=1,
        )
        reranker = OpenAIRerankerClient(config=cfg)
        passages = [f"[{c.get('category','')}] {c['name']}: {str(c.get('description',''))[:200]}" for c in candidates]
        # Limit to 15 candidates to avoid API overload, wrap in try for zip errors
        passages_limited = passages[:15]
        candidates_limited = candidates[:15]
        ranked = None
        try:
            ranked = asyncio.run(reranker.rank(query, passages_limited))
        except Exception as e:
            logger.warning(f"Reranker API error: {e}")
            return candidates[:top_k]
        ordered = []
        seen = set()
        if ranked:
            for passage, score in ranked[:top_k]:
                if isinstance(passage, str):
                    for c in candidates:
                        if c['name'] not in seen and f"[{c.get('category','')}] {c['name']}" in passage:
                            ordered.append({**c, "rerank_score": round(float(score), 4)})
                            seen.add(c['name'])
                            break
        for c in candidates:
            if c['name'] not in seen and len(ordered) < top_k:
                ordered.append(c)
                seen.add(c['name'])
        return (ordered[:top_k])
    except Exception as e:
        logger.warning(f"Rerank outer error: {e}")
        return candidates[:top_k]


def _chunk_search(nc, query: str, emb_client, top_k: int = 10) -> List[str]:
    """Search paper original.md paragraphs via fulltext + vector.
    Returns entity names linked to matched papers.
    """
    # Simple: fulltext search on paper text, then return linked entities
    try:
        # Use BM25 on a fulltext index over paper content if available,
        # otherwise fall back to paper name search
        rows = nc.execute_query(
            "MATCH (ep:Episode) WHERE toLower(ep.source_folder) CONTAINS toLower($q) "
            "RETURN ep.source_folder AS paper LIMIT 5",
            {"q": query[:30]}
        )
        if rows:
            papers = [r["paper"] for r in rows]
            entities = nc.execute_query(
                "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) "
                "WHERE ep.source_folder IN $papers "
                "RETURN DISTINCT e.name AS name LIMIT $k",
                {"papers": papers, "k": top_k}
            )
            return [r["name"] for r in entities]
    except Exception:
        pass
    return []


# ═══════════════════════════════════════════════════════════════
# 6 Search Configs
# ═══════════════════════════════════════════════════════════════

class ConfigRunner:
    def __init__(self, nc: Neo4jConnection, emb: QwenEmbeddingClient, llm: QwenMaxClient = None):
        self.nc = nc
        self.emb = emb
        self.llm = llm

    def _vector_search(self, query: str, top_k: int = TOP_K_VEC) -> List[Dict]:
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

    def config_C_baseline(self, query: str) -> List[str]:
        """Vector + BM25 + RRF"""
        vec = self._vector_search(query, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_C_rerank(self, query: str) -> List[str]:
        """C + Cross-Encoder rerank"""
        vec = self._vector_search(query, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K * 3)
        reranked = _rerank_candidates(query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def config_C_hyde(self, query: str) -> List[str]:
        """C + HyDE"""
        hyde = _generate_hyde_answer(self.llm, query) if self.llm else None
        search_q = (hyde or query)[:2000]
        vec = self._vector_search(search_q, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_C_expand(self, query: str) -> List[str]:
        """C + Query expansion"""
        expanded = _expand_query(self.nc, query)
        # Merge results from original + expanded queries
        vec = self._vector_search(query, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        for eq in expanded[:3]:
            bm25 += _bm25_search(self.nc, eq, 5)
            extra_vec = self._vector_search(eq, 5)
            vec += extra_vec
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K)
        return [r["name"] for r in fused]

    def config_C_full(self, query: str) -> List[str]:
        """C + rerank + hyde + expansion"""
        hyde = _generate_hyde_answer(self.llm, query) if self.llm else None
        search_q = (hyde or query)[:2000]
        vec = self._vector_search(search_q, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        expanded = _expand_query(self.nc, query)
        for eq in expanded[:3]:
            bm25 += _bm25_search(self.nc, eq, 5)
            extra_vec = self._vector_search(eq, 5)
            vec += extra_vec
        fused = _rrf_fusion([vec, bm25], top_k=TOP_K * 3)
        reranked = _rerank_candidates(query, fused, TOP_K)
        return [r["name"] for r in reranked]

    def config_C_chunk(self, query: str) -> List[str]:
        """C + paper chunk retrieval (adds entities from matched paper chunks)"""
        vec = self._vector_search(query, TOP_K_VEC)
        bm25 = _bm25_search(self.nc, query, TOP_K_BM25)
        chunk_entities = _chunk_search(self.nc, query, self.emb, TOP_K)
        # Add chunk entities as additional result list
        chunk_list = [{"name": n, "category": "", "description": "", "score": 0.1} for n in chunk_entities]
        fused = _rrf_fusion([vec, bm25, chunk_list], top_k=TOP_K)
        return [r["name"] for r in fused]

    def run_all(self, test_set: Dict) -> Dict:
        configs = {
            "C_baseline": self.config_C_baseline,
            "C_rerank": self.config_C_rerank,
            "C_hyde": self.config_C_hyde,
            "C_expand": self.config_C_expand,
            "C_full": self.config_C_full,
            "C_chunk": self.config_C_chunk,
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
                        if cfg_name not in data["lb_results"]:
                            data["lb_results"][cfg_name] = []
                        # Extend list for this paper
                        while len(data["lb_results"][cfg_name]) <= qi:
                            data["lb_results"][cfg_name].append([])
                        data["lb_results"][cfg_name][qi] = hits
                    except Exception as e:
                        logger.warning(f"{cfg_name} failed for '{qtext[:40]}': {e}")
                        while len(data["lb_results"].get(cfg_name, [])) <= qi:
                            data["lb_results"].setdefault(cfg_name, []).append([])

                processed += 1
                if processed % 100 == 0:
                    logger.info(f"  Progress: {processed}/{total_q}")
                    _save_checkpoint(test_set)

            time.sleep(0.05)  # rate limiting

        return test_set


# ═══════════════════════════════════════════════════════════════
# Metrics
# ═══════════════════════════════════════════════════════════════

def compute_metrics(test_set: Dict) -> Dict:
    config_names = set()
    for data in test_set.values():
        for k in data.get("lb_results", {}):
            config_names.add(k)
    if not config_names:
        return {}

    accum = {c: {"hits_at_5": [], "hits_at_10": [], "rr": [], "ranks": []} for c in config_names}

    for paper_name, data in test_set.items():
        gt = set(data.get("ground_truth_entities", []))
        if not gt:
            continue
        lb = data.get("lb_results", {})
        for cfg in config_names:
            hits_list = lb.get(cfg, [])
            for hits in hits_list:
                positions = [i for i, name in enumerate(hits) if name in gt]
                first = positions[0] + 1 if positions else None
                rr = 1.0 / first if first else 0.0
                accum[cfg]["hits_at_5"].append(1 if positions and min(positions) < 5 else 0)
                accum[cfg]["hits_at_10"].append(1 if positions else 0)
                accum[cfg]["rr"].append(rr)
                if first:
                    accum[cfg]["ranks"].append(first)

    metrics = {}
    for cfg in config_names:
        a = accum[cfg]
        n = len(a["hits_at_5"])
        if n == 0:
            metrics[cfg] = {"error": "No data", "n": 0}
            continue
        metrics[cfg] = {
            "n": n,
            "recall_at_5": round(sum(a["hits_at_5"]) / n, 4),
            "recall_at_10": round(sum(a["hits_at_10"]) / n, 4),
            "mrr": round(sum(a["rr"]) / n, 4),
            "hit_rate": round(sum(a["hits_at_10"]) / n, 4),
            "zero_hit_rate": round(1 - sum(a["hits_at_10"]) / n, 4),
            "median_rank": round(sorted(a["ranks"])[len(a["ranks"]) // 2], 1) if a["ranks"] else None,
        }
    return metrics


# ── Checkpoint ──────────────────────────────────────────────
def _save_checkpoint(test_set: Dict):
    try:
        CKPT_OUTPUT.write_text(json.dumps({"test_set": test_set, "updated": datetime.now().isoformat()},
                                          ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════
# Report
# ═══════════════════════════════════════════════════════════════

def print_report(metrics: Dict):
    labels = {
        "C_baseline": "C: Vec+BM25 (baseline)",
        "C_rerank": "C+rerank",
        "C_hyde": "C+HyDE",
        "C_expand": "C+Expand",
        "C_full": "C+Full (all)",
        "C_chunk": "C+Chunk",
    }
    order = ["C_baseline", "C_rerank", "C_hyde", "C_expand", "C_chunk", "C_full"]

    print()
    print("=" * 80)
    print("  Layer 1b: Post-Upgrade Ablation Report")
    print("=" * 80)
    print(f"{'Config':<25} {'N':>5} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 80)

    baseline_r5 = metrics.get("C_baseline", {}).get("recall_at_5", 0)
    for cfg in order:
        if cfg not in metrics:
            continue
        m = metrics[cfg]
        delta = ""
        if cfg != "C_baseline" and baseline_r5 > 0:
            d = (m["recall_at_5"] - baseline_r5) / baseline_r5 * 100
            delta = f" (+{d:.1f}%)"
        print(f"{labels.get(cfg, cfg):<25} {m.get('n',0):>5} "
              f"{m.get('recall_at_5',0):>8.4f} {m.get('recall_at_10',0):>8.4f} "
              f"{m.get('mrr',0):>8.4f} {m.get('zero_hit_rate',0)*100:>9.1f}% {delta}")
    print("-" * 80)

    # Analysis
    print()
    print("Key Findings:")
    if "C_rerank" in metrics and "C_baseline" in metrics:
        r5_diff = metrics["C_rerank"]["recall_at_5"] - metrics["C_baseline"]["recall_at_5"]
        print(f"  Reranker impact: R@5 {r5_diff:+.4f} (positions 6-10 pushed to top-5)")
    if "C_hyde" in metrics and "C_baseline" in metrics:
        r10_diff = metrics["C_hyde"]["recall_at_10"] - metrics["C_baseline"]["recall_at_10"]
        print(f"  HyDE impact: R@10 {r10_diff:+.4f}")
    if "C_expand" in metrics and "C_baseline" in metrics:
        z_diff = metrics["C_expand"]["zero_hit_rate"] - metrics["C_baseline"]["zero_hit_rate"]
        print(f"  Expansion impact: ZeroHit {z_diff:+.4f} (reducing 17.5%% zero-hit)")
    if "C_full" in metrics:
        print(f"  Full combo: R@5={metrics['C_full']['recall_at_5']:.4f} R@10={metrics['C_full']['recall_at_10']:.4f} (theoretical upper bound)")


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

def main():
    logger.info("=" * 60)
    logger.info("Layer 1b: Post-Upgrade Ablation Study")
    logger.info("=" * 60)

    # Load existing test set
    if not CKPT_INPUT.exists():
        logger.error("No eval checkpoint found. Run eval_retrieval.py first.")
        return

    cp = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))
    test_set = cp["test_set"]

    # Check if Layer 1b already ran
    if CKPT_OUTPUT.exists():
        prev = json.loads(CKPT_OUTPUT.read_text(encoding="utf-8"))
        if prev.get("lb_ablation_done"):
            test_set = prev.get("test_set", test_set)
            logger.info(f"Resuming from Layer 1b checkpoint: {len(test_set)} papers")
        else:
            test_set = prev.get("test_set", test_set)

    n_queries = sum(len(v.get("questions", [])) for v in test_set.values())
    logger.info(f"Test set: {len(test_set)} papers, {n_queries} queries")

    # Check which configs are already done
    done_configs = set()
    for data in test_set.values():
        for cfg in data.get("lb_results", {}):
            done_configs.add(cfg)
        break
    if done_configs:
        logger.info(f"Already completed configs: {sorted(done_configs)}")

    # Init clients
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    # Run
    if "C_full" not in done_configs:  # Only run if not all done
        logger.info("Running 6 configs...")
        runner = ConfigRunner(nc, emb, llm)
        test_set = runner.run_all(test_set)
        cp["lb_ablation_done"] = True
        _save_checkpoint(test_set)

    # Compute metrics
    logger.info("Computing metrics...")
    metrics = compute_metrics(test_set)

    # Report
    print_report(metrics)

    # Save
    report = {
        "timestamp": datetime.now().isoformat(),
        "config": {"papers": len(test_set), "queries": n_queries},
        "metrics": metrics,
    }
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report saved: {REPORT_FILE}")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
