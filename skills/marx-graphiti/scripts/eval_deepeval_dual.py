#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_deepeval_dual.py — DeepEval 双引擎评测 (Cognee + Graphiti)
════════════════════════════════════════════════════════════════
数据流:
  30题 gold → Cognee SDK (11003) / Graphiti Neo4j (11001)
  → LLMTestCase → DeepEval metrics → JSON 报告

指标: Faithfulness, AnswerRelevancy, ContextualPrecision, ContextualRecall,
      ContextualRelevancy, Hallucination

运行:
  python eval_deepeval_dual.py --sample 5            # smoke test
  python eval_deepeval_dual.py --sample 30 --engine both  # full
"""
import argparse
import asyncio
import json
import os
import sys
import time
import warnings
from pathlib import Path
from typing import Dict, List

warnings.filterwarnings("ignore")

# ── Cognee path setup ──
COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

import httpx
from neo4j import GraphDatabase
from openai import OpenAI

# ── DeepEval ──
from deepeval import evaluate
from deepeval.test_case import LLMTestCase
from deepeval.metrics import (
    FaithfulnessMetric, AnswerRelevancyMetric,
    ContextualPrecisionMetric, ContextualRecallMetric,
    ContextualRelevancyMetric, HallucinationMetric,
)

# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════

GROUND_TRUTH = COGNEE_ROOT / "eval" / "ground_truth_30q.json"
OUTPUT_DIR = Path(__file__).parent / "eval_output"

GRAPHITI_URI = "bolt://127.0.0.1:11001"
GRAPHITI_AUTH = ("neo4j", "neo4j123")

JUDGE_MODEL = "qwen3.7-max"
TOP_K = 10
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")

# DeepEval uses openai client — point it to DashScope
os.environ["OPENAI_API_KEY"] = LLM_API_KEY
os.environ["OPENAI_API_BASE"] = LLM_ENDPOINT


# ═══════════════════════════════════════════════════════════════
# GraphitiSearcher (reuse from eval_ragas_dual.py)
# ═══════════════════════════════════════════════════════════════

class GraphitiSearcher:
    def __init__(self):
        self.driver = GraphDatabase.driver(GRAPHITI_URI, auth=GRAPHITI_AUTH)
        self.driver.verify_connectivity()
        print("Graphiti Neo4j connected: 11001")
        self.emb_client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
                                 http_client=httpx.Client(timeout=60))
        self._emb_cache: Dict[str, List[float]] = {}

    def _embed(self, text: str):
        if text in self._emb_cache:
            return self._emb_cache[text]
        try:
            r = self.emb_client.embeddings.create(model=EMBED_MODEL, input=text)
            vec = r.data[0].embedding
            self._emb_cache[text] = vec
            return vec
        except Exception:
            return None

    def entity_vector_search(self, query, top_k=30):
        qv = self._embed(query)
        if qv is None: return []
        with self.driver.session() as s:
            rows = s.run(
                "CALL db.index.vector.queryNodes('entity_vector_idx', $tk, $v) "
                "YIELD node, score RETURN node.name AS name, node.category AS category, "
                "node.description AS description, score ORDER BY score DESC LIMIT $k",
                tk=top_k, v=qv, k=top_k)
            return [dict(r) for r in rows]

    def entity_bm25_search(self, query, top_k=30):
        try:
            with self.driver.session() as s:
                rows = s.run(
                    "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
                    "YIELD node, score RETURN node.name AS name, node.category AS category, "
                    "node.description AS description, score ORDER BY score DESC LIMIT $k",
                    q=query, k=top_k)
                return [dict(r) for r in rows]
        except Exception:
            return []

    def chunk_bridge_search(self, query, top_k=30):
        qv = self._embed(query)
        if qv is None: return []
        with self.driver.session() as s:
            rows = s.run(
                "CALL db.index.vector.queryNodes('chunk_vector_idx', $tk, $v) "
                "YIELD node, score "
                "MATCH (node)-[:CHUNK_OF]->(ep:Episode)<-[:EXTRACTED_FROM]-(e:Entity) "
                "RETURN DISTINCT e.name AS name, e.category AS category, "
                "e.description AS description, max(score) AS score "
                "ORDER BY score DESC LIMIT $k",
                tk=top_k, v=qv, k=top_k)
            return [dict(r) for r in rows]

    @staticmethod
    def rrf_fuse(lists, k=60, top_k=10):
        scores, meta = {}, {}
        for rlist in lists:
            for rank, item in enumerate(rlist, start=1):
                name = item["name"]
                scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
                if name not in meta: meta[name] = item
        return [meta[n] for n in sorted(scores, key=lambda n: -scores[n])[:top_k]]

    def get_passages(self, entity_name, top_k=5):
        if not self.driver: return []
        with self.driver.session() as s:
            entities = s.run(
                "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($en) "
                "RETURN e.name AS name LIMIT 1", en=entity_name).data()
            if not entities: return []
            e_name = entities[0]["name"]
            episodes = s.run(
                "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper, ep.year AS year, "
                "ep.author AS author LIMIT 3", en=e_name).data()

        passages, seen = [], set()
        for ep in episodes:
            paper = ep["paper"]
            if paper in seen: continue
            seen.add(paper)
            with self.driver.session() as s2:
                chunks = s2.run(
                    "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
                    "WHERE c.chunk_type IN ['original','abstract'] "
                    "RETURN c.text AS text ORDER BY c.chunk_index ASC LIMIT 3", p=paper).data()
            for ck in chunks:
                text = str(ck.get("text", ""))[:500]
                if len(text) < 20: continue
                passages.append({"text": text, "paper": paper, "year": ep.get("year", ""),
                                 "author": str(ep.get("author", ""))[:30]})
                if len(passages) >= top_k: break
            if len(passages) >= top_k: break
        return passages

    def search(self, query):
        t0 = time.time()
        try:
            path1_vec = self.entity_vector_search(query)
            path1_bm25 = self.entity_bm25_search(query)
            path2_chunk = self.chunk_bridge_search(query)
            entities = self.rrf_fuse([path1_vec, path1_bm25, path2_chunk], top_k=TOP_K)

            all_passages, seen_txts = [], set()
            for e in entities[:8]:
                for p in self.get_passages(e["name"]):
                    key = p["text"][:80]
                    if key not in seen_txts:
                        seen_txts.add(key)
                        all_passages.append(p)

            llm = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
                         http_client=httpx.Client(timeout=120))
            pass_ctx = ""
            for i, p in enumerate(all_passages[:20], 1):
                pass_ctx += (f"[{i}] {p.get('author','佚名')} ({p.get('year','')}). "
                            f"{p['text'][:300]}\n")
            ent_ctx = ""
            for i, e in enumerate(entities[:10], 1):
                ent_ctx += (f"[实体{i}] {e.get('category','')}|{e['name']}: "
                           f"{str(e.get('description',''))[:150]}\n")

            prompt = f"""你是马克思主义理论学术专家。基于提供的论文段落和知识图谱实体，准确回答查询问题。

