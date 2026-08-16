#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一 API 调用客户端
- DeepSeekClient：LLM 调用（限流 + 指数退避重试 + 缓存 + 成本追踪）
- QwenEmbeddingClient：Embedding 调用（令牌桶限流 + 重试 + 缓存 + 模型一致性校验）
- CostMonitor：Token 计数与成本监控
- RateLimiter：令牌桶 QPS 限流
"""

import time
import json
import threading
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime

import requests
import logging
logger = logging.getLogger(__name__)


# ---- 速率限制器 ----
class RateLimiter:
    """线程安全的令牌桶 QPS 限流"""

    def __init__(self, qps_limit: float = 10):
        self.qps_limit = qps_limit
        self.tokens = qps_limit
        self.last_refill = time.time()
        self.lock = threading.Lock()

    def acquire(self):
        with self.lock:
            now = time.time()
            elapsed = now - self.last_refill
            self.tokens = min(self.qps_limit, self.tokens + elapsed * self.qps_limit)
            self.last_refill = now
            if self.tokens >= 1:
                self.tokens -= 1
            else:
                wait = (1 - self.tokens) / self.qps_limit
                time.sleep(wait)
                self.tokens = 0
                self.last_refill = time.time()


# ---- 成本监控 ----
class CostMonitor:
    PRICES = {
        "deepseek": {"input": 0.000002, "output": 0.000008},
        "qwen_max": {"input": 0.000004, "output": 0.000012},   # qwen3.7-max 输入¥4/百万 输出¥12/百万
        "qwen_embed": {"input": 0.0000007}
    }

    def __init__(self, budget_limit: float = 100.0):
        self.budget_limit = budget_limit
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cost = 0.0
        self.history: List[Dict] = []
        self.warning_threshold = 0.8
        self._alerted = False          # 防止重复告警
        self._alert_callback = None    # 外部告警回调
        self._calling_script = None    # 当前调用脚本名 (用于日志)
        self._checkpoint_saver = None  # 外部断点保存回调 (预停机前调用)
        self._pre_shutdown = False     # 预停机标志: 触发后拒绝所有新请求

    def set_alert_callback(self, callback):
        """设置预算告警回调: callback(percent, current_cost, budget_limit)"""
        self._alert_callback = callback

    def set_checkpoint_saver(self, saver):
        """设置预停机断点保存回调: saver(script_name, cost, budget_limit)"""
        self._checkpoint_saver = saver

    def set_calling_script(self, name: str):
        self._calling_script = name

    def _check_budget_alarm(self):
        """检查是否超过预警阈值，触发回调"""
        if self.budget_limit <= 0:
            return None
        pct = self.total_cost / self.budget_limit
        if pct >= 1.0 and not self._pre_shutdown:
            # 预算超限 → 触发预停机
            self._pre_shutdown = True
            msg = (f"\n{'='*60}\n"
                   f"BUDGET EXCEEDED: cost RMB {self.total_cost:.4f} "
                   f"exceeds budget RMB {self.budget_limit}\n"
                   f"Saving checkpoint and shutting down...\n"
                   f"{'='*60}")
            print(msg, flush=True)
            if self._checkpoint_saver:
                self._checkpoint_saver(self._calling_script or "unknown",
                                       self.total_cost, self.budget_limit)
            return msg
        if pct >= self.warning_threshold and not self._alerted:
            self._alerted = True
            msg = (f"\n{'='*60}\n"
                   f"BUDGET ALARM: cost RMB {self.total_cost:.4f} "
                   f"= {pct:.1%} of budget RMB {self.budget_limit}\n"
                   f"Current task will complete, then STOP. "
                   f"DO NOT start new tasks.\n"
                   f"{'='*60}")
            print(msg, flush=True)
            if self._alert_callback:
                self._alert_callback(pct, self.total_cost, self.budget_limit)
            return msg
        return None

    def is_shutdown(self) -> bool:
        """预停机状态: 外部脚本应在每篇论文处理前检查此标志"""
        return self._pre_shutdown

    def add_usage(self, api_type: str, input_tokens: int = 0, output_tokens: int = 0) -> bool:
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        if api_type in self.PRICES:
            price = self.PRICES[api_type]
            cost = (input_tokens / 1000) * price.get("input", 0) + \
                   (output_tokens / 1000) * price.get("output", 0)
            self.total_cost += cost
            self.history.append({
                "timestamp": datetime.now().isoformat(),
                "api_type": api_type,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost": cost
            })
        self._check_budget_alarm()
        if self.total_cost > self.budget_limit:
            self._pre_shutdown = True
            return False
        return True

    def estimate_cost(self, estimated_tokens: int, api_type: str = "deepseek") -> float:
        if api_type in self.PRICES:
            price = self.PRICES[api_type]
            return (estimated_tokens / 1000) * price.get("input", 0)
        return 0.0

    def get_summary(self) -> Dict:
        return {
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_tokens": self.total_input_tokens + self.total_output_tokens,
            "total_cost": self.total_cost,
            "budget_limit": self.budget_limit,
            "budget_usage_percent": (self.total_cost / self.budget_limit * 100) if self.budget_limit > 0 else 0,
        }

    def save_report(self, report_path: Path):
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump({
                "summary": self.get_summary(),
                "history": self.history[-200:]
            }, f, ensure_ascii=False, indent=2)


# ---- 向量模型一致性校验 ----
class EmbeddingModelValidator:
    _META_PATH = None

    @classmethod
    def _get_meta_path(cls) -> Path:
        if cls._META_PATH is not None:
            return cls._META_PATH
        from .cache import CACHE_DIR
        cls._META_PATH = CACHE_DIR / "embedding_meta.json"
        return cls._META_PATH

    def __init__(self, model_name: str, dimension: int):
        self.current_model = model_name
        self.current_dimension = dimension
        self._load_or_init_meta()

    def _load_or_init_meta(self):
        meta_path = self._get_meta_path()
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            saved_model = meta.get("model_name")
            saved_dim = meta.get("dimension")
            if saved_model != self.current_model or saved_dim != self.current_dimension:
                raise ValueError(
                    f"向量模型不一致！当前: {self.current_model}({self.current_dimension}维), "
                    f"已建库: {saved_model}({saved_dim}维)"
                )
        else:
            self._save_meta()

    def _save_meta(self):
        meta_path = self._get_meta_path()
        meta_path.parent.mkdir(exist_ok=True)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({
                "model_name": self.current_model,
                "dimension": self.current_dimension,
                "created_at": datetime.now().isoformat()
            }, f, ensure_ascii=False, indent=2)

    def validate(self, model_name: str, dimension: int) -> bool:
        return model_name == self.current_model and dimension == self.current_dimension


# ---- DeepSeek LLM 客户端 ----
class DeepSeekClient:
    def __init__(self, api_key: str = None, base_url: str = None, model: str = None,
                 cache: Any = None, monitor: CostMonitor = None, qps_limit: float = None):
        from .config import get_deepseek_config, get_pipeline_config
        cfg = get_deepseek_config()
        pipe = get_pipeline_config()

        self.api_key = api_key or cfg["api_key"]
        self.base_url = base_url or cfg["base_url"]
        self.model = model or cfg["model"]
        self.cache = cache
        self.monitor = monitor or CostMonitor(pipe.get("budget_limit", 100))
        self.limiter = RateLimiter(qps_limit or pipe.get("deepseek_qps", 2))
        self.failed_tasks: List[Dict] = []
        self._lock = threading.Lock()

    def call(self, prompt: str, json_schema: Dict = None, max_retries: int = 4,
             timeout: int = 600, system_prompt: str = None) -> Optional[Dict]:
        """
        调用 DeepSeek API
        返回 {"content": str, "raw": dict} 或 None
        """
        # 缓存
        if self.cache:
            cached = self.cache.get_llm(prompt)
            if cached:
                return cached["result"]

        self.limiter.acquire()

        url = f"{self.base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        messages = [
            {"role": "system", "content": system_prompt or "你是马克思主义理论与哲学社科领域的知识抽取专家。"},
            {"role": "user", "content": prompt}
        ]

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 81920
        }
        if json_schema:
            payload["response_format"] = {"type": "json_object"}

        for attempt in range(max_retries):
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
                if resp.status_code == 200:
                    result = resp.json()
                    content = result["choices"][0]["message"]["content"]
                    usage = result.get("usage", {})
                    self.monitor.add_usage("deepseek",
                                           usage.get("prompt_tokens", 0),
                                           usage.get("completion_tokens", 0))
                    parsed = {"content": content, "raw": result}
                    if self.cache:
                        self.cache.set_llm(prompt, parsed, usage.get("total_tokens", 0))
                    return parsed

                elif resp.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue
                else:
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    self._record_failure(prompt, f"HTTP {resp.status_code}: {resp.text[:200]}")
                    return None

            except requests.Timeout:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                self._record_failure(prompt, "Timeout")
                return None
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                self._record_failure(prompt, str(e))
                return None

        return None

    def call_json(self, prompt: str, json_schema: Dict = None, max_retries: int = 4,
                  timeout: int = 600, system_prompt: str = None) -> Optional[Dict]:
        """
        调用 DeepSeek 并返回解析后的 JSON dict
        JSON 解析失败自动重试（附带格式修正提示）
        """
        original_prompt = prompt
        for attempt in range(max_retries):
            result = self.call(prompt, json_schema, max_retries=1, timeout=timeout,
                              system_prompt=system_prompt)
            if result is None:
                continue
            content = result.get("content", "")
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                prompt = (
                    original_prompt
                    + f"\n\n上一次输出无法解析为JSON。请严格输出完整JSON，空字段用[]或\"\"，禁止省略键名。"
                )
        return None

    def _record_failure(self, prompt: str, error: str):
        with self._lock:
            self.failed_tasks.append({
                "timestamp": datetime.now().isoformat(),
                "content_preview": prompt[:200],
                "api_type": "qwen_max",
                "error": error
            })

    def get_failed_tasks(self) -> List[Dict]:
        return self.failed_tasks

    def export_failures(self, path: Path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.failed_tasks, f, ensure_ascii=False, indent=2)


# ---- Qwen3.7-Max LLM 客户端 (通义千问) ----
class QwenMaxClient:
    """Qwen3.7-Max via DashScope compatible-mode API (OpenAI-compatible)"""

    def __init__(self, api_key: str = None, base_url: str = None, model: str = None,
                 cache: Any = None, monitor: CostMonitor = None, qps_limit: float = None):
        from .config import get_qwen_max_config, get_pipeline_config
        cfg = get_qwen_max_config()
        pipe = get_pipeline_config()

        self.api_key = api_key or cfg["api_key"]
        self.base_url = (base_url or cfg["base_url"]).rstrip("/")
        self.model = model or cfg["model"]
        self.cache = cache
        self.monitor = monitor or CostMonitor(pipe.get("budget_limit", 100))
        self.limiter = RateLimiter(qps_limit or pipe.get("deepseek_qps", 2))
        self.failed_tasks: List[Dict] = []
        self._lock = threading.Lock()

    def call(self, prompt: str, json_schema: Dict = None, max_retries: int = 4,
             timeout: int = 600, system_prompt: str = None) -> Optional[Dict]:
        if self.cache:
            cached = self.cache.get_llm("qwen:" + prompt)
            if cached:
                return cached["result"]

        self.limiter.acquire()

        url = f"{self.base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        messages = [
            {"role": "system", "content": system_prompt or "你是马克思主义理论与哲学社科领域的知识抽取专家。"},
            {"role": "user", "content": prompt}
        ]

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 16384
        }
        if json_schema:
            payload["response_format"] = {"type": "json_object"}

        for attempt in range(max_retries):
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
                if resp.status_code == 200:
                    result = resp.json()
                    content = result["choices"][0]["message"]["content"]
                    usage = result.get("usage", {})
                    self.monitor.add_usage("qwen_max",
                                           usage.get("prompt_tokens", 0),
                                           usage.get("completion_tokens", 0))
                    parsed = {"content": content, "raw": result}
                    if self.cache:
                        self.cache.set_llm("qwen:" + prompt, parsed, usage.get("total_tokens", 0))
                    return parsed
                elif resp.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue
                else:
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    self._record_failure(prompt, f"HTTP {resp.status_code}: {resp.text[:200]}")
                    return None
            except requests.Timeout:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                self._record_failure(prompt, "Timeout")
                return None
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                self._record_failure(prompt, str(e))
                return None
        return None

    def call_json(self, prompt: str, json_schema: Dict = None, max_retries: int = 4,
                  timeout: int = 600, system_prompt: str = None) -> Optional[Dict]:
        original_prompt = prompt
        for attempt in range(max_retries):
            t0 = time.time()
            result = self.call(prompt, json_schema, max_retries=1, timeout=timeout,
                              system_prompt=system_prompt)
            elapsed = time.time() - t0
            if result is None:
                logger.warning(f"call_json attempt {attempt+1}: call() returned None after {elapsed:.0f}s")
                continue
            content = result.get("content", "")
            logger.info(f"call_json attempt {attempt+1}: content_len={len(content)} elapsed={elapsed:.0f}s")
            try:
                return json.loads(content)
            except json.JSONDecodeError as e1:
                # qwen3.7-max / deepseek may wrap JSON in markdown code blocks
                import re as _re
                cleaned = _re.sub(r'^```(?:json)?\s*', '', content)
                cleaned = _re.sub(r'\s*```$', '', cleaned)
                if cleaned != content:
                    try:
                        return json.loads(cleaned)
                    except json.JSONDecodeError:
                        pass
                # Strip trailing garbage (e.g. extra text after closing })
                # Find the last } and try to parse up to there
                last_brace = content.rfind('}')
                if last_brace > 0 and last_brace < len(content) - 1:
                    try:
                        return json.loads(content[:last_brace + 1])
                    except json.JSONDecodeError:
                        pass
                logger.warning(f"call_json attempt {attempt+1}: JSONDecodeError={e1} content_tail={content[-100:]}")
                prompt = original_prompt + f"\n\n上一次输出无法解析为JSON。请严格输出完整JSON，空字段用[]或\"\"，禁止省略键名。"
        return None

    def _record_failure(self, prompt: str, error: str):
        with self._lock:
            self.failed_tasks.append({
                "timestamp": datetime.now().isoformat(),
                "content_preview": prompt[:200],
                "api_type": "qwen_max",
                "error": error
            })

    def get_failed_tasks(self) -> List[Dict]:
        return self.failed_tasks

    def export_failures(self, path: Path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.failed_tasks, f, ensure_ascii=False, indent=2)


# ---- Qwen Embedding 客户端 ----
class QwenEmbeddingClient:
    def __init__(self, api_key: str = None, base_url: str = None, model: str = None,
                 dimension: int = None, cache: Any = None, monitor: CostMonitor = None,
                 qps_limit: float = None):
        from .config import get_qwen_config, get_pipeline_config
        cfg = get_qwen_config()
        pipe = get_pipeline_config()

        self.api_key = api_key or cfg["api_key"]
        self.base_url = base_url or cfg["base_url"]
        self.model = model or cfg["model"]
        self.dimension = dimension or cfg["dimension"]
        self.cache = cache
        self.monitor = monitor or CostMonitor(pipe.get("budget_limit", 100))
        self.limiter = RateLimiter(qps_limit or pipe.get("qwen_qps", 20))
        self.max_input_chars = 8000
        self.batch_size = 10  # text-embedding-v4 限制每批最多 10 条
        self.validator = EmbeddingModelValidator(self.model, self.dimension)

    def _truncate(self, text: str) -> str:
        if len(text) > self.max_input_chars:
            return text[:self.max_input_chars]
        return text

    def embed_batch(self, texts: List[str], max_retries: int = 4, timeout: int = 30) -> Optional[List[List[float]]]:
        """批量生成向量（带缓存、限流、重试、维度校验）"""
        texts = [self._truncate(t) for t in texts]

        # 分离已缓存
        cached_vectors: List[Optional[List[float]]] = [None] * len(texts)
        need_idx = []
        need_texts = []
        for i, t in enumerate(texts):
            if self.cache:
                vec = self.cache.get_embedding(t)
                if vec is not None:
                    cached_vectors[i] = vec
                    continue
            need_idx.append(i)
            need_texts.append(t)

        if not need_texts:
            return cached_vectors

        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        results: List[Optional[List[float]]] = [None] * len(need_texts)

        for batch_start in range(0, len(need_texts), self.batch_size):
            batch_texts = need_texts[batch_start:batch_start + self.batch_size]
            data = {
                "model": self.model,
                "input": {"texts": batch_texts},
                "parameters": {"output_type": "dense", "dimension": self.dimension}
            }

            for attempt in range(max_retries):
                try:
                    self.limiter.acquire()
                    resp = requests.post(self.base_url, headers=headers, json=data, timeout=timeout)
                    if resp.status_code == 200:
                        result = resp.json()
                        embeddings = result.get("output", {}).get("embeddings", [])
                        usage = result.get("usage", {})
                        self.monitor.add_usage("qwen_embed", usage.get("total_tokens", 0), 0)

                        for j, emb in enumerate(embeddings):
                            vec = emb.get("embedding", [])
                            if len(vec) != self.dimension:
                                if len(vec) < self.dimension:
                                    vec = vec + [0.0] * (self.dimension - len(vec))
                                else:
                                    vec = vec[:self.dimension]
                            flat_idx = batch_start + j
                            results[flat_idx] = vec
                            if self.cache:
                                self.cache.set_embedding(batch_texts[j], vec)
                        break

                    elif resp.status_code == 429:
                        time.sleep(2 ** attempt)
                        continue
                    else:
                        if attempt < max_retries - 1:
                            time.sleep(2 ** attempt)
                            continue
                except Exception:
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue

        # 合并缓存与新结果
        final = []
        ri = 0
        for i in range(len(texts)):
            if cached_vectors[i] is not None:
                final.append(cached_vectors[i])
            else:
                final.append(results[ri] if ri < len(results) else None)
                ri += 1
        return final if all(v is not None for v in final) else None

    def embed(self, text: str) -> Optional[List[float]]:
        """单条向量化"""
        result = self.embed_batch([text])
        return result[0] if result else None
