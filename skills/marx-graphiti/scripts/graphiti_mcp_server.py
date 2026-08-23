"""
Graphiti MCP Server — 启动命令: python graphiti_mcp_server.py
MCP 端点: http://127.0.0.1:8001/mcp
"""
import os, sys

os.environ["OPENAI_API_KEY"] = "placeholder"

API_KEY = ""
BASE_URL = "https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
# Embedding uses DashScope standard endpoint (MAAS has Access denied for embeddings)
EMBED_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
EMBED_API_KEY = ""

from graphiti_core import Graphiti
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_client import OpenAIClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from mcp.server.fastmcp import FastMCP

# Import curated domain relation types
sys.path.insert(0, r"%USERPROFILE%")
from marx_edge_types import (
    MARX_EDGE_TYPES, MARX_ENTITY_TYPE_MAP, MARX_EDGE_TYPE_DESCRIPTIONS,
)

# --- Graphiti ---
llm_config = LLMConfig(api_key=API_KEY, model="qwen3.7-max", base_url=BASE_URL)
graphiti = Graphiti(
    "bolt://localhost:7687", "neo4j", "password",
    llm_client=OpenAIClient(config=llm_config),
    embedder=OpenAIEmbedder(config=OpenAIEmbedderConfig(
        api_key=EMBED_API_KEY, embedding_model="text-embedding-v4", embedding_dim=1024, base_url=EMBED_BASE_URL,
    )),
    cross_encoder=OpenAIRerankerClient(config=llm_config),
)

# --- MCP ---
mcp = FastMCP("Graphiti Knowledge Graph")

@mcp.tool()
async def add_paper(paper_name: str, content: str) -> str:
    """将一篇学术论文添加到知识图谱，自动提取实体和关系"""
    try:
        result = await graphiti.add_episode(
            name=paper_name, episode_body=content[:20000],
            source_description="CSSCI 学术论文",
        )
        n = len(result.nodes) if result.nodes else 0
        e = len(result.edges) if result.edges else 0
        return f"已提取: {n} 个实体, {e} 条关系"
    except Exception as ex:
        return f"错误: {ex}"

@mcp.tool()
async def add_paper_curated(paper_name: str, content: str) -> str:
    """将论文添加到知识图谱，使用15种领域精选关系类型（IMPLEMENTS/CAUSES/CONFLICTS_WITH等）约束提取，提升精确率。

    对比 add_paper（自由提取），本工具将关系类型限定为资本下乡领域的15种核心类型，
    有效减少噪音关系和无关边。"""
    import json
    try:
        # Build custom extraction instructions with entity type hints
        entity_hints = "\n".join(
            f"  - {cn_name} ({en_name})" for cn_name, en_name in
            list(MARX_ENTITY_TYPE_MAP.items())[:20]
        )
        relation_hints = "\n".join(
            f"  - {rname}: {rdesc}" for rname, rdesc in MARX_EDGE_TYPE_DESCRIPTIONS.items()
        )
        custom_instructions = f"""你正在处理一篇关于"资本下乡"（工商资本进入农业农村领域）的CSSCI学术论文。

领域实体类型参考（请尽量将实体归类为以下类型之一）：
{entity_hints}

领域关系类型说明（只能使用FACT_TYPES中列出的关系类型）：
{relation_hints}

提取要求：
1. 优先识别政策文件、制度安排、利益主体、经济概念等核心实体
2. 重点关注因果关系(CAUSES)、利益冲突(CONFLICTS_WITH)、制度规制(REGULATES)、土地流转(TRANSFERS_TO)等核心关系
3. 为每条关系填写fact字段时保留具体人名/地名/数据/年份
4. 避免提取过于宽泛或无具体事实支撑的关系"""

        result = await graphiti.add_episode(
            name=paper_name,
            episode_body=content[:20000],
            source_description="CSSCI 学术论文（资本下乡领域精选关系类型）",
            edge_types=MARX_EDGE_TYPES,
            custom_extraction_instructions=custom_instructions,
        )
        n = len(result.nodes) if result.nodes else 0
        e = len(result.edges) if result.edges else 0
        edge_types_found = {}
        for edge in (result.edges or []):
            rt = edge.relation_type if hasattr(edge, 'relation_type') else str(edge)
            edge_types_found[rt] = edge_types_found.get(rt, 0) + 1
        return json.dumps({
            "status": "ok",
            "entities_extracted": n,
            "edges_extracted": e,
            "edge_types_used": edge_types_found,
        }, ensure_ascii=False)
    except Exception as ex:
        return json.dumps({"status": "error", "error": str(ex)}, ensure_ascii=False)

@mcp.tool()
async def get_entity_schema() -> str:
    """返回当前图形引擎使用的实体类型分类体系和精选关系类型说明"""
    import json
    return json.dumps({
        "entity_types": MARX_ENTITY_TYPE_MAP,
        "relation_types": MARX_EDGE_TYPE_DESCRIPTIONS,
        "total_entity_types": len(MARX_ENTITY_TYPE_MAP),
        "total_relation_types": len(MARX_EDGE_TYPES),
    }, ensure_ascii=False, indent=2)

@mcp.tool()
async def search_papers(query: str, max_results: int = 5) -> str:
    """语义搜索知识图谱中的论文实体和关系"""
    try:
        result = await graphiti.search(query, num_results=max_results)
        if not result:
            return "未找到相关结果"
        return "\n".join(f"- {r.fact}" for r in result[:max_results])
    except Exception as ex:
        return f"错误: {ex}"

@mcp.tool()
async def get_status() -> str:
    """获取知识图谱统计"""
    from neo4j import GraphDatabase
    d = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "password"))
    with d.session() as s:
        nodes = s.run("MATCH (n) RETURN count(n) as c").single()["c"]
        edges = s.run("MATCH ()-[r]->() RETURN count(r) as c").single()["c"]
    d.close()
    return f"节点: {nodes}, 边: {edges}"

if __name__ == "__main__":
    import uvicorn
    print("Graphiti MCP Server -> http://127.0.0.1:8001/mcp")
    starlette_app = mcp.streamable_http_app()
    uvicorn.run(starlette_app, host="127.0.0.1", port=8001)
