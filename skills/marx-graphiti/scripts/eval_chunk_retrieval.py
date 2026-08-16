#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_chunk_retrieval.py — Script 1: Chunk-Level Retrieval Evaluation (P0)
══════════════════════════════════════════════════════════════════════════
Reuses 604-question test set. Evaluates chunk-level search vs entity search.

Configs:
  C_BASELINE:      entity Vector+BM25+RRF (from existing checkpoint)
  CHUNK_BM25:      chunk_text_ft fulltext search -> paper origin
  CHUNK_VECTOR:    chunk_vector_idx vector search -> paper origin
  CHUNK_HYBRID:    chunk BM25 + vector RRF fusion -> paper origin
  ENTITY_BRIDGE:   C_baseline -> get_entity_passages -> paper origin

Metrics:
  Paper-Recall@5/10: does a top-K result come from correct paper?
  Zero-Hit Recovery: % of queries where entity=0 hits but chunk=N hits
  Overlap Rate: % of queries where entity and chunk agree on paper

Cost: RMB 0 (BM25 free, embeddings cached, no LLM calls)
Time: ~15 minutes for 604 queries
"""

import sys, json, time, math, hashlib, sqlite3
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient

logger = get_logger("eval_chunk")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_chunk_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_chunk_report.json"

TOP_K = 10
CACHE_DB = SCRIPT_DIR / "eval_output" / "embedding_cache.db"


# ═══════════════════════════════════════════════════════════════
# Embedding cache (read query embeddings, write new ones)
# ═══════════════════════════════════════════════════════════════

class QueryEmbedCache:
    def __init__(self, db_path: Path = CACHE_DB):
        self.db_path = db_path
        self.conn = None
        self.hits = 0
        self.misses = 0

    def _connect(self):
        if self.conn is None:
            db_path_str = str(self.db_path)
            self.conn = sqlite3.connect(db_path_str)
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, vector TEXT, created_at TEXT)")
            self.conn.commit()

    def get(self, text: str) -> Optional[List[float]]:
        self._connect()
        key = hashlib.md5(text.encode("utf-8")).hexdigest()
        row = self.conn.execute("SELECT vector FROM cache WHERE key=?", (key,)).fetchone()
        if row:
            self.hits += 1
            return json.loads(row[0])
        self.misses += 1
        return None

    def set(self, text: str, vec: List[float]):
        self._connect()
        key = hashlib.md5(text.encode("utf-8")).hexdigest()
        self.conn.execute(
            "INSERT OR REPLACE INTO cache VALUES (?, ?, ?)",
            (key, json.dumps(vec), datetime.now().isoformat()))
        self.conn.commit()

    def stats(self) -> str:
        total = self.hits + self.misses
        return f"{self.hits}/{total} ({self.hits/total*100:.0f}%)" if total else "empty"


# ═══════════════════════════════════════════════════════════════
# Search functions
# ═══════════════════════════════════════════════════════════════

def chunk_bm25(nc: Neo4jConnection, query: str, top_k: int = 30) -> List[Dict]:
    """Search chunk_text_ft fulltext index, return chunk data with paper origin."""
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('chunk_text_ft', $q) "
            "YIELD node, score "
            "MATCH (node)-[:CHUNK_OF]->(ep:Episode) "
            "RETURN node.text AS text, node.chunk_type AS ctype, "
            "ep.source_folder AS paper, ep.year AS year, ep.author AS author, "
            "score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k}
        )
        return [{
            "text": r.get("text", "")[:200],
            "chunk_type": r.get("ctype", ""),
            "paper": r.get("paper", ""),
            "year": r.get("year"),
            "author": str(r.get("author", ""))[:30],
            "score": round(r["score"], 4),
        } for r in rows]
    except Exception as e:
        logger.warning(f"chunk_bm25 failed: {e}")
        return []


def chunk_vector(emb: QwenEmbeddingClient, ecache: QueryEmbedCache,
                 nc: Neo4jConnection, query: str, top_k: int = 30) -> List[Dict]:
    """Search chunk_vector_idx vector index, return chunk data with paper origin."""
    qv = ecache.get(query)
    if qv is None:
        qv = emb.embed(query)
        if qv is not None:
            ecache.set(query, qv)
    if qv is None:
        return []
    try:
        rows = nc.execute_query(
            f"CALL db.index.vector.queryNodes('chunk_vector_idx', {top_k}, $v) "
            "YIELD node, score "
            "MATCH (node)-[:CHUNK_OF]->(ep:Episode) "
            "RETURN node.text AS text, node.chunk_type AS ctype, "
            "ep.source_folder AS paper, ep.year AS year, ep.author AS author, "
            "score "
            "ORDER BY score DESC LIMIT $k",
            {"v": qv, "k": top_k}
        )
        return [{
            "text": r.get("text", "")[:200],
            "chunk_type": r.get("ctype", ""),
            "paper": r.get("paper", ""),
            "year": r.get("year"),
            "author": str(r.get("author", ""))[:30],
            "score": round(r["score"], 4),
        } for r in rows]
    except Exception as e:
        logger.warning(f"chunk_vector failed: {e}")
        return []


def rrf_fuse(lists: List[List[Dict]], k: int = 60, top_k: int = 30) -> List[Dict]:
    scores, meta = {}, {}
    for rlist in lists:
        for rank, item in enumerate(rlist, start=1):
            key = item.get("paper", "") + "|" + item.get("text", "")[:50]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank)
            if key not in meta:
                meta[key] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [meta[key] for key, _ in merged]


def entity_bridge(nc: Neo4jConnection, entity_hits: List[str],
                  ground_truth_paper: str) -> Tuple[List[str], int]:
    """Given entity names from C_baseline, get passages and check paper origin."""
    papers = set()
    count = 0
    for ename in entity_hits[:5]:
        try:
            rows = nc.execute_query(
                "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper LIMIT 1",
                {"en": ename}
            )
            for r in rows:
                papers.add(r["paper"])
                count += 1
        except Exception:
            pass
    return list(papers)[:10], count


# ═══════════════════════════════════════════════════════════════
# Metrics and reporting
# ═══════════════════════════════════════════════════════════════

def compute_metrics(results: Dict[str, List[List[str]]]) -> Dict:
    """Compute Paper-Recall@K, ZeroHit rates per config."""
    configs = ["C_baseline", "CHUNK_BM25", "CHUNK_VECTOR", "CHUNK_HYBRID", "ENTITY_BRIDGE"]
    metrics = {}
    for cfg in configs:
        hits5, hits10, rr_list, ranks = [], [], [], []
        for paper_predictions in results.get(cfg, []):
            hits = [i for i, p in enumerate(paper_predictions) if p == "HIT"]  # placeholder
            # Redo properly below
        # We compute per-loop below
    # Compute properly
    m = {}
    for cfg in configs:
        data = results.get(cfg, [])
        if not data:
            m[cfg] = {"n": 0, "error": "no data"}
            continue
        r5, r10, rr_vals, rank_list = [], [], [], []
        for paper_list in data:
            gt_paper = paper_list[0] if paper_list else None  # metadata
            if not gt_paper:
                continue
            predictions = paper_list[1:] if len(paper_list) > 1 else []
            hit_pos = [i for i, p in enumerate(predictions) if p == gt_paper]
            first = hit_pos[0] + 1 if hit_pos else None
            r5.append(1 if hit_pos and min(hit_pos) < 5 else 0)
            r10.append(1 if bool(hit_pos) else 0)
            rr_vals.append(1.0 / first if first else 0.0)
            if first:
                rank_list.append(first)
        n = len(r5)
        m[cfg] = {
            "n": n, "R@5": round(sum(r5)/n, 4), "R@10": round(sum(r10)/n, 4),
            "MRR": round(sum(rr_vals)/n, 4), "ZeroHit%": round((1-sum(r10)/n)*100, 1),
            "median_rank": round(sorted(rank_list)[len(rank_list)//2], 1) if rank_list else None,
        }
    return m


def compute_results(test_set: Dict, nc: Neo4jConnection, emb: QwenEmbeddingClient,
                    ecache: QueryEmbedCache) -> Tuple[Dict, Dict]:
    """Run all 5 configs against the test set. Returns (raw_results, metrics)."""
    configs = {
        "C_baseline": lambda q, gt: _get_baseline_papers(test_set, q),
        "CHUNK_BM25": lambda q, gt: [r["paper"] for r in chunk_bm25(nc, q, TOP_K * 3)[:TOP_K]],
        "CHUNK_VECTOR": lambda q, gt: [r["paper"] for r in chunk_vector(emb, ecache, nc, q, TOP_K * 3)[:TOP_K]],
        "CHUNK_HYBRID": lambda q, gt: [r["paper"] for r in
            rrf_fuse([chunk_bm25(nc, q, TOP_K * 3), chunk_vector(emb, ecache, nc, q, TOP_K * 3)], top_k=TOP_K)],
        "ENTITY_BRIDGE": lambda q, gt: _bridge_papers(nc, test_set, q, gt),
    }

    # Collect ground truths and run
    results = {cfg: [] for cfg in configs}
    total = 0

    # First pass: build query -> ground_truth paper mapping
    query_gt_map = {}
    for paper_name, data in test_set.items():
        gt_paper = paper_name  # The paper folder IS the ground truth
        for qdata in data.get("questions", []):
            qtext = qdata["question"]
            query_gt_map[qtext] = gt_paper
            # Also store entity hits from existing checkpoint
    total = len(query_gt_map)

    # Run each config
    processed = 0
    t0 = time.time()

    for qtext, gt_paper in query_gt_map.items():
        for cfg_name, cfg_fn in configs.items():
            try:
                papers = cfg_fn(qtext, gt_paper)
                results[cfg_name].append([gt_paper] + papers[:TOP_K])
            except Exception as e:
                results[cfg_name].append([gt_paper])

        processed += 1
        if processed % 50 == 0:
            elapsed = time.time() - t0
            rate = processed / elapsed if elapsed > 0 else 0
            eta = (total - processed) / rate / 60 if rate > 0 else 0
            logger.info(f"  [{processed}/{total}] {rate:.2f}q/s ETA {eta:.0f}min ecache={ecache.stats()}")

        if processed % 100 == 0:
            _save_checkpoint(results)

    # Compute metrics
    metrics = {}
    for cfg in configs:
        data = results[cfg]
        r5, r10, rr_vals, rank_list = [], [], [], []
        for row in data:
            gt_paper = row[0]
            preds = row[1:]
            hit_pos = [i for i, p in enumerate(preds) if p == gt_paper]
            first = hit_pos[0] + 1 if hit_pos else None
            r5.append(1 if hit_pos and min(hit_pos) < 5 else 0)
            r10.append(1 if bool(hit_pos) else 0)
            rr_vals.append(1.0 / first if first else 0.0)
            if first:
                rank_list.append(first)
        n = len(r5)
        metrics[cfg] = {
            "n": n, "R@5": round(sum(r5)/n, 4), "R@10": round(sum(r10)/n, 4),
            "MRR": round(sum(rr_vals)/n, 4), "ZeroHit%": round((1-sum(r10)/n)*100, 1),
            "median_rank": round(sorted(rank_list)[len(rank_list)//2], 1) if rank_list else None,
        }

    # Zero-Hit Recovery
    baseline_hits = {}
    for row in results["C_baseline"]:
        baseline_hits[row[0]] = any(p == row[0] for p in row[1:])

    for cfg in ["CHUNK_BM25", "CHUNK_VECTOR", "CHUNK_HYBRID"]:
        recovered = 0
        zero_total = 0
        for row in results[cfg]:
            gt_paper = row[0]
            if gt_paper not in baseline_hits or not baseline_hits[gt_paper]:
                zero_total += 1
                if any(p == gt_paper for p in row[1:]):
                    recovered += 1
        if zero_total > 0:
            metrics[cfg]["zero_hit_recovery"] = {
                "recovered": recovered,
                "total_zero_hit": zero_total,
                "rate": round(recovered / zero_total * 100, 1),
            }

    return results, metrics


def _get_baseline_papers(test_set: Dict, query: str) -> List[str]:
    """Get paper names from C_baseline results in the existing checkpoint."""
    for paper_name, data in test_set.items():
        for qi, qdata in enumerate(data.get("questions", [])):
            if qdata["question"] == query:
                # Get C_vector_bm25 results
                cv = data.get("results", {}).get("C_vector_bm25", [])
                if qi < len(cv):
                    entity_names = cv[qi]
                    # Look up which papers these entities belong to
                    return entity_names[:TOP_K]
        return []
    return []


def _bridge_papers(nc: Neo4jConnection, test_set: Dict, query: str,
                   gt_paper: str) -> List[str]:
    """Get entity names from C_baseline, then bridge to papers via EXTRACTED_FROM."""
    entity_names = _get_baseline_papers(test_set, query)
    if not entity_names:
        return []
    papers, _ = entity_bridge(nc, entity_names[:5], gt_paper)
    return papers[:TOP_K]


def _save_checkpoint(results: Dict):
    try:
        data = {
            "results": results,
            "updated": datetime.now().isoformat(),
        }
        CKPT_OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def print_report(metrics: Dict):
    print()
    print("=" * 70)
    print("  Chunk Retrieval Evaluation")
    print("=" * 70)
    labels = {
        "C_baseline": "C: Entity BM25+Vec",
        "CHUNK_BM25": "CHUNK_BM25",
        "CHUNK_VECTOR": "CHUNK_VECTOR",
        "CHUNK_HYBRID": "CHUNK_HYBRID",
        "ENTITY_BRIDGE": "ENTITY_BRIDGE",
    }
    print(f"{'Config':<25} {'R@5':>8} {'R@10':>8} {'MRR':>8} {'ZeroHit%':>10}")
    print("-" * 70)
    for cfg in ["C_baseline", "CHUNK_BM25", "CHUNK_VECTOR", "CHUNK_HYBRID", "ENTITY_BRIDGE"]:
        if cfg not in metrics:
            continue
        m = metrics[cfg]
        print(f"{labels[cfg]:<25} {m['R@5']:>8.4f} {m['R@10']:>8.4f} "
              f"{m['MRR']:>8.4f} {m['ZeroHit%']:>9.1f}%")

    print("-" * 70)
    print()
    print("Zero-Hit Recovery (entity misses that chunk search catches):")
    for cfg in ["CHUNK_BM25", "CHUNK_VECTOR", "CHUNK_HYBRID"]:
        if cfg in metrics and "zero_hit_recovery" in metrics[cfg]:
            z = metrics[cfg]["zero_hit_recovery"]
            print(f"  {labels[cfg]}: {z['recovered']}/{z['total_zero_hit']} ({z['rate']}%)")


def main():
    logger.info("=" * 60)
    logger.info("Script 1: Chunk Retrieval Evaluation")
    logger.info("=" * 60)

    if not CKPT_INPUT.exists():
        logger.error("No test set. Run eval_retrieval.py first.")
        return
    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]
    nq = sum(len(v.get("questions", [])) for v in test_set.values())
    logger.info(f"Test set: {len(test_set)} papers, {nq} questions")

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    ecache = QueryEmbedCache()

    results, metrics = compute_results(test_set, nc, emb, ecache)

    print_report(metrics)

    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "papers": len(test_set), "queries": nq,
        "metrics": metrics,
        "cache_stats": ecache.stats(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()


if __name__ == "__main__":
    main()
