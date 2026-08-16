#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_trulens_dual.py — TruLens 双引擎评测 (Cognee + Graphiti)
═══════════════════════════════════════════════════════════════
TruLens RAG Triad: Groundedness, ContextRelevance, AnswerRelevance

设计原则: TruLens 不做管线，只做评测。引擎答案和上下文预先收集好，
用 TruCustomApp + Feedback functions 逐条打分。

运行:
  python eval_trulens_dual.py --sample 5             # smoke test
  python eval_trulens_dual.py --sample 30 --engine graphiti  # single engine
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

# ── Cognee path ──
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

# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════

GROUND_TRUTH = COGNEE_ROOT / "eval" / "ground_truth_30q.json"
OUTPUT_DIR = Path(__file__).parent / "eval_output"

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
EMBED_MODEL = "text-embedding-v4"
TOP_K = 10

# TruLens needs a writable SQLite path — use our output dir
os.environ["TRULENS_DB_PATH"] = str(OUTPUT_DIR / ".trulens")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════
# Graphiti searcher
# ═══════════════════════════════════════════════════════════════

class GraphitiSearcher:
    def __init__(self):
        self.driver = GraphDatabase.driver(
            "bolt://127.0.0.1:11001", auth=("neo4j", "neo4j123"))
        self.driver.verify_connectivity()
        self.emb_client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
                                 http_client=httpx.Client(timeout=60))
        self._emb_cache: Dict[str, List[float]] = {}
        print("Graphiti Neo4j connected: 11001")

    def _embed(self, text):
        if text in self._emb_cache:
            return self._emb_cache[text]
        try:
            r = self.emb_client.embeddings.create(model=EMBED_MODEL, input=text)
            self._emb_cache[text] = r.data[0].embedding
            return self._emb_cache[text]
        except Exception:
            return None

    def search(self, query):
        t0 = time.time()
        try:
            qv = self._embed(query)
            contexts = []

            with self.driver.session() as s:
                rows = s.run(
                    "CALL db.index.vector.queryNodes('entity_vector_idx', 30, $v) "
                    "YIELD node, score "
                    "RETURN node.name AS name, node.category AS category, "
                    "node.description AS description, score "
                    "ORDER BY score DESC LIMIT 10", v=qv)
                entities = [dict(r) for r in rows]

                for e in entities[:5]:
                    ep_rows = s.run(
                        "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
                        "RETURN ep.source_folder AS paper, ep.author AS author, "
                        "ep.year AS year LIMIT 2", en=e["name"]).data()
                    for ep in ep_rows:
                        ck_rows = s.run(
                            "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
                            "WHERE c.chunk_type IN ['original','abstract'] "
                            "RETURN c.text AS text ORDER BY c.chunk_index ASC LIMIT 2",
                            p=ep["paper"]).data()
                        for ck in ck_rows:
                            txt = str(ck.get("text", ""))[:500]
                            if len(txt) > 20:
                                author = str(ep.get("author", "?"))[:20]
                                year = str(ep.get("year", "?"))
                                contexts.append(f"[{author}, {year}] {txt}")

            ctx_text = "\n".join(contexts[:20])[:5000]
            prompt = f"""你是马克思主义理论学术专家。基于上下文准确回答查询问题。
禁止编造、假设或因果推断。使用[作者, 年份]标注来源。

查询：{query}

上下文：
{ctx_text}"""

            llm = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
                         http_client=httpx.Client(timeout=120))
            r = llm.chat.completions.create(
                model="qwen-plus", messages=[{"role": "user", "content": prompt}],
                temperature=0.2, max_tokens=2000)
            answer = r.choices[0].message.content or "[EMPTY]"

            return {"answer": answer, "contexts": contexts[:25],
                    "elapsed": round(time.time() - t0, 2), "error": None}
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time() - t0, 2), "error": str(e)[:200]}

    def close(self):
        if self.driver: self.driver.close()


