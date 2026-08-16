#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_layer3.py — Layer 3: End-to-End RAG Quality (LLM-as-Judge)
══════════════════════════════════════════════════════════════════
Samples 50 queries from existing test set. For each:
  1. Retrieve top-5 entities + distill content via upgraded hybrid search
  2. Generate answer with LLM
  3. Judge with 4-dimension LLM scoring

Dimensions:
  - Faithfulness (1-5): Is the answer grounded in retrieved context?
  - Relevance (1-5): Does the answer directly address the query?
  - Completeness (1-5): Does it cover all key points from context?
  - Attribution (1-5): Can each claim be traced to specific entity/paper?

Cost: ~RMB 3 (50 queries x 2 LLM calls/query)
"""

import sys
import json
import time
import random
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_layer3")
REPORT_FILE = SCRIPT_DIR / "eval_layer3_report.json"

SAMPLE_SIZE = 50
TOP_K = 5

JUDGE_SYSTEM_PROMPT = (
    "你是一位严谨的学术评审专家，负责评估基于知识图谱检索增强生成（RAG）的回答质量。"
    "请从以下四个维度评分（1-5分，1=很差，5=优秀），并给出简要理由。"
    "输出严格JSON格式。"
)


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
    scores = {}
    meta = {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    return [{**meta.get(name, {"name": name}), "score": round(rrf_score, 4)}
            for name, rrf_score in merged]


def retrieve_context(nc, emb: QwenEmbeddingClient, query: str, top_k: int = TOP_K) -> Dict:
    """Retrieve entities + distill content for a query."""
    vec_results = []
    qv = emb.embed(query)
    if qv:
        try:
            rows = nc.execute_query(
                "CALL db.index.vector.queryNodes('entity_vector_idx', 30, $v) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, node.description AS description, score "
                "ORDER BY score DESC LIMIT 20",
                {"v": qv, "k": 20}
            )
            vec_results = [{"name": r["name"], "category": r.get("category", ""),
                            "description": str(r.get("description", ""))[:250],
                            "score": round(r["score"], 4)} for r in rows]
        except Exception:
            pass
    bm25_results = _bm25_search(nc, query, 20)
    fused = _rrf_fusion([vec_results, bm25_results], top_k=top_k)

    # Enrich with distill content
    enriched = []
    for f in fused:
        name = f["name"]
        entry = {**f, "distill_layers": None, "neighbors": [], "papers": []}
        # Get distill
        try:
            ds = nc.execute_query(
                "MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e:Entity {name: $n}) "
                "RETURN ld.core_concept_definition AS cd, ld.theoretical_system_and_innovation AS ti, "
                "ld.dialectical_logic_chain AS dc LIMIT 1",
                {"n": name}
            )
            if ds:
                entry["distill_layers"] = {
                    "core_concept": str(ds[0].get("cd", ""))[:300],
                    "theory_innovation": str(ds[0].get("ti", ""))[:300],
                    "dialectical_chain": str(ds[0].get("dc", ""))[:300],
                }
        except Exception:
            pass
        # Get neighbors
        try:
            rels = nc.execute_query(
                "MATCH (e:Entity {name: $n})-[r]-(other:Entity) WHERE type(r) <> 'EXTRACTED_FROM' "
                "RETURN type(r) AS rel, other.name AS target LIMIT 5",
                {"n": name}
            )
            entry["neighbors"] = [f"{r['rel']} -> {r['target']}" for r in rels]
        except Exception:
            pass
        # Get source papers
        try:
            eps = nc.execute_query(
                "MATCH (e:Entity {name: $n})-[:EXTRACTED_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper LIMIT 3",
                {"n": name}
            )
            entry["papers"] = [e["paper"] for e in eps]
        except Exception:
            pass
        enriched.append(entry)
    return {"entities": enriched}


def generate_answer(llm: QwenMaxClient, query: str, context: Dict) -> Optional[str]:
    """Generate an answer based on retrieved context."""
    ctx_text = ""
    for i, e in enumerate(context.get("entities", []), 1):
        ctx_text += f"[{i}] {e['category']} | {e['name']}: {e['description']}\n"
        if e.get("distill_layers"):
            dl = e["distill_layers"]
            if dl.get("core_concept"):
                ctx_text += f"    Core concept: {dl['core_concept'][:200]}\n"
        if e.get("neighbors"):
            ctx_text += f"    Related: {', '.join(e['neighbors'][:3])}\n"
        if e.get("papers"):
            ctx_text += f"    Source papers: {', '.join(e['papers'][:2])}\n"

    prompt = (
        "你是一位马克思主义理论学者。基于以下检索到的知识图谱上下文，回答问题。\n\n"
        f"问题：{query}\n\n"
        f"检索上下文：\n{ctx_text[:4000]}\n\n"
        "请给出一个学术性的回答（200-400字），引用上下文中的实体和关系，标注来源。"
    )

    result = llm.call(prompt, max_retries=3, timeout=120,
                      system_prompt="你是马克思主义理论领域的学术专家。")
    if result:
        return result.get("content", "")
    return None


def judge_answer(llm: QwenMaxClient, query: str, context: Dict, answer: str) -> Optional[Dict]:
    """Judge the answer on 4 dimensions."""
    ctx_summary = ""
    for i, e in enumerate(context.get("entities", [])[:5], 1):
        ctx_summary += f"[{i}] {e['name']} ({e['category']})\n"

    prompt = (
        f"查询问题：{query}\n\n"
        f"检索到的上下文实体：\n{ctx_summary}\n"
        f"生成的答案：\n{answer[:2000]}\n\n"
        "请从以下四个维度评分（1-5分，1=很差，5=优秀）：\n"
        "1. faithfulness（忠实度）：答案是否严格基于检索上下文，有无幻觉编造？\n"
        "2. relevance（相关性）：答案是否直接回应了查询问题？\n"
        "3. completeness（完整性）：答案是否覆盖了上下文中所有关键要点？\n"
        "4. attribution（溯源度）：答案中的每个主张是否可追溯到具体实体/论文？\n\n"
        "对每个维度的评分给出一个句子级别的理由。"
        '输出JSON：{"scores":{"faithfulness":4,"relevance":5,"completeness":3,"attribution":4},'
        '"justification":{"faithfulness":"...","relevance":"...","completeness":"...","attribution":"..."},'
        '"overall_feedback":"50字以内的总体评价"}'
    )

    result = llm.call_json(prompt, json_schema=True, max_retries=3, timeout=120,
                           system_prompt=JUDGE_SYSTEM_PROMPT)
    return result


def print_report(results: List[Dict]):
    """Aggregate and print results."""
    scores = {"faithfulness": [], "relevance": [], "completeness": [], "attribution": []}
    for r in results:
        s = r.get("scores", {})
        for dim in scores:
            if s.get(dim):
                scores[dim].append(s[dim])

    print()
    print("=" * 80)
    print("  Layer 3: End-to-End RAG Quality (LLM-as-Judge)")
    print("=" * 80)
    print(f"  Sample size: {len(results)} queries")
    print()
    print(f"{'Dimension':<20} {'Mean':>6} {'Min':>4} {'Max':>4} {'<3':>5}")
    print("-" * 50)

    summary = {}
    for dim, vals in scores.items():
        if vals:
            mean = sum(vals) / len(vals)
            low = sum(1 for v in vals if v < 3)
            summary[dim] = {"mean": round(mean, 2), "min": min(vals), "max": max(vals), "below_3": low}
            print(f"{dim:<20} {mean:>6.2f} {min(vals):>4} {max(vals):>4} {low:>5}")
        else:
            print(f"{dim:<20} {'N/A':>6}")

    print("-" * 50)

    # Overall
    overall = [sum(r.get("scores", {}).values()) / 4 for r in results if r.get("scores")]
    if overall:
        print(f"\n  Overall score: {sum(overall)/len(overall):.2f}/5.00 (mean of 4 dimensions)")
        print(f"  Best query:    {max(overall):.2f}")
        print(f"  Worst query:   {min(overall):.2f}")
        print(f"  >= 4.0:        {sum(1 for o in overall if o >= 4.0)}/{len(overall)}")

    return summary


def main():
    logger.info("=" * 60)
    logger.info("Layer 3: End-to-End RAG Quality (LLM-as-Judge)")
    logger.info("=" * 60)

    # Load test set
    ck = SCRIPT_DIR / ".eval_checkpoint.json"
    if not ck.exists():
        logger.error("No eval checkpoint. Run eval_retrieval.py first.")
        return
    test_set = json.loads(ck.read_text(encoding="utf-8"))["test_set"]

    # Sample 50 queries
    all_queries = []
    for paper, data in test_set.items():
        for qdata in data.get("questions", []):
            all_queries.append((paper, qdata["question"]))

    random.seed(42)
    sampled = random.sample(all_queries, min(SAMPLE_SIZE, len(all_queries)))
    logger.info(f"Sampled {len(sampled)}/{len(all_queries)} queries")

    # Init clients
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    results = []
    for i, (paper, query) in enumerate(sampled):
        logger.info(f"  [{i+1}/{len(sampled)}] {query[:60]}...")

        # Retrieve
        ctx = retrieve_context(nc, emb, query)
        if not ctx.get("entities"):
            results.append({"query": query, "paper": paper[:80], "error": "No entities retrieved", "scores": {}})
            continue

        # Generate
        answer = generate_answer(llm, query, ctx)
        if answer is None:
            results.append({"query": query, "paper": paper[:80], "error": "Generation failed", "scores": {}})
            continue

        # Judge
        judgment = judge_answer(llm, query, ctx, answer)
        if judgment is None:
            results.append({"query": query, "paper": paper[:80], "answer": answer[:300], "error": "Judgment failed", "scores": {}})
            continue

        results.append({
            "query": query,
            "paper": paper[:80],
            "answer": answer[:500],
            "scores": judgment.get("scores", {}),
            "justification": judgment.get("justification", {}),
            "feedback": judgment.get("overall_feedback", ""),
            "retrieved_count": len(ctx["entities"]),
        })

        time.sleep(0.1)

    # Report
    metrics = print_report(results)

    # Save
    report = {
        "timestamp": datetime.now().isoformat(),
        "sample_size": len(sampled),
        "metrics": metrics,
        "results": [{"query": r["query"][:100],
                     "paper": r.get("paper", ""),
                     "scores": r.get("scores", {}),
                     "feedback": r.get("feedback", "")[:200]}
                    for r in results],
    }
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report saved: {REPORT_FILE}")

    nc.close()
    logger.info("Done")


if __name__ == "__main__":
    main()
