#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_unified_tri.py — 三框架统一评测 (Ragas + DeepEval + TruLens Triad)
═══════════════════════════════════════════════════════════════════════
设计:
  1. Phase 1: 查询一次 (Cognee + Graphiti 各 30 题)，**禁用 Cognee cache**
  2. Phase 2: Ragas → DeepEval → TruLens Triad 逐个串行打分
  3. 所有 Judge 用 qwen3.7-max, 串行调 API 避免流控

运行:
  python eval_unified_tri.py --sample 5              # smoke test
  python eval_unified_tri.py --sample 30             # full
  python eval_unified_tri.py --sample 30 --engine graphiti
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import types
import warnings
from pathlib import Path
from typing import Dict, List

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════════════
# Setup
# ═══════════════════════════════════════════════════════════════

COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))

# 禁用 Cognee session cache — 否则返回旧答案 (坑8/坑9)
os.environ["CACHING"] = "false"

import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

import httpx
from neo4j import GraphDatabase
from openai import OpenAI

OUTPUT_DIR = Path(__file__).resolve().parent / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
EMBED_MODEL = "text-embedding-v4"
GROUND_TRUTH = COGNEE_ROOT / "eval" / "ground_truth_30q.json"
TOP_K = 10

JUDGE_MODEL = "qwen3.7-max"
JUDGE_MAX_TOKENS = 4096

# API 调用的 client（串行复用）
_api_client = None

def _get_client():
    global _api_client
    if _api_client is None:
        _api_client = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
                             http_client=httpx.Client(timeout=180))
    return _api_client

# ═══════════════════════════════════════════════════════════════
# Monkey-patch Ragas
# ═══════════════════════════════════════════════════════════════

_fake_vertexai = types.ModuleType("langchain_community.chat_models.vertexai")
_fake_vertexai.ChatVertexAI = type("FakeChatVertexAI", (), {})
_fake_cm = types.ModuleType("langchain_community.chat_models")
_fake_cm.vertexai = _fake_vertexai
sys.modules["langchain_community.chat_models.vertexai"] = _fake_vertexai
sys.modules["langchain_community.chat_models"] = _fake_cm

from ragas import evaluate as ragas_evaluate
from ragas.metrics import (
    Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall,
)
from ragas.llms import llm_factory
from ragas.embeddings import OpenAIEmbeddings
from datasets import Dataset

from deepeval.metrics import (
    FaithfulnessMetric, AnswerRelevancyMetric,
    ContextualPrecisionMetric, ContextualRecallMetric, ContextualRelevancyMetric,
)
from deepeval.test_case import LLMTestCase

os.environ["OPENAI_API_KEY"] = LLM_API_KEY
os.environ["OPENAI_API_BASE"] = LLM_ENDPOINT

# ═══════════════════════════════════════════════════════════════
# Graphiti Searcher
# ═══════════════════════════════════════════════════════════════

