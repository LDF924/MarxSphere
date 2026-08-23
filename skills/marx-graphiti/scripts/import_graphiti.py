"""
已修复所有兼容性问题:
1. DashScopeClient: /chat/completions + json_object
2. BatchOpenAIEmbedder: 分片≤10
3. small_model: 显式设置避免 gpt-4.1-nano 默认值
"""
import asyncio, sys, time, io, os
from pathlib import Path
from datetime import datetime
from pydantic import BaseModel, Field

# ====== 配置 ======
PAPERS_DIR = Path(r"D:\Desktop\ov_import")
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASS = os.environ.get("NEO4J_PASS", "password")
API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
BASE_URL = os.environ.get("DASHSCOPE_BASE_URL", "https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
TOTAL_PAPERS = 208
import os

sys.path.insert(0, r"%USERPROFILE%")
from custom_graphiti_client import DashScopeClient
from custom_embedder import BatchOpenAIEmbedder

class Concept(BaseModel):
    """学术概念或理论"""
    definition: str | None = Field(default=None, description="简要定义")

class Scholar(BaseModel):
    """学者/研究人员"""
    institution: str | None = Field(default=None, description="所属机构")

class Organization(BaseModel):
    """组织机构"""
    org_type: str | None = Field(default=None, description="组织类型")

class Location(BaseModel):
    """地理位置"""
    loc_type: str | None = Field(default=None, description="地点类型")

class Policy(BaseModel):
    """政策法规文件"""
    year: str | None = Field(default=None, description="年份")

class Event(BaseModel):
    """事件历史节点"""
    year: str | None = Field(default=None, description="年份")

class Metric(BaseModel):
    """量化指标统计数据"""
    value: str | None = Field(default=None, description="数值")

ENTITY_TYPES = {
    "Concept": Concept, "Scholar": Scholar, "Organization": Organization,
    "Location": Location, "Policy": Policy, "Event": Event, "Metric": Metric,
}

class Proposes(BaseModel): pass
class Cites(BaseModel): pass
class AffiliatedWith(BaseModel): pass
class LocatedIn(BaseModel): pass
class Influences(BaseModel): pass
class Measures(BaseModel): pass
class Opposes(BaseModel): pass

EDGE_TYPES = {k: v for k, v in {
    "Proposes": Proposes, "Cites": Cites, "AffiliatedWith": AffiliatedWith,
    "LocatedIn": LocatedIn, "Influences": Influences, "Measures": Measures,
    "Opposes": Opposes,
}.items()}

EDGE_TYPE_MAP = {
    ("Scholar", "Concept"): ["Proposes", "Opposes"],
    ("Scholar", "Scholar"): ["Cites", "Influences"],
    ("Scholar", "Organization"): ["AffiliatedWith"],
    ("Organization", "Location"): ["LocatedIn"],
    ("Event", "Location"): ["LocatedIn"],
    ("Policy", "Concept"): ["Influences"],
    ("Metric", "Concept"): ["Measures"],
    ("Concept", "Concept"): ["Influences", "Opposes"],
    ("Scholar", "Event"): ["Influences"],
    ("Organization", "Policy"): ["Influences"],
    ("Scholar", "Policy"): ["Proposes", "Opposes"],
}


async def import_one(paper_dir: Path):
    from graphiti_core import Graphiti
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

    paper_name = paper_dir.name
    original = paper_dir / f"{paper_name}.original.md"
    if not original.exists():
        return None, None

    content = original.read_text(encoding="utf-8")[:20000]
    terms_file = paper_dir / "术语表.md"
    if terms_file.exists():
        content += "\n\n## 术语表\n" + terms_file.read_text(encoding="utf-8")

    llm_config = LLMConfig(
        api_key=API_KEY, model="qwen3.7-max", base_url=BASE_URL,
        small_model="qwen3.7-max",
    )

    g = Graphiti(
        NEO4J_URI, NEO4J_USER, NEO4J_PASS,
        llm_client=DashScopeClient(config=llm_config),
        embedder=BatchOpenAIEmbedder(api_key=API_KEY, base_url=BASE_URL),
        cross_encoder=OpenAIRerankerClient(config=llm_config),
    )

    result = await asyncio.wait_for(
        g.add_episode(
            name=paper_name, episode_body=content,
            source_description="CSSCI 学术论文",
            reference_time=datetime(2017, 6, 1),
        ),
        timeout=300
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

    # QPM 控制参数
    MAX_QPM = 3
    COOLDOWN = 60
    tokens_used = 0
    TOKENS_PER_PAPER = 150000
    WARN_THRESHOLD = 100000

    print(f"Import {total} papers | LLM=qwen3.7-max\n")
    print(f"Target: {NEO4J_URI} | {TOTAL_PAPERS} total papers\n")

    ok = fail = 0
    for i, p in enumerate(batch):
        name = p.name[:50]
        print(f"[{start+i+1}] {name}", end=" ", flush=True)
        try:
            n, e = await import_one(p)
            if n is not None:
                print(f"OK {n}n {e}e")
                ok += 1
                tokens_used += TOKENS_PER_PAPER
            else:
                print("skip")
        except Exception as ex:
            err = str(ex)
            if '429' in err or 'Rate limit' in err or 'limit_requests' in err:
                print(f"QPM_HIT, cooldown {COOLDOWN}s...")
                time.sleep(COOLDOWN)
                try:
                    n, e = await import_one(p)
                    if n is not None:
                        print(f"  retry OK {n}n {e}e")
                        ok += 1
                        tokens_used += TOKENS_PER_PAPER
                    else:
                        print("  retry skip")
                except Exception as ex2:
                    print(f"  retry FAIL {str(ex2)[:100]}")
                    fail += 1
            elif '403' in err or 'quota' in err.lower() or 'FreeTier' in err or 'insufficient' in err.lower():
                print(f"QUOTA_EXHAUSTED. Saving checkpoint at paper {start+i+1}")
                with open(r"%USERPROFILE%\import_checkpoint.txt", "w") as cf:
                    cf.write(str(start + i + 1))
                return
            else:
                print(f"FAIL {str(ex)[:120]}")
                fail += 1

        if (i + 1) % 3 == 0:
            print(f"  -- [{i+1}/{total}] ok={ok} fail={fail} | ~{tokens_used} tokens\n")
        time.sleep(30)

    print(f"\n{'='*40}")
    print(f"Done: {total} papers | {ok} ok | {fail} fail")


if __name__ == "__main__":
    asyncio.run(main())
