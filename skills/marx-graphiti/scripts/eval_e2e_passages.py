#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_e2e_passages.py — Script 3: End-to-End RAG with Passages (P1)
═══════════════════════════════════════════════════════════════════
Full post-upgrade pipeline on 30 queries:
  rewrite -> decompose -> entity hybrid search -> get_entity_passages
  -> compress_passages -> single unified generate+judge LLM call

Compares against Layer 3 v2 baseline (entity+distill only, overall 4.73/5).
Goal: passages should improve completeness (was 4.40) and attribution (was 4.64).

Cost: ~RMB 0.96 | Time: ~15 min
"""

import sys, json, time, random, re, hashlib, sqlite3
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient, QwenMaxClient
from pipeline.config import get_qwen_max_config

logger = get_logger("eval_e2e_p")

CKPT_INPUT = SCRIPT_DIR / ".eval_checkpoint.json"
CKPT_OUT = SCRIPT_DIR / ".eval_e2e_checkpoint.json"
REPORT_FILE = SCRIPT_DIR / "eval_e2e_passages_report.json"
BASELINE_REPORT = SCRIPT_DIR / "eval_layer3_report.json"

SAMPLE = 30
TOP_K = 5


# ═══════════════════════════════════════════════════════════════
# Helpers (entity search + passage retrieval + compress)
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


def rrf(lists, top_k=30):
    scores, meta = {}, {}
    for rlist in lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0/(60+rank)
            if name not in meta: meta[name] = item
    return [meta[name] for name,_ in sorted(scores.items(), key=lambda x:x[1], reverse=True)[:top_k]]


def get_entity_passages(nc, entity_name: str, top_k: int = 5) -> List[Dict]:
    """Paper origin passage retrieval (from mcp_server/server.py)."""
    entities = nc.execute_query(
        "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($en) "
        "RETURN e.name AS name LIMIT 1", {"en": entity_name})
    if not entities:
        return []
    e_name = entities[0]["name"]
    episodes = nc.execute_query(
        "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
        "RETURN ep.source_folder AS paper, ep.title AS title, ep.year AS year, ep.author AS author LIMIT 3",
        {"en": e_name})
    passages, seen = [], set()
    for ep in episodes:
        paper = ep["paper"]
        if paper in seen: continue
        seen.add(paper)
        chunks = nc.execute_query(
            "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
            "WHERE c.chunk_type IN ['original','abstract'] "
            "RETURN c.text AS text, c.chunk_type AS ct ORDER BY c.chunk_index ASC LIMIT 3",
            {"p": paper})
        for ck in chunks:
            passages.append({"text": str(ck.get("text",""))[:500],
                             "chunk_type": ck.get("ct","original"),
                             "paper": paper, "year": ep.get("year"),
                             "author": str(ep.get("author",""))[:30]})
            if len(passages) >= top_k: break
        if len(passages) >= top_k: break
    return passages


def compress_passages(llm, passages_text: str, context: str = "", max_tokens: int = 2000) -> str:
    """LLM-based academic text compression."""
    if len(passages_text) < 200:
        return passages_text
    ctx = f"Context: {context[:200]}\n\n" if context else ""
    prompt = (
        f"{ctx}Compress the following academic text keeping ALL key facts, claims, "
        f"entity names, years, and methodology terms. Remove only boilerplate and redundancies. "
        f"Target ~{max_tokens} characters.\n\n---\n{passages_text[:max_tokens*2]}\n---\n\nCompressed:"
    )
    try:
        r = llm.call(prompt, max_retries=2, timeout=90,
                     system_prompt="You are an expert academic text compressor. Preserve all facts.")
        if r:
            return r.get("content","")[:max_tokens]
    except Exception:
        pass
    return passages_text[:max_tokens]


def llm_rewrite(llm, query: str) -> List[str]:
    try:
        r = llm.call_json(
            f"将以下学术查询改写为3种表述形式：\n\n{query}\n\n输出: {{\"variants\":[\"关键词\",\"学术术语\",\"同义改写\"]}}\n只输出JSON。",
            max_retries=2, timeout=90, system_prompt="只输出JSON对象。")
        if r and isinstance(r, dict):
            return r.get("variants", [])[:3]
    except Exception:
        pass
    return []


# ═══════════════════════════════════════════════════════════════
# Unified generate + judge
# ═══════════════════════════════════════════════════════════════

def generate_and_judge(llm: QwenMaxClient, query: str, context: str,
                       passage_meta: List[Dict]) -> Optional[Dict]:
    """Single LLM call: generate answer + 4-dim self-judge + passage rating."""

    # Build passage context with full citation metadata
    pass_ctx = ""
    for i, pm in enumerate(passage_meta, 1):
        author = pm.get('author', '佚名')
        year = pm.get('year', '')
        title = str(pm.get('title', pm.get('paper', '')))[:60]
        pass_ctx += f"[{i}] {author} ({year}). {title}. ...{pm['text'][:250]}\n"

    prompt = f"""你是马克思主义理论学术专家和评审专家。请完成：

