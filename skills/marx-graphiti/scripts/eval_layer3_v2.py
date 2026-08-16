#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_layer3_v2.py — Layer 3: End-to-End RAG Quality (LLM-as-Judge) — ROBUST VERSION

Fixes:
  - Merged judge: single LLM call per query (generation + judging in one pass)
  - 3s delay between queries to avoid rate limiting
  - Checkpoint after every 5 queries
  - Self-contained LLM reranker (no graphiti dependency)
  - batch_size=5 parallel windows with cooldown

Cost: ~RMB 1.5 (50 queries x 1 combined LLM call)
"""

import sys, json, time, random, requests
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient

logger = get_logger("eval_l3_v2")

REPORT_FILE = SCRIPT_DIR / "eval_layer3_report.json"
CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_l3_v2_checkpoint.json"

SAMPLE_SIZE = 50
TOP_K = 5
API_KEY = "sk-ws-H.RXMHHLH.aQS0.MEUCIQCGr5pSqW59dgtOBZYzXkKDwyw_N8KW9v7nm6EbHQo2DQIgELqkOl1wmVBnDWPoedB1eqvv37kBeoMTrKrm3GtGU8g"
API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen3.7-max"
COOLDOWN = 3  # seconds between queries


def chat(messages: List[Dict], max_tokens: int = 4096, temperature: float = 0.3, timeout: int = 120) -> Optional[str]:
    """Single synchronous chat call."""
    try:
        resp = requests.post(
            f"{API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
            json={"model": MODEL, "messages": messages, "temperature": temperature, "max_tokens": max_tokens},
            timeout=timeout,
        )
        if resp.status_code != 200:
            return None
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        logger.warning(f"Chat failed: {e}")
        return None


# ════════════════════════════════════════
# Helpers
# ════════════════════════════════════════

def _bm25_search(nc, query: str, top_k: int = 20) -> List[Dict]:
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


def _rrf_fusion(ranked_lists: list, k: int = 60, top_k: int = 20) -> List[Dict]:
    scores = {}; meta = {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [{**meta.get(name, {"name": name}), "score": round(rrf_score, 4)}
            for name, rrf_score in merged]


def retrieve(nc, emb, query: str, top_k: int = TOP_K) -> Dict:
    """Vector + BM25 -> RRF -> top-K entities + distill + neighbors."""
    qv = emb.embed(query)
    vec_results = []
    if qv:
        try:
            rows = nc.execute_query(
                "CALL db.index.vector.queryNodes('entity_vector_idx', 20, $v) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, node.description AS description, score "
                "ORDER BY score DESC LIMIT 15",
                {"v": qv, "k": 15}
            )
            vec_results = [{"name": r["name"], "category": r.get("category", ""),
                            "description": str(r.get("description", ""))[:250],
                            "score": round(r["score"], 4)} for r in rows]
        except Exception:
            pass
    bm25_results = _bm25_search(nc, query, 15)
    fused = _rrf_fusion([vec_results, bm25_results], top_k=top_k * 2)

    # LLM rerank
    items = [f"[{i}] {e['category']} | {e['name']} | {e['description'][:100]}" for i, e in enumerate(fused[:15])]
    prompt = (
        f"Query: {query}\n\nCandidates:\n" + "\n".join(items) + f"\n\nSelect {top_k} best indices. "
        'Output JSON: {"ranked": [0,3,5,...]}'
    )
    ranked = fused[:top_k]
    try:
        resp = requests.post(
            f"{API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
            json={
                "model": MODEL, "temperature": 0, "max_tokens": 100,
                "messages": [{"role": "system", "content": "Rank candidates by relevance."},
                             {"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            try:
                data = json.loads(content)
                indices = data.get("ranked", [])
            except Exception:
                import re
                indices = [int(n) for n in re.findall(r'\d+', content)[:top_k]]
            ranked = [fused[i] for i in indices if 0 <= i < len(fused)][:top_k]
    except Exception:
        pass

    # Enrich top-K
    enriched = []
    for e in ranked[:top_k]:
        entry = {**e, "distill_layers": None, "neighbors": [], "papers": []}
        name = e["name"]
        try:
            ds = nc.execute_query(
                "MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(en:Entity {name: $n}) "
                "RETURN ld.core_concept_definition AS cd LIMIT 1",
                {"n": name}
            )
            if ds:
                entry["distill_layers"] = {"core": str(ds[0].get("cd", ""))[:300]}
        except Exception:
            pass
        try:
            rels = nc.execute_query(
                "MATCH (en:Entity {name: $n})-[r]-(other:Entity) WHERE type(r) <> 'EXTRACTED_FROM' "
                "RETURN type(r) AS rel, other.name AS target LIMIT 5",
                {"n": name}
            )
            entry["neighbors"] = [f"{r['rel']} -> {r['target']}" for r in rels]
        except Exception:
            pass
        try:
            eps = nc.execute_query(
                "MATCH (en:Entity {name: $n})-[:EXTRACTED_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper LIMIT 2",
                {"n": name}
            )
            entry["papers"] = [e["paper"] for e in eps]
        except Exception:
            pass
        enriched.append(entry)
    return {"entities": enriched}


# ════════════════════════════════════════
# Unified generate+judge (single LLM call)
# ════════════════════════════════════════

def generate_and_judge(query: str, context: Dict) -> Optional[Dict]:
    """Single LLM call: generate answer + self-judge on 4 dimensions."""

    # Build context text
    ctx_text = ""
    for i, e in enumerate(context.get("entities", []), 1):
        ctx_text += f"[{i}] {e['category']} | {e['name']}: {e['description'][:150]}\n"
        if e.get("distill_layers") and e["distill_layers"].get("core"):
            ctx_text += f"    Concept: {e['distill_layers']['core'][:200]}\n"
        if e.get("papers"):
            ctx_text += f"    Source: {', '.join(e['papers'][:2])}\n"

    prompt = f"""你是马克思主义理论学术专家。请完成两项任务：

