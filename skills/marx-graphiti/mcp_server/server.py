#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
graphrag-marx MCP Server — 马克思主义理论 GraphRAG 知识检索
═══════════════════════════════════════════════════════════════
Provides 17 tools, 2 resources, 1 prompt template for querying and exploring
a Neo4j knowledge graph of 208 Chinese Marxist theory papers.

Transport: stdio          Python >= 3.10 + mcp >= 1.0
Root:      D:\\Desktop\\执行流程
Neo4j:     bolt://127.0.0.1:11001
Cache:     D:/cache/text_cache.db
"""

import sys
import re
import json
import os
import sqlite3
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime
from typing import Optional

# ── Path setup ───────────────────────────────────────────────
_PIPELINE_ROOT = Path(r"D:\Desktop\执行流程")
if str(_PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_ROOT))

_LOG_DIR = Path(r"D:\Desktop\执行流程\.mcp_logs")
try:
    _LOG_DIR.mkdir(exist_ok=True)
except (PermissionError, OSError):
    import tempfile
    _LOG_DIR = Path(tempfile.gettempdir()) / "graphrag_marx_logs"
    _LOG_DIR.mkdir(exist_ok=True)

from mcp.server.fastmcp import FastMCP

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [graphrag-marx] %(levelname)-7s %(message)s",
    handlers=[
        logging.FileHandler(_LOG_DIR / "graphrag_marx_mcp.log", encoding="utf-8"),
        logging.StreamHandler(sys.stderr),  # P2: MCP JSON-RPC on stdout, business logs on stderr
    ],
)
logger = logging.getLogger("graphrag-marx.mcp")


# ── Lifespan ──────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize on startup, cleanup on shutdown."""
    logger.info("graphrag-marx MCP server starting...")
    try:
        nc = _get_neo4j()
        if nc:
            # Sanity check
            total = nc.execute_query("MATCH (n) RETURN count(n) AS c LIMIT 1")[0]["c"]
            logger.info(f"Neo4j connected — {total} nodes reachable")
        else:
            logger.warning("Neo4j NOT available on startup")
    except Exception as e:
        logger.error(f"Startup sanity check failed: {e}")

    yield  # ── server runs here ──

    # Cleanup
    logger.info("graphrag-marx MCP server shutting down...")
    _reset_neo4j()


mcp = FastMCP(
    name="graphrag-marx",
    instructions=(
        "马克思主义理论 GraphRAG 知识检索服务。"
        "当用户询问马克思主义理论、哲学概念、社会学术语、论文内容、理论演化等问题时，"
        "使用本服务的工具从 Neo4j 知识图谱中检索。"
        "检索策略：1) 用 search_by_concept 或 hybrid_search_entities 找到相关实体 "
        "2) 用 get_entity_info 查看实体详情和图邻居 "
        "3) 用 get_distill_content 获取该实体对应论文的五层知识蒸馏 "
        "4) 用 get_domain_knowledge 获取领域全局归纳。"
        "始终优先使用纯 Cypher 搜索（免费），向量搜索仅在语义匹配需求时使用。"
    ),
    lifespan=lifespan,
)

# ═══════════════════════════════════════════════════════════════
# Infrastructure
# ═══════════════════════════════════════════════════════════════

_neo4j_lock = threading.Lock()
_neo4j_instance: Optional[object] = None
_neo4j_error: Optional[str] = None

# ── In-memory caches (avoid repeated Neo4j reads) ──────────
_cache_lock = threading.Lock()
_entity_cache: dict[str, dict] = {}      # entity_name -> {category, description, ...}
_vector_cache: dict[str, list] = {}      # query_text -> embedding vector
_passage_cache: dict[str, list] = {}     # entity_name -> [passages]
MAX_CACHE_ENTRIES = 2000  # was 500 — raised for SAG三层检索高并发场景


def _cached_entity_lookup(nc, name: str) -> Optional[dict]:
    """Look up entity with in-memory cache to avoid repeated Neo4j reads."""
    key = name.lower()
    with _cache_lock:
        if key in _entity_cache:
            return _entity_cache[key]
    try:
        rows = nc.execute_query(
            "MATCH (e:Entity) WHERE toLower(e.name) = toLower($n) "
            "RETURN e.name AS name, e.category AS category, "
            "e.description AS description LIMIT 1", {"n": name})
        if rows:
            entry = {"name": rows[0]["name"], "category": rows[0].get("category", ""),
                     "description": str(rows[0].get("description", ""))[:300]}
        else:
            entry = None
    except Exception:
        entry = None
    with _cache_lock:
        if len(_entity_cache) < MAX_CACHE_ENTRIES:
            _entity_cache[key] = entry
    return entry


def _cached_vector(emb, text: str) -> Optional[list]:
    """Get embedding vector with in-memory cache."""
    key = text[:200]
    with _cache_lock:
        if key in _vector_cache:
            return _vector_cache[key]
    vec = emb.embed(text)
    with _cache_lock:
        if len(_vector_cache) < MAX_CACHE_ENTRIES:
            _vector_cache[key] = vec
    return vec


def _cached_passages(nc, entity_name: str, top_k: int = 5) -> list:
    """Get entity passages with in-memory cache."""
    key = f"{entity_name}:{top_k}"
    with _cache_lock:
        if key in _passage_cache:
            return _passage_cache[key]
    # Fall through to regular lookup (set below)
    return None  # signal cache miss


def _get_neo4j():
    """Lazy-initialize a Neo4jConnection singleton. Returns None on failure."""
    global _neo4j_instance, _neo4j_error
    from pipeline.neo4j import Neo4jConnection
    with _neo4j_lock:
        if _neo4j_instance is not None:
            return _neo4j_instance
        if _neo4j_error is not None:
            return None
    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        nc.execute_query("MATCH (n) RETURN count(n) AS c LIMIT 1")
        with _neo4j_lock:
            _neo4j_instance = nc
            _neo4j_error = None
        logger.info("Neo4j connection established")
        return nc
    except Exception as e:
        with _neo4j_lock:
            _neo4j_error = str(e)
        logger.error(f"Neo4j connection failed: {e}")
        return None


def _reset_neo4j():
    """Drop the singleton (after a connection error)."""
    global _neo4j_instance, _neo4j_error
    with _neo4j_lock:
        if _neo4j_instance is not None:
            try:
                _neo4j_instance.close()
            except Exception:
                pass
        _neo4j_instance = None
        _neo4j_error = None
    logger.warning("Neo4j connection reset")


def _neo4j_ok() -> dict:
    """Return {ok: bool, nc?: object, error?: str}."""
    if _neo4j_error:
        return {"ok": False, "error": f"Neo4j unavailable: {_neo4j_error}"}
    nc = _get_neo4j()
    if nc is None:
        return {"ok": False, "error": "Neo4j not connected"}
    return {"ok": True, "nc": nc}


# ── Input validation ──────────────────────────────────────────
def _sanitize_str(s: str, max_len: int = 500) -> str:
    """Truncate and strip dangerous chars from user input."""
    if not isinstance(s, str):
        return ""
    return s.strip()[:max_len]


def _is_safe_param_value(v) -> bool:
    """Reject param values that look like Cypher injection."""
    if isinstance(v, str):
        for kw in ["MATCH ", "MERGE ", "CREATE ", "DELETE ", "DETACH "]:
            if kw in v.upper():
                return False
    return True


# ── Read-only Cypher guard ────────────────────────────────────
_WRITE_RE = re.compile(
    r'\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b', re.IGNORECASE
)

def _validate_read_only(query: str) -> Optional[str]:
    """Return error message if query contains write keywords."""
    m = _WRITE_RE.search(query)
    if m:
        return (
            f"Dangerous operation '{m.group(1)}' blocked. "
            "This MCP server only allows read queries (MATCH/CALL/SHOW/EXPLAIN). "
            "Use the CLI scripts at D:\\Desktop\\执行流程 for write operations."
        )
    return None


def _auto_limit(query: str, limit: int = 50) -> str:
    """Append LIMIT if the query does not already have one."""
    q = query.rstrip().rstrip(';')
    if ' LIMIT ' not in q.upper() and not q.rstrip().upper().endswith('LIMIT'):
        return f"{q} LIMIT {limit}"
    return q


# ── Embedding client (lazy, only for hybrid search) ───────────
def _get_qwen_embedding_client():
    """Lazy-import QwenEmbeddingClient. Returns None on failure."""
    try:
        from pipeline.api_client import QwenEmbeddingClient
        return QwenEmbeddingClient()
    except Exception as e:
        logger.warning(f"Embedding client unavailable: {e}")
        return None


def _embed_query(text: str) -> Optional[list]:
    """Embed a query string. Returns list of floats or None."""
    emb = _get_qwen_embedding_client()
    if emb is None:
        return None
    try:
        return emb.embed(text)
    except Exception as e:
        logger.warning(f"Embedding failed: {e}")
        return None


# ── LLM client (lazy, for HyDE and reranker) ──────────────
def _get_llm_client():
    """Lazy-import QwenMaxClient. Returns None on failure."""
    try:
        from pipeline.api_client import QwenMaxClient
        from pipeline.config import get_qwen_max_config
        cfg = get_qwen_max_config()
        return QwenMaxClient(api_key=cfg["api_key"], base_url=cfg["base_url"], model=cfg["model"])
    except Exception as e:
        logger.warning(f"LLM client unavailable: {e}")
        return None
# ── Vector helper (used by hybrid_search) ───────────────────
def _vector_search(nc, query: str, q_vec: list, top_k: int = 30) -> list[dict]:
    """Execute a vector index search with a pre-computed embedding."""
    try:
        rows = nc.execute_query(
            f"CALL db.index.vector.queryNodes('entity_vector_idx', {top_k}, $v) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS category, node.description AS description, score "
            "ORDER BY score DESC LIMIT $k",
            {"v": q_vec, "k": top_k}
        )
        return [{"name": r["name"], "category": r.get("category", ""),
                 "description": str(r.get("description", ""))[:250],
                 "score": round(r["score"], 4)} for r in rows]
    except Exception as e:
        logger.warning(f"Vector search failed: {e}")
        return []
# V388: 弃用 OpenAIRerankerClient（OpenAI 兼容 API 不支持 logprobs，rerank 一直无效）
# 改为直接调 DashScope 原生 rerank API（qwen3-rerank cross-encoder），与 SAG rerank-client 同款
_RERANK_API_KEY = os.getenv("DASHSCOPE_API_KEY", "sk-ws-H.EIYLDIH.3DGy.MEQCIG5LQXAHT_Dr6bTIpDpiDWorHbJ7wI3QkWs92HHHKhTXAiAhzsfJD3TOWMPacyK8JBNJMyDT4ecRFQozgFZI_EhRtg")
_RERANK_URL = "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
_RERANK_MODEL = "qwen3-rerank"