## 任务1：生成回答
基于以下论文段落和知识图谱实体，回答查询问题（300-500字学术中文）。
要求：
1. 每个主张必须标注来源，使用格式：[作者, 年份]
2. 严格基于提供的段落和实体，不得添加外部知识或编造信息
3. 如果某条段落与查询无关，忽略它
4. 优先使用段落中的原文信息和数据

查询：{query}

上下文（论文段落）：
{pass_ctx[:3000]}
{context[:1000]}

## 任务2：自我评估
从4个维度评分（1-5分），请严格评分，不要虚高：
- faithfulness(忠实度)：是否严格基于提供的段落和实体，没有编造或引入外部知识？
- relevance(相关性)：回答是否直接回应查询，没有偏离主题？
- completeness(完整性)：是否覆盖了论文段落和实体中所有与查询相关的关键要点？
- attribution(溯源度)：每个事实主张是否明确标注了[作者, 年份]来源？有没有主张缺少引用？

## 任务3：段落相关性
对每条段落评分（1-3分）：1=无关 2=部分相关 3=高度相关

输出JSON：
{{"answer":"...(含[作者,年份]引用)...",
  "scores":{{"faithfulness":4,"relevance":5,"completeness":3,"attribution":4}},
  "justification":{{"faithfulness":"...","relevance":"...","completeness":"...","attribution":"..."}},
  "passage_ratings":{{"1":3,"2":2}},
  "most_useful_passages":[1,3],
  "overall_feedback":"50字以内总体评价"
}}"""

    r = llm.call(prompt, max_retries=3, timeout=120,
                 system_prompt="你是马克思主义理论的学术专家和评审专家。输出严格JSON。")
    if r is None:
        return None
    content = r.get("content", "")
    content = re.sub(r'^```(?:json)?\s*', '', content)
    content = re.sub(r'\s*```$', '', content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return None


# ═══════════════════════════════════════════════════════════════
# Main pipeline
# ═══════════════════════════════════════════════════════════════

def run_pipeline(emb, nc, llm, query: str) -> Tuple[Optional[Dict], List[Dict], str]:
    """Full pipeline: rewrite -> decompose -> entity search -> passages -> compress -> generate+judge."""
    # 1. Rewrite
    variants = llm_rewrite(llm, query)

    # 2. Entity search (on original + variants)
    all_vec = entity_vector(emb, nc, query)
    all_bm25 = entity_bm25(nc, query)
    for v in variants[:3]:
        all_vec += entity_vector(emb, nc, v)
        all_bm25 += entity_bm25(nc, v)
    entities = rrf([all_vec, all_bm25], top_k=TOP_K)[:TOP_K]

    # 3. Get passages for top-5 entities, with smart dedup
    all_passages = []
    seen_texts = set()
    for e in entities:
        ps = get_entity_passages(nc, e["name"], top_k=5)
        for p in ps:
            # Dedup: skip near-duplicate passages (first 80 chars match)
            key = p["text"][:80]
            if key not in seen_texts:
                seen_texts.add(key)
                all_passages.append(p)
    if len(all_passages) > 20:
        all_passages = all_passages[:20]

    # 4. Compress (shorter target to reduce dilution)
    passages_text = " ".join([p["text"] for p in all_passages])
    compressed = compress_passages(llm, passages_text, query, max_tokens=1500)

    # 6. Build entity context
    ctx_text = ""
    for i, e in enumerate(entities, 1):
        ctx_text += f"[实体{i}] {e['category']} | {e['name']}: {e['description'][:150]}\n"

    # 7. Generate + judge (with tightened prompt)
    judgment = generate_and_judge(llm, query, ctx_text, all_passages)

    return judgment, all_passages, compressed


def print_report(results: List[Dict], baseline_metrics: Optional[Dict]):
    scores = {"faithfulness": [], "relevance": [], "completeness": [], "attribution": []}
    pass_ratings = []
    for r in results:
        s = r.get("scores", {})
        for dim in scores:
            if s.get(dim):
                scores[dim].append(s[dim])
        pr = r.get("passage_ratings", {})
        pass_ratings.extend(pr.values())

    print()
    print("=" * 70)
    print("  End-to-End RAG with Passages (n=" + str(len(results)) + ")")
    print("=" * 70)
    print(f"{'Dimension':<20} {'Mean':>6} {'Delta vs LC3':>14}")
    print("-" * 50)

    summary = {}
    for dim, vals in scores.items():
        if vals:
            mean = sum(vals)/len(vals)
            d = ""
            if baseline_metrics and dim in baseline_metrics:
                bl = baseline_metrics[dim].get("mean", 0)
                d = f"{mean-bl:+.2f}"
            summary[dim] = {"mean": round(mean,2), "delta": d}
            print(f"{dim:<20} {mean:>6.2f} {d:>14}")
    print("-" * 50)

    overall = [sum(r.get("scores",{}).values())/max(1,len(r.get("scores",{})))
               for r in results if r.get("scores")]
    if overall:
        print(f"\n  Overall: {sum(overall)/len(overall):.2f}/5.00")
        print(f"  Best: {max(overall):.2f}  Worst: {min(overall):.2f}")

    if pass_ratings:
        mean_pr = sum(pass_ratings)/len(pass_ratings)
        useful = sum(1 for v in pass_ratings if v >= 2) / len(pass_ratings) * 100
        print(f"  Passage relevance: {mean_pr:.2f}/3 ({useful:.0f}% rated >=2)")

    if baseline_metrics and "overall_mean" in baseline_metrics:
        bl_overall = baseline_metrics["overall_mean"]
        new_overall = sum(overall)/len(overall) if overall else 0
        print(f"  Delta vs entity-only (Layer 3 v2): {new_overall - bl_overall:+.2f}")

    return summary


def main():
    logger.info("=" * 60)
    logger.info("Script 3: E2E RAG with Passages")
    logger.info("=" * 60)

    if not CKPT_INPUT.exists():
        logger.error("No test set.")
        return
    test_set = json.loads(CKPT_INPUT.read_text(encoding="utf-8"))["test_set"]

    # Sample 30 queries
    all_queries = []
    for paper, data in test_set.items():
        for qi, qdata in enumerate(data.get("questions", [])):
            all_queries.append((paper, qdata["question"]))
    random.seed(42)
    sampled = random.sample(all_queries, min(SAMPLE, len(all_queries)))

    # Load baseline
    bl_metrics = None
    if BASELINE_REPORT.exists():
        bl = json.loads(BASELINE_REPORT.read_text(encoding="utf-8"))
        bl_metrics = bl.get("metrics", {})

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()
    qw_cfg = get_qwen_max_config()
    llm = QwenMaxClient(api_key=qw_cfg["api_key"], base_url=qw_cfg["base_url"], model=qw_cfg["model"])

    # Resume
    results = []
    if CKPT_OUT.exists():
        results = json.loads(CKPT_OUT.read_text(encoding="utf-8"))
        logger.info(f"Resuming from {len(results)} results")

    for idx in range(len(results), len(sampled)):
        paper, qtext = sampled[idx]
        logger.info(f"  [{idx+1}/{len(sampled)}] {qtext[:60]}...")

        try:
            judgment, passages, compressed = run_pipeline(emb, nc, llm, qtext)
        except Exception as e:
            logger.warning(f"  Pipeline failed for [{idx+1}]: {e}")
            results.append({"query": qtext, "error": f"pipeline error: {str(e)[:100]}"})
            CKPT_OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            continue

        if judgment:
            results.append({
                "query": qtext, "paper": paper[:80],
                "answer": judgment.get("answer","")[:400],
                "scores": judgment.get("scores",{}),
                "passage_ratings": judgment.get("passage_ratings",{}),
                "feedback": judgment.get("overall_feedback",""),
                "n_passages": len(passages),
                "compressed_len": len(compressed),
            })
        else:
            results.append({"query": qtext, "error": "generation/judgment failed"})

        # Save checkpoint after EVERY query (not every 5)
        CKPT_OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(2)

    metrics = print_report(results, bl_metrics)

    REPORT_FILE.write_text(json.dumps({
        "timestamp": datetime.now().isoformat(),
        "sample": len(sampled),
        "metrics": metrics,
        "results": [{"query": r["query"][:100], "scores": r.get("scores",{}), "feedback": r.get("feedback","")} for r in results],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Report: {REPORT_FILE}")

    nc.close()


if __name__ == "__main__":
    main()