class GraphitiSearcher:
    def __init__(self):
        self.driver = GraphDatabase.driver("bolt://127.0.0.1:11001", auth=("neo4j", "neo4j123"))
        self.driver.verify_connectivity()
        self.emb_client = _get_client()
        self._emb_cache: Dict[str, List[float]] = {}
        print("  Graphiti Neo4j: 11001 ONLINE")

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
                    "CALL db.index.vector.queryNodes('entity_vector_idx', 30, $v) YIELD node, score "
                    "RETURN node.name AS name, node.category AS category, "
                    "node.description AS description, score ORDER BY score DESC LIMIT 10",
                    v=qv)
                entities = [dict(r) for r in rows]

                for i, e in enumerate(entities[:5]):
                    eps = s.run(
                        "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
                        "RETURN ep.source_folder AS paper, ep.author AS author, "
                        "ep.year AS year LIMIT 2", en=e["name"]).data()
                    for ep in eps:
                        cks = s.run(
                            "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
                            "WHERE c.chunk_type IN ['original','abstract'] "
                            "RETURN c.text AS text ORDER BY c.chunk_index ASC LIMIT 2",
                            p=ep["paper"]).data()
                        for ck in cks:
                            txt = str(ck.get("text", ""))[:500]
                            if len(txt) > 20:
                                contexts.append(
                                    f"[{str(ep.get('author','?'))[:20]}, {ep.get('year','?')}] {txt}")

            ctx_text = "\n".join(contexts[:20])[:5000]
            prompt = f"""你是马克思主义理论学术专家。基于上下文准确回答查询问题。
禁止编造、假设或因果推断。使用[作者, 年份]标注来源。

查询：{query}
上下文：
{ctx_text}"""
            r = _get_client().chat.completions.create(
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
# Cognee Searcher (with CACHING=false)
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
# Phase 2a: Ragas
# ═══════════════════════════════════════════════════════════════

def run_ragas(samples, engine_name):
    valid = [s for s in samples if not s.get("error") and len(s["answer"]) > 20
             and not s["answer"].startswith("[ERROR]")]
    if not valid:
        print(f"    [{engine_name}] Ragas: no valid samples")
        return {"n": 0}

    _llm_client = _get_client()
    judge_llm = llm_factory(f"openai/{JUDGE_MODEL}", client=_llm_client, max_tokens=JUDGE_MAX_TOKENS)
    judge_llm.model = JUDGE_MODEL
    judge_emb = OpenAIEmbeddings(client=_llm_client, model="text-embedding-v4")
    judge_emb.embed_query = judge_emb.embed_text
    judge_emb.embed_documents = judge_emb.embed_texts

    metrics = [
        Faithfulness(llm=judge_llm),
        AnswerRelevancy(llm=judge_llm, embeddings=judge_emb),
        ContextPrecision(llm=judge_llm),
        ContextRecall(llm=judge_llm),
    ]

    data_dict = {
        "question": [s["question"] for s in valid],
        "answer": [s["answer"] for s in valid],
        "contexts": [s["contexts"] for s in valid],
        "ground_truth": [s["ground_truth"] for s in valid],
    }
    dataset = Dataset.from_dict(data_dict)

    print(f"    [{engine_name}] Ragas: {len(valid)} samples...", flush=True)
    t0 = time.time()
    result = ragas_evaluate(dataset, metrics=metrics)
    elapsed = round(time.time() - t0, 1)

    mnames = ["faithfulness", "answer_relevancy", "context_precision", "context_recall"]
    agg = {}
    per_sample = []
    for i, s in enumerate(valid):
        row = {"id": s["id"], "question": s["question"][:60]}
        for mn in mnames:
            try:
                val = result[mn][i]
                row[mn] = round(float(val), 4) if val is not None else None
            except (KeyError, IndexError, TypeError):
                row[mn] = None
        per_sample.append(row)

    for mn in mnames:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals) / max(len(vals), 1), 4) if vals else None

    print(f"    [{engine_name}] Ragas done: {agg}")
    return {"n": len(valid), "elapsed": elapsed, "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════════════
# Phase 2b: DeepEval (串行)
# ═══════════════════════════════════════════════════════════════

def run_deepeval(samples, engine_name):
    valid = [s for s in samples if not s.get("error") and len(s["answer"]) > 20
             and not s["answer"].startswith("[ERROR]")]
    if not valid:
        print(f"    [{engine_name}] DeepEval: no valid samples")
        return {"n": 0}

    mnames = ["Faithfulness", "AnswerRelevancy", "ContextualPrecision",
              "ContextualRecall", "ContextualRelevancy"]

    def _make_metrics():
        return [
            FaithfulnessMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
            AnswerRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
            ContextualPrecisionMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
            ContextualRecallMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
            ContextualRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
        ]

    print(f"    [{engine_name}] DeepEval: {len(valid)} samples (serial)...", flush=True)
    t0 = time.time()
    per_sample = []

    for i, s in enumerate(valid):
        tc = LLMTestCase(input=s["question"], actual_output=s["answer"],
                         expected_output=s["ground_truth"],
                         retrieval_context=s["contexts"] if s["contexts"] else ["[no context]"])
        row = {"id": s["id"], "question": s["question"][:60]}
        metrics = _make_metrics()
        for mname, m in zip(mnames, metrics):
            try:
                m.measure(tc, _show_indicator=False)
                row[mname] = round(m.score, 4) if m.score is not None else None
            except Exception as e:
                row[mname] = None
        per_sample.append(row)
        if (i + 1) % 5 == 0:
            print(f"      [{engine_name}] {i+1}/{len(valid)} done", flush=True)

    elapsed = round(time.time() - t0, 1)
    agg = {}
    for mn in mnames:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals) / max(len(vals), 1), 4) if vals else None

    print(f"    [{engine_name}] DeepEval done ({elapsed}s): {agg}")
    return {"n": len(valid), "elapsed": elapsed, "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════════════
# Phase 2c: TruLens Triad (手写，功能等价)
# ═══════════════════════════════════════════════════════════════

def _triad_score(prompt, max_tokens=256):
    try:
        r = _get_client().chat.completions.create(
            model=JUDGE_MODEL, messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=max_tokens)
        m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', r.choices[0].message.content)
        return float(m.group(1)) / 10.0 if m else 0.5
    except Exception:
        return 0.5

def run_trulens_triad(samples, engine_name):
    valid = [s for s in samples if not s.get("error") and len(s["answer"]) > 20
             and not s["answer"].startswith("[ERROR]")]
    if not valid:
        print(f"    [{engine_name}] TruLens Triad: no valid samples")
        return {"n": 0}

    print(f"    [{engine_name}] TruLens Triad: {len(valid)} samples...", flush=True)
    t0 = time.time()
    per_sample = []

    for i, s in enumerate(valid):
        ctx = "\n---\n".join(s.get("contexts", ["[no context]"]))[:4000]
        ans = str(s["answer"])[:2000]
        q = s["question"]

        g_score = _triad_score(
            f"You are an information verifier. Score if the ANSWER is supported by SOURCE.\n\n"
            f"SOURCE:\n{ctx}\n\nANSWER:\n{ans}\n\n"
            f'Output JSON: {{"score": <0-10>, "reason": "<brief>"}}\nJSON:')

        cr_score = _triad_score(
            f"You are a relevance judge. Score if CONTEXTS are relevant to QUESTION.\n\n"
            f"QUESTION: {q[:500]}\n\nCONTEXTS:\n{ctx[:3000]}\n\n"
            f'Output JSON: {{"score": <0-10>, "reason": "<brief>"}}\nJSON:')

        ar_score = _triad_score(
            f"You are a relevance judge. Score if ANSWER addresses QUESTION.\n\n"
            f"QUESTION: {q[:500]}\n\nANSWER:\n{ans}\n\n"
            f'Output JSON: {{"score": <0-10>, "reason": "<brief>"}}\nJSON:')

        per_sample.append({
            "id": s["id"], "question": q[:60],
            "Groundedness": round(g_score, 4),
            "ContextRelevance": round(cr_score, 4),
            "AnswerRelevance": round(ar_score, 4),
        })

        if (i + 1) % 10 == 0:
            print(f"      [{engine_name}] {i+1}/{len(valid)} done", flush=True)

    elapsed = round(time.time() - t0, 1)
    agg = {}
    for col in ["Groundedness", "ContextRelevance", "AnswerRelevance"]:
        vals = [ps[col] for ps in per_sample if ps.get(col) is not None]
        agg[col] = round(sum(vals) / max(len(vals), 1), 4) if vals else None

    print(f"    [{engine_name}] TruLens Triad done ({elapsed}s): {agg}")
    return {"n": len(valid), "elapsed": elapsed, "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=30)
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("--skip", nargs="*", default=[], choices=["ragas", "deepeval", "trulens"],
                        help="Skip specified frameworks")
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    run_cognee = args.engine in ("cognee", "both")
    run_graphiti = args.engine in ("graphiti", "both")
    skip = set(args.skip)

    print("=" * 70)
    print("  Unified Tri-Framework RAG Evaluation")
    print(f"  Cognee: {'ON' if run_cognee else 'OFF'}  Graphiti: {'ON' if run_graphiti else 'OFF'}")
    print(f"  Judge:  {JUDGE_MODEL}")
    print(f"  Cognee cache: DISABLED (CACHING=false)")
    print(f"  Frameworks: Ragas {'✓' if 'ragas' not in skip else '✗'} | "
          f"DeepEval {'✓' if 'deepeval' not in skip else '✗'} | "
          f"TruLens Triad {'✓' if 'trulens' not in skip else '✗'}")
    print(f"  Queries: {args.sample}")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    queries = gt_data["queries"][:args.sample]

    # ═══════════════════════════════════════════════════════════
    # Phase 1: Collect answers ONCE
    # ═══════════════════════════════════════════════════════════
    print(f"\n{'─'*60}")
    print("  Phase 1: Collecting answers")
    print(f"{'─'*60}")

    graphiti_samples, cognee_samples = [], []

    if run_graphiti:
        gs = GraphitiSearcher()
        try:
            for i, q in enumerate(queries):
                t0 = time.time()
                r = gs.search(q["query"])
                s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
                     "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
                     "elapsed": r["elapsed"], "error": r.get("error")}
                graphiti_samples.append(s)
                ok = "OK" if not r.get("error") else "ERR"
                print(f"  G [{i+1:2d}/{len(queries)}] {q['id']}: {q['query'][:40]}... ({r['elapsed']:.0f}s) {ok}")
        finally:
            gs.close()

    if run_cognee:
        cs = CogneeSearcher()
        try:
            for i, q in enumerate(queries):
                t0 = time.time()
                r = await cs.search(q["query"])
                s = {"id": q["id"], "question": q["query"], "answer": r["answer"],
                     "contexts": r["contexts"], "ground_truth": q.get("ground_truth_answer", ""),
                     "elapsed": r["elapsed"], "error": r.get("error")}
                cognee_samples.append(s)
                ok = "OK" if not r.get("error") else f"ERR: {str(r.get('error',''))[:30]}"
                print(f"  C [{i+1:2d}/{len(queries)}] {q['id']}: {q['query'][:40]}... ({r['elapsed']:.0f}s) {ok}")
        finally:
            pass

    # ═══════════════════════════════════════════════════════════
    # Phase 2: Run all three frameworks
    # ═══════════════════════════════════════════════════════════
    print(f"\n{'─'*60}")
    print("  Phase 2: Evaluation")
    print(f"{'─'*60}")

    results = {"cognee": {}, "graphiti": {}}

    for engine_key, engine_label, samples in [
        ("cognee", "Cognee (11003)", cognee_samples),
        ("graphiti", "Graphiti (11001)", graphiti_samples),
    ]:
        if not samples:
            continue
        print(f"\n  === {engine_label} ===")

        if "ragas" not in skip:
            results[engine_key]["ragas"] = run_ragas(samples, engine_label)
        if "deepeval" not in skip:
            results[engine_key]["deepeval"] = run_deepeval(samples, engine_label)
        if "trulens" not in skip:
            results[engine_key]["trulens"] = run_trulens_triad(samples, engine_label)

    # ═══════════════════════════════════════════════════════════
    # Summary tables
    # ═══════════════════════════════════════════════════════════
    print(f"\n{'='*80}")
    print("  UNIFIED TRI-FRAMEWORK SUMMARY")
    print(f"{'='*80}")

    for fw_label, fw_key, fw_metrics in [
        ("Ragas", "ragas", ["faithfulness", "answer_relevancy", "context_precision", "context_recall"]),
        ("DeepEval", "deepeval", ["Faithfulness", "AnswerRelevancy", "ContextualPrecision",
                                   "ContextualRecall", "ContextualRelevancy"]),
        ("TruLens Triad", "trulens", ["Groundedness", "ContextRelevance", "AnswerRelevance"]),
    ]:
        print(f"\n  [{fw_label}]")
        print(f"  {'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
        print(f"  {'-'*50}")
        for mn in fw_metrics:
            cv = results.get("cognee", {}).get(fw_key, {}).get("aggregate", {}).get(mn)
            gv = results.get("graphiti", {}).get(fw_key, {}).get("aggregate", {}).get(mn)
            cs = f"{cv:.4f}" if cv is not None else "N/A"
            gs = f"{gv:.4f}" if gv is not None else "N/A"
            d = f"{gv - cv:+.4f}" if (cv is not None and gv is not None) else "N/A"
            print(f"  {mn:<24} {cs:>10} {gs:>10} {d:>10}")

    # ═══════════════════════════════════════════════════════════
    # Save
    # ═══════════════════════════════════════════════════════════
    ts = time.strftime("%Y%m%d_%H%M%S")
    report = {
        "framework": "Ragas+DeepEval+TruLensTriad",
        "timestamp": ts,
        "judge_model": JUDGE_MODEL,
        "n_queries": len(queries),
        "cognee_cache_disabled": True,
        "results": results,
    }
    out_path = Path(args.output) if args.output else OUTPUT_DIR / f"unified_tri_{ts}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{'='*70}")
    print(f"  Report: {out_path}")
    print(f"{'='*70}")

if __name__ == "__main__":
    asyncio.run(main())