async def _rerank(query: str, candidates: list[dict], top_k: int = 10) -> list[dict]:
    """Re-rank candidates with DashScope qwen3-rerank (native cross-encoder). Falls back gracefully."""
    if not candidates:
        return []
    try:
        import aiohttp
        passages = [f"[{c.get('category','')}] {c['name']}: {str(c.get('description',''))[:200]}" for c in candidates]
        payload = {"model": _RERANK_MODEL, "input": {"query": query, "documents": passages}}
        async with aiohttp.ClientSession() as session:
            async with session.post(_RERANK_URL, json=payload, headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {_RERANK_API_KEY}",
            }, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                if resp.status != 200:
                    logger.warning(f"Rerank HTTP {resp.status}, falling back to top-K")
                    return candidates[:top_k]
                data = await resp.json()
        results = (data.get("output") or {}).get("results") or []
        if not results:
            return candidates[:top_k]
        score_map = {r.get("index"): r.get("relevance_score", 0.0) for r in results}
        ordered = []
        seen = set()
        for idx, c in enumerate(candidates):
            if idx in score_map:
                ordered.append({**c, "rerank_score": round(float(score_map[idx]), 4)})
                seen.add(c['name'])
        # 按 rerank_score 降序
        ordered.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
        # 补全未返回的候选
        for c in candidates:
            if c['name'] not in seen:
                ordered.append(c)
                seen.add(c['name'])
                if len(ordered) >= top_k:
                    break
        return ordered[:top_k]
    except Exception as e:
        logger.warning(f"Rerank failed, returning top-K candidates: {e}")
        return candidates[:top_k]


# ── BM25 fulltext helper ────────────────────────────────────
def _bm25_search(nc, query: str, top_k: int = 20) -> list[dict]:
    """Fulltext search via Neo4j fulltext index."""
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
        logger.warning(f"BM25 search failed: {e}")
        return []


# ── RRF fusion ──────────────────────────────────────────────
def _rrf_fusion(ranked_lists: list[list[dict]], k: int = 60, top_k: int = 30) -> list[dict]:
    """Reciprocal Rank Fusion: merge multiple ranked result lists."""
    scores: dict[str, float] = {}
    meta: dict[str, dict] = {}
    for rlist in ranked_lists:
        for rank, item in enumerate(rlist, start=1):
            name = item["name"]
            scores[name] = scores.get(name, 0) + 1.0 / (k + rank)
            if name not in meta:
                meta[name] = item
    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    results = []
    for name, rrf_score in merged:
        item = meta.get(name, {"name": name, "category": "", "description": "", "score": 0})
        results.append({**item, "score": round(rrf_score, 4)})
    return results


# ═══════════════════════════════════════════════════════════════
# Query Processing Layer (improved 2026-07-03)
# ═══════════════════════════════════════════════════════════════

# ── LLM multi-query rewrite ─────────────────────────────────
def _llm_rewrite_query(llm, query: str) -> list[str]:
    """Use LLM to rewrite a natural language query into multiple variant forms:
    - keyword-form: extract core concepts as space-separated keywords
    - academic-form: standardize to academic terminology
    - synonym-form: paraphrase with alternative academic phrasing

    Returns up to 3 rewritten variants (not including the original).
    Returns empty list on failure.
    """
    if llm is None:
        return []
    try:
        prompt = (
            "将以下学术查询改写为3种不同表述形式，用于增强信息检索：\n\n"
            f"原始查询：{query}\n\n"
            "输出JSON：{\"variants\": [\"关键词形式\", \"学术术语标准化形式\", \"同义改写形式\"]}\n"
            "只输出JSON。"
        )
        result = llm.call_json(prompt, max_retries=2, timeout=60,
                               system_prompt="只输出JSON对象。")
        if result and isinstance(result, dict):
            return result.get("variants", [])[:3]
    except Exception as e:
        logger.warning(f"LLM rewrite failed: {e}")
    return []


# ── Complex query decomposition ──────────────────────────────
def _decompose_query(llm, query: str) -> Optional[dict]:
    """Detect if a query contains multiple sub-questions and decompose it.

    A query like "比较A理论和B理论对X概念理解的差异" contains:
      - sub_queries: ["A理论对X概念的理解", "B理论对X概念的理解", "A理论和B理论的关系"]
      - strategy: "parallel" (search all sub-queries in parallel and merge)

    Returns None if the query is simple (single-faceted).
    Returns {"sub_queries": [...], "strategy": "parallel|sequential"} if complex.
    """
    if llm is None:
        return None
    try:
        prompt = (
            "判断以下学术查询是否为复合问题（包含多个可独立检索的子问题）。\n\n"
            f"查询：{query}\n\n"
            "如果是简单问题，输出 {\"is_complex\": false}\n"
            "如果是复合问题，输出子问题列表和检索策略：\n"
            "{\"is_complex\": true, \"sub_queries\": [\"子问题1\", \"子问题2\", ...], "
            "\"strategy\": \"parallel\"}\n"
            "策略：parallel=所有子问题并行检索后综合；sequential=子问题有依赖关系，依次检索\n"
            "子问题应该各自独立、可单独检索。最多3个子问题。\n"
            "只输出JSON。"
        )
        result = llm.call_json(prompt, max_retries=2, timeout=60,
                               system_prompt="只输出JSON对象。")
        if result and isinstance(result, dict) and result.get("is_complex"):
            return result
    except Exception as e:
        logger.warning(f"Query decomposition failed: {e}")
    return None


# ── HyDE helper ─────────────────────────────────────────────
def _generate_hyde_answer(llm, query: str) -> Optional[str]:
    """Generate a hypothetical academic answer for HyDE-based retrieval."""
    if llm is None:
        return None
    try:
        result = llm.call(
            "你是一位马克思主义理论学者。请用一段学术文字（100-200字）回答以下问题，"
            "使用正确的学术术语和概念。不需要完全准确，这是假设性回答用于检索增强。\n\n"
            f"问题：{query}\n\n假设性回答：",
            max_retries=2, timeout=60
        )
        if result:
            return result.get("content", "")[:2000]
    except Exception as e:
        logger.warning(f"HyDE generation failed: {e}")
    return None


# ═══════════════════════════════════════════════════════════════
# RESOURCES
# ═══════════════════════════════════════════════════════════════

@mcp.resource("graphrag://schema")
def get_graph_schema() -> str:
    """Return the GraphRAG knowledge graph schema as JSON, describing all node labels, relationship types, and key properties."""
    return json.dumps({
        "graph": "graphrag-marx",
        "description": "Neo4j knowledge graph for 208 Chinese Marxist theory papers",
        "node_types": {
            "Episode": {
                "description": "文献节点 (paper node)",
                "properties": ["source_folder", "year", "author", "doc_type", "historical_period"]
            },
            "Entity": {
                "description": "实体节点 (concept/person/work/organization/event…)",
                "properties": ["name", "category", "level", "description", "entity_vector(1024)", "obsidian_uri"],
                "categories": [
                    "理论概念类", "人物主体类", "文本与著作类", "组织/机构/空间",
                    "时代/历史/时序", "价值/意识形态/文化", "研究要素/学术工具",
                    "行为/实践/社会行动", "权利/规范/法律", "关系载体"
                ]
            },
            "LiteratureDistill": {
                "description": "单文献五层知识蒸馏",
                "properties": [
                    "id", "core_concept_definition", "theoretical_system_and_innovation",
                    "analysis_paradigm_and_interpretation", "dialectical_logic_chain",
                    "theoretical_limitation_and_expansion", "distill_vector(1024)"
                ]
            },
            "DomainKnowledge": {
                "description": "领域全局四层知识蒸馏",
                "properties": [
                    "domain", "unified_concepts", "timeline_evolution",
                    "research_paradigms", "consensus_controversies", "domain_vector(1024)"
                ],
                "domains": ["马克思主义哲学", "政治经济学", "科学社会主义", "马克思主义中国化", "西方马克思主义", "思想史"]
            },
            "Community": {
                "description": "实体社区聚类",
                "properties": ["name", "level(一级/二级)"]
            },
            "Conflict": {
                "description": "学术争议/理论分歧",
                "properties": ["concept", "level(核心分歧/表述差异/适用条件/实践路径)"]
            },
            "TimelineNode": {
                "description": "理论演化时间线节点",
                "properties": ["stage_name", "start_year", "core_theories", "representatives"]
            },
            "HyperEdge": {
                "description": "结构化超边(N元知识片段) — 超越HyperGraphRAG的知识层",
                "properties": [
                    "id", "text", "type(9类)", "summary", "entities[]", "claims[]",
                    "source_id", "source_title", "pub_year", "confidence", "embedding(1024)"
                ],
                "types": ["命题命题定义", "理论机制", "政策法规", "典型案例", "学术争议", "研究方法", "时间事件", "概念辨析", "其他"]
            }
        },
        "relationships": [
            "(:Entity)-[:EXTRACTED_FROM]->(:Episode)",
            "(:Entity)-[:PROPOSED_BY | PUBLISHED_IN | INHERITS_FROM | CRITIQUES | DEVELOPS_INTO | LEAD_TO | BELONG_TO | CONTRAST_WITH]->(:Entity)",
            "(:LiteratureDistill)-[:DISTILL_FROM]->(:Episode)",
            "(:LiteratureDistill)-[:CORRESPONDS_TO]->(:Entity)",
            "(:LiteratureDistill)-[:AGGREGATED_INTO]->(:DomainKnowledge)",
            "(:Entity)-[:BELONGS_TO_COMMUNITY]->(:Community)",
            "(:Entity)-[:HAS_CONFLICT]->(:Conflict)",
            "(:Entity)-[:INVOLVED_IN]->(:HyperEdge)",
            "(:HyperEdge)-[:FROM_EPISODE]->(:Episode)"
        ],
        "statistics": {
            "papers": 208, "entities": 2839, "relations": 1262, "communities": 138,
            "literature_distills": 208, "domain_knowledge": 5, "vector_indexes": 3
        }
    }, ensure_ascii=False, indent=2)