防幻觉铁律：
1. 只陈述段落中明确写出的内容
2. 禁止因果推断
3. 禁止假设和猜测
4. 每句话必须能对应到具体的段落编号
5. 使用[作者, 年份]标注每个主张的具体来源

查询：{query}

论文段落：
{pass_ctx[:4000]}

知识图谱实体：
{ent_ctx[:1500]}"""

            r = llm.chat.completions.create(
                model=JUDGE_MODEL, messages=[{"role": "user", "content": prompt}],
                temperature=0.2, max_tokens=2000)
            answer = r.choices[0].message.content or ""

            return {
                "answer": answer[:4000],
                "contexts": [p["text"][:500] for p in all_passages],
                "elapsed": round(time.time() - t0, 2),
                "error": None,
            }
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time() - t0, 2), "error": str(e)[:200]}

    def close(self):
        if self.driver: self.driver.close()


# ═══════════════════════════════════════════════════════════════
# CogneeSearcher
# ═══════════════════════════════════════════════════════════════

class CogneeSearcher:
    def __init__(self):
        self.user = None

    async def _get_user(self):
        if self.user is None:
            self.user = await get_default_user()
        return self.user

    async def search(self, query):
        t0 = time.time()
        user = await self._get_user()
        try:
            chunks_result = await search(query_type=SearchType.CHUNKS, query_text=query,
                                         top_k=TOP_K, user=user)
            contexts = self._extract_chunk_texts(chunks_result)

            answer_result = await search(query_type=SearchType.GRAPH_COMPLETION,
                                         query_text=query, top_k=TOP_K, user=user)
            answer = self._extract_answer_text(answer_result)

            return {"answer": answer[:4000] if answer else "[EMPTY]", "contexts": contexts,
                    "elapsed": round(time.time() - t0, 2), "error": None}
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time() - t0, 2), "error": str(e)[:200]}

    @staticmethod
    def _extract_chunk_texts(result):
        texts = []
        items = result if isinstance(result, list) else [result]
        for item in items:
            if isinstance(item, str): texts.append(item[:500])
            elif isinstance(item, dict):
                txt = item.get("text") or item.get("content") or str(item)
                texts.append(str(txt)[:500])
            else: texts.append(str(item)[:500])
        return texts[:20]

    @staticmethod
    def _extract_answer_text(result):
        if isinstance(result, list): return "\n".join(str(r) for r in result)
        return str(result)


# ═══════════════════════════════════════════════════════════════
# Collect samples
# ═══════════════════════════════════════════════════════════════

def collect_graphiti(searcher, queries):
    samples = []
    for i, q in enumerate(queries):
        print(f"  Graphiti [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...",
              end=" ", flush=True)
        r = searcher.search(q["query"])
        s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
             "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
             "engine": "Graphiti", "elapsed": r["elapsed"], "error": r.get("error")}
        samples.append(s)
        status = "OK" if not r.get("error") else f"ERR: {r['error'][:40]}"
        print(f"({r['elapsed']:.1f}s, {len(r['contexts'])}ctx) {status}")
    return samples


async def collect_cognee(searcher, queries):
    samples = []
    for i, q in enumerate(queries):
        print(f"  Cognee   [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...",
              end=" ", flush=True)
        r = await searcher.search(q["query"])
        s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
             "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
             "engine": "Cognee", "elapsed": r["elapsed"], "error": r.get("error")}
        samples.append(s)
        status = "OK" if not r.get("error") else f"ERR: {r['error'][:40]}"
        print(f"({r['elapsed']:.1f}s, {len(r['contexts'])}ctx) {status}")
    return samples


# ═══════════════════════════════════════════════════════════════
# DeepEval evaluation
# ═══════════════════════════════════════════════════════════════

def make_metrics():
    """Create DeepEval metrics with qwen-plus judge. Skip Hallucination (requires additional context)."""
    return [
        FaithfulnessMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
        AnswerRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
        ContextualPrecisionMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
        ContextualRecallMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
        ContextualRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
    ]


def run_deepeval_eval(samples, engine_name):
    valid = [s for s in samples if not s.get("error") and s["answer"]
             and not s["answer"].startswith("[ERROR]") and len(s["answer"]) > 20]
    skipped = len(samples) - len(valid)
    if skipped:
        print(f"  [{engine_name}] Skipping {skipped} error/empty samples")

    if not valid:
        return {"engine": engine_name, "error": "no valid samples", "n": 0}

    print(f"  [{engine_name}] Running DeepEval on {len(valid)} samples...")
    t0 = time.time()

    per_sample = []
    mnames = ["Faithfulness", "AnswerRelevancy", "ContextualPrecision",
              "ContextualRecall", "ContextualRelevancy"]

    for i, s in enumerate(valid):
        tc = LLMTestCase(
            input=s["question"],
            actual_output=s["answer"],
            expected_output=s["ground_truth"],
            retrieval_context=s["contexts"] if s["contexts"] else ["[no context]"],
        )
        row = {"id": s["id"], "question": s["question"][:80]}
        metrics = make_metrics()
        for mname, m in zip(mnames, metrics):
            try:
                m.measure(tc)
                row[mname] = round(m.score, 4) if m.score is not None else None
                row[f"{mname}_reason"] = str(getattr(m, "reason", ""))[:200]
            except Exception as e:
                row[mname] = None
                row[f"{mname}_reason"] = f"error: {str(e)[:100]}"
        per_sample.append(row)

        if (i + 1) % 10 == 0:
            print(f"    [{i+1}/{len(valid)}] done")

    elapsed = round(time.time() - t0, 1)
    print(f"  [{engine_name}] DeepEval done in {elapsed}s")

    agg = {}
    for mname in mnames:
        scores = [ps[mname] for ps in per_sample if ps.get(mname) is not None]
        agg[mname] = round(sum(scores) / max(len(scores), 1), 4) if scores else None

    return {"engine": engine_name, "n_samples": len(valid), "n_skipped": skipped,
            "elapsed": elapsed, "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=30)
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    run_cognee = args.engine in ("cognee", "both")
    run_graphiti = args.engine in ("graphiti", "both")

    print("=" * 70)
    print("  DeepEval Dual-Engine RAG Evaluation")
    print(f"  Cognee: {'ON' if run_cognee else 'OFF'}  Graphiti: {'ON' if run_graphiti else 'OFF'}")
    print(f"  Judge:  qwen-plus")
    print(f"  Queries: {args.sample}")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    queries = gt_data["queries"][:args.sample]

    print(f"\n{'─'*60}\n  Phase 1: Collecting answers\n{'─'*60}")

    graphiti_samples, cognee_samples = [], []
    if run_graphiti:
        gs = GraphitiSearcher()
        try: graphiti_samples = collect_graphiti(gs, queries)
        finally: gs.close()
    if run_cognee:
        cs = CogneeSearcher()
        try: cognee_samples = await collect_cognee(cs, queries)
        finally: pass

    print(f"\n{'─'*60}\n  Phase 2: DeepEval evaluation\n{'─'*60}")

    g_result, c_result = {}, {}
    if run_cognee and cognee_samples:
        c_result = run_deepeval_eval(cognee_samples, "Cognee (11003)")
    if run_graphiti and graphiti_samples:
        g_result = run_deepeval_eval(graphiti_samples, "Graphiti (11001)")

    # ── Print summary ──
    print(f"\n{'='*80}")
    print("  DeepEval Dual-Engine Evaluation — Summary")
    print(f"{'='*80}")
    mnames = ["Faithfulness", "AnswerRelevancy", "ContextualPrecision",
              "ContextualRecall", "ContextualRelevancy", "Hallucination"]
    print(f"{'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
    print("-" * 55)
    for m in mnames:
        cv = c_result.get("aggregate", {}).get(m) if c_result else None
        gv = g_result.get("aggregate", {}).get(m) if g_result else None
        cs = f"{cv:.4f}" if cv is not None else "N/A"
        gs = f"{gv:.4f}" if gv is not None else "N/A"
        d = f"{gv - cv:+.4f}" if (cv and gv) else "N/A"
        print(f"{m:<24} {cs:>10} {gs:>10} {d:>10}")

    # ── Save ──
    ts = time.strftime("%Y%m%d_%H%M%S")
    report = {"framework": f"DeepEval", "timestamp": ts, "judge_model": "qwen-plus",
              "n_queries": len(queries),
              "cognee": c_result, "graphiti": g_result}
    out_path = Path(args.output) if args.output else OUTPUT_DIR / f"deepeval_dual_{ts}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nReport saved: {out_path}")

if __name__ == "__main__":
    asyncio.run(main())
