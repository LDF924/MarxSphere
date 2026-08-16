"""自定义 Graphiti LLM Client — 适配阿里百炼 /chat/completions"""
import json, logging
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
from pydantic import BaseModel
from graphiti_core.llm_client.config import DEFAULT_MAX_TOKENS, LLMConfig
from graphiti_core.llm_client.openai_base_client import BaseOpenAIClient, DEFAULT_REASONING, DEFAULT_VERBOSITY

logger = logging.getLogger(__name__)


class FakeResponse:
    """Wraps a dict as if it were an OpenAI Responses API response with .output_text"""
    def __init__(self, content: str, usage=None):
        self.output_text = content
        self.usage = usage


class DashScopeClient(BaseOpenAIClient):

    def __init__(self, config: LLMConfig | None = None, cache: bool = False,
                 client=None, max_tokens=DEFAULT_MAX_TOKENS,
                 reasoning=DEFAULT_REASONING, verbosity=DEFAULT_VERBOSITY):
        super().__init__(config, cache, max_tokens, reasoning, verbosity)
        if config is None:
            config = LLMConfig()
        self.client = client or AsyncOpenAI(api_key=config.api_key, base_url=config.base_url)

    async def _create_structured_completion(
        self, model: str, messages: list[ChatCompletionMessageParam],
        temperature: float | None, max_tokens: int,
        response_model: type[BaseModel],
        reasoning: str | None = None, verbosity: str | None = None,
    ):
        schema_json = json.dumps(response_model.model_json_schema(), ensure_ascii=False)
        schema_instruction = (
            f"\n\nYou MUST respond with a single RAW JSON object that strictly matches this schema:\n"
            f"{schema_json}\n"
            f"Do NOT wrap with markdown code blocks (no ```json). Only output the raw JSON object.\n"
        )
        messages = list(messages)
        last = messages[-1]
        messages[-1] = {
            "role": last["role"],
            "content": (last.get("content", "") or "") + schema_instruction,
        }

        kwargs = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        if temperature is not None:
            kwargs["temperature"] = temperature

        response = await self.client.chat.completions.create(**kwargs)
        content = response.choices[0].message.content or "{}"

        # Strip markdown fences
        text = content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        # Parse to validate JSON, then wrap as FakeResponse
        parsed = json.loads(text)
        return FakeResponse(json.dumps(parsed, ensure_ascii=False), response.usage)

    async def _create_completion(self, **kwargs):
        return await self.client.chat.completions.create(**kwargs)


class BatchEmbedder:
    """包装 OpenAIEmbedder，自动把 >10 的批次切成百炼兼容的 10 个一组"""
    def __init__(self, api_key: str, base_url: str, model: str = "text-embedding-v4", dim: int = 1024):
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
        self.config = OpenAIEmbedderConfig(
            api_key=api_key, embedding_model=model,
            embedding_dim=dim, base_url=base_url,
        )
        self.inner = OpenAIEmbedder(config=self.config)
        self.embedding_model = model

    async def create_batch(self, texts: list[str]) -> list[list[float]]:
        MAX_BATCH = 10
        results = []
        for i in range(0, len(texts), MAX_BATCH):
            chunk = texts[i:i + MAX_BATCH]
            embeddings = await self.inner.create_batch(chunk)
            results.extend(embeddings)
        return results

    async def create(self, text: str) -> list[float]:
        result = await self.inner.create_batch([text])
        return result[0]