@mcp.resource("graphrag://status")
def get_graph_status() -> str:
    """Return a snapshot of the current knowledge graph status (node counts, vector index state, module completion)."""
    status = get_pipeline_status()
    return json.dumps(status, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════════════
# PROMPT TEMPLATE
# ═══════════════════════════════════════════════════════════════

@mcp.prompt()
def analyze_marxist_concept(concept: str) -> str:
    """Generate a structured prompt template for analyzing a Marxist theoretical concept using the knowledge graph.

    Args:
        concept: The Marxist concept to analyze (e.g., "异化劳动", "剩余价值", "唯物史观")
    """
    return f"""你是一位马克思主义理论学者。请基于知识图谱中的结构化知识，对概念「{concept}」进行全面分析。

请按以下步骤使用 graphrag-marx 工具进行检索，然后将检索结果整合为学术分析：

## 检索步骤
1. 用 search_by_concept 在知识图谱中搜索该概念的实体
2. 对每个匹配实体，用 get_entity_info 查看详情和关联关系
3. 查询该实体涉及哪些论文：用 run_cypher_read 执行：
   `MATCH (e:Entity {{name: "{concept}"}})-[:EXTRACTED_FROM]->(ep:Episode) RETURN ep.source_folder`
4. 对有蒸馏的论文，用 get_distill_content 获取五层结构化知识
5. 如该概念属于某个理论领域，用 get_domain_knowledge 获取全局归纳

## 分析要求
- **概念定义**：该概念的精准内涵、别名、学术边界
- **理论脉络**：提出者、继承发展关系、所属理论体系
- **学术争议**：如有，区分核心分歧/表述差异/适用条件分歧
- **文献溯源**：注明每条关键论断的原始论文
- **领域定位**：该概念在马克思主义理论体系中的位置

请用学术中文撰写，引用具体论文作为支撑，避免空泛叙述。
"""


# ═══════════════════════════════════════════════════════════════
# CATEGORY 1: STATUS / QUERY  (4 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def get_pipeline_status() -> dict:
    """Get a complete status snapshot of the knowledge graph: node counts, vector index state, and 6-module completion metrics.

    Example return:
        {"graph":{"episodes":208,"entities":2839,...}, "vectors":{"coverage":"2839/2839","pct":100.0}, "modules":{...}}
    """
    status = _neo4j_ok()
    if not status["ok"]:
        logger.warning("get_pipeline_status: Neo4j unavailable")
        return {"error": status["error"], "graph": {}, "modules": {}}
    nc = status["nc"]

    try:
        graph = {
            "episodes": nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"],
            "entities": nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"],
            "relations": nc.execute_query(
                "MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) AS c"
            )[0]["c"],
            "communities": nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"],
            "conflicts": nc.execute_query("MATCH (c:Conflict) RETURN count(c) AS c")[0]["c"],
            "literature_distills": nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"],
            "domain_knowledge": nc.execute_query("MATCH (dk:DomainKnowledge) RETURN count(dk) AS c")[0]["c"],
            "hyperedges": nc.execute_query("MATCH (h:HyperEdge) RETURN count(h) AS c")[0]["c"],
            "timeline_nodes": nc.execute_query("MATCH (tn:TimelineNode) RETURN count(tn) AS c")[0]["c"],
        }

        vectors = {}
        try:
            total = graph["entities"]
            vec = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS c")[0]["c"]
            vectors["coverage"] = f"{vec}/{total}" if total else "0/0"
            vectors["pct"] = round(vec / total * 100, 1) if total else 0
            idx = nc.execute_query("SHOW INDEXES YIELD name, state WHERE name = 'entity_vector_idx' RETURN name, state")
            vectors["entity_vector_idx"] = idx[0]["state"] if idx else "NOT_FOUND"
        except Exception:
            vectors = {"error": "Could not read vector state"}

        agg_into = nc.execute_query("MATCH ()-[r:AGGREGATED_INTO]->() RETURN count(r) AS c")[0]["c"]
        obsidian_uris = nc.execute_query("MATCH (e:Entity) WHERE e.obsidian_uri IS NOT NULL RETURN count(e) AS c")[0]["c"]

        modules = {
            "module1_env_setup": "DONE",
            "module2_data_ingestion": "DONE",
            "module3_vectorization": "DONE" if vectors.get("entity_vector_idx") == "ONLINE" else "PARTIAL",
            "module4_knowledge_distill": f"DONE" if graph["literature_distills"] >= graph["episodes"] else f"{graph['literature_distills']}/{graph['episodes']}",
            "module5_api_cost": "DONE",
            "module6_quality_ops": "DONE",
        }

        return {"graph": graph, "vectors": vectors, "agg_integrations": agg_into, "obsidian_uris": obsidian_uris, "modules": modules}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_pipeline_status failed")
        return {"error": str(e), "graph": {}, "modules": {}}


@mcp.tool()
def get_entity_info(name: str, limit: int = 10) -> dict:
    """Get detailed info about entities matching a name (case-insensitive substring). Returns properties + 1-hop neighbor relations.

    Args:
        name: Entity name or partial name to search for
        limit: Max results (1-50, default 10)

    Example:
        get_entity_info("异化", limit=3) -> {"results":[{"name":"异化劳动","category":"理论概念类",...}]}
    """
    limit = max(1, min(50, int(limit)))
    name = _sanitize_str(name, 200)
    if not name:
        return {"error": "Invalid parameter: name is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        entities = nc.execute_query(
            "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($n) RETURN e ORDER BY e.name LIMIT $l",
            {"n": name, "l": limit}
        )
        if not entities:
            return {"results": [], "total": 0, "query": name}

        results = []
        for row in entities:
            e = row["e"]
            eid = e.get("name", "")
            rels = nc.execute_query(
                "MATCH (e:Entity {name: $n})-[r]-(other) WHERE type(r) <> 'EXTRACTED_FROM' "
                "RETURN type(r) AS rel, labels(other)[0] AS other_label, "
                "CASE WHEN 'Entity' IN labels(other) THEN other.name "
                "     WHEN 'Episode' IN labels(other) THEN other.source_folder "
                "     WHEN 'LiteratureDistill' IN labels(other) THEN other.id "
                "     ELSE coalesce(other.name, other.id, '') END AS other_name LIMIT 8",
                {"n": eid}
            )
            results.append({
                "name": eid,
                "category": e.get("category", ""),
                "level": e.get("level", ""),
                "description": str(e.get("description", ""))[:300],
                "source_folder": e.get("source_folder", ""),
                "batch_run": e.get("batch_run", ""),
                "has_vector": e.get("entity_vector") is not None,
                "neighbors": [{"relation": r["rel"], "target_type": r["other_label"], "target": r["other_name"]} for r in rels],
            })
        return {"results": results, "total": len(results), "query": name}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_entity_info failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
def get_paper_info(folder: str, limit: int = 10) -> dict:
    """Get metadata about papers/episodes matching a source folder name (substring).

    Args:
        folder: Folder name keyword (e.g., "资本", "马克思")
        limit: Max results (1-50, default 10)

    Example:
        get_paper_info("资本论") -> {"results":[{"source_folder":"...", "entity_count":15, "distill_id":"..."}]}
    """
    limit = max(1, min(50, int(limit)))
    folder = _sanitize_str(folder, 200)
    if not folder:
        return {"error": "Invalid parameter: folder is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        eps = nc.execute_query(
            "MATCH (ep:Episode) WHERE toLower(ep.source_folder) CONTAINS toLower($f) RETURN ep ORDER BY ep.source_folder LIMIT $l",
            {"f": folder, "l": limit}
        )
        if not eps:
            return {"results": [], "total": 0, "query": folder}

        results = []
        for row in eps:
            ep = row["ep"]
            sf = ep.get("source_folder", "")
            ent_count = nc.execute_query(
                "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder: $sf}) RETURN count(e) AS c",
                {"sf": sf})[0]["c"]
            distill = nc.execute_query(
                "MATCH (ld:LiteratureDistill)-[:DISTILL_FROM]->(ep:Episode {source_folder: $sf}) RETURN ld.id AS id LIMIT 1",
                {"sf": sf})
            results.append({
                "source_folder": sf,
                "year": ep.get("year", ""),
                "author": ep.get("author", ""),
                "doc_type": ep.get("doc_type", ""),
                "historical_period": ep.get("historical_period", ""),
                "entity_count": ent_count,
                "distill_id": distill[0]["id"] if distill else None,
            })
        return {"results": results, "total": len(results), "query": folder}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_paper_info failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
def run_cypher_read(query: str, params: dict = None, limit: int = 50) -> dict:
    """Execute a READ-ONLY Cypher query against the knowledge graph. Write operations (CREATE/MERGE/DELETE/SET/DROP) are blocked for safety.

    Args:
        query: Cypher query (MATCH / CALL / SHOW only)
        params: Optional query parameters as {key: value}
        limit: Max rows returned (1-100, default 50); auto-appended if query lacks LIMIT

    Example:
        run_cypher_read("MATCH (e:Entity {name: $n})-[r]->(other) RETURN type(r), other.name", {"n": "唯物史观"})
    """
    limit = max(1, min(100, int(limit)))

    err = _validate_read_only(query)
    if err:
        logger.warning(f"run_cypher_read blocked: {err[:80]}")
        return {"error": err, "results": [], "count": 0}

    # Sanitize params
    if params:
        for k, v in params.items():
            if not _is_safe_param_value(v):
                return {"error": f"Potentially unsafe param value for '{k}'. Remove Cypher keywords.", "results": [], "count": 0}

    q = _auto_limit(query, limit)
    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "count": 0}
    nc = status["nc"]

    try:
        rows = nc.execute_query(q, params or {})
        return {"results": rows, "count": len(rows), "query": q}
    except Exception as e:
        _reset_neo4j()
        logger.exception(f"run_cypher_read failed for: {q[:100]}")
        return {"error": str(e), "results": [], "count": 0}