## 任务1：生成回答
基于以下检索上下文，回答问题（200-400字学术中文）。

查询：{query}

检索上下文：
{ctx_text[:4000]}

## 任务2：自我评估
对你的回答从以下4个维度评分（1-5分），并给出每项一句话理由：
- faithfulness：是否严格基于检索上下文，无幻觉？
- relevance：是否直接回应查询？
- completeness：是否覆盖上下文中关键要点？
- attribution：每个主张能否追溯到具体实体/论文？

输出JSON格式：
{{"answer": "...", "scores": {{"faithfulness": 4, "relevance": 5, "completeness": 3, "attribution": 4}}, "justification": {{"faithfulness": "...", "relevance": "...", "completeness": "...", "attribution": "..."}}, "overall_feedback": "50字以内总体评价"}}"""

    content = chat([
        {"role": "system", "content": "你是马克思主义理论的学术专家和评审专家。输出严格JSON。"},
        {"role": "user", "content": prompt}
    ], max_tokens=3000, temperature=0.3)

    if content is None:
        return None

    # Parse JSON
    try:
        return json.loads(content)
    except Exception:
        import re
        cleaned = re.sub(r'^```(?:json)?\s*', '', content)
        cleaned = re.sub(r'\s*```$', '', cleaned)
        try:
            return json.loads(cleaned)
        except Exception:
            return None


def print_report(results: List[Dict]):
    scores = {"faithfulness": [], "relevance": [], "completeness": [], "attribution": []}
    for r in results:
        s = r.get("scores", {})
        for dim in scores:
            if s.get(dim):
                scores[dim].append(s[dim])

    print()
    print("=" * 80)
    print("  Layer 3: End-to-End RAG Quality (LLM-as-Judge, Unified)")
    print("=" * 80)
    print(f"  Sample: {len(results)} queries")
    print()
    print(f"{'Dimension':<20} {'Mean':>6} {'<3':>5}")
    print("-" * 40)

    summary = {}
    for dim, vals in scores.items():
        if vals:
            mean = sum(vals) / len(vals)
            low = sum(1 for v in vals if v < 3)
            summary[dim] = {"mean": round(mean, 2), "below_3": low}
            print(f"{dim:<20} {mean:>6.2f} {low:>5}")
    print("-" * 40)

    overall = [sum(r.get("scores", {}).values()) / max(1, len(r.get("scores", {})))
               for r in results if r.get("scores")]
    if overall:
        print(f"\n  Overall: {sum(overall)/len(overall):.2f}/5.00")
        print(f"  >= 4.0:  {sum(1 for o in overall if o >= 4.0)}/{len(overall)}")
        print(f"  Best:    {max(overall):.2f}")
        print(f"  Worst:   {min(overall):.2f}")

    return summary


def main():
    logger.info("Layer 3 v2 starting")

    if not CKPT_INPUT.exists():
        logger.error("No eval checkpoint. Run eval_retrieval.py first.")
        return

    # Load test set
    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]
    all_queries = []
    for paper, data in test_set.items():
        for qdata in data.get("questions", []):
            all_queries.append((paper, qdata["question"]))

    random.seed(42)
    sampled = random.sample(all_queries, min(SAMPLE_SIZE, len(all_queries)))
    logger.info(f"Sampled {len(sampled)}/{len(all_queries)} queries")

    # Resume from checkpoint
    results = []
    if CKPT_OUT.exists():
        results = json.loads(CKPT_OUT.read_text(encoding="utf-8"))
        logger.info(f"Resuming: {len(results)} already done")

    start_idx = len(results)
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()

    for i in range(start_idx, len(sampled)):
        paper, query = sampled[i]
        logger.info(f"  [{i+1}/{len(sampled)}] {query[:50]}...")

        ctx = retrieve(nc, emb, query)
        if not ctx.get("entities"):
            results.append({"query": query, "error": "No entities"})
            continue

        result = generate_and_judge(query, ctx)
        if result is None:
            results.append({"query": query, "error": "LLM call failed"})
        else:
            results.append({
                "query": query,
                "paper": paper[:80],
                "answer": result.get("answer", "")[:500],
                "scores": result.get("scores", {}),
                "justification": result.get("justification", {}),
                "feedback": result.get("overall_feedback", ""),
            })

        # Checkpoint every 5
        if (i + 1) % 5 == 0:
            CKPT_OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

        time.sleep(COOLDOWN)  # rate limit

    # Report
    metrics = print_report(results)

    # Save
    report = {
        "timestamp": datetime.now().isoformat(),
        "sample_size": len(sampled),
        "metrics": metrics,
        "results": [{"query": r["query"][:100], "scores": r.get("scores", {}),
                     "feedback": r.get("feedback", "")[:200]} for r in results],
    }
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
