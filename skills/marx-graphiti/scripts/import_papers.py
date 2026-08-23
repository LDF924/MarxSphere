"""
批量导入 208 篇论文到 OpenViking（WebDAV PUT）和 Graphiti
用法: python import_papers.py [start] [count]
"""
import asyncio
import sys
import time
from pathlib import Path
from datetime import datetime
import requests

PAPERS_DIR = Path(r"D:\Desktop\ov_import")
OV_URL = "http://127.0.0.1:8000"

API_KEY = ""
BASE_URL = "https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"


def add_to_openviking(paper_dir: Path) -> int:
    """先 MKCOL 创建目录，再 PUT 上传 4 个文件到 OpenViking"""
    paper_name = paper_dir.name
    # 先创建目录 (409 说明已存在，忽略)
    resp_mkcol = requests.request("MKCOL", f"{OV_URL}/webdav/resources/{paper_name}/")
    if resp_mkcol.status_code not in (200, 201, 204, 409):
        print(f"    [WARN] MKCOL: {resp_mkcol.status_code}")
        return 0

    count = 0
    for md_file in sorted(paper_dir.glob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        resp = requests.put(
            f"{OV_URL}/webdav/resources/{paper_name}/{md_file.name}",
            data=content.encode("utf-8"),
            timeout=60,
            headers={"Content-Type": "text/markdown; charset=utf-8"},
        )
        if resp.status_code in (200, 201, 204):
            count += 1
        else:
            print(f"    [WARN] {md_file.name}: HTTP {resp.status_code}")
    return count


async def add_to_graphiti(paper_dir: Path):
    from graphiti_core import Graphiti
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_client import OpenAIClient
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

    paper_name = paper_dir.name
    original_name = f"{paper_name}.original.md"
    original_path = paper_dir / original_name
    if not original_path.exists():
        return None

    content = original_path.read_text(encoding="utf-8")

    llm_config = LLMConfig(api_key=API_KEY, model="qwen3.7-max", base_url=BASE_URL)
    g = Graphiti(
        "bolt://localhost:7687", "neo4j", "password",
        llm_client=OpenAIClient(config=llm_config),
        embedder=OpenAIEmbedder(config=OpenAIEmbedderConfig(
            api_key=API_KEY, embedding_model="text-embedding-v4",
            embedding_dim=1024, base_url=BASE_URL,
        )),
        cross_encoder=OpenAIRerankerClient(config=llm_config),
    )

    # 限制长度 + 用 markdown code block 包装
    body = content[:20000] if len(content) > 20000 else content
    body = "```markdown\n" + body + "\n```"
    try:
        result = await g.add_episode(
            name=paper_name,
            episode_body=body,
            source_description="CSSCI 学术论文",
            reference_time=datetime(2017, 6, 1),
        )
        n_nodes = len(result.nodes) if result.nodes else 0
        n_edges = len(result.edges) if result.edges else 0
        return n_nodes, n_edges
    except Exception as e:
        print(f"    [ERROR] {e}")
        return None


async def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else None

    paper_dirs = sorted([d for d in PAPERS_DIR.iterdir() if d.is_dir()])
    batch = paper_dirs[start:start + limit] if limit else paper_dirs[start:]
    total = len(batch)

    print(f"导入 {total} 篇 (第 {start}~{start+total-1})")
    print(f"OpenViking WebDAV: {OV_URL}")
    print(f"Graphiti LLM: qwen3.7-max\n")

    for i, paper_dir in enumerate(batch):
        idx = start + i
        name = paper_dir.name[:60]
        print(f"[{idx+1}] {name}")

        # 1) OpenViking WebDAV upload
        n_ov = add_to_openviking(paper_dir)
        print(f"  OV: {n_ov}/4 files")

        # 2) Graphiti entity extraction
        gt = await add_to_graphiti(paper_dir)
        if gt:
            nodes, edges = gt
            print(f"  GT: {nodes} nodes, {edges} edges")

        if (i + 1) % 3 == 0:
            print(f"  ...{i+1}/{total}\n")
            time.sleep(1)

    print(f"\n===== 完成: {total} 篇 =====")


if __name__ == "__main__":
    asyncio.run(main())
