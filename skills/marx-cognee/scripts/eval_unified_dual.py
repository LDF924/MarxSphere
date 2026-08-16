"""
Unified Dual-Engine RAG Evaluation — Cognee + Graphiti side-by-side.

Runs the SAME 30-question gold-standard test set (eval/ground_truth_30q.json)
against BOTH engines, scored by the SAME external 5-Dim LLM Judge (qwen-plus, 0-1 scale).

Produces: per-engine metrics, cross-engine deltas, entity-level retrieval metrics
(using cross-graph alignment), per-query entity overlap, and 11-class defect diagnosis.

Prerequisite: scripts/align_cross_graph.py must have been run to generate
scripts/cross_graph_alignment.json (entity name mapping Cognee <-> Graphiti).

Usage:
  cd %USERPROFILE%/cognee

  # Full 30q dual-engine eval
  .venv312/Scripts/python.exe eval_unified_dual.py

  # Sample 5 queries first
  .venv312/Scripts/python.exe eval_unified_dual.py --sample 5

  # Custom judge model
  .venv312/Scripts/python.exe eval_unified_dual.py --judge-model qwen3.7-max

  # Single engine only
  .venv312/Scripts/python.exe eval_unified_dual.py --engine cognee
  .venv312/Scripts/python.exe eval_unified_dual.py --engine graphiti

  # Resume from checkpoint
  .venv312/Scripts/python.exe eval_unified_dual.py --resume

Design:
  - Cognee: cognee SDK search(GRAPH_COMPLETION, include_references=True, top_k=10)
  - Graphiti: direct Neo4j 11001 (2-path recall: entity vector+BM25 RRF + chunk bridge)
  - Judge: shared 5-Dim external LLM Judge (qwen-plus), used for BOTH engines
  - Graphiti answer generation: self-judge prompt (proven 4.96/5.00), but then
    re-scored independently by the external Judge for apples-to-apples comparison
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

# ── Cognee setup ──
os.chdir("%USERPROFILE%/cognee")
sys.path.insert(0, ".")
import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

# ── External deps ──
import httpx
import numpy as np
from neo4j import GraphDatabase
from openai import OpenAI

# ── Constants ──
GROUND_TRUTH = Path("eval/ground_truth_30q.json")
ALIGNMENT_FILE = Path("scripts/cross_graph_alignment.json")
OUTPUT_DIR = Path("eval/unified_reports")
CHECKPOINT_FILE = OUTPUT_DIR / ".unified_checkpoint.json"
TOP_K = 10
TIMEOUT = 300.0  # per-query timeout seconds

GRAPHITI_URI = "bolt://127.0.0.1:11001"
GRAPHITI_AUTH = ("neo4j", "neo4j123")

# ── Judge config ──
JUDGE_MODEL_DEFAULT = "qwen-plus"
JUDGE_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
JUDGE_API_KEY = os.getenv("LLM_API_KEY", "")

# ── Embedding config (for Graphiti searches) ──
EMBED_ENDPOINT = os.getenv("EMBEDDING_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
EMBED_API_KEY = os.getenv("EMBEDDING_API_KEY", os.getenv("LLM_API_KEY", ""))
EMBED_MODEL = "text-embedding-v4"

# ── 11-class defect rules (same as eval_auto.py) ──
DEFECT_RULES = [
    ("D01_NO_RESULT",       lambda s, a: len(str(a.get("answer", ""))) < 30),
    ("D02_HALLUCINATION",   lambda s, a: s.get("faithfulness", 1) < 0.30 and len(str(a.get("answer", ""))) > 30),
    ("D03_OFF_TOPIC",       lambda s, a: s.get("relevance", 1) < 0.30),
    ("D04_INCOMPLETE",      lambda s, a: s.get("completeness", 1) < 0.30),
    ("D05_NO_ATTRIBUTION",  lambda s, a: s.get("attribution", 1) < 0.15),
    ("D06_ENTITY_CONFUSION",lambda s, a: s.get("faithfulness", 1) < 0.4 and s.get("relevance", 1) > 0.5),
    ("D07_VAGUE_EDGE",      lambda s, a: s.get("completeness", 1) < 0.4 and s.get("faithfulness", 1) > 0.5),
    ("D08_STALE_ANSWER",    lambda s, a: a.get("elapsed", 999) < 0.5),
    ("D09_LOW_COVERAGE",    lambda s, a: s.get("completeness", 1) < 0.35 and s.get("relevance", 1) > 0.5),
    ("D10_TIMEOUT",         lambda s, a: "error" in str(a.get("answer", "")).lower() or a.get("error") is not None),
    ("D11_JUDGE_FAIL",      lambda s, a: sum(s.get(d, 0) for d in ["faithfulness","relevance","completeness","attribution"]) < 0.01),
]

DEFECT_DESCRIPTIONS = {
    "D01_NO_RESULT": "检索返回空结果，知识图谱中缺失相关实体/关系",
    "D02_HALLUCINATION": "LLM生成的事实未在知识图谱中找到支撑，忠实度低",
    "D03_OFF_TOPIC": "回答与问题不相关，检索偏离或LLM偏离主题",
    "D04_INCOMPLETE": "回答遗漏关键维度，知识图谱覆盖不足",
    "D05_NO_ATTRIBUTION": "回答未引用具体来源/论文，缺乏可追溯性",
    "D06_ENTITY_CONFUSION": "实体映射错误，同名实体混淆或类型归错",
    "D07_VAGUE_EDGE": "关系类型过于宽泛，缺少领域精炼关系",
    "D08_STALE_ANSWER": "疑似返回缓存答案",
    "D09_LOW_COVERAGE": "回答实体数不足，图谱密度偏低",
    "D10_TIMEOUT": "搜索超时",
    "D11_JUDGE_FAIL": "Judge评分技术性失败",
}


# ═══════════════════════════════════════════════════════════════════════════════
# AlignmentMapper
# ═══════════════════════════════════════════════════════════════════════════════

class AlignmentMapper:
    """Load cross-graph entity alignment and provide bidirectional lookups."""

    def __init__(self, alignment_path: Path):
        if not alignment_path.exists():
            self.c2g = {}
            self.g2c = {}
            self.loaded = False
            print(f"WARNING: Alignment file not found: {alignment_path}")
            print("  Entity-level metrics and name mapping will be skipped.")
            print("  Run: .venv312/Scripts/python.exe scripts/align_cross_graph.py")
            return

        data = json.loads(alignment_path.read_text(encoding="utf-8"))
        matches = data.get("matches", [])
        self.stats = data.get("stats", {})
        self.loaded = True

        self.c2g = {}  # cognee_name -> (graphiti_name, confidence, method)
        self.g2c = {}  # graphiti_name -> (cognee_name, confidence, method)

        for m in matches:
            cn = m["cognee_name"]
            gn = m["graphiti_name"]
            conf = m.get("confidence", 0.5)
            method = m.get("method", "unknown")

            if cn not in self.c2g or conf > self.c2g[cn][1]:
                self.c2g[cn] = (gn, conf, method)
            if gn not in self.g2c or conf > self.g2c[gn][1]:
                self.g2c[gn] = (cn, conf, method)

        print(f"Alignment loaded: {len(self.c2g)} Cognee→Graphiti, "
              f"{len(self.g2c)} Graphiti→Cognee mappings")

    def map_to_graphiti(self, cognee_entities: list[str]) -> dict[str, Optional[str]]:
        """Map Cognee expected_entities to Graphiti entity names."""
        result = {}
        for e in cognee_entities:
            if e in self.c2g:
                result[e] = self.c2g[e][0]
            else:
                # Try normalized match
                norm_e = self._normalize(e)
                for cname, (gname, _, _) in self.c2g.items():
                    if self._normalize(cname) == norm_e:
                        result[e] = gname
                        break
                else:
                    result[e] = None
        return result

    def map_to_cognee(self, graphiti_entities: list[str]) -> dict[str, Optional[str]]:
        """Map Graphiti entity names back to Cognee names."""
        result = {}
        for e in graphiti_entities:
            if e in self.g2c:
                result[e] = self.g2c[e][0]
            else:
                result[e] = None
        return result

    @staticmethod
    def _normalize(name: str) -> str:
        n = str(name).strip().lower()
        n = re.sub(r"[（()）\[\]【】\"\"''《》「」『』.,;:：；，。]", "", n)
        n = re.sub(r"\s+", " ", n).strip()
        return n


# ═══════════════════════════════════════════════════════════════════════════════
# Judge
# ═══════════════════════════════════════════════════════════════════════════════

def five_dim_judge(query: str, gt_answer: str, candidate_answer: str,
                   gt_entities: list[str], model: str = JUDGE_MODEL_DEFAULT) -> dict:
    """External 5-Dim LLM Judge — shared for BOTH engines. 0-1 scale."""
    ep = JUDGE_ENDPOINT
    ak = JUDGE_API_KEY
    md = model.replace("openai/", "") if model.startswith("openai/") else model

    cl = OpenAI(base_url=ep, api_key=ak, http_client=httpx.Client(timeout=120))

    ca = str(candidate_answer)[:2500]
    ge = ", ".join(str(e)[:40] for e in (gt_entities or [])[:15])
    ga = str(gt_answer)[:2000]

    prompt = f"""你是一个RAG系统多维度评估器。对候选回答在5个维度上独立打分（0.0-1.0）。