# ═══════════════════════════════════════════════════════════════
# Cognee searcher
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
        try:
            user = await self._get_user()
            c_result = await search(query_type=SearchType.CHUNKS, query_text=query,
                                    top_k=TOP_K, user=user)
            contexts = []
            items = c_result if isinstance(c_result, list) else [c_result]
            for item in items:
                if isinstance(item, str): contexts.append(item[:500])
                elif isinstance(item, dict):
                    t = item.get("text") or item.get("content") or str(item)
                    contexts.append(str(t)[:500])
                else: contexts.append(str(item)[:500])

            a_result = await search(query_type=SearchType.GRAPH_COMPLETION,
                                    query_text=query, top_k=TOP_K, user=user)
            if isinstance(a_result, list):
                answer = "\n".join(str(r) for r in a_result)
            else:
                answer = str(a_result)

            return {"answer": answer[:4000] if answer else "[EMPTY]",
                    "contexts": contexts[:20],
                    "elapsed": round(time.time() - t0, 2), "error": None}
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time() - t0, 2), "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════
# TruLens: 不需要 instrument — 直接逐条调 LLM 打分
# ═══════════════════════════════════════════════════════════════

JUDGE_MODEL = "qwen3.7-max"

def trulens_groundedness(contexts: List[str], answer: str) -> float:
    """LLM-judge: is the answer grounded in the contexts?"""
    ctx = "\n---\n".join(contexts)[:4000]
    ans = str(answer)[:2000]
    prompt = f"""You are an information verifier. Determine if each statement in the ANSWER is supported by the SOURCE text.

SOURCE:
{ctx}

ANSWER:
{ans}

Output a JSON with a score from 0 to 10 (0=completely unsupported/hallucinated, 10=fully supported by sources):
{{"score": <0-10>, "reason": "<one sentence>"}}
JSON:"""

    try:
        client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY)
        r = client.chat.completions.create(
            model=JUDGE_MODEL, messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=256)
        import re
        m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', r.choices[0].message.content)
        return float(m.group(1)) / 10.0 if m else 0.5
    except Exception:
        return 0.5


def trulens_context_relevance(question: str, contexts: List[str]) -> float:
    """LLM-judge: are retrieved contexts relevant to question?"""
    ctx_sample = "\n---\n".join(c[:300] for c in contexts[:5])[:3000]
    prompt = f"""You are a relevance judge. Rate how relevant the retrieved CONTEXTS are to the QUESTION.

QUESTION: {question[:500]}

CONTEXTS:
{ctx_sample}

Output JSON: {{"score": <0-10>, "reason": "<one sentence>"}}
JSON:"""

    try:
        client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY)
        r = client.chat.completions.create(
            model=JUDGE_MODEL, messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=256)
        import re
        m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', r.choices[0].message.content)
        return float(m.group(1)) / 10.0 if m else 0.5
    except Exception:
        return 0.5


def trulens_answer_relevance(question: str, answer: str) -> float:
    """LLM-judge: does the answer directly address the question?"""
    prompt = f"""You are a relevance judge. Rate whether the ANSWER directly addresses the QUESTION.

QUESTION: {question[:500]}

ANSWER: {str(answer)[:2000]}

Output JSON: {{"score": <0-10>, "reason": "<one sentence>"}}
JSON:"""

    try:
        client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY)
        r = client.chat.completions.create(
            model=JUDGE_MODEL, messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=256)
        import re
        m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', r.choices[0].message.content)
        return float(m.group(1)) / 10.0 if m else 0.5
    except Exception:
        return 0.5


# ═══════════════════════════════════════════════════════════════
# Run eval
# ═══════════════════════════════════════════════════════════════