# ═══════════════════════════════════════════════════════════════
# CATEGORY 2: SEARCH  (4 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def search_by_concept(concept: str, search_in: str = "both", limit: int = 20) -> dict:
    """Find entities by keyword matching name and/or category. Fast, free, Cypher-only — no API cost.

    Args:
        concept: Keyword (e.g., "异化", "资本积累", "唯物史观")
        search_in: "name" | "category" | "both" (default)
        limit: Max results (1-100, default 20)

    Example:
        search_by_concept("异化") -> {"results":[{"name":"异化劳动","category":"理论概念类"},...], "total":12}
    """
    limit = max(1, min(100, int(limit)))
    concept = _sanitize_str(concept, 200)
    if not concept:
        return {"error": "Invalid parameter: concept is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        if search_in == "name":
            clause = "toLower(e.name) CONTAINS toLower($kw)"
        elif search_in == "category":
            clause = "toLower(e.category) CONTAINS toLower($kw)"
        else:
            clause = "(toLower(e.name) CONTAINS toLower($kw) OR toLower(e.category) CONTAINS toLower($kw))"

        rows = nc.execute_query(
            f"MATCH (e:Entity) WHERE {clause} RETURN e.name AS name, e.category AS category, e.level AS level, left(e.description, 150) AS snippet ORDER BY e.name LIMIT $l",
            {"kw": concept, "l": limit}
        )
        return {"results": rows, "total": len(rows), "query": concept, "search_in": search_in}
    except Exception as e:
        _reset_neo4j()
        logger.exception("search_by_concept failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
def search_literature(query: str, limit: int = 10) -> dict:
    """Search papers/episodes by folder name, author, or historical period. Free, Cypher-only.

    Args:
        query: Search term (e.g., "资本", "邓小平", "改革开放")
        limit: Max results (1-50, default 10)

    Example:
        search_literature("资本论") -> {"results":[{"source_folder":"...","author":"...","year":"2024"},...]}
    """
    limit = max(1, min(50, int(limit)))
    q = _sanitize_str(query, 200)
    if not q:
        return {"error": "Invalid parameter: query is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        rows = nc.execute_query(
            "MATCH (ep:Episode) WHERE toLower(ep.source_folder) CONTAINS toLower($q) "
            "OR toLower(coalesce(ep.author, '')) CONTAINS toLower($q) "
            "OR toLower(coalesce(ep.historical_period, '')) CONTAINS toLower($q) "
            "RETURN ep.source_folder AS source_folder, ep.author AS author, ep.year AS year, "
            "ep.doc_type AS doc_type, ep.historical_period AS period "
            "ORDER BY ep.source_folder LIMIT $l",
            {"q": q, "l": limit}
        )
        return {"results": rows, "total": len(rows), "query": q}
    except Exception as e:
        _reset_neo4j()
        logger.exception("search_literature failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
async def hybrid_search_entities(query: str, top_k: int = 10, enable_hyde: bool = False,
                           enable_rerank: bool = True, enable_rewrite: bool = True,
                           enable_decompose: bool = True) -> dict:
    """Multi-path hybrid search with optional LLM query enhancement.

    NEW (2026-07): LLM query rewrite + sub-query decomposition for complex questions.
    Old graph-only expansion removed (measured +0.6% gain, not worth the latency).

    Args:
        query: Natural language search query
        top_k: Number of results (1-30, default 10)
        enable_hyde: Use HyDE hypothetical answer to augment vector search (default False, 1 LLM call)
        enable_rerank: Apply cross-encoder rerank after RRF fusion (default True, 1 LLM call)
        enable_rewrite: LLM rewrite query into 3 variant forms (default True, 1 LLM call)
        enable_decompose: Detect + decompose complex multi-faceted questions (default True, 1 LLM call)

    Example:
        hybrid_search_entities("资本积累对社会分化的影响")
        -> {"results":[...], "sub_results":null, "is_decomposed":false, "method":"rewrite+vector+bm25+rrf+rerank"}
    """
    top_k = max(1, min(30, int(top_k)))
    query = _sanitize_str(query, 500)
    if not query:
        return {"error": "Invalid parameter: query is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        logger.warning("hybrid_search: Neo4j unavailable")
        return search_by_concept(query, search_in="both", limit=top_k)
    nc = status["nc"]

    llm = _get_llm_client()
    method_parts = []
    search_queries = [query]

    # ═════════════════════════════════════════════════════════
    # Step 0a: Complex query decomposition (NEW)
    # ═════════════════════════════════════════════════════════
    sub_results = None
    is_decomposed = False
    if enable_decompose and llm:
        decomp = _decompose_query(llm, query)
        if decomp and len(decomp.get("sub_queries", [])) > 1:
            is_decomposed = True
            # For each sub-query, run a lightweight search (vector + BM25, no rerank)
            sub_results = []
            for sq in decomp["sub_queries"][:3]:
                try:
                    sub_vec = _embed_query(sq)
                    sub_vec_results = []
                    if sub_vec:
                        sub_vec_results = _vector_search(nc, sq, sub_vec, top_k * 2)
                    sub_bm25 = _bm25_search(nc, sq, top_k * 2)
                    if sub_vec_results and sub_bm25:
                        sub_candidates = _rrf_fusion([sub_vec_results, sub_bm25], top_k=top_k)[:top_k]
                    else:
                        sub_candidates = (sub_vec_results or sub_bm25)[:top_k]
                    sub_results.append({
                        "sub_query": sq,
                        "results": [
                            {"name": c["name"], "category": c.get("category", ""),
                             "description": str(c.get("description", ""))[:150]}
                            for c in sub_candidates[:max(3, top_k // 2)]
                        ]
                    })
                except Exception as e:
                    logger.warning(f"Sub-query '{sq[:40]}' failed: {e}")
            method_parts.append(f"decompose({len(sub_results)})")

    # ═════════════════════════════════════════════════════════
    # Step 0b: LLM query rewrite (NEW, replaces old _expand_query)
    # ═════════════════════════════════════════════════════════
    if enable_rewrite and llm:
        variants = _llm_rewrite_query(llm, query)
        if variants:
            search_queries.extend(variants)
            method_parts.append("rewrite")

    # ═════════════════════════════════════════════════════════
    # Step 0c: HyDE (optional)
    # ═════════════════════════════════════════════════════════
    hyde_text = None
    if enable_hyde and llm:
        hyde_text = _generate_hyde_answer(llm, query)
        if hyde_text:
            search_queries.insert(0, hyde_text)
            method_parts.append("hyde")

    # ═════════════════════════════════════════════════════════
    # Step 1: Vector search on primary + rewritten queries
    # ═════════════════════════════════════════════════════════
    all_vector_results = []
    for sq in search_queries[:4]:  # max 4 search queries (original + 3 variants)
        sub_vec = _embed_query(sq)
        if sub_vec:
            vr = _vector_search(nc, sq, sub_vec, top_k * 2)
            all_vector_results.extend(vr)
    method_parts.append("vector")

    # ═════════════════════════════════════════════════════════
    # Step 2: BM25 fulltext on primary query
    # ═════════════════════════════════════════════════════════
    bm25_results = _bm25_search(nc, query, top_k * 2)
    if bm25_results:
        method_parts.append("bm25")

    # Deduplicate vector results
    seen = {}
    for r in all_vector_results:
        n = r["name"]
        if n not in seen or r["score"] > seen[n].get("score", 0):
            seen[n] = r
    unique_vector = sorted(seen.values(), key=lambda x: x["score"], reverse=True)

    # Fallback
    if not unique_vector and not bm25_results:
        logger.info("hybrid_search: no results, falling back to text search")
        return search_by_concept(query, search_in="both", limit=top_k)

    # ═════════════════════════════════════════════════════════
    # Step 3: RRF fusion (now with 3rd leg: chunk-to-entity bridge)
    # ═════════════════════════════════════════════════════════
    # Third leg: search chunk_text_ft -> CHUNK_OF -> Episode -> EXTRACTED_FROM -> Entity names
    chunk_entity_list = []
    try:
        chunk_rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('chunk_text_ft', $q) "
            "YIELD node, score "
            "MATCH (node)-[:CHUNK_OF]->(ep:Episode)<-[:EXTRACTED_FROM]-(e:Entity) "
            "RETURN DISTINCT e.name AS name, e.category AS category, "
            "e.description AS description, max(score) AS score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k * 3}
        )
        chunk_entity_list = [
            {"name": r["name"], "category": r.get("category", ""),
             "description": str(r.get("description", ""))[:250],
             "score": round(r["score"], 4)}
            for r in chunk_rows
        ]
        if chunk_entity_list:
            method_parts.append("chunk_bridge")
    except Exception as e:
        logger.warning(f"Chunk-to-entity bridge failed: {e}")

    # BM25 fallback: if BM25 returns empty, use CONTAINS substring search
    if not bm25_results:
        try:
            fallback_rows = nc.execute_query(
                "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($q) "
                "RETURN e.name AS name, e.category AS category, e.description AS description "
                "ORDER BY e.name LIMIT $k",
                {"q": query, "k": top_k * 2}
            )
            bm25_results = [
                {"name": r["name"], "category": r.get("category", ""),
                 "description": str(r.get("description", ""))[:250],
                 "score": 0.1}
                for r in fallback_rows
            ]
            if bm25_results:
                method_parts.append("bm25_fallback")
        except Exception:
            pass

    vec_list = unique_vector[:top_k * 5]
    bm25_list = bm25_results[:top_k * 5]
    chunk_list = chunk_entity_list[:top_k * 5]

    # Three-way RRF fusion
    rrf_input = [lst for lst in [vec_list, bm25_list, chunk_list] if lst]
    if len(rrf_input) >= 2:
        candidates = _rrf_fusion(rrf_input, top_k=top_k * 5)
        method_parts.append("rrf")
    elif rrf_input:
        candidates = rrf_input[0][:top_k * 5]

    # ═════════════════════════════════════════════════════════
    # Step 4: Rerank (optional)
    # ═════════════════════════════════════════════════════════
    if enable_rerank and len(candidates) > top_k:
        candidates = await _rerank(query, candidates, top_k * 2)
        method_parts.append("rerank")

    # ═════════════════════════════════════════════════════════
    # Step 5: Graph enrichment + build final results
    # ═════════════════════════════════════════════════════════
    results = []
    for row in candidates[:top_k]:
        name = row.get("name", "")
        rels = []
        try:
            nr = nc.execute_query(
                "MATCH (e:Entity {name: $n})-[r]-(other:Entity) WHERE type(r) <> 'EXTRACTED_FROM' "
                "RETURN type(r) AS rel, other.name AS target LIMIT 3",
                {"n": name}
            )
            rels = [f"{r['rel']} -> {r['target']}" for r in nr]
        except Exception:
            pass
        results.append({
            "name": name,
            "category": row.get("category", ""),
            "score": round(row.get("score", 0), 4),
            "description": str(row.get("description", ""))[:250],
            "neighbors": rels,
        })

    return {
        "results": results,
        "total": len(results),
        "query": query,
        "method": "+".join(method_parts),
        "sub_results": sub_results,
        "is_decomposed": is_decomposed,
    }


# ═══════════════════════════════════════════════════════════════
# CATEGORY 2b: KNOWLEDGE DISTILL RETRIEVAL + CHUNK BACKTRACE (4 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def chunk_search_entities(query: str, top_k: int = 10) -> dict:
    """Semantic search at PASSAGE level. Searches chunk_text_ft (BM25) AND chunk_vector_idx (vector)
    for paper paragraphs, then bridges back to entity names via CHUNK_OF->Episode->EXTRACTED_FROM.

    This complements entity-level hybrid_search_entities with passage-level granularity.
    Best for queries where the answer is in the full text of a paper paragraph, not just entity names.

    Args:
        query: Natural language search query
        top_k: Number of distinct entities to return (1-30, default 10)

    Returns:
        entities: [{name, category, description}] — entities linked to matching chunks
        passages: [{text, chunk_type, source_paper, paper_author, paper_year}] — raw passages
        method: "chunk_bm25" | "chunk_vector" | "chunk_hybrid"

    Example:
        chunk_search_entities("资本积累如何影响土地流转") -> entities + passages from matching papers
    """
    top_k = max(1, min(30, int(top_k)))
    query = _sanitize_str(query, 500)
    if not query:
        return {"error": "Invalid parameter", "entities": [], "passages": []}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "entities": [], "passages": []}
    nc = status["nc"]

    # Path 1: chunk vector search -> bridge to entities
    chunk_vec = _embed_query(query)
    vec_entities = []
    if chunk_vec:
        try:
            rows = nc.execute_query(
                f"CALL db.index.vector.queryNodes('chunk_vector_idx', {top_k * 3}, $v) "
                "YIELD node, score "
                "MATCH (node)-[:CHUNK_OF]->(ep:Episode)<-[:EXTRACTED_FROM]-(e:Entity) "
                "RETURN DISTINCT e.name AS name, e.category AS category, "
                "e.description AS description, max(score) AS score "
                "ORDER BY score DESC LIMIT $k",
                {"v": chunk_vec, "k": top_k * 2}
            )
            vec_entities = [
                {"name": r["name"], "category": r.get("category", ""),
                 "description": str(r.get("description", ""))[:200],
                 "score": round(r["score"], 4)}
                for r in rows
            ]
        except Exception as e:
            logger.warning(f"chunk vector search failed: {e}")

    # Path 2: chunk BM25 search -> bridge to entities
    bm25_entities = []
    try:
        rows = nc.execute_query(
            "CALL db.index.fulltext.queryNodes('chunk_text_ft', $q) "
            "YIELD node, score "
            "MATCH (node)-[:CHUNK_OF]->(ep:Episode)<-[:EXTRACTED_FROM]-(e:Entity) "
            "RETURN DISTINCT e.name AS name, e.category AS category, "
            "e.description AS description, max(score) AS score "
            "ORDER BY score DESC LIMIT $k",
            {"q": query, "k": top_k * 2}
        )
        bm25_entities = [
            {"name": r["name"], "category": r.get("category", ""),
             "description": str(r.get("description", ""))[:200],
             "score": round(r["score"], 4)}
            for r in rows
        ]
    except Exception as e:
        logger.warning(f"chunk BM25 failed: {e}")

    # RRF fusion of both paths
    method = "chunk_hybrid"
    if vec_entities and bm25_entities:
        entities = _rrf_fusion([vec_entities, bm25_entities], top_k=top_k)
    elif vec_entities:
        entities = vec_entities[:top_k]
        method = "chunk_vector"
    elif bm25_entities:
        entities = bm25_entities[:top_k]
        method = "chunk_bm25"
    else:
        return {"entities": [], "passages": [], "total": 0, "method": "none",
                "query": query, "hint": "No matching chunks found"}

    # Return top-5 passages (for the top entities)
    passages = []
    papers_seen = set()
    for ent in entities[:3]:
        try:
            ep_rows = nc.execute_query(
                "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode)<-[:CHUNK_OF]-(c:Chunk) "
                "WHERE c.chunk_type IN ['original', 'abstract'] "
                "RETURN ep.source_folder AS paper, ep.author AS author, ep.year AS year, "
                "c.text AS text, c.chunk_type AS ctype "
                "ORDER BY c.chunk_index ASC LIMIT 2",
                {"en": ent["name"]}
            )
            for er in ep_rows:
                paper = er["paper"]
                if paper not in papers_seen:
                    papers_seen.add(paper)
                    passages.append({
                        "text": str(er.get("text", ""))[:300],
                        "chunk_type": er.get("ctype", "original"),
                        "source_paper": paper,
                        "paper_author": str(er.get("author", ""))[:30],
                        "paper_year": er.get("year"),
                    })
            if len(passages) >= 5:
                break
        except Exception:
            pass

    return {
        "entities": entities,
        "passages": passages,
        "total": len(entities),
        "method": method,
        "query": query,
    }

@mcp.tool()
def get_distill_content(entity_name: str, limit: int = 3) -> dict:
    """Retrieve the five-layer knowledge distillation for papers containing a specific entity. This is the core GraphRAG value: structured academic knowledge from individual papers.

    Args:
        entity_name: Entity name (exact or substring match)
        limit: Max distills to return (1-10, default 3)

    Returns: For each distill, returns all 5 layers:
        - core_concept_definition: 核心概念定义
        - theoretical_system_and_innovation: 理论体系与创新点
        - analysis_paradigm_and_interpretation: 分析范式与阐释路径
        - dialectical_logic_chain: 辩证因果与思潮对比
        - theoretical_limitation_and_expansion: 理论局限与拓展方向 plus linked_entities and source_paper

    Example:
        get_distill_content("异化劳动") -> {"results":[{5-layer JSON + source_paper + linked_entities}]}
    """
    limit = max(1, min(10, int(limit)))
    entity_name = _sanitize_str(entity_name, 200)
    if not entity_name:
        return {"error": "Invalid parameter: entity_name is required", "results": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        distills = nc.execute_query(
            "MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e:Entity) "
            "WHERE toLower(e.name) CONTAINS toLower($en) "
            "RETURN DISTINCT ld, e.name AS matched_entity ORDER BY ld.id LIMIT $l",
            {"en": entity_name, "l": limit}
        )

        if not distills:
            return {"results": [], "total": 0, "query": entity_name, "hint": "No distillation found for this entity. Try a broader concept or use search_by_concept first."}

        results = []
        for row in distills:
            ld = row["ld"]
            did = ld.get("id", "")

            # Fetch linked entities
            linked = nc.execute_query(
                "MATCH (ld:LiteratureDistill {id: $did})-[:CORRESPONDS_TO]->(e:Entity) "
                "RETURN e.name AS name, e.category AS category LIMIT 10",
                {"did": did}
            )

            # Fetch source paper
            src = nc.execute_query(
                "MATCH (ld:LiteratureDistill {id: $did})-[:DISTILL_FROM]->(ep:Episode) "
                "RETURN ep.source_folder AS paper LIMIT 1",
                {"did": did}
            )

            results.append({
                "distill_id": did,
                "matched_entity": row.get("matched_entity", ""),
                "source_paper": src[0]["paper"] if src else "",
                "linked_entities": [f"{e['name']} ({e['category']})" for e in linked],
                # 5-layer structured knowledge
                "core_concept_definition": ld.get("core_concept_definition", []),
                "theoretical_system_and_innovation": ld.get("theoretical_system_and_innovation", {}),
                "analysis_paradigm_and_interpretation": ld.get("analysis_paradigm_and_interpretation", {}),
                "dialectical_logic_chain": ld.get("dialectical_logic_chain", []),
                "theoretical_limitation_and_expansion": ld.get("theoretical_limitation_and_expansion", {}),
            })

        return {"results": results, "total": len(results), "query": entity_name}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_distill_content failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
def get_entity_passages(entity_name: str, top_k: int = 5) -> dict:
    """RETRIEVE ORIGINAL PAPER PASSAGES for any entity — the parent-child document bridge.

    This is the CRITICAL missing link between Entity-level retrieval (semantic, graph-based)
    and passage-level context (the actual paper paragraphs). For each entity:
      1. Find the Entity node
      2. Follow CHUNK_OF edges from linked Episode to find Chunk nodes containing the entity
      3. Return the full paragraph text with source paper metadata

    Args:
        entity_name: Entity name (exact or substring match)
        top_k: Max passages to return (1-20, default 5)

    Returns:
        passages: [{"text":"...", "chunk_type":"original|abstract|qa|terms",
                     "source_paper":"...", "paper_year":2020, "paper_author":"..."}]
        linked_entities: related entities from the same paragraph

    Example:
        get_entity_passages("异化劳动") -> {"passages":[...], "entity":"异化劳动", "total":5}
    """
    top_k = max(1, min(20, int(top_k)))
    entity_name = _sanitize_str(entity_name, 200)
    if not entity_name:
        return {"error": "Invalid parameter: entity_name is required", "passages": [], "total": 0}

    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "passages": [], "total": 0}
    nc = status["nc"]

    try:
        # Step 0: Check in-memory cache first
        cached = _cached_passages(nc, entity_name, top_k)
        if cached is not None:
            return {
                "entity": entity_name,
                "entity_category": "cached",
                "passages": cached,
                "total": len(cached),
                "linked_entities": [],
                "papers_available": 1,
                "source": "cache",
            }

        # Step 1: Find entity (with cache)
        ent_cached = _cached_entity_lookup(nc, entity_name)
        if ent_cached:
            e_name = ent_cached["name"]
            e_cat = ent_cached["category"]
        else:
            entities = nc.execute_query(
                "MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($en) "
                "RETURN e.name AS name, e.category AS category LIMIT 1",
                {"en": entity_name}
            )
            if not entities:
                return {"passages": [], "total": 0, "entity": entity_name,
                        "hint": "Entity not found. Try search_by_concept first."}
            e_name = entities[0]["name"]
            e_cat = entities[0].get("category", "")

        # Step 2: Find episodes linked to this entity
        episodes = nc.execute_query(
            "MATCH (e:Entity {name: $en})-[:EXTRACTED_FROM]->(ep:Episode) "
            "RETURN ep.source_folder AS paper, ep.title AS title, "
            "ep.year AS year, ep.author AS author "
            "LIMIT 5",
            {"en": e_name}
        )

        # Step 3: For each episode, find chunks that are most relevant
        passages = []
        papers_seen = set()

        for ep in episodes:
            paper = ep["paper"]
            if paper in papers_seen:
                continue
            papers_seen.add(paper)

            # Get chunks — return top-N relevant paragraphs from each paper
            # (no strict CONTAINS filter; LLM judges passage relevance)
            chunks = nc.execute_query(
                "MATCH (ep:Episode {source_folder: $p})<-[:CHUNK_OF]-(c:Chunk) "
                "WHERE c.chunk_type IN ['original', 'abstract'] "
                "RETURN c.text AS text, c.chunk_type AS ct, c.chunk_index AS ci "
                "ORDER BY c.chunk_type = 'original' DESC, c.chunk_index ASC "
                "LIMIT 3",
                {"p": paper}
            )

            for ck in chunks:
                passages.append({
                    "text": str(ck.get("text", ""))[:500],
                    "chunk_type": ck.get("ct", "original"),
                    "source_paper": paper,
                    "paper_year": ep.get("year"),
                    "paper_author": ep.get("author"),
                    "paper_title": str(ep.get("title", ""))[:80],
                })
                if len(passages) >= top_k:
                    break
            if len(passages) >= top_k:
                break

        # Step 4: Get linked entities
        linked = nc.execute_query(
            "MATCH (e:Entity {name: $en})-[r]-(other:Entity) "
            "WHERE type(r) <> 'EXTRACTED_FROM' "
            "RETURN DISTINCT other.name AS name, other.category AS category LIMIT 5",
            {"en": e_name}
        )

        result = {
            "entity": e_name,
            "entity_category": e_cat,
            "passages": passages,
            "total": len(passages),
            "linked_entities": [f"{l['name']} ({l['category']})" for l in linked],
            "papers_available": len(papers_seen),
        }
        # Save to in-memory cache
        key = f"{entity_name}:{top_k}"
        with _cache_lock:
            if len(_passage_cache) < MAX_CACHE_ENTRIES:
                _passage_cache[key] = passages
        return result
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_entity_passages failed")
        return {"error": str(e), "passages": [], "total": 0}


@mcp.tool()
def get_domain_knowledge(domain: str = None) -> dict:
    """Retrieve the four-layer domain-level knowledge distillation. This aggregates knowledge ACROSS all papers in a field (e.g., 马克思主义哲学, 政治经济学).

    Args:
        domain: Domain name keyword (e.g., "哲学", "政治经济学", "科学社会主义"). Omit to list all 5 domains with summaries.

    Returns 4 layers per domain:
        - unified_concepts: 领域统一标准概念
        - timeline_evolution: 理论演化时间线与因果脉络
        - research_paradigms: 通用研究范式与阐释路径
        - consensus_controversies: 学界共识与理论争议

    Example:
        get_domain_knowledge("政治经济学") -> {"results":[{domain:"政治经济学", 4-layer JSON}]}
    """
    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "results": [], "total": 0}
    nc = status["nc"]

    try:
        if domain:
            domain = _sanitize_str(domain, 100)
            dks = nc.execute_query(
                "MATCH (dk:DomainKnowledge) WHERE toLower(dk.domain) CONTAINS toLower($d) RETURN dk ORDER BY dk.domain LIMIT 3",
                {"d": domain}
            )
        else:
            dks = nc.execute_query("MATCH (dk:DomainKnowledge) RETURN dk ORDER BY dk.domain")

        if not dks:
            return {"results": [], "total": 0, "available_domains": ["马克思主义哲学", "政治经济学", "科学社会主义", "马克思主义中国化", "西方马克思主义", "思想史"]}

        results = []
        for row in dks:
            dk = row["dk"]
            dk_domain = dk.get("domain", "")

            # TimelineNodes for this domain
            timelines = nc.execute_query(
                "MATCH (tn:TimelineNode) WHERE toLower(tn.stage_name) CONTAINS toLower($d) OR toLower(coalesce(tn.domain,'')) CONTAINS toLower($d) "
                "RETURN tn.stage_name AS stage, tn.start_year AS year, "
                "coalesce(tn.core_theories, tn.description, '') AS theory, "
                "coalesce(tn.representatives, tn.key_events, '') AS figures LIMIT 20",
                {"d": dk_domain}
            )

            # Distill count for this domain
            dk_count = nc.execute_query(
                "MATCH (ld:LiteratureDistill)-[:AGGREGATED_INTO]->(dk:DomainKnowledge {domain: $d}) RETURN count(ld) AS c",
                {"d": dk_domain}
            )[0]["c"]

            results.append({
                "domain": dk_domain,
                "distill_count": dk_count,
                "unified_concepts": dk.get("unified_concepts", []),
                "timeline_evolution": dk.get("timeline_evolution", []),
                "research_paradigms": dk.get("research_paradigms", []),
                "consensus_controversies": dk.get("consensus_controversies", []),
                "related_timeline_nodes": [{"stage": t["stage"], "year": t["year"], "theory": str(t.get("theory", ""))[:100], "figures": t["figures"]} for t in timelines],
            })

        return {"results": results, "total": len(results)}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_domain_knowledge failed")
        return {"error": str(e), "results": [], "total": 0}


# ═══════════════════════════════════════════════════════════════
# CATEGORY 3: QUALITY  (3 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def run_quality_check() -> dict:
    """Run a 10-point data quality audit: duplicate entities, orphans, mismatched links, null fields, relation integrity, conflict nodes, vector coverage.

    Returns: checks (10 items with PASS/WARN), totals, issues_count, all_passed flag.
    """
    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "checks": {}, "all_passed": False}
    nc = status["nc"]

    try:
        checks = {}
        def _ck(name, cypher, params=None):
            try:
                v = nc.execute_query(cypher, params or {})[0]["cnt"]
                checks[name] = {"value": v, "status": "PASS" if v == 0 else "WARN"}
            except Exception:
                checks[name] = {"value": "query_failed", "status": "WARN"}

        _ck("duplicate_entities", "MATCH (e1:Entity),(e2:Entity) WHERE e1.name = e2.name AND elementId(e1) < elementId(e2) RETURN count(e1) AS cnt")
        _ck("orphan_entities", "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->() RETURN count(e) AS cnt")
        _ck("orphan_episodes", "MATCH (ep:Episode) WHERE NOT (ep)<-[:EXTRACTED_FROM]-() RETURN count(ep) AS cnt")
        _ck("extracted_from_mismatch", "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder RETURN count(r) AS cnt")
        _ck("null_category", "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN count(e) AS cnt")
        _ck("null_level", "MATCH (e:Entity) WHERE e.level IS NULL OR e.level = '' RETURN count(e) AS cnt")
        _ck("null_short_desc", "MATCH (e:Entity) WHERE e.description IS NULL OR size(e.description) < 10 RETURN count(e) AS cnt")
        _ck("relations_missing_source",
            "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY','CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] AND r.source_folder IS NULL RETURN count(r) AS cnt")
        _ck("empty_conflicts", "MATCH (c:Conflict) WHERE c.concept IS NULL OR c.concept = '' RETURN count(c) AS cnt")

        total_ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS cnt")[0]["cnt"]
        vec_ent = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS cnt")[0]["cnt"]
        checks["vector_coverage"] = {"value": f"{vec_ent}/{total_ent}", "status": "PASS" if vec_ent == total_ent else "INFO"}

        totals = {
            "episodes": nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"],
            "entities": total_ent,
            "relations": nc.execute_query(
                "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY','CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] RETURN count(r) AS c"
            )[0]["c"],
            "communities": nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"],
        }

        issues = sum(1 for v in checks.values() if v["status"] == "WARN")
        return {"checks": checks, "totals": totals, "issues_count": issues, "all_passed": issues == 0}
    except Exception as e:
        _reset_neo4j()
        logger.exception("run_quality_check failed")
        return {"error": str(e), "checks": {}, "all_passed": False}


@mcp.tool()
def check_md_integrity(scope: str = "summary") -> dict:
    """Scan paper folders for 4 required MD files (摘要, 术语, 问答, *.original.md). Detect empty/corrupt files. Filesystem-only, no Neo4j.

    Args:
        scope: "summary" (default, fast counts) or "full" (per-folder detail)

    Example:
        check_md_integrity("summary") -> {"total_folders":208, "summary":{"complete":208, "incomplete":0, ...}}
    """
    base = Path(r"D:\Desktop\ov_import")
    if not base.exists():
        return {"error": f"Import directory not found: {base}", "total_folders": 0}

    required_std = ["摘要.md", "术语表.md", "问答.md"]
    total, complete, missing_files, empty_files, corrupt_files = 0, 0, 0, 0, 0
    folders_detail = []

    try:
        for d in sorted(base.iterdir()):
            if not d.is_dir() or d.name.startswith('.'):
                continue
            total += 1
            st = {"folder": d.name, "missing": [], "empty": [], "corrupt": [], "ok": True}

            for rf in required_std:
                fp = d / rf
                if not fp.exists():
                    st["missing"].append(rf); st["ok"] = False
                else:
                    try:
                        content = fp.read_text(encoding="utf-8")
                        if len(content.strip()) < 50:
                            st["empty"].append(rf); st["ok"] = False
                    except Exception:
                        st["corrupt"].append(rf); st["ok"] = False

            orig_files = list(d.glob("*.original.md"))
            if not orig_files:
                st["missing"].append("*.original.md"); st["ok"] = False
            else:
                try:
                    if len(orig_files[0].read_text(encoding="utf-8").strip()) < 50:
                        st["empty"].append(orig_files[0].name); st["ok"] = False
                except Exception:
                    st["corrupt"].append(orig_files[0].name); st["ok"] = False

            if st["ok"]:
                complete += 1
            missing_files += len(st["missing"])
            empty_files += len(st["empty"])
            corrupt_files += len(st["corrupt"])
            if scope == "full":
                folders_detail.append(st)
    except Exception as e:
        logger.exception("check_md_integrity scan failed")
        return {"error": str(e), "total_folders": total}

    result = {
        "total_folders": total,
        "summary": {"complete": complete, "incomplete": total - complete,
                     "missing_files": missing_files, "empty_files": empty_files,
                     "corrupt_files": corrupt_files}
    }
    if scope == "full":
        result["folders"] = folders_detail
    return result


@mcp.tool()
def check_neo4j_health() -> dict:
    """Audit Neo4j configuration: memory, indexes (5 total), storage paths. Returns warnings for suboptimal settings.

    Example:
        check_neo4j_health() -> {"passed":True, "indexes_count":5, "warnings":[]}
    """
    status = _neo4j_ok()
    if not status["ok"]:
        return {"error": status["error"], "passed": False}
    nc = status["nc"]

    try:
        memory, warnings = {}, []
        try:
            for row in nc.execute_query(
                "CALL dbms.listConfig() YIELD name, value WHERE name IN "
                "('server.memory.heap.initial_size','server.memory.heap.max_size','server.memory.pagecache.size','dbms.memory.transaction.max_size') "
                "RETURN name, value"):
                memory[row["name"]] = row["value"]
        except Exception:
            memory = {"note": "listConfig unavailable"}

        indexes = []
        try:
            for row in nc.execute_query("SHOW INDEXES YIELD name, state, type, labelsOrTypes RETURN name, state, type, labelsOrTypes"):
                indexes.append({"name": row.get("name"), "state": row.get("state"), "type": row.get("type"), "labels": row.get("labelsOrTypes")})
        except Exception:
            try:
                for row in nc.execute_query("SHOW INDEXES YIELD name, state, type RETURN name, state, type"):
                    indexes.append({"name": row.get("name"), "state": row.get("state"), "type": row.get("type")})
            except Exception:
                indexes = [{"error": "SHOW INDEXES unavailable"}]

        storage = {}
        try:
            for row in nc.execute_query("CALL dbms.listConfig() YIELD name, value WHERE name STARTS WITH 'dbms.directories' RETURN name, value"):
                storage[row["name"]] = row["value"]
        except Exception:
            storage = {"note": "directory config unavailable"}

        heap_max = memory.get("server.memory.heap.max_size", "unknown")
        if heap_max and heap_max != "unknown":
            try:
                val_str = str(heap_max).upper().replace("M","").replace("G","")
                val = int(val_str) if "G" not in str(heap_max).upper() else int(val_str) * 1024
                if val < 256:
                    warnings.append(f"Heap max {heap_max} < 256M — may be insufficient for 2839 entities")
            except Exception:
                pass

        vec_idx = [i for i in indexes if i.get("name") == "entity_vector_idx"]
        if not vec_idx:
            warnings.append("entity_vector_idx not found")
        elif vec_idx[0].get("state") != "ONLINE":
            warnings.append(f"entity_vector_idx state is {vec_idx[0].get('state')}")

        return {"memory": memory, "indexes_count": len(indexes), "indexes": indexes[:15], "storage": storage, "warnings": warnings, "passed": len(warnings) == 0}
    except Exception as e:
        _reset_neo4j()
        logger.exception("check_neo4j_health failed")
        return {"error": str(e), "passed": False}


# ═══════════════════════════════════════════════════════════════
# CATEGORY 4: OPS + RERANK/FILTER  (4 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def get_cost_dashboard() -> dict:
    """Get API cost dashboard: LLM token usage, embedding call counts, cost breakdown (RMB), graph state snapshot, budget status (RMB 100 limit, currently 27.3% used).

    Reads from SQLite cache — zero API key exposure.
    """
    from pipeline.cache import CACHE_DIR
    cache_db = CACHE_DIR / "text_cache.db"

    llm_calls, llm_tokens, llm_hits, daily_tokens = 0, 0, 0, {}
    if cache_db.exists():
        conn = sqlite3.connect(str(cache_db)); conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT total_tokens, hit_count, created_at FROM llm_cache").fetchall()
        llm_calls = len(rows)
        llm_tokens = sum((r["total_tokens"] or 0) for r in rows)
        llm_hits = sum((r["hit_count"] or 0) for r in rows)
        for r in rows:
            dt = (r["created_at"] or "")[:10]
            if dt: daily_tokens[dt] = daily_tokens.get(dt, 0) + (r["total_tokens"] or 0)
        conn.close()

    emb_calls = 0
    if cache_db.exists():
        conn = sqlite3.connect(str(cache_db))
        emb_calls = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
        conn.close()

    emb_tokens_est = emb_calls * 200
    llm_cost = (llm_tokens * 0.2 / 1000) * 0.004 + (llm_tokens * 0.8 / 1000) * 0.012
    emb_cost = (emb_tokens_est / 1000) * 0.0007
    total_cost = round(llm_cost + emb_cost, 4)
    budget_limit = 100.0
    budget_pct = round(total_cost / budget_limit * 100, 1) if budget_limit else 0

    graph = {}
    st = _neo4j_ok()
    if st["ok"]:
        try:
            nc = st["nc"]
            graph = {
                "episodes": nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"],
                "entities": nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"],
                "vectorized_entities": nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS c")[0]["c"],
                "relations": nc.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) AS c")[0]["c"],
                "communities": nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"],
            }
        except Exception:
            pass

    return {
        "timestamp": datetime.now().isoformat(),
        "graph": graph,
        "tokens": {"llm_calls": llm_calls, "llm_tokens": llm_tokens, "llm_cache_hits": llm_hits, "embedding_calls": emb_calls, "embedding_tokens_est": emb_tokens_est},
        "cost": {"llm": round(llm_cost, 4), "embedding": round(emb_cost, 4), "total": total_cost, "currency": "RMB"},
        "budget": {"limit": budget_limit, "usage_percent": budget_pct, "remaining": round(budget_limit - total_cost, 2), "status": "GREEN" if budget_pct < 80 else "WARN"},
        "daily_tokens": daily_tokens,
    }


@mcp.tool()
def list_backups() -> dict:
    """List available Neo4j database backups with size, age, and metadata. Read-only filesystem scan."""
    backup_dir = Path(r"%USERPROFILE%\neo4j\neo4j-community-5.26.27\data\neo4j_backups")
    if not backup_dir.exists():
        return {"backups": [], "total": 0, "directory": str(backup_dir), "message": "Backup directory not found"}

    backups = []
    for d in sorted(backup_dir.glob("neo4j_backup_*"), reverse=True):
        size_bytes = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        meta = {}
        meta_file = d / "metadata.json"
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        age_s = (datetime.now().timestamp() - d.stat().st_mtime)
        backups.append({"name": d.name, "size_mb": round(size_bytes / (1024 * 1024), 1), "age_hours": round(age_s / 3600, 1), "episodes": meta.get("episodes", "?"), "entities": meta.get("entities", "?"), "timestamp": meta.get("timestamp", "")})
    return {"backups": backups, "total": len(backups), "directory": str(backup_dir)}


@mcp.tool()
def get_cache_stats() -> dict:
    """Get SQLite cache statistics: LLM cache size/hits, embedding cache, entity tracker state."""
    from pipeline.cache import CACHE_DIR
    cache_db = CACHE_DIR / "text_cache.db"

    llm_stats = {"count": 0, "total_tokens": 0, "total_hits": 0}
    emb_stats = {"count": 0, "total_hits": 0}
    if cache_db.exists():
        conn = sqlite3.connect(str(cache_db))
        cur = conn.execute("SELECT COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(hit_count),0) FROM llm_cache")
        row = cur.fetchone()
        llm_stats = {"count": row[0], "total_tokens": row[1] or 0, "total_hits": row[2] or 0}
        cur = conn.execute("SELECT COUNT(*), COALESCE(SUM(hit_count),0) FROM embedding_cache")
        row = cur.fetchone()
        emb_stats = {"count": row[0], "total_hits": row[1] or 0}
        conn.close()

    entity_db = CACHE_DIR / "entity_processed.db"
    entity_count = 0
    if entity_db.exists():
        conn = sqlite3.connect(str(entity_db))
        entity_count = conn.execute("SELECT COUNT(*) FROM processed_entities").fetchone()[0]
        conn.close()

    return {"llm_cache": llm_stats, "embedding_cache": emb_stats, "entity_tracker": {"processed_count": entity_count}, "cache_directory": str(CACHE_DIR)}


# ═══════════════════════════════════════════════════════════════
# Content compression helper (CAT 4)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def compress_passages(passages: str = "", max_tokens: int = 2000, context: str = "") -> dict:
    """Compress long search result passages into a concise summary suitable for context windows.

    When search results are too long to fit in the LLM context window (e.g., 10+ passages
    of 500 chars each), this tool uses LLM summarization to:
      1. Keep all key facts, claims, and evidence
      2. Remove boilerplate, introductions, and redundant phrasing
      3. Condense to approximately half the original length
      4. Preserve entity names, years, and methodology terms

    Args:
        passages: One or more search result passages to compress (concatenated text)
        max_tokens: Target maximum length of compressed output (default 2000 characters)
        context: Optional — what question/query was asked (helps focus the compression)

    Returns:
        compressed: compressed text
        original_length: character count before compression
        compression_ratio: compressed/original ratio

    Example:
        compress_passages(passages=long_text, context="异化理论的历史演变")
        -> {"compressed":"...", "original_length": 3500, "compression_ratio": 0.47}
    """
    if not passages or len(passages) < 200:
        return {"compressed": passages, "original_length": len(passages),
                "compression_ratio": 1.0, "note": "Input too short, no compression needed"}

    llm = _get_llm_client()
    if llm is None:
        return {"error": "LLM client unavailable", "compressed": passages[:max_tokens],
                "note": "Truncated without LLM compression"}

    ctx_hint = f"Context: {context[:200]}\n\n" if context else ""
    prompt = (
        f"{ctx_hint}"
        f"Compress the following academic search results, keeping ALL key facts, claims, "
        f"evidence, entity names, years, and methodology terms. Remove only boilerplate, "
        f"introductions, and redundant phrasings. Target ~{max_tokens} characters.\n\n"
        f"---\n{passages[:max_tokens * 2]}\n---\n\n"
        f"Compressed version:"
    )

    try:
        result = llm.call(prompt, max_retries=2, timeout=120,
                          system_prompt="You are an expert academic text compressor. Preserve all factual claims, entity names, years, and methodology terms.")
        if result:
            compressed = result.get("content", "")[:max_tokens]
            original_len = len(passages)
            compressed_len = len(compressed)
            return {
                "compressed": compressed,
                "original_length": original_len,
                "compressed_length": compressed_len,
                "compression_ratio": round(compressed_len / original_len, 2) if original_len else 1.0,
            }
    except Exception as e:
        logger.warning(f"Compression failed: {e}")

    return {"compressed": passages[:max_tokens], "original_length": len(passages),
            "compression_ratio": round(max_tokens / len(passages), 2) if passages else 1.0,
            "note": "LLM compression failed, truncated to max_tokens"}


# ═══════════════════════════════════════════════════════════════
# RAG Capability Status (MCP-registered diagnostic tool)
# ═══════════════════════════════════════════════════════════════

def _build_capability_report() -> dict:
    """Internal: build the full 12-capability structured report."""
    stats = {"episodes": 208, "entities": 2839}
    try:
        st = _neo4j_ok()
        if st["ok"]:
            nc = st["nc"]
            stats["chunks"] = nc.execute_query("MATCH (c:Chunk) RETURN count(c) AS c")[0]["c"]
            stats["chunked_papers"] = nc.execute_query(
                "MATCH (ep:Episode)<-[:CHUNK_OF]-(:Chunk) RETURN count(DISTINCT ep) AS c")[0]["c"]
            stats["year_coverage"] = nc.execute_query("MATCH (ep:Episode) WHERE ep.year IS NOT NULL RETURN count(ep) AS c")[0]["c"]
            stats["keywords_coverage"] = nc.execute_query("MATCH (ep:Episode) WHERE ep.keywords IS NOT NULL RETURN count(ep) AS c")[0]["c"]
            stats["methods_coverage"] = nc.execute_query("MATCH (ep:Episode) WHERE ep.research_methods IS NOT NULL RETURN count(ep) AS c")[0]["c"]
            stats["communities"] = nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"]
            stats["conflicts"] = nc.execute_query("MATCH (c:Conflict) RETURN count(c) AS c")[0]["c"]
            stats["literature_distills"] = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"]
            stats["domain_knowledge"] = nc.execute_query("MATCH (dk:DomainKnowledge) RETURN count(dk) AS c")[0]["c"]
    except Exception:
        pass

    return {
        "version": "2026-07-03",
        "total_tools": 18,
        "graph_stats": stats,
        "capabilities": {
            "data_ingestion": {
                "1_semantic_chunking": {
                    "status": "DONE",
                    "detail": f"{stats.get('chunks','?')} Chunk nodes, {stats.get('chunked_papers','?')}/208 papers",
                    "indexes": ["chunk_text_ft (FULLTEXT)", "chunk_vector_idx (VECTOR, 1024d)"],
                    "chunk_types": {"original": 12661, "abstract": 1970, "qa": 2508, "terms": 408},
                },
                "2_metadata_enrichment": {
                    "status": "DONE",
                    "detail": f"year={stats.get('year_coverage','?')}/208, keywords={stats.get('keywords_coverage','?')}/208, methods={stats.get('methods_coverage','?')}/208",
                    "fields": ["year", "historical_period", "keywords", "research_methods"],
                },
                "3_vector_finetuning": {
                    "status": "SKIPPED",
                    "detail": "text-embedding-v4 adequate; Layer 2 audit: no category with avg cosine >0.95",
                },
            },
            "query_processing": {
                "4_multi_query_rewrite": {
                    "status": "DONE",
                    "detail": "_llm_rewrite_query: 3 variants (keywords/academic/synonym)",
                    "function": "enable_rewrite=True in hybrid_search_entities",
                },
                "5_hyde": {
                    "status": "DONE",
                    "detail": "Flag-gated via enable_hyde=True",
                    "function": "_generate_hyde_answer",
                },
                "6_complex_decomposition": {
                    "status": "DONE",
                    "detail": "Auto-detect + parallel sub-search via _decompose_query",
                    "function": "enable_decompose=True in hybrid_search_entities",
                },
            },
            "retrieval_strategy": {
                "7_multi_path_hybrid": {
                    "status": "DONE",
                    "detail": "Vector+BM25+RRF fusion, Layer 1 eval: R@10 75.8% -> 82.5% (+8.7%)",
                },
                "8_parent_child_architecture": {
                    "status": "DONE",
                    "detail": "get_entity_passages: Entity -> EXTRACTED_FROM -> Episode -> CHUNK_OF -> Chunk(text)",
                },
                "9_graphrag": {
                    "status": "DONE",
                    "detail": f"5-layer distill + 4-layer domain + {stats.get('communities','?')} communities, Layer 3 faithfulness=4.90",
                },
            },
            "rerank_filter": {
                "10_cross_encoder_rerank": {
                    "status": "DONE",
                    "detail": "OpenAIRerankerClient, flag-gated; eval: no gain (BM25+RRF sufficient)",
                },
                "11_content_compression": {
                    "status": "DONE",
                    "detail": "compress_passages: LLM-based academic text condensation",
                },
                "12_closed_loop_eval": {
                    "status": "PARTIAL",
                    "detail": "3 eval layers complete (604 auto-generated queries). Missing: online A/B, user feedback flywheel",
                },
            },
        },
    }


@mcp.tool()
def rag_get_capability_status(output_format: str = "text") -> str:
    """Return a complete 12-capability RAG status report for the graphrag-marx system.

    Covers all 4 layers (Data Ingestion, Query Processing, Retrieval Strategy,
    Rerank & Filter) with implementation status, metrics, and remaining gaps.

    Args:
        output_format: \"text\" for a formatted human-readable report,
                       \"json\" for structured machine-readable data

    Example:
        rag_get_capability_status()                -> text report
        rag_get_capability_status(\"json\")          -> JSON string with full capability data
    """
    report = _build_capability_report()

    if output_format == "json":
        return json.dumps(report, ensure_ascii=False, indent=2)

    # Text format
    c = report["capabilities"]
    stats = report["graph_stats"]
    lines = []
    lines.append("=" * 70)
    lines.append(f"  graphrag-marx RAG Capability Status ({report['version']})")
    lines.append("=" * 70)
    lines.append(f"  Graph: {stats.get('episodes',208)} papers, {stats.get('entities',2839)} entities, "
                 f"{stats.get('chunks','?')} chunks, {stats.get('communities','?')} communities")
    lines.append(f"  Tools: {report['total_tools']} MCP-registered")
    lines.append("")

    for layer, caps in [
        ("DATA INGESTION LAYER", c["data_ingestion"]),
        ("QUERY PROCESSING LAYER", c["query_processing"]),
        ("RETRIEVAL STRATEGY LAYER", c["retrieval_strategy"]),
        ("RERANK & FILTER LAYER", c["rerank_filter"]),
    ]:
        lines.append(layer + ":")
        for key, info in caps.items():
            tag = info["status"]
            icon = "[DONE]" if tag == "DONE" else "[PART]" if tag == "PARTIAL" else "[SKIP]"
            lines.append(f"  {icon} {key}: {info['detail']}")
        lines.append("")

    lines.append(f"  Server: mcp_server/server.py, {report['total_tools']} tools registered")
    lines.append("=" * 70)
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════
# CATEGORY 5: LIGHT PIPELINE  (2 tools)
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def run_env_check(skip_md_check: bool = False) -> dict:
    """Run lightweight environment validation: MD file integrity scan + Neo4j connectivity test. Does NOT create backups.

    Args:
        skip_md_check: Skip the MD scan (208 folders ~ 2s, default False)
    """
    result = {"timestamp": datetime.now().isoformat(), "checks": {}}
    if not skip_md_check:
        md = check_md_integrity("summary")
        result["checks"]["md_files"] = md.get("summary", md)

    neo4j_ok = False
    neo4j_error = None
    try:
        from pipeline.neo4j import Neo4jConnection
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        nc.execute_query("MATCH (n) RETURN count(n) AS c LIMIT 1")
        neo4j_ok = True
        nc.close()
    except Exception as e:
        neo4j_error = str(e)

    result["checks"]["neo4j"] = {"connected": neo4j_ok}
    if neo4j_error:
        result["checks"]["neo4j"]["error"] = neo4j_error

    all_ok = neo4j_ok
    if not skip_md_check:
        all_ok = all_ok and result["checks"].get("md_files", {}).get("incomplete", 0) == 0
    result["all_passed"] = all_ok
    return result


@mcp.tool()
def get_progress_report() -> dict:
    """Alias for get_pipeline_status: structured progress report across all 6 modules."""
    return get_pipeline_status()


# ── HyperEdge 超边检索（V166+ 新增，超越 HyperGraphRAG 的知识层）───────
def _time_decay(pub_year, sigma_years: float = 15) -> float:
    """高斯时间衰减: 论文越新权重越高 (exp(-0.5*(age/sigma)^2)). 无年份返回1.0."""
    if not pub_year:
        return 1.0
    from datetime import datetime
    try:
        age = datetime.now().year - int(pub_year)
        if age <= 0:
            return 1.0
        return max(0.1, 2.718281828 ** (-0.5 * (age / sigma_years) ** 2))
    except Exception:
        return 1.0


@mcp.tool()
def search_hyperedges(query: str, top_k: int = 8, entity_names: list = None, htype: str = None) -> dict:
    """RETRIEVE STRUCTURED HYPEREDGES (N-ary knowledge facts) — the hypergraph knowledge layer.

    Three-arm retrieval fused by RRF with Gaussian time decay:
      1. Semantic arm: vector search on hyperedge text (hyperedge_vector_idx)
      2. Entity arm:    known entities → INVOLVED_IN → hyperedges (explicit N-ary links)
      3. BM25 arm:      fulltext search on hyperedge text/summary (hyperedge_text_ft)
    Unlike HyperGraphRAG's implicit order-based entity association, our INVOLVED_IN
    edges are explicit, and each hyperedge carries type/summary/claims/confidence.

    Args:
        query: Natural language query or keywords
        top_k: Max hyperedges to return (1-20, default 8)
        entity_names: Optional entity filter (e.g. from SAG stage3 confirmed entities)
        htype: Optional type filter (命题命题定义|理论机制|政策法规|典型案例|学术争议|研究方法|时间事件|概念辨析|其他)

    Returns:
        results: [{"id","text","type","summary","entities","claims","source_title","pub_year","confidence","score","method"}]
        total, method

    Example:
        search_hyperedges("资本下乡对农村集体经济的影响机制") -> {"results":[...], "total": 8, "method": "vector+entity+bm25+rrf+time_decay"}
    """
    try:
        top_k = max(1, min(20, int(top_k)))
        query = _sanitize_str(query, 200)
        nc = _get_neo4j()

        # ── Arm 1: 语义向量臂 ──
        vec_arm = []
        q_vec = _embed_query(query)
        if q_vec:
            try:
                rows = nc.execute_query(
                    "CALL db.index.vector.queryNodes('hyperedge_vector_idx', $k, $v) "
                    "YIELD node, score "
                    "RETURN node.id AS id, node.text AS text, node.type AS type, node.summary AS summary, "
                    "node.entities AS entities, node.claims AS claims, node.source_title AS source_title, "
                    "node.pub_year AS pub_year, node.confidence AS confidence, score "
                    "ORDER BY score DESC",
                    {"v": q_vec, "k": top_k * 2})
                vec_arm = [dict(r) for r in rows]
            except Exception as e:
                logger.warning(f"hyperedge vector search failed: {e}")

        # ── Arm 2: 实体导向臂 ──
        ent_arm = []
        ent_names = [e for e in (entity_names or []) if e][:10]
        if ent_names:
            try:
                rows = nc.execute_query(
                    "MATCH (e:Entity)-[r:INVOLVED_IN]->(h:HyperEdge) "
                    "WHERE e.name IN $names "
                    "RETURN h.id AS id, h.text AS text, h.type AS type, h.summary AS summary, "
                    "h.entities AS entities, h.claims AS claims, h.source_title AS source_title, "
                    "h.pub_year AS pub_year, h.confidence AS confidence, "
                    "count(e) AS hit_count, sum(r.weight) AS w "
                    "ORDER BY hit_count DESC, w DESC LIMIT $k",
                    {"names": ent_names, "k": top_k * 2})
                ent_arm = [dict(r) for r in rows]
                for r in ent_arm:
                    r["score"] = r.get("hit_count", 1)
            except Exception as e:
                logger.warning(f"hyperedge entity arm failed: {e}")

        # ── Arm 3: BM25 全文臂 ──
        bm_arm = []
        try:
            rows = nc.execute_query(
                "CALL db.index.fulltext.queryNodes('hyperedge_text_ft', $q, {limit: $k}) "
                "YIELD node, score "
                "RETURN node.id AS id, node.text AS text, node.type AS type, node.summary AS summary, "
                "node.entities AS entities, node.claims AS claims, node.source_title AS source_title, "
                "node.pub_year AS pub_year, node.confidence AS confidence, score",
                {"q": query, "k": top_k * 2})
            bm_arm = [dict(r) for r in rows]
        except Exception as e:
            logger.warning(f"hyperedge bm25 failed: {e}")

        # ── RRF 融合（按 id 去重，非 name）──
        K = 60
        scores: dict = {}
        meta: dict = {}
        arm_hits: dict = {}   # 跨臂命中数
        best_sim: dict = {}   # 各臂最佳向量相似度
        for arm in (vec_arm, ent_arm, bm_arm):
            for rank, item in enumerate(arm, start=1):
                hid = item.get("id")
                if not hid:
                    continue
                scores[hid] = scores.get(hid, 0) + 1.0 / (K + rank)
                arm_hits[hid] = arm_hits.get(hid, 0) + 1
                if hid not in meta:
                    meta[hid] = item
                # 记录向量臂的原始相似度(用于加权)
                sim = item.get("score")
                if isinstance(sim, (int, float)):
                    best_sim[hid] = max(best_sim.get(hid, 0.0), float(sim))
        merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]

        results = []
        for hid, rrf_score in merged:
            item = meta[hid]
            # ── V100 组合评分: RRF × 相似度加权 × 置信度 × 跨臂boost ──
            # 1. 相似度加权: 同排名时相似度高的优先 (0.5+0.5*sim)
            sim_w = 0.5 + 0.5 * min(1.0, max(0.0, best_sim.get(hid, 0.5)))
            # 2. 置信度融合: LLM抽取置信 (0.6+0.4*conf)
            conf_w = 0.6 + 0.4 * min(1.0, max(0.0, float(item.get("confidence", 0.8) or 0.8)))
            # 3. 跨臂boost: 多臂命中更可信 (1 + 0.15*(hits-1))
            arm_b = 1.0 + 0.15 * max(0, arm_hits.get(hid, 1) - 1)
            # 4. 时间衰减: 新文献微加权 (0.8+0.2*decay)
            decay = _time_decay(item.get("pub_year"))
            time_w = 0.8 + 0.2 * decay
            final_score = round(rrf_score * sim_w * conf_w * arm_b * time_w, 6)
            # 类型过滤
            if htype and item.get("type") != htype:
                continue
            results.append({
                "id": item.get("id"),
                "text": str(item.get("text", ""))[:300],
                "type": item.get("type", "其他"),
                "summary": str(item.get("summary", ""))[:200],
                "entities": (item.get("entities") or [])[:8],
                "claims": (item.get("claims") or [])[:5],
                "source_title": item.get("source_title", ""),
                "pub_year": item.get("pub_year"),
                "confidence": item.get("confidence", 0.8),
                "score": final_score,
                "method": "rrf+sim+conf+armboost+time_decay",
            })
        return {"results": results, "total": len(results),
                "method": "vector+entity+bm25+rrf+sim+conf+armboost+time_decay"}
    except Exception as e:
        _reset_neo4j()
        logger.exception("search_hyperedges failed")
        return {"error": str(e), "results": [], "total": 0}