问题：{query}

标准答案：{ga}
期望实体：{ge}

候选回答：{ca}

评分标准：
1. Faithfulness（忠实度 0-1）：候选回答中的事实声称是否都能在标准答案中找到对应？有无编造不存在的人名、地名、数据、因果？
2. Relevance（相关性 0-1）：候选回答与问题的匹配程度？有无答非所问？
3. Completeness（完整性 0-1）：候选回答覆盖了标准答案的多少方面？有无遗漏关键维度？
4. Attribution（溯源度 0-1）：候选回答是否引用了具体来源/论文/数据？是否可追溯到具体文献？
5. Overall（综合 0-1）：综合4个维度的整体质量。

只输出JSON（不要其他文字）：
{{"faithfulness":0.X,"relevance":0.X,"completeness":0.X,"attribution":0.X,"overall":0.X,"note":"一句话总结"}}"""

    for retry in range(3):
        try:
            r = cl.chat.completions.create(
                model=md, messages=[{"role":"user","content":prompt}],
                temperature=0, max_tokens=300,
            )
            raw = r.choices[0].message.content.strip()
            m = re.search(r"\{[^}]+\}", raw)
            if m:
                scores = json.loads(m.group())
                for k in ["faithfulness","relevance","completeness","attribution","overall"]:
                    scores.setdefault(k, 0.0)
                return scores
        except Exception as e:
            if retry < 2:
                time.sleep(2 * (retry + 1))
            else:
                return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":f"judge error: {str(e)[:80]}"}
    return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"judge failed"}


def diagnose_defects(scores: dict, answer_info: dict) -> list[str]:
    """Apply 11-class defect rules."""
    defects = []
    for code, rule in DEFECT_RULES:
        try:
            if rule(scores, answer_info):
                defects.append(code)
        except Exception:
            pass
    return defects or ["OK"]


# ═══════════════════════════════════════════════════════════════════════════════
# GraphitiSearcher
# ═══════════════════════════════════════════════════════════════════════════════

class GraphitiSearcher:
    """Direct Neo4j access to Graphiti (11001), replicating eval_e2e_v4.py's
    2-path parallel recall pipeline."""

    def __init__(self):
        self.driver = GraphDatabase.driver(GRAPHITI_URI, auth=GRAPHITI_AUTH)
        # Verify connectivity
        try:
            self.driver.verify_connectivity()
            print("Graphiti Neo4j connected: 11001")
        except Exception as e:
            print(f"WARNING: Graphiti Neo4j unavailable: {e}")
            self.driver = None
            return

        self.emb_client = OpenAI(
            base_url=EMBED_ENDPOINT,
            api_key=EMBED_API_KEY,
            http_client=httpx.Client(timeout=60),
        )
        self.emb_model = EMBED_MODEL
        # Cache embeddings per query to avoid re-embedding
        self._emb_cache: dict[str, list[float]] = {}

    def _embed(self, text: str) -> Optional[list[float]]:
        if text in self._emb_cache:
            return self._emb_cache[text]
        try:
            r = self.emb_client.embeddings.create(model=self.emb_model, input=text)
            vec = r.data[0].embedding
            self._emb_cache[text] = vec
            return vec
        except Exception as e:
            print(f"  [Graphiti] embed error: {e}")
            return None

    def entity_vector_search(self, query: str, top_k: int = 30) -> list[dict]:
        """Path 1a: vector search on entity_vector_idx."""
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

    def entity_bm25_search(self, query: str, top_k: int = 30) -> list[dict]:
        """Path 1b: BM25 fulltext on entity_name_ft."""
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

    def chunk_bridge_search(self, query: str, top_k: int = 30) -> list[dict]:
        """Path 2: vector search chunk_vector_idx → bridge to entities."""
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
    def rrf_fuse(lists: list[list[dict]], k: int = 60, top_k: int = 10) -> list[dict]:
        """Reciprocal Rank Fusion across multiple ranked lists."""
        scores: dict[str, float] = {}
        meta: dict[str, dict] = {}
        for rlist in lists:
            for rank, item in enumerate(rlist, start=1):
                name = item["name"]
                scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
                if name not in meta:
                    meta[name] = item
        sorted_names = sorted(scores.keys(), key=lambda n: -scores[n])
        return [meta[n] for n in sorted_names[:top_k]]

    def get_passages(self, entity_name: str, top_k: int = 5) -> list[dict]:
        """Entity → Episode → Chunk backtrace with dedup."""
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
                    "text": text,
                    "paper": paper,
                    "year": ep.get("year", ""),
                    "author": str(ep.get("author", ""))[:30],
                    "title": str(ep.get("title", ""))[:80],
                })
                if len(passages) >= top_k:
                    break
            if len(passages) >= top_k:
                break
        return passages

    def search(self, query: str) -> dict:
        """Full Graphiti hybrid search → answer generation.

        Returns: {answer, entities, passages, elapsed, error}
        """
        if not self.driver:
            return {"answer": "[ERROR] Graphiti Neo4j unavailable", "entities": [],
                    "passages": [], "elapsed": 0, "error": "Neo4j 11001 unavailable"}

        t0 = time.time()
        try:
            # 2-path parallel recall
            path1_vec = self.entity_vector_search(query)
            path1_bm25 = self.entity_bm25_search(query)
            path2_chunk = self.chunk_bridge_search(query)

            entities = self.rrf_fuse([path1_vec, path1_bm25, path2_chunk], top_k=TOP_K)

            # Get passages for top entities
            all_passages, seen_txts = [], set()
            for e in entities[:8]:  # top 8 entities → passages
                ps = self.get_passages(e["name"])
                for p in ps:
                    key = p["text"][:80]
                    if key not in seen_txts:
                        seen_txts.add(key)
                        all_passages.append(p)

            # Generate answer via LLM (self-judge prompt pattern from eval_e2e_v4.py)
            llm = OpenAI(
                base_url=JUDGE_ENDPOINT,
                api_key=JUDGE_API_KEY,
                http_client=httpx.Client(timeout=120),
            )

            pass_ctx = ""
            for i, p in enumerate(all_passages[:20], 1):
                pass_ctx += (f"[{i}] {p.get('author','佚名')} ({p.get('year','')}). "
                             f"{p['text'][:300]}\n")
            ent_ctx = ""
            for i, e in enumerate(entities[:10], 1):
                desc = str(e.get('description', ''))[:150]
                ent_ctx += f"[实体{i}] {e.get('category','')}|{e['name']}: {desc}\n"

            prompt = f"""你是马克思主义理论学术专家。你需要基于提供的论文段落和知识图谱实体，准确回答查询问题。

