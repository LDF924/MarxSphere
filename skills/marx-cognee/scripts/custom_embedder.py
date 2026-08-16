"""Embedding 适配 — 继承 OpenAIEmbedder，将大批次分片为 10 一组"""
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig


class BatchOpenAIEmbedder(OpenAIEmbedder):
    def __init__(self, api_key: str, base_url: str, model: str = "text-embedding-v4", dim: int = 1024):
        config = OpenAIEmbedderConfig(
            api_key=api_key, embedding_model=model,
            embedding_dim=dim, base_url=base_url,
        )
        super().__init__(config=config)

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        MAX_BATCH = 10
        results = []
        for i in range(0, len(input_data_list), MAX_BATCH):
            chunk = input_data_list[i:i + MAX_BATCH]
            embeddings = await super().create_batch(chunk)
            results.extend(embeddings)
        return results
