"""统一 LLM 抽象层 — 支持本地模型（Ollama / llama.cpp）和 API 模式自动切换。

配置方式（config.env）：
  LLM_MODE=local          # local | api
  LLM_BASE_URL=...        # API 模式：OpenAI 兼容地址
  LLM_API_KEY=...         # API 模式：密钥
  LLM_MODEL=deepseek-chat # API 模式：模型名
  LLM_TIMEOUT=300         # 读取超时（秒），长文档/代码生成建议 300-600
  LOCAL_PROVIDER=ollama   # 本地模式：ollama | llamacpp
  LOCAL_MODEL=qwen3:4b    # 本地模式：模型名
"""

import logging
import time
from typing import Optional

import httpx
from openai import OpenAI

logger = logging.getLogger("pdf2obsidian")

# 全局 token 统计
TOKEN_USAGE = {}
for _key in ("summary", "glossary", "qa", "translate"):
    for _suffix in ("_prompt", "_completion", "_total"):
        TOKEN_USAGE[f"{_key}{_suffix}"] = 0

# 可重试异常：仅连接/读取超时和网络错误，不重试业务错误（4xx/5xx）
RETRYABLE_EXCEPTIONS = (
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    httpx.NetworkError,
)


def _is_retryable(err: Exception) -> bool:
    """判断异常是否可重试（仅网络/超时类）。"""
    if isinstance(err, RETRYABLE_EXCEPTIONS):
        return True
    err_str = str(err).lower()
    retry_keywords = ("timed out", "timeout", "connection reset", "connection refused",
                       "network", "eof", "broken pipe", "tls", "ssl", "too many requests")
    return any(kw in err_str for kw in retry_keywords)


def _openai_client(config: dict) -> Optional[OpenAI]:
    """创建 OpenAI 兼容客户端（API 或本地 Ollama）。

    timeout 使用 httpx.Timeout 精细化控制：
      - connect: 10s（建立连接）
      - read: 由 LLM_TIMEOUT 控制（等待响应，长文本建议 300-600s）
      - write: 60s（发送请求体）
      - pool: 10s（连接池获取）
    """
    base_url = config.get("LLM_BASE_URL", "").strip()
    api_key = config.get("LLM_API_KEY", "").strip()
    if not base_url:
        return None

    read_timeout = int(config.get("LLM_TIMEOUT", "300"))
    http_timeout = httpx.Timeout(
        connect=10.0,
        read=float(read_timeout),
        write=60.0,
        pool=10.0,
    )
    return OpenAI(
        base_url=base_url,
        api_key=api_key or "not-needed",
        timeout=http_timeout,
        max_retries=0,  # 我们自己控制重试逻辑
    )


def get_llm_mode(config: dict) -> str:
    """返回当前 LLM 模式：local 或 api。"""
    return config.get("LLM_MODE", "api").strip().lower()


def get_model_name(config: dict) -> str:
    """返回当前模型名。"""
    mode = get_llm_mode(config)
    if mode == "local":
        return config.get("LOCAL_MODEL", "qwen3:4b").strip()
    return config.get("LLM_MODEL", "deepseek-chat").strip()


def chat(system: str, user: str, config: dict, max_tokens: int = 4096,
         usage_key: str = "unknown") -> Optional[str]:
    """发送聊天请求（流式），返回文本响应。统一处理 API/本地。

    特性：
      - stream=True 流式分片推送，避免长文本超时
      - httpx.Timeout(connect=10, read=LLM_TIMEOUT, write=60) 细粒度超时
      - 指数退避重试（最多 3 次），仅重试网络/超时异常
      - 不重试 4xx/5xx HTTP 业务错误
    """
    client = _openai_client(config)
    if not client:
        logger.error("LLM 未配置（LLM_BASE_URL 为空）")
        return None

    model = get_model_name(config)
    temperature = float(config.get("GENERATION_TEMPERATURE", "0.5"))
    max_retries = int(config.get("MAX_RETRIES", "3"))

    for attempt in range(max_retries):
        try:
            # 流式调用 — 分片实时推送，服务端超时容错更高
            stream = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
                stream_options={"include_usage": True},
            )

            # 收集流式响应
            chunks = []
            usage = None
            for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    chunks.append(chunk.choices[0].delta.content)
                # DeepSeek stream 把 usage 放在最后一个 chunk
                if hasattr(chunk, "usage") and chunk.usage:
                    usage = chunk.usage

            if usage:
                TOKEN_USAGE[f"{usage_key}_prompt"] += usage.prompt_tokens
                TOKEN_USAGE[f"{usage_key}_completion"] += usage.completion_tokens
                TOKEN_USAGE[f"{usage_key}_total"] += usage.total_tokens

            return "".join(chunks)

        except RETRYABLE_EXCEPTIONS as e:
            logger.warning(
                "LLM 调用超时/网络错误 (attempt %d/%d, key=%s): %s",
                attempt + 1, max_retries, usage_key, str(e)[:120]
            )
            if attempt < max_retries - 1:
                wait = 5 * (2 ** attempt)  # 指数退避: 5s, 10s, 20s
                logger.info("  等待 %.0fs 后重试...", wait)
                time.sleep(wait)
        except Exception as e:
            # 非可重试异常（4xx/5xx 业务错误等），不重试
            logger.warning(
                "LLM 调用失败 (attempt %d/%d, key=%s, 不可重试): %s",
                attempt + 1, max_retries, usage_key, str(e)[:200]
            )
            break  # 不重试业务错误

    return None


def get_token_usage() -> dict:
    return dict(TOKEN_USAGE)


def reset_token_usage():
    global TOKEN_USAGE
    TOKEN_USAGE = {k: 0 for k in TOKEN_USAGE}