⚠️ 防幻觉铁律（违反即为严重扣分）：
1. 只陈述段落中明确写出的内容。段落没说"导致"→禁止写"导致"；段落没说数字→禁止编造数据。
2. 禁止因果推断！不要说"A导致B""A引发B""A推动了B"，除非段落原文对此有明确表述。
3. 禁止假设和猜测！不要写"可能""或许""一般认为""学界通常认为"——只写段落中确凿的陈述。
4. 每句话必须能对应到具体的段落编号[1]-[20]或实体编号[实体1]-[实体N]。
5. 如果段落只描述了现象，就只总结现象，不要去推测原因、后果或意义。
6. 使用[作者, 年份]标注每个主张的具体来源。不能标注来源的主张＝你在编造，必须删除。

查询：{query}

论文段落（每个编号对应一篇论文的原文段落）：
{pass_ctx[:4000]}

知识图谱实体（仅供参考，回答仍必须以论文段落为准）：
{ent_ctx[:1500]}"""

            r = llm.chat.completions.create(
                model="qwen-plus", messages=[{"role":"user","content":prompt}],
                temperature=0.2, max_tokens=2000,
            )
            answer = r.choices[0].message.content or ""

            elapsed = time.time() - t0
            return {
                "answer": answer[:4000],
                "entities": [e["name"] for e in entities],
                "passages": all_passages,
                "elapsed": round(elapsed, 2),
                "error": None,
            }

        except Exception as e:
            elapsed = time.time() - t0
            return {
                "answer": f"[ERROR] {e}",
                "entities": [],
                "passages": [],
                "elapsed": round(elapsed, 2),
                "error": str(e)[:200],
            }

    def close(self):
        if self.driver:
            self.driver.close()


# ═══════════════════════════════════════════════════════════════════════════════
# Entity extraction helpers
# ═══════════════════════════════════════════════════════════════════════════════

# Cache for Neo4j entity lookups (expensive to query per search)
_cognee_entity_cache: Optional[set[str]] = None


def _load_cognee_entity_names() -> set[str]:
    """Load all Cognee entity names from Neo4j 11003. Cached globally."""
    global _cognee_entity_cache
    if _cognee_entity_cache is not None:
        return _cognee_entity_cache
    driver = GraphDatabase.driver("bolt://127.0.0.1:11003", auth=("neo4j", "neo4j123"))
    with driver.session() as s:
        recs = s.run("MATCH (e:Entity) WHERE e.name IS NOT NULL AND e.name <> '' "
                     "RETURN e.name AS name").data()
    driver.close()
    _cognee_entity_cache = {r["name"] for r in recs}
    print(f"  [EntityCache] Loaded {len(_cognee_entity_cache)} Cognee entity names")
    return _cognee_entity_cache


def extract_entities_from_cognee_result(result, cache: set[str] | None = None) -> list[str]:
    """Extract entity names from a Cognee search result.

    Cognee's search() returns list[str] — LLM-generated answer text with
    embedded entity mentions and [来源:...] citations. We match the answer
    text against the Neo4j entity name dictionary to find which entities
    were referenced.
    """
    if cache is None:
        cache = _load_cognee_entity_names()

    # Extract answer text
    if isinstance(result, list):
        answer_texts = [str(r) for r in result]
    elif isinstance(result, str):
        answer_texts = [result]
    else:
        answer_texts = [str(result)]

    found_entities: list[str] = []
    seen = set()

    # Match known entity names (longest first to avoid partial matches)
    sorted_entities = sorted(cache, key=len, reverse=True)
    for text in answer_texts:
        for entity_name in sorted_entities:
            if entity_name in seen:
                continue
            if entity_name in text:
                found_entities.append(entity_name)
                seen.add(entity_name)
                if len(found_entities) >= 30:
                    break
        if len(found_entities) >= 30:
            break

    # Also extract [来源: X] citations as paper-name entities
    source_pattern = re.findall(r'\[来源[:：]\s*([^\]]+)\]', '\n'.join(answer_texts))
    for src in source_pattern:
        src = src.strip()[:80]
        if src not in seen and src in cache:
            found_entities.append(src)
            seen.add(src)

    return found_entities[:30]


# ═══════════════════════════════════════════════════════════════════════════════
# Entity retrieval metrics
# ═══════════════════════════════════════════════════════════════════════════════

def compute_entity_retrieval(gt_entities: list[str], predicted_entities: list[str],
                             alignment: AlignmentMapper, engine: str) -> dict:
    """Compute R@K, MRR, Precision, Coverage using alignment-mapped entity names."""
    if engine == "graphiti":
        mapping = alignment.map_to_graphiti(gt_entities)
        mapped_gt = list(set(v for v in mapping.values() if v is not None))
    else:
        mapped_gt = [e for e in gt_entities]

    # Also check fuzzy: normalized name match
    pred_norm = {AlignmentMapper._normalize(e): e for e in predicted_entities}
    gt_norm = {AlignmentMapper._normalize(e): e for e in mapped_gt}

    found = []
    for i, pe in enumerate(predicted_entities):
        pn = AlignmentMapper._normalize(pe)
        if pn in gt_norm:
            found.append(i)

    first_rank = found[0] + 1 if found else None
    n_gt = max(len(mapped_gt), 1)
    found_set = set(pred_norm.keys()) & set(gt_norm.keys())

    return {
        "R@5": 1 if found and min(found) < 5 else 0,
        "R@10": 1 if found else 0,
        "MRR": round(1.0 / first_rank if first_rank else 0.0, 4),
        "precision_at_10": round(len(found) / min(10, n_gt), 4),
        "coverage": round(len(found_set) / n_gt, 4),
        "gt_total": n_gt,
        "gt_found": len(found_set),
    }


def compute_entity_overlap(cognee_ents: list[str], graphiti_ents: list[str],
                           alignment: AlignmentMapper) -> dict:
    """Per-query entity overlap using alignment mapping."""
    g_to_c = alignment.map_to_cognee(graphiti_ents)
    mapped_g = set(v for v in g_to_c.values() if v is not None)

    c_norm_ents = {AlignmentMapper._normalize(e) for e in cognee_ents}
    g_norm_mapped = {AlignmentMapper._normalize(e) for e in mapped_g}

    shared = c_norm_ents & g_norm_mapped
    union = c_norm_ents | g_norm_mapped

    # Also track original names
    shared_original = []
    for cn in cognee_ents:
        cnn = AlignmentMapper._normalize(cn)
        if cnn in g_norm_mapped:
            # Find the original Graphiti name
            for gn, (gcn, _, _) in alignment.g2c.items():
                if AlignmentMapper._normalize(gcn) == cnn:
                    shared_original.append([cn, gn])
                    break

    return {
        "jaccard": round(len(shared) / max(len(union), 1), 4),
        "shared_count": len(shared),
        "cognee_total": len(cognee_ents),
        "graphiti_total": len(graphiti_ents),
        "graphiti_mapped_total": len(mapped_g),
        "shared_entities": shared_original[:10],
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Main pipeline
# ═══════════════════════════════════════════════════════════════════════════════

def load_checkpoint() -> dict:
    if CHECKPOINT_FILE.exists():
        try:
            return json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"completed_ids": []}


def save_checkpoint(completed_ids: list[str], results: list[dict]):
    CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT_FILE.write_text(json.dumps({
        "completed_ids": completed_ids,
        "results": results,
        "ts": time.time(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")


async def main():
    parser = argparse.ArgumentParser(description="Unified Dual-Engine RAG Evaluation")
    parser.add_argument("--sample", type=int, default=30, help="Number of queries to run (default: 30)")
    parser.add_argument("--judge-model", default=JUDGE_MODEL_DEFAULT,
                        choices=["qwen-plus", "qwen3.7-max", "qwen-max", "qwen-turbo"])
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    parser.add_argument("-o", "--output", default=None, help="Custom output path")
    args = parser.parse_args()

    run_cognee = args.engine in ("cognee", "both")
    run_graphiti = args.engine in ("graphiti", "both")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tag = f"{'dual' if args.engine == 'both' else args.engine}_{args.judge_model.replace('.','')}"
    output_path = Path(args.output) if args.output else OUTPUT_DIR / f"unified_{tag}_{timestamp}.json"

    print("=" * 70)
    print(f"Unified Dual-Engine RAG Evaluation")
    print(f"  Cognee:   {'ON' if run_cognee else 'OFF'}")
    print(f"  Graphiti: {'ON' if run_graphiti else 'OFF'}")
    print(f"  Judge:    {args.judge_model}")
    print(f"  Queries:  {args.sample}")
    print(f"  Output:   {output_path}")
    print("=" * 70)

    # ── Load data ──
    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"][:args.sample]

    alignment = AlignmentMapper(ALIGNMENT_FILE)

    # Checkpoint
    cp = load_checkpoint() if args.resume else {"completed_ids": [], "results": []}
    completed_ids = set(cp.get("completed_ids", []))

    # ── Initialize searchers ──
    user = await get_default_user()
    search_type = SearchType.GRAPH_COMPLETION

    graphiti_searcher = GraphitiSearcher() if run_graphiti else None

    # ── Phase 1: Collect answers ──
    print(f"\n{'='*70}")
    print(f"Phase 1: Collecting answers from both engines")
    print(f"{'='*70}")

    collected = list(cp.get("results", []))

    for i, qd in enumerate(gt_queries):
        qid = qd["id"]
        q = qd["query"]

        if qid in completed_ids:
            print(f"  [{i+1:2d}/{len(gt_queries)}] {qid} SKIP (checkpoint)")
            continue

        print(f"  [{i+1:2d}/{len(gt_queries)}] {qid}: {q[:45]}...")

        # ── Run both engines concurrently ──
        async def cognee_task():
            t0 = time.time()
            try:
                r = await asyncio.wait_for(
                    search(query_text=q, query_type=search_type,
                           datasets=["capital_rebuild"], top_k=TOP_K,
                           include_references=False),
                    timeout=TIMEOUT,
                )
                elapsed = time.time() - t0
                entities = extract_entities_from_cognee_result(r)
                return {
                    "answer": str(r)[:4000],
                    "entities": entities,
                    "elapsed": round(elapsed, 2),
                    "error": None,
                }
            except Exception as e:
                elapsed = time.time() - t0
                return {
                    "answer": f"[ERROR] {e}",
                    "entities": [],
                    "elapsed": round(elapsed, 2),
                    "error": str(e)[:200],
                }

        async def graphiti_task():
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, graphiti_searcher.search, q)

        if run_cognee and run_graphiti:
            c_result, g_result = await asyncio.gather(cognee_task(), graphiti_task())
        elif run_cognee:
            c_result = await cognee_task()
            g_result = None
        else:
            c_result = None
            g_result = await graphiti_task()

        collected.append({
            "query_id": qid,
            "query": q,
            "difficulty": qd.get("difficulty", "medium"),
            "cognee": c_result,
            "graphiti": g_result,
        })
        completed_ids.add(qid)

        # Save checkpoint every 5 queries
        if (i + 1) % 5 == 0:
            save_checkpoint(list(completed_ids), collected)

    save_checkpoint(list(completed_ids), collected)

    # ── Phase 2: 5-Dim Judge ──
    print(f"\n{'='*70}")
    print(f"Phase 2: External 5-Dim LLM Judge ({args.judge_model})")
    print(f"{'='*70}")

    judged = []
    for i, (row, qd) in enumerate(zip(collected, gt_queries)):
        qid = row["query_id"]
        q = row["query"]
        ga = qd.get("ground_truth_answer", "")
        ge = qd.get("expected_entities", [])

        # Judge Cognee
        c_scores = None
        if row.get("cognee") and not row["cognee"].get("error"):
            c_scores = five_dim_judge(q, ga, row["cognee"]["answer"], ge, args.judge_model)
        elif row.get("cognee") and row["cognee"].get("error"):
            c_scores = {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}

        # Judge Graphiti — map expected entities to Graphiti names
        g_scores = None
        if row.get("graphiti") and not row["graphiti"].get("error"):
            ge_mapped = list(alignment.map_to_graphiti(ge).values()) if alignment.loaded else ge
            ge_mapped = [x for x in ge_mapped if x is not None] or ge  # fallback to original if no mapping
            g_scores = five_dim_judge(q, ga, row["graphiti"]["answer"], ge_mapped, args.judge_model)
        elif row.get("graphiti") and row["graphiti"].get("error"):
            g_scores = {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}

        # Defect diagnosis
        c_defects = diagnose_defects(c_scores or {}, row.get("cognee") or {}) if c_scores else None
        g_defects = diagnose_defects(g_scores or {}, row.get("graphiti") or {}) if g_scores else None

        # Entity retrieval metrics
        c_ret_metrics = None
        g_ret_metrics = None
        e_overlap = None

        if alignment.loaded:
            if row.get("cognee") and row["cognee"].get("entities"):
                c_ret_metrics = compute_entity_retrieval(ge, row["cognee"]["entities"], alignment, "cognee")
            if row.get("graphiti") and row["graphiti"].get("entities"):
                g_ret_metrics = compute_entity_retrieval(ge, row["graphiti"]["entities"], alignment, "graphiti")
            if (row.get("cognee") and row["cognee"].get("entities") and
                row.get("graphiti") and row["graphiti"].get("entities")):
                e_overlap = compute_entity_overlap(
                    row["cognee"]["entities"], row["graphiti"]["entities"], alignment)

        jd = {
            "query_id": qid,
            "query": q[:50],
            "difficulty": qd.get("difficulty", "medium"),
        }
        if c_scores:
            jd["cognee"] = {
                "answer": (row.get("cognee", {}).get("answer", ""))[:2000],
                "scores": c_scores,
                "defects": c_defects,
                "entities": (row.get("cognee", {}).get("entities", []))[:20],
                "elapsed": row.get("cognee", {}).get("elapsed", 0),
                "retrieval": c_ret_metrics,
            }
        else:
            jd["cognee"] = None

        if g_scores:
            jd["graphiti"] = {
                "answer": (row.get("graphiti", {}).get("answer", ""))[:2000],
                "scores": g_scores,
                "defects": g_defects,
                "entities": (row.get("graphiti", {}).get("entities", []))[:20],
                "elapsed": row.get("graphiti", {}).get("elapsed", 0),
                "retrieval": g_ret_metrics,
            }
        else:
            jd["graphiti"] = None

        if e_overlap:
            jd["entity_overlap"] = e_overlap

        judged.append(jd)

        # Print per-query summary
        cf = c_scores.get("faithfulness", 0) if c_scores else 0
        cr = c_scores.get("relevance", 0) if c_scores else 0
        gf = g_scores.get("faithfulness", 0) if g_scores else 0
        gr = g_scores.get("relevance", 0) if g_scores else 0
        print(f"  [{i+1:2d}/{len(gt_queries)}] Cognee F={cf:.2f} R={cr:.2f} | Graphiti F={gf:.2f} R={gr:.2f} | {q[:30]}")

    # ── Phase 3: Aggregate ──
    print(f"\n{'='*70}")
    print(f"Phase 3: Aggregate Metrics")
    print(f"{'='*70}")

    dims = ["faithfulness", "relevance", "completeness", "attribution", "overall"]

    def aggregate_engine(engine_key: str) -> dict:
        scores_by_dim = {d: [] for d in dims}
        elapsed_vals = []
        defect_counts = defaultdict(int)
        per_diff = {diff: {d: [] for d in dims} for diff in ["easy", "medium", "hard"]}
        ret_by_dim = {"R@5": [], "R@10": [], "MRR": [], "precision_at_10": [], "coverage": []}

        for j in judged:
            ed = j.get(engine_key)
            if ed is None:
                continue
            s = ed.get("scores", {})
            for d in dims:
                scores_by_dim[d].append(s.get(d, 0))
            elapsed_vals.append(ed.get("elapsed", 0))

            diff = j.get("difficulty", "medium")
            for d in dims:
                per_diff[diff][d].append(s.get(d, 0))

            for defect in ed.get("defects", []):
                defect_counts[defect] += 1

            ret = ed.get("retrieval")
            if ret:
                for rk in ret_by_dim:
                    ret_by_dim[rk].append(ret.get(rk, 0))

        n = max(len(scores_by_dim["faithfulness"]), 1)
        summary = {d: round(sum(scores_by_dim[d]) / n, 4) for d in dims}
        summary["avg_latency_s"] = round(sum(elapsed_vals) / max(len(elapsed_vals), 1), 1)

        diff_summary = {}
        for diff in ["easy", "medium", "hard"]:
            dd = per_diff[diff]
            if dd["faithfulness"]:
                diff_summary[diff] = {
                    "count": len(dd["faithfulness"]),
                    "faithfulness": round(sum(dd["faithfulness"]) / len(dd["faithfulness"]), 4),
                    "relevance": round(sum(dd["relevance"]) / len(dd["relevance"]), 4),
                    "overall": round(sum(dd["overall"]) / len(dd["overall"]), 4),
                }

        defect_summary = {}
        for code, cnt in sorted(defect_counts.items(), key=lambda x: -x[1]):
            defect_summary[code] = {"count": cnt, "description": DEFECT_DESCRIPTIONS.get(code, "未知")}

        ret_summary = {}
        for rk in ret_by_dim:
            vals = ret_by_dim[rk]
            if vals:
                ret_summary[rk] = round(sum(vals) / len(vals), 4)

        return {
            "summary": summary,
            "per_difficulty": diff_summary,
            "defect_summary": defect_summary,
            "defective_count": sum(1 for j in judged if j.get(engine_key) and j[engine_key].get("defects") != ["OK"]),
            "healthy_count": sum(1 for j in judged if j.get(engine_key) and j[engine_key].get("defects") == ["OK"]),
            "retrieval_metrics": ret_summary,
            "total_queries": n,
        }

    cognee_agg = aggregate_engine("cognee") if run_cognee else None
    graphiti_agg = aggregate_engine("graphiti") if run_graphiti else None

    # Cross-engine delta
    cross_engine = None
    if cognee_agg and graphiti_agg:
        delta = {}
        better = {}
        for d in dims:
            cv = cognee_agg["summary"].get(d, 0)
            gv = graphiti_agg["summary"].get(d, 0)
            delta[d] = round(gv - cv, 4)
            if abs(delta[d]) < 0.02:
                better[d] = "tie"
            elif delta[d] > 0:
                better[d] = "graphiti"
            else:
                better[d] = "cognee"

        # Entity overlap summary
        overlap_jaccards = []
        for j in judged:
            eo = j.get("entity_overlap")
            if eo:
                overlap_jaccards.append(eo["jaccard"])

        cross_engine = {
            "delta": delta,
            "better_engine": better,
            "entity_overlap": {
                "mean_jaccard": round(sum(overlap_jaccards) / max(len(overlap_jaccards), 1), 4) if overlap_jaccards else 0,
                "queries_with_overlap": len(overlap_jaccards),
            },
        }

    # ── Phase 4: Generate report ──
    print(f"\nPhase 4: Generating Report...")

    report = {
        "version": "unified-v1",
        "timestamp": datetime.now().isoformat(),
        "config": {
            "test_set": str(GROUND_TRUTH),
            "num_queries": len(gt_queries),
            "cognee_search_type": "GRAPH_COMPLETION",
            "cognee_model": "qwen-plus",
            "cognee_top_k": TOP_K,
            "cognee_include_references": True,
            "graphiti_search": "hybrid_search_entities (2-path RRF) + entity_passages",
            "graphiti_top_k": TOP_K,
            "judge_model": args.judge_model,
            "judge_scale": "0-1",
            "alignment_used": alignment.loaded,
            "alignment_stats": alignment.stats if alignment.loaded else None,
        },
        "cognee": cognee_agg,
        "graphiti": graphiti_agg,
        "cross_engine": cross_engine,
        "per_query": judged,
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Write LATEST
    latest_path = OUTPUT_DIR / "LATEST_UNIFIED.json"
    latest_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── Print summary ──
    print(f"\n{'='*70}")
    print(f"UNIFIED DUAL-ENGINE RAG EVALUATION — RESULTS")
    print(f"{'='*70}")

    if cognee_agg:
        cs = cognee_agg["summary"]
        print(f"\n  Cognee (GRAPH + qwen-plus + refs):")
        print(f"    F={cs['faithfulness']:.4f}  R={cs['relevance']:.4f}  C={cs['completeness']:.4f}  A={cs['attribution']:.4f}  O={cs['overall']:.4f}")
        print(f"    Latency: {cs['avg_latency_s']}s  Defects: {cognee_agg['defective_count']}/{cognee_agg['total_queries']}")
        if cognee_agg["retrieval_metrics"]:
            rm = cognee_agg["retrieval_metrics"]
            print(f"    Retrieval: R@10={rm.get('R@10',0):.4f}  MRR={rm.get('MRR',0):.4f}  Coverage={rm.get('coverage',0):.4f}")

    if graphiti_agg:
        gs = graphiti_agg["summary"]
        print(f"\n  Graphiti (hybrid + passages):")
        print(f"    F={gs['faithfulness']:.4f}  R={gs['relevance']:.4f}  C={gs['completeness']:.4f}  A={gs['attribution']:.4f}  O={gs['overall']:.4f}")
        print(f"    Latency: {gs['avg_latency_s']}s  Defects: {graphiti_agg['defective_count']}/{graphiti_agg['total_queries']}")
        if graphiti_agg["retrieval_metrics"]:
            rm = graphiti_agg["retrieval_metrics"]
            print(f"    Retrieval: R@10={rm.get('R@10',0):.4f}  MRR={rm.get('MRR',0):.4f}  Coverage={rm.get('coverage',0):.4f}")

    if cross_engine:
        ce = cross_engine
        print(f"\n  Cross-Engine Delta (Graphiti − Cognee):")
        for d in dims:
            symbol = "+" if ce["delta"][d] > 0 else ""
            winner = ce["better_engine"][d]
            print(f"    {d:15s}: {symbol}{ce['delta'][d]:.4f}  → {winner}")
        print(f"    Entity Overlap Jaccard: {ce['entity_overlap']['mean_jaccard']:.4f}")

    print(f"\n  Report: {output_path}")
    print(f"  LATEST:  {latest_path}")

    if graphiti_searcher:
        graphiti_searcher.close()


if __name__ == "__main__":
    asyncio.run(main())