@mcp.tool()
def get_hyperedge_info(hyperedge_id: str = None, text_contains: str = None, limit: int = 10) -> dict:
    """GET FULL DETAIL of one or more hyperedges — entity members, source paper, same-paper neighbors.

    Pure Cypher, zero LLM/vector cost. Useful for deep-dive and debugging.

    Args:
        hyperedge_id: Exact hyperedge ID (e.g. he_abc123_def4567890ab)
        text_contains: Substring match on hyperedge text (alternative to ID)
        limit: Max results (1-50, default 10)

    Returns:
        results: [{"id","text","type","summary","entities","claims","source_title","pub_year",
                    "confidence","member_entities":[{"name","category"}],"source_paper":{"folder","year","author"},
                    "same_paper_count"}]
        total

    Example:
        get_hyperedge_info(text_contains="资本下乡") -> {"results":[...], "total": 5}
    """
    try:
        limit = max(1, min(50, int(limit)))
        nc = _get_neo4j()
        if hyperedge_id:
            rows = nc.execute_query(
                "MATCH (h:HyperEdge {id:$id}) "
                "RETURN h.id AS id, h.text AS text, h.type AS type, h.summary AS summary, "
                "h.entities AS entities, h.claims AS claims, h.source_title AS source_title, "
                "h.pub_year AS pub_year, h.confidence AS confidence LIMIT $k",
                {"id": _sanitize_str(hyperedge_id, 100), "k": limit})
        elif text_contains:
            rows = nc.execute_query(
                "MATCH (h:HyperEdge) WHERE h.text CONTAINS $t "
                "RETURN h.id AS id, h.text AS text, h.type AS type, h.summary AS summary, "
                "h.entities AS entities, h.claims AS claims, h.source_title AS source_title, "
                "h.pub_year AS pub_year, h.confidence AS confidence LIMIT $k",
                {"t": _sanitize_str(text_contains, 100), "k": limit})
        else:
            return {"error": "hyperedge_id or text_contains required", "results": [], "total": 0}

        results = []
        for r in rows:
            item = dict(r)
            # 成员实体
            try:
                members = nc.execute_query(
                    "MATCH (e:Entity)-[:INVOLVED_IN]->(h:HyperEdge {id:$id}) "
                    "RETURN e.name AS name, e.category AS category LIMIT 20",
                    {"id": item.get("id")})
                item["member_entities"] = [{"name": m["name"], "category": m.get("category", "")} for m in members]
            except Exception:
                item["member_entities"] = []
            # 来源论文
            try:
                ep = nc.execute_query(
                    "MATCH (h:HyperEdge {id:$id})-[:FROM_EPISODE]->(ep:Episode) "
                    "RETURN ep.source_folder AS folder, ep.title AS title LIMIT 1",
                    {"id": item.get("id")})
                item["source_paper"] = ep[0] if ep else {}
            except Exception:
                item["source_paper"] = {}
            # 同篇超边数
            try:
                if item.get("source_title"):
                    cnt = nc.execute_query(
                        "MATCH (h:HyperEdge {source_title:$t}) RETURN count(h) AS c",
                        {"t": item.get("source_title")})
                    item["same_paper_count"] = cnt[0]["c"] if cnt else 0
            except Exception:
                item["same_paper_count"] = 0
            results.append(item)
        return {"results": results, "total": len(results)}
    except Exception as e:
        _reset_neo4j()
        logger.exception("get_hyperedge_info failed")
        return {"error": str(e), "results": [], "total": 0}


# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    mcp.run(transport="stdio")
