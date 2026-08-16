#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_ragas_dual.py — Ragas 双引擎评测 (Cognee + Graphiti)
═══════════════════════════════════════════════════════════════
数据流:
  30题 gold → Cognee SDK (11003) / Graphiti Neo4j (11001)
  → {question, answer, contexts, ground_truth}
  → Ragas evaluate() → JSON 报告

指标: Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall,
      AnswerCorrectness, SemanticSimilarity

Usage:
  cd %USERPROFILE%/.claude/skills/marx-graphiti/scripts
  python eval_ragas_dual.py              # full 30 questions
  python eval_ragas_dual.py --sample 5   # smoke test
  python eval_ragas_dual.py --engine cognee     # single engine
  python eval_ragas_dual.py --engine graphiti   # single engine
"""
import argparse
import asyncio
import json
import os
import sys
import time
import types
from pathlib import Path
from typing import Dict, List, Optional

# ── Monkey-patch: Ragas 0.4.3 imports langchain_community.chat_models.vertexai
#   which doesn't exist in newer langchain-community. Fake it. ──
_fake_vertexai = types.ModuleType("langchain_community.chat_models.vertexai")
_fake_vertexai.ChatVertexAI = type("FakeChatVertexAI", (), {})
_fake_chat_models = types.ModuleType("langchain_community.chat_models")
_fake_chat_models.vertexai = _fake_vertexai
sys.modules["langchain_community.chat_models.vertexai"] = _fake_vertexai
sys.modules["langchain_community.chat_models"] = _fake_chat_models

# ── Cognee path setup ──
COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

# ── Neo4j + LLM for Graphiti ──
import httpx
from neo4j import GraphDatabase
from openai import OpenAI

# ── Ragas ──
import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, module="ragas")
from ragas import evaluate
from ragas.metrics import (
    Faithfulness, AnswerRelevancy, ContextPrecision,
    ContextRecall, AnswerCorrectness,
)
from ragas.llms import llm_factory
from ragas.embeddings import OpenAIEmbeddings
from datasets import Dataset

# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════

GROUND_TRUTH = COGNEE_ROOT / "eval" / "ground_truth_30q.json"
OUTPUT_DIR = Path(__file__).parent / "eval_output"
CKPT_FILE = OUTPUT_DIR / ".ragas_checkpoint.json"

GRAPHITI_URI = "bolt://127.0.0.1:11001"
GRAPHITI_AUTH = ("neo4j", "neo4j123")

COGNEE_URI = "bolt://127.0.0.1:11003"
COGNEE_AUTH = ("neo4j", "neo4j123")

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
EMBED_MODEL = "text-embedding-v4"
TOP_K = 10

# ═══════════════════════════════════════════════════════════════
# Ragas Judge 配置 — qwen3.7-max via DashScope
# ═══════════════════════════════════════════════════════════════
JUDGE_MODEL = "qwen3.7-max"
JUDGE_MAX_TOKENS = 4096

_llm_client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_ENDPOINT,
                     http_client=httpx.Client(timeout=120))

_judge_llm = llm_factory(f"openai/{JUDGE_MODEL}", client=_llm_client, max_tokens=JUDGE_MAX_TOKENS)
_judge_llm.model = JUDGE_MODEL  # strip provider prefix for DashScope

_judge_emb = OpenAIEmbeddings(client=_llm_client, model="text-embedding-v4")
# Patch: Ragas metrics expect embed_query/embed_documents but OpenAIEmbeddings
# exposes embed_text/embed_texts. Alias them.
_judge_emb.embed_query = _judge_emb.embed_text
_judge_emb.embed_documents = _judge_emb.embed_texts

RAGAS_METRICS = [
    Faithfulness(llm=_judge_llm),
    AnswerRelevancy(llm=_judge_llm, embeddings=_judge_emb),
    ContextPrecision(llm=_judge_llm),
    ContextRecall(llm=_judge_llm),
]


# ═══════════════════════════════════════════════════════════════
# GraphitiSearcher (复用 eval_unified_dual.py 的 2-path pipeline)
# ═══════════════════════════════════════════════════════════════

class GraphitiSearcher:
    """Direct Neo4j access to Graphiti (11001) — 2-path parallel recall."""

    def __init__(self):
        self.driver = GraphDatabase.driver(GRAPHITI_URI, auth=GRAPHITI_AUTH)
        self.driver.verify_connectivity()
        print("Graphiti Neo4j connected: 11001")

        self.emb_client = OpenAI(
            base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
            http_client=httpx.Client(timeout=60))
        self._emb_cache: Dict[str, List[float]] = {}

    def _embed(self, text: str) -> Optional[List[float]]:
        if text in self._emb_cache:
            return self._emb_cache[text]
        try:
            r = self.emb_client.embeddings.create(model=EMBED_MODEL, input=text)
            vec = r.data[0].embedding
            self._emb_cache[text] = vec
            return vec
        except Exception as e:
            print(f"  [Graphiti] embed error: {e}")
            return None

    def entity_vector_search(self, query: str, top_k: int = 30) -> List[Dict]:
        qv = self._embed(query)
        if qv is None:
            return []
        with self.driver.session() as s:
            rows = s.run(
                "CALL db.index.vector.queryNodes('entity_vector_idx', $tk, $v) "
                "YIELD node, score "
                "RETURN node.name AS name, node.category AS category, "
                "node.description AS description, score "
                "ORDER BY score DESC LIMIT $k",
                tk=top_k, v=qv, k=top_k)
            return [dict(r) for r in rows]

    def entity_bm25_search(self, query: str, top_k: int = 30) -> List[Dict]:
        try:
            with self.driver.session() as s:
                rows = s.run(
                    "CALL db.index.fulltext.queryNodes('entity_name_ft', $q) "
                    "YIELD node, score "
                    "RETURN node.name AS name, node.category AS category, "
                    "node.description AS description, score "
                    "ORDER BY score DESC LIMIT $k",
                    q=query, k=top_k)
                return [dict(r) for r in rows]
        except Exception:
            return []

    def chunk_bridge_search(self, query: str, top_k: int = 30) -> List[Dict]:
        qv = self._embed(query)
        if qv is None:
            return []
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
    def rrf_fuse(lists: List[List[Dict]], k: int = 60, top_k: int = 10) -> List[Dict]:
        scores: Dict[str, float] = {}
        meta: Dict[str, Dict] = {}
        for rlist in lists:
            for rank, item in enumerate(rlist, start=1):
                name = item["name"]
                scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
                if name not in meta:
                    meta[name] = item
        return [meta[n] for n in sorted(scores, key=lambda n: -scores[n])[:top_k]]

    def get_passages(self, entity_name: str, top_k: int = 5) -> List[Dict]:
        if not self.driver:
            return []
        with self.driver.session() as s:
            entities = s.run(
                "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($en) "
                "RETURN e.name AS name LIMIT 1", en=entity_name).data()
            if not entities:
                return []
            e_name = entities[0]["name"]
            episodes = s.run(
                "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper, ep.title AS title, "
                "ep.year AS year, ep.author AS author LIMIT 3", en=e_name).data()

        passages, seen = [], set()
        for ep in episodes:
            paper = ep["paper"]
            if paper in seen:
                continue
            seen.add(paper)
            with self.driver.session() as s2:
                chunks = s2.run(
                    "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
                    "WHERE c.chunk_type IN ['original','abstract'] "
                    "RETURN c.text AS text, c.chunk_type AS ct "
                    "ORDER BY c.chunk_index ASC LIMIT 3", p=paper).data()
            for ck in chunks:
                text = str(ck.get("text", ""))[:500]
                if len(text) < 20:
                    continue
                passages.append({
                    "text": text, "paper": paper,
                    "year": ep.get("year", ""),
                    "author": str(ep.get("author", ""))[:30],
                })
                if len(passages) >= top_k:
                    break
            if len(passages) >= top_k:
                break
        return passages

    def search(self, query: str) -> Dict:
        """2-path recall + answer generation. Returns {answer, entities, passages, elapsed, error}."""
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
2. 禁止因果推断——不要说"A导致B""A引发B"，除非段落原文对此有明确表述
3. 禁止假设和猜测——不要写"可能""或许""一般认为"
4. 每句话必须能对应到具体的段落编号
5. 使用[作者, 年份]标注每个主张的具体来源

查询：{query}

论文段落：
{pass_ctx[:4000]}

知识图谱实体：
{ent_ctx[:1500]}"""

            r = llm.chat.completions.create(
                model="qwen-plus",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2, max_tokens=2000)
            answer = r.choices[0].message.content or ""

            return {
                "answer": answer[:4000],
                "entities": [e["name"] for e in entities],
                "passages": all_passages,
                "elapsed": round(time.time() - t0, 2),
                "error": None,
            }
        except Exception as e:
            return {
                "answer": f"[ERROR] {e}",
                "entities": [], "passages": [],
                "elapsed": round(time.time() - t0, 2),
                "error": str(e)[:200],
            }

    def close(self):
        if self.driver:
            self.driver.close()


