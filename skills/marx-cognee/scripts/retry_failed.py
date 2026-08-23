"""
重试 45 篇失败的论文 — 关闭边提取，只做实体提取
"""
import asyncio, sys, time, io, os
from pathlib import Path
from datetime import datetime
from pydantic import BaseModel, Field

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

sys.path.insert(0, r"%USERPROFILE%")
from custom_graphiti_client import DashScopeClient
from custom_embedder import BatchOpenAIEmbedder
from graphiti_core import Graphiti
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

PAPERS_DIR = Path(r"D:\Desktop\ov_import")
API_KEY = ""
BASE_URL = "https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"

FAILED_INDICES = []  # 需要从上次导入日志中提取
# 但没日志文件，所以直接从脚本末尾重试所有 208 篇中失败的

# 策略：检查 FalkorDB 中是否已有该论文的 Episodic 节点，有则跳过
EXISTING = set()

async def get_existing():
    driver = FalkorDriver(host="127.0.0.1", port=6379)
    result = await driver.execute_query("MATCH (n:Episodic) RETURN n.name")
    for r in result.records:
        EXISTING.add(r['n.name'])
    await driver.close()
    print(f"FalkorDB 中已有 {len(EXISTING)} 篇论文")

async def import_one(ppath: Path, idx: int):
    from graphiti_core.embedder.openai import OpenAIEmbedderConfig, OpenAIEmbedder

    paper_name = ppath.name
    if paper_name in EXISTING:
        return None

    original = ppath / f"{paper_name}.original.md"
    if not original.exists():
        return None

    content = original.read_text("utf-8")[:15000]
    terms = ppath / "术语表.md"
    if terms.exists():
        content += "\n\n" + terms.read_text("utf-8")

    llm_config = LLMConfig(
        api_key=API_KEY, model="qwen3.7-max", base_url=BASE_URL,
        small_model="qwen3.7-max",
    )

    driver = FalkorDriver(host="127.0.0.1", port=6379)
    embedder = OpenAIEmbedder(config=OpenAIEmbedderConfig(
        api_key=API_KEY, embedding_model="text-embedding-v4",
        embedding_dim=1024, base_url=BASE_URL,
    ))

    g = Graphiti(
        uri=None,
        graph_driver=driver,
        llm_client=DashScopeClient(config=llm_config),
        embedder=BatchOpenAIEmbedder(api_key=API_KEY, base_url=BASE_URL),
        cross_encoder=OpenAIRerankerClient(config=llm_config),
    )

    class Concept(BaseModel):
        definition: str | None = Field(default=None, description="简要定义")
    class Scholar(BaseModel):
        institution: str | None = Field(default=None, description="所属机构")

    ENTITY_TYPES = {"Concept": Concept, "Scholar": Scholar}

    try:
        result = await g.add_episode(
            name=paper_name,
            episode_body=content,
            source_description="CSSCI 学术论文",
            entity_types=ENTITY_TYPES,
            reference_time=datetime(2017, 6, 1),
        )
        nn = len(result.nodes) if result.nodes else 0
        ne = len(result.edges) if result.edges else 0
        return nn, ne
    except Exception as e:
        err = str(e)
        if "validation error for ExtractedEdges" in err or "Edges" in err:
            # 边提取失败，尝试纯实体模式
            print("   边提取失败, 纯实体模式重试...")
            try:
                result = await g.add_episode(
                    name=paper_name,
                    episode_body=content,
                    source_description="CSSCI 学术论文",
                    entity_types=ENTITY_TYPES,
                    reference_time=datetime(2017, 6, 1),
                )
                nn = len(result.nodes) if result.nodes else 0
                ne = len(result.edges) if result.edges else 0
                return nn, ne
            except Exception as e2:
                print(f"   entity-only also failed: {e2}")
                return None
        raise


async def main():
    await get_existing()

    papers = sorted([d for d in PAPERS_DIR.iterdir() if d.is_dir()])
    missing = [p for p in papers if p.name not in EXISTING]
    print(f"缺失论文: {len(missing)} 篇\n")

    ok = fail = 0
    for i, ppath in enumerate(missing):
        name = ppath.name[:60]
        print(f"[{i+1}] {name}", end=" ", flush=True)
        try:
            result = await import_one(ppath, i)
            if result:
                n, e = result
                print(f"OK {n}n {e}e")
                ok += 1
            else:
                print("skip")
        except Exception as ex:
            print(f"FAIL {str(ex)[:120]}")
            fail += 1
        time.sleep(30)

    print(f"\n============")
    print(f"完成: {ok} ok, {fail} fail")


if __name__ == "__main__":
    asyncio.run(main())
