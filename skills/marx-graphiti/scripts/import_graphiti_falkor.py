"""
Graphiti + FalkorDB 全量导入 208 篇论文
FalkorDB 通过 Docker Desktop 运行，连接方式: redis://localhost:6379
"""
import asyncio, sys, time, io, os, subprocess
from pathlib import Path
from datetime import datetime
from pydantic import BaseModel, Field

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ====== 配置 ======
PAPERS_DIR = Path(r"D:\Desktop\ov_import")
API_KEY = "sk-ws-H.RYRRIEP.c27n.MEQCIH9Blb-_G38pAxOmXN9aOGSyyc_EjejYiztcv1di2feQAiB3d4VNAhBro7ts94OR5HD9biDhseby4C8YIeOdhjXWvw"
BASE_URL = "https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
TOTAL_PAPERS = 208

# FalkorDB connection via Docker Desktop
FALKORDB_HOST = "127.0.0.1"
FALKORDB_PORT = 6379

sys.path.insert(0, r"%USERPROFILE%")
from custom_graphiti_client import DashScopeClient
from custom_embedder import BatchOpenAIEmbedder

# FalkorDB 健康检查通过 docker exec
def check_falkordb():
    try:
        result = subprocess.run(
            ["powershell", "-Command", "docker", "exec", "falkordb", "redis-cli", "ping"],
            capture_output=True, text=True, timeout=10
        )
        return "PONG" in result.stdout
    except:
        return False

print(f"FalkorDB check: {'OK' if check_falkordb() else 'UNREACHABLE'}")
print(f"API: qwen3.7-max @ {BASE_URL}")
print(f"Papers: {TOTAL_PAPERS} in {PAPERS_DIR}")
print()

# ====== Entity types ======
class Concept(BaseModel):
    definition: str | None = Field(default=None, description="简要定义")

class Scholar(BaseModel):
    institution: str | None = Field(default=None, description="所属机构")

ENTITY_TYPES = {
    "Concept": Concept, "Scholar": Scholar,
}

async def import_one(paper_dir: Path):
    from graphiti_core import Graphiti
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

    paper_name = paper_dir.name
    original = paper_dir / f"{paper_name}.original.md"
    if not original.exists():
        return None, None

    content = original.read_text(encoding="utf-8")[:15000]
    terms_file = paper_dir / "术语表.md"
    if terms_file.exists():
        content += "\n\n## 术语表\n" + terms_file.read_text(encoding="utf-8")

    llm_config = LLMConfig(
        api_key=API_KEY, model="qwen3.7-max", base_url=BASE_URL,
        small_model="qwen3.7-max",
    )

    from graphiti_core.driver.falkordb_driver import FalkorDriver

    driver = FalkorDriver(host=FALKORDB_HOST, port=FALKORDB_PORT)

    g = Graphiti(
        uri=None,
        graph_driver=driver,
        llm_client=DashScopeClient(config=llm_config),
        embedder=BatchOpenAIEmbedder(api_key=API_KEY, base_url=BASE_URL),
        cross_encoder=OpenAIRerankerClient(config=llm_config),
    )

    result = await g.add_episode(
        name=paper_name, episode_body=content,
        source_description="CSSCI 学术论文",
        entity_types=ENTITY_TYPES,
        reference_time=datetime(2017, 6, 1),
    )

    n_nodes = len(result.nodes) if result.nodes else 0
    n_edges = len(result.edges) if result.edges else 0
    return n_nodes, n_edges


async def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else None

    papers = sorted([d for d in PAPERS_DIR.iterdir() if d.is_dir()])
    batch = papers[start:] if limit is None else papers[start:start + limit]
    total = len(batch)

    print(f"Import {total} papers (idx {start}..), {TOTAL_PAPERS} total\n")

    ok = fail = 0
    for i, p in enumerate(batch):
        name = p.name[:50]
        print(f"[{start+i+1}] {name}", end=" ", flush=True)
        try:
            n, e = await import_one(p)
            if n is not None:
                print(f"OK {n}n {e}e")
                ok += 1
            else:
                print("skip (no original)")
        except Exception as ex:
            print(f"FAIL {str(ex)[:120]}")
            fail += 1

        if (i + 1) % 3 == 0:
            print(f"  -- [{i+1}/{total}] ok={ok} fail={fail}\n")
        time.sleep(30)

    print(f"\n==========")
    print(f"Done: {total} papers | {ok} ok | {fail} fail")


if __name__ == "__main__":
    asyncio.run(main())
