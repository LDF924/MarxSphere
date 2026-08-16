#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
pipeline 共享配置模块
- 统一加载 D:\config\pipeline_config.json
- API 密钥优先从环境变量读取，fallback 到配置文件
- 环境切换：test / production
"""

import os
import json
from pathlib import Path

# 按优先级查找配置文件：当前目录 → D:\config → 默认值
_CONFIG_CANDIDATES = [
    Path(__file__).parent.parent / "pipeline_config.json",  # 与模块同目录
    Path("D:/config/pipeline_config.json"),                  # 全局配置
]
CONFIG_PATH = None
for _p in _CONFIG_CANDIDATES:
    if _p.exists():
        CONFIG_PATH = _p
        break
if CONFIG_PATH is None:
    CONFIG_PATH = _CONFIG_CANDIDATES[0]  # 使用第一个路径尝试

DEFAULT_CONFIG = {
    "env": "production",
    "neo4j": {
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "neo4j123"
    },
    "api": {
        "deepseek": {
            "base_url": "https://api.deepseek.com/v1",
            "model": "deepseek-v4-flash",
            "price_per_1k_tokens": 0.001
        },
        "qwen_embedding": {
            "base_url": "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
            "model": "text-embedding-v4",
            "dimension": 1024,
            "price_per_1k_tokens": 0.0007
        }
    },
    "pipeline": {
        "deepseek_qps": 3,
        "qwen_qps": 20,
        "batch_size": 50,
        "budget_limit": 10.0,
        "batch_validation_size": 50,
        "review_confidence_threshold": 0.7,
        "enable_review_gate": True
    }
}


def _deep_merge(base: dict, override: dict) -> dict:
    merged = base.copy()
    for k, v in override.items():
        if isinstance(v, dict) and k in merged and isinstance(merged[k], dict):
            merged[k] = _deep_merge(merged[k], v)
        else:
            merged[k] = v
    return merged


def _load_user_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _build_config() -> dict:
    user = _load_user_config()
    return _deep_merge(DEFAULT_CONFIG, user)


CONFIG = _build_config()

_ENV = CONFIG.get("env", "production")

_DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY")
_QWEN_KEY = os.environ.get("QWEN_API_KEY")

if not _DEEPSEEK_KEY:
    _DEEPSEEK_KEY = CONFIG.get("api", {}).get("deepseek", {}).get("key", "")
if not _QWEN_KEY:
    _QWEN_KEY = CONFIG.get("api", {}).get("qwen_embedding", {}).get("key", "")

DEEPSEEK_API_KEY = _DEEPSEEK_KEY
QWEN_API_KEY = _QWEN_KEY
QWEN_MAX_KEY = os.environ.get("QWEN_MAX_KEY") or CONFIG.get("api", {}).get("qwen_max", {}).get("key", "")
RUN_ENV = _ENV


def get_qwen_max_config() -> dict:
    cfg = CONFIG.get("api", {}).get("qwen_max", {})
    return {
        "api_key": QWEN_MAX_KEY,
        "base_url": cfg.get("base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "model": cfg.get("model", "qwen3.7-max"),
        "price_per_1k_tokens": cfg.get("price_per_1k_tokens", 0)
    }


def get_deepseek_config() -> dict:
    cfg = CONFIG.get("api", {}).get("deepseek", {})
    return {
        "api_key": DEEPSEEK_API_KEY,
        "base_url": cfg.get("base_url", "https://api.deepseek.com/v1"),
        "model": cfg.get("model", "deepseek-v4-flash"),
        "price_per_1k_tokens": cfg.get("price_per_1k_tokens", 0.001)
    }


def get_qwen_config() -> dict:
    cfg = CONFIG.get("api", {}).get("qwen_embedding", {})
    return {
        "api_key": QWEN_API_KEY,
        "base_url": cfg.get("base_url", "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"),
        "model": cfg.get("model", "qwen3-embedding-4b"),
        "dimension": cfg.get("dimension", 1024),
        "price_per_1k_tokens": cfg.get("price_per_1k_tokens", 0.0007)
    }


def get_neo4j_config() -> dict:
    return CONFIG.get("neo4j", {})


def get_pipeline_config() -> dict:
    return CONFIG.get("pipeline", {})