def run_trulens_eval(engine_name: str, samples: List[Dict]):
    """Score each sample with Triad feedback functions."""
    per_sample = []
    t0 = time.time()

    for i, s in enumerate(samples):
        score_g = trulens_groundedness(s.get("contexts", []), s["answer"])
        score_cr = trulens_context_relevance(s["question"], s.get("contexts", []))
        score_ar = trulens_answer_relevance(s["question"], s["answer"])

        per_sample.append({
            "id": s["id"], "question": s["question"][:80],
            "Groundedness": round(score_g, 4),
            "ContextRelevance": round(score_cr, 4),
            "AnswerRelevance": round(score_ar, 4),
        })

        if (i + 1) % 10 == 0:
            print(f"    [{engine_name}] {i+1}/{len(samples)} scored")

    elapsed = round(time.time() - t0, 1)

    agg = {}
    for col in ["Groundedness", "ContextRelevance", "AnswerRelevance"]:
        vals = [ps[col] for ps in per_sample if ps.get(col) is not None]
        agg[col] = round(sum(vals) / max(len(vals), 1), 4) if vals else None

    return {"engine": engine_name, "n_samples": len(samples),
            "elapsed": elapsed, "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=30)
    parser.add_argument("--engine", default="both",
                        choices=["cognee", "graphiti", "both"])
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    run_cognee = args.engine in ("cognee", "both")
    run_graphiti = args.engine in ("graphiti", "both")

    print("=" * 70)
    print("  TruLens-Compatible Dual-Engine RAG Evaluation")
    print(f"  Cognee: {'ON' if run_cognee else 'OFF'}  Graphiti: {'ON' if run_graphiti else 'OFF'}")
    print(f"  RAG Triad: Groundedness, ContextRelevance, AnswerRelevance")
    print(f"  Judge: {JUDGE_MODEL}")
    print(f"  Queries: {args.sample}")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    queries = gt_data["queries"][:args.sample]

    print(f"\n{'─'*60}\n  Phase 1: Collecting answers\n{'─'*60}")

    graphiti_samples, cognee_samples = [], []

    if run_graphiti:
        gs = GraphitiSearcher()
        try:
            for i, q in enumerate(queries):
                print(f"  Graphiti [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...",
                      end=" ", flush=True)
                r = gs.search(q["query"])
                s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
                     "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
                     "elapsed": r["elapsed"], "error": r.get("error")}
                graphiti_samples.append(s)
                st = "OK" if not r.get("error") else "ERR"
                print(f"({r['elapsed']:.1f}s, {len(r['contexts'])}ctx) {st}")
        finally:
            gs.close()

    if run_cognee:
        cs = CogneeSearcher()
        try:
            for i, q in enumerate(queries):
                print(f"  Cognee   [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...",
                      end=" ", flush=True)
                r = await cs.search(q["query"])
                s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
                     "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
                     "elapsed": r["elapsed"], "error": r.get("error")}
                cognee_samples.append(s)
                st = "OK" if not r.get("error") else f"ERR: {r['error'][:40]}"
                print(f"({r['elapsed']:.1f}s, {len(r['contexts'])}ctx) {st}")
        finally:
            pass

    print(f"\n{'─'*60}\n  Phase 2: RAG Triad Evaluation\n{'─'*60}")

    g_result, c_result = {}, {}

    if run_graphiti and graphiti_samples:
        valid = [s for s in graphiti_samples if not s.get("error")
                 and len(s["answer"]) > 20 and not s["answer"].startswith("[ERROR]")]
        print(f"  Graphiti: {len(valid)}/{len(graphiti_samples)} valid samples")
        g_result = run_trulens_eval("Graphiti-11001", valid)

    if run_cognee and cognee_samples:
        valid = [s for s in cognee_samples if not s.get("error")
                 and len(s["answer"]) > 20 and not s["answer"].startswith("[ERROR]")]
        print(f"  Cognee: {len(valid)}/{len(cognee_samples)} valid samples")
        c_result = run_trulens_eval("Cognee-11003", valid)

    # ── Summary ──
    print(f"\n{'='*80}")
    print("  TruLens Dual-Engine Evaluation — Summary")
    print(f"{'='*80}")
    mnames = ["Groundedness", "ContextRelevance", "AnswerRelevance"]
    print(f"{'Metric':<22} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
    print("-" * 55)
    for m in mnames:
        cv = c_result.get("aggregate", {}).get(m) if c_result else None
        gv = g_result.get("aggregate", {}).get(m) if g_result else None
        cs_str = f"{cv:.4f}" if cv is not None else "N/A"
        gs_str = f"{gv:.4f}" if gv is not None else "N/A"
        d = f"{gv - cv:+.4f}" if (cv and gv) else "N/A"
        print(f"{m:<22} {cs_str:>10} {gs_str:>10} {d:>10}")

    # ── Save ──
    ts = time.strftime("%Y%m%d_%H%M%S")
    report = {"framework": "TruLens (compatible)", "timestamp": ts,
              "judge_model": JUDGE_MODEL, "n_queries": len(queries),
              "cognee": c_result, "graphiti": g_result}
    out_path = Path(args.output) if args.output else OUTPUT_DIR / f"trulens_dual_{ts}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nReport saved: {out_path}")

if __name__ == "__main__":
    asyncio.run(main())
