from graphiti_core import Graphiti
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_client import OpenAIClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

# ====== 你的阿里百炼 Graphiti API Key ======
API_KEY = ""
BASE_URL = "https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
# Embedding uses DashScope standard endpoint (MAAS has Access denied for embeddings)
EMBED_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
EMBED_API_KEY = ""
# ===========================================

llm_config = LLMConfig(
    api_key=API_KEY,
    model="qwen3.7-max",
    base_url=BASE_URL,
)

graphiti = Graphiti(
    "bolt://localhost:7687",
    "neo4j",
    "password",
    llm_client=OpenAIClient(config=llm_config),
    embedder=OpenAIEmbedder(config=OpenAIEmbedderConfig(
        api_key=EMBED_API_KEY,
        embedding_model="text-embedding-v4",
        embedding_dim=1024,
        base_url=EMBED_BASE_URL,
    )),
    cross_encoder=OpenAIRerankerClient(config=llm_config),
)

print("Graphiti 初始化成功！")
print(f"图数据库: bolt://localhost:7687")
print(f"LLM: qwen3.7-max")
print(f"Embedding: text-embedding-v4 (1024维) [DashScope标准端点]")
print(f"Reranker: qwen3.7-max (cross_encoder via 阿里百炼)")