# ═══════════════════════════════════════════════════════════════
# CogneeSearcher — via SDK
# ═══════════════════════════════════════════════════════════════

class CogneeSearcher:
    """Cognee SDK wrapper — returns answer + contexts for Ragas."""

    def __init__(self):
        self.user = None  # set async
        self.driver = GraphDatabase.driver(COGNEE_URI, auth=COGNEE_AUTH)
        self.driver.verify_connectivity()
        print("Cognee Neo4j connected: 11003")

    async def _get_user(self):
        if self.user is None:
            self.user = await get_default_user()
        return self.user

    async def search(self, query: str) -> Dict:
        """Search Cognee: CHUNKS for contexts, GRAPH_COMPLETION for answer."""
        t0 = time.time()
        user = await self._get_user()

        try:
            # ── Get contexts from CHUNKS search ──
            chunks_result = await search(
                query_type=SearchType.CHUNKS, query_text=query,
                top_k=TOP_K, user=user)
            contexts = self._extract_chunk_texts(chunks_result)

            # ── Get answer from GRAPH_COMPLETION ──
            answer_result = await search(
                query_type=SearchType.GRAPH_COMPLETION, query_text=query,
                top_k=TOP_K, user=user)
            answer = self._extract_answer_text(answer_result)

            return {
                "answer": answer[:4000] if answer else "[EMPTY]",
                "contexts": contexts,
                "elapsed": round(time.time() - t0, 2),
                "error": None,
            }
        except Exception as e:
            return {
                "answer": f"[ERROR] {e}",
                "contexts": [],
                "elapsed": round(time.time() - t0, 2),
                "error": str(e)[:200],
            }

    @staticmethod
    def _extract_chunk_texts(result) -> List[str]:
        """Extract text chunks from Cognee CHUNKS search result."""
        texts = []
        if isinstance(result, list):
            for item in result:
                if isinstance(item, str):
                    texts.append(item[:500])
                elif isinstance(item, dict):
                    txt = item.get("text") or item.get("content") or str(item)
                    texts.append(str(txt)[:500])
                else:
                    texts.append(str(item)[:500])
        elif isinstance(result, str):
            texts.append(result[:500])
        return texts[:20]  # cap at 20

    @staticmethod
    def _extract_answer_text(result) -> str:
        """Extract answer from Cognee GRAPH_COMPLETION result."""
        if isinstance(result, list):
            return "\n".join(str(r) for r in result)
        return str(result)

    def close(self):
        if self.driver:
            self.driver.close()


# ═══════════════════════════════════════════════════════════════
# Ragas 数据收集
# ═══════════════════════════════════════════════════════════════

def collect_graphiti_samples(searcher: GraphitiSearcher,
                             queries: List[Dict]) -> List[Dict]:
    """Run all queries through Graphiti, return Ragas-format samples."""
    samples = []
    for i, q in enumerate(queries):
        print(f"  Graphiti [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...", end=" ", flush=True)
        result = searcher.search(q["query"])
        # contexts = passage texts
        contexts = [p["text"][:500] for p in result.get("passages", [])]
        if not contexts:
            # fallback: entity descriptions as contexts
            contexts = [f"{e}: {searcher.entity_vector_search(q['query'], top_k=5)}"]

        sample = {
            "question": q["query"],
            "answer": result["answer"],
            "contexts": contexts if contexts else ["[no contexts retrieved]"],
            "ground_truth": q.get("ground_truth_answer", ""),
            "id": q["id"],
            "engine": "Graphiti",
            "elapsed": result["elapsed"],
            "error": result.get("error"),
        }
        samples.append(sample)
        status = "OK" if not result.get("error") else f"ERR: {result['error'][:40]}"
        print(f"({result['elapsed']:.1f}s, {len(contexts)}ctx) {status}")
    return samples


async def collect_cognee_samples(searcher: CogneeSearcher,
                                 queries: List[Dict]) -> List[Dict]:
    """Run all queries through Cognee, return Ragas-format samples."""
    samples = []
    for i, q in enumerate(queries):
        print(f"  Cognee   [{i+1}/{len(queries)}] {q['id']}: {q['query'][:50]}...", end=" ", flush=True)
        result = await searcher.search(q["query"])
        contexts = result.get("contexts", [])
        sample = {
            "question": q["query"],
            "answer": result["answer"],
            "contexts": contexts if contexts else ["[no contexts retrieved]"],
            "ground_truth": q.get("ground_truth_answer", ""),
            "id": q["id"],
            "engine": "Cognee",
            "elapsed": result["elapsed"],
            "error": result.get("error"),
        }
        samples.append(sample)
        status = "OK" if not result.get("error") else f"ERR: {result['error'][:40]}"
        print(f"({result['elapsed']:.1f}s, {len(contexts)}ctx) {status}")
    return samples


# ═══════════════════════════════════════════════════════════════
# Ragas 评测 + 报告
# ═══════════════════════════════════════════════════════════════

def run_ragas_eval(samples: List[Dict], engine_name: str) -> Dict:
    """Run Ragas metrics on collected samples."""
    # Filter out errors
    valid = [s for s in samples if not s.get("error") and s["answer"] and
             not s["answer"].startswith("[ERROR]") and len(s["answer"]) > 20]

    skipped = len(samples) - len(valid)
    if skipped:
        print(f"  [{engine_name}] Skipping {skipped} samples with errors/empty answers")

    if not valid:
        print(f"  [{engine_name}] No valid samples — skipping Ragas eval")
        return {"engine": engine_name, "error": "no valid samples", "n": 0}

    data_dict = {
        "question": [s["question"] for s in valid],
        "answer": [s["answer"] for s in valid],
        "contexts": [s["contexts"] for s in valid],
        "ground_truth": [s["ground_truth"] for s in valid],
    }
    dataset = Dataset.from_dict(data_dict)

    print(f"  [{engine_name}] Running Ragas on {len(valid)} samples...")
    t0 = time.time()
    result = evaluate(dataset, metrics=RAGAS_METRICS)
    elapsed = time.time() - t0
    print(f"  [{engine_name}] Ragas done in {elapsed:.1f}s")

    # Convert EvaluationResult to dict (keyed-access by string metric name)
    result_dict = {}
    try:
        for key in ["faithfulness", "answer_relevancy", "context_precision",
                     "context_recall"]:
            try:
                vals = result[key]
                result_dict[key] = list(vals) if hasattr(vals, '__iter__') else vals
            except (KeyError, TypeError):
                result_dict[key] = []
    except Exception as e:
        print(f"  Warning: Could not parse result: {e}")
        result_dict = {"error": str(e)}
    result_dict["engine"] = engine_name
    result_dict["n_samples"] = len(valid)
    result_dict["n_skipped"] = skipped
    result_dict["ragas_elapsed"] = round(elapsed, 1)

    # Per-sample scores for detailed report
    per_sample = []
    for i, s in enumerate(valid):
        row = {"id": s["id"], "question": s["question"][:80]}
        for metric_name in ["faithfulness", "answer_relevancy", "context_precision",
                            "context_recall"]:
            vals = result_dict.get(metric_name, [])
            if isinstance(vals, list) and i < len(vals):
                row[metric_name] = round(vals[i], 4) if vals[i] is not None else None
        per_sample.append(row)
    result_dict["per_sample"] = per_sample

    return result_dict


def print_summary(cognee_result: Dict, graphiti_result: Dict):
    """Print comparison table."""
    print()
    print("=" * 80)
    print("  Ragas Dual-Engine Evaluation — Summary")
    print("=" * 80)

    metric_names = ["faithfulness", "answer_relevancy", "context_precision",
                    "context_recall", "answer_correctness"]
    labels = ["Faithfulness", "AnswerRelevancy", "ContextPrecision",
              "ContextRecall", "AnswerCorrectness"]

    print(f"{'Metric':<22} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
    print("-" * 55)

    for mname, label in zip(metric_names, labels):
        cv = cognee_result.get(mname)
        gv = graphiti_result.get(mname)

        if isinstance(cv, list):
            cv = sum(x for x in cv if x is not None) / max(len([x for x in cv if x is not None]), 1)
        if isinstance(gv, list):
            gv = sum(x for x in gv if x is not None) / max(len([x for x in gv if x is not None]), 1)

        cs = f"{cv:.4f}" if cv is not None else "N/A"
        gs = f"{gv:.4f}" if gv is not None else "N/A"
        if cv is not None and gv is not None:
            delta = f"{gv - cv:+.4f}"
        else:
            delta = "N/A"
        print(f"{label:<22} {cs:>10} {gs:>10} {delta:>10}")

    print("-" * 55)
    nc = cognee_result.get("n_samples", 0)
    ng = graphiti_result.get("n_samples", 0)
    print(f"  Cognee: {nc} samples, Graphiti: {ng} samples")
    print("=" * 80)


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

async def main():
    parser = argparse.ArgumentParser(description="Ragas Dual-Engine RAG Evaluation")
    parser.add_argument("--sample", type=int, default=30)
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    run_cognee = args.engine in ("cognee", "both")
    run_graphiti = args.engine in ("graphiti", "both")

    print("=" * 70)
    print("  Ragas Dual-Engine RAG Evaluation")
    print(f"  Cognee:   {'ON' if run_cognee else 'OFF'}")
    print(f"  Graphiti: {'ON' if run_graphiti else 'OFF'}")
    print(f"  Judge:    {JUDGE_MODEL} (via LiteLLM → DashScope)")
    print(f"  Queries:  up to {args.sample}")
    print("=" * 70)

    # ── Load data ──
    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    queries = gt_data["queries"][:args.sample]
    print(f"Loaded {len(queries)} queries from ground_truth_30q.json")

    # ── Phase 1: Collect samples from both engines ──
    print(f"\n{'─'*60}")
    print("  Phase 1: Collecting answers from engines")
    print(f"{'─'*60}")

    graphiti_samples, cognee_samples = [], []

    if run_graphiti:
        gs = GraphitiSearcher()
        try:
            graphiti_samples = collect_graphiti_samples(gs, queries)
        finally:
            gs.close()

    if run_cognee:
        cs = CogneeSearcher()
        try:
            cognee_samples = await collect_cognee_samples(cs, queries)
        finally:
            cs.close()

    # ── Phase 2: Ragas evaluation ──
    print(f"\n{'─'*60}")
    print("  Phase 2: Ragas evaluation")
    print(f"{'─'*60}")

    cognee_result, graphiti_result = {}, {}

    if run_cognee and cognee_samples:
        cognee_result = run_ragas_eval(cognee_samples, "Cognee (11003)")

    if run_graphiti and graphiti_samples:
        graphiti_result = run_ragas_eval(graphiti_samples, "Graphiti (11001)")

    # ── Phase 3: Report ──
    if cognee_result and graphiti_result:
        print_summary(cognee_result, graphiti_result)
    elif cognee_result:
        print_summary(cognee_result, {"n_samples": 0})
    elif graphiti_result:
        print_summary({"n_samples": 0}, graphiti_result)

    # ── Save ──
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    report = {
        "framework": "Ragas v0.4.3",
        "timestamp": timestamp,
        "judge_model": JUDGE_MODEL,
        "n_queries": len(queries),
        "cognee": cognee_result,
        "graphiti": graphiti_result,
        "raw_samples": {
            "cognee": cognee_samples,
            "graphiti": graphiti_samples,
        },
    }

    out_path = Path(args.output) if args.output else OUTPUT_DIR / f"ragas_dual_{timestamp}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nReport saved: {out_path}")

if __name__ == "__main__":
    asyncio.run(main())
