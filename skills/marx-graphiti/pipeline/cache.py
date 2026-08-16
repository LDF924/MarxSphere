#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一本地缓存层（SQLite），合并模块4/5/6的三套缓存实现
- LLM 结果缓存（key=prompt MD5）
- Embedding 向量缓存（key=text MD5）
- 实体处理状态追踪
- LRU 淘汰策略
"""

import json
import sqlite3
import hashlib
import threading
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime


CACHE_DIR = Path("D:/cache")
try:
    CACHE_DIR.mkdir(exist_ok=True)
except PermissionError:
    import tempfile
    CACHE_DIR = Path(tempfile.gettempdir()) / "pipeline_cache"
    CACHE_DIR.mkdir(exist_ok=True)


class TextCache:
    """统一缓存（LLM + Embedding），LRU 淘汰"""

    MAX_MEMORY = 2000

    def __init__(self, db_path: Path = None):
        self.db_path = db_path or (CACHE_DIR / "text_cache.db")
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._lock = threading.Lock()
        self._init_tables()
        self._access_order: List[str] = []  # LRU 追踪

    def _init_tables(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS llm_cache (
                hash_key TEXT PRIMARY KEY,
                prompt TEXT,
                result TEXT,
                total_tokens INTEGER,
                hit_count INTEGER DEFAULT 0,
                last_hit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS embedding_cache (
                hash_key TEXT PRIMARY KEY,
                text_content TEXT,
                vector TEXT,
                hit_count INTEGER DEFAULT 0,
                last_hit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_llm_hit ON llm_cache(hit_count)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_emb_hit ON embedding_cache(hit_count)")
        self.conn.commit()

    @staticmethod
    def md5(text: str) -> str:
        return hashlib.md5(text.encode("utf-8")).hexdigest()

    # --- LLM 缓存 ---
    def get_llm(self, prompt: str) -> Optional[Dict]:
        key = self.md5(prompt)
        with self._lock:
            cursor = self.conn.execute(
                "SELECT result, total_tokens FROM llm_cache WHERE hash_key = ?", (key,)
            )
            row = cursor.fetchone()
            if row:
                self.conn.execute(
                    "UPDATE llm_cache SET hit_count = hit_count + 1, last_hit = ? WHERE hash_key = ?",
                    (datetime.now().isoformat(), key)
                )
                self.conn.commit()
                self._touch(key)
                return {"result": json.loads(row[0]), "total_tokens": row[1]}
        return None

    def set_llm(self, prompt: str, result: Dict, total_tokens: int):
        key = self.md5(prompt)
        with self._lock:
            self.conn.execute(
                "REPLACE INTO llm_cache (hash_key, prompt, result, total_tokens) VALUES (?, ?, ?, ?)",
                (key, prompt, json.dumps(result, ensure_ascii=False), total_tokens)
            )
            self.conn.commit()
            self._touch(key)
            self._evict_if_needed("llm_cache")

    # --- Embedding 缓存 ---
    def get_embedding(self, text: str) -> Optional[List[float]]:
        key = self.md5(text)
        with self._lock:
            cursor = self.conn.execute(
                "SELECT vector FROM embedding_cache WHERE hash_key = ?", (key,)
            )
            row = cursor.fetchone()
            if row:
                self.conn.execute(
                    "UPDATE embedding_cache SET hit_count = hit_count + 1, last_hit = ? WHERE hash_key = ?",
                    (datetime.now().isoformat(), key)
                )
                self.conn.commit()
                self._touch(key)
                return json.loads(row[0])
        return None

    def set_embedding(self, text: str, vector: List[float]):
        key = self.md5(text)
        with self._lock:
            self.conn.execute(
                "REPLACE INTO embedding_cache (hash_key, text_content, vector) VALUES (?, ?, ?)",
                (key, text, json.dumps(vector))
            )
            self.conn.commit()
            self._touch(key)
            self._evict_if_needed("embedding_cache")

    # --- LRU 淘汰 ---
    def _touch(self, key: str):
        if key in self._access_order:
            self._access_order.remove(key)
        self._access_order.append(key)

    def _evict_if_needed(self, table: str):
        """LRU：超过 MAX_MEMORY 后淘汰最久未用的 25%"""
        if len(self._access_order) <= self.MAX_MEMORY:
            return
        evict_count = len(self._access_order) // 4
        evict_keys = self._access_order[:evict_count]
        self._access_order = self._access_order[evict_count:]
        for key in evict_keys:
            self.conn.execute(f"DELETE FROM {table} WHERE hash_key = ?", (key,))
        self.conn.commit()

    # --- 兼容旧 API ---
    def get(self, text: str, api_type: str) -> Optional[Dict]:
        if api_type == "qwen_embed":
            vec = self.get_embedding(text)
            return {"embedding": vec} if vec else None
        return self.get_llm(text)

    def set(self, text: str, api_type: str, response: Dict):
        if api_type == "qwen_embed":
            vec = response.get("embedding")
            if vec:
                self.set_embedding(text, vec)
        else:
            self.set_llm(text, response, 0)

    def get_stats(self) -> Dict:
        stats = {"total": 0, "total_hits": 0, "by_type": {}}
        for table, label in [("llm_cache", "deepseek"), ("embedding_cache", "qwen_embed")]:
            cur = self.conn.execute(f"SELECT COUNT(*), COALESCE(SUM(hit_count),0) FROM {table}")
            row = cur.fetchone()
            stats["by_type"][label] = {"count": row[0], "hits": row[1] or 0}
            stats["total"] += row[0]
            stats["total_hits"] += (row[1] or 0)
        return stats

    def close(self):
        self.conn.close()


class EntityProcessTracker:
    """实体级处理状态追踪，避免消歧/聚类环节重复调用 LLM"""

    def __init__(self, db_path: Path = None):
        self.db_path = db_path or (CACHE_DIR / "entity_processed.db")
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._lock = threading.Lock()
        self._init_db()

    def _init_db(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS processed_entities (
                entity_key TEXT PRIMARY KEY,
                entity_name TEXT,
                task_type TEXT,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_task_type ON processed_entities(task_type)")
        self.conn.commit()

    @staticmethod
    def _get_entity_key(entity_name: str, task_type: str) -> str:
        raw = f"{task_type}:{entity_name.strip()}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def is_processed(self, entity_name: str, task_type: str) -> bool:
        key = self._get_entity_key(entity_name, task_type)
        cur = self.conn.execute("SELECT 1 FROM processed_entities WHERE entity_key = ?", (key,))
        return cur.fetchone() is not None

    def mark_processed(self, entity_name: str, task_type: str):
        key = self._get_entity_key(entity_name, task_type)
        with self._lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO processed_entities (entity_key, entity_name, task_type) VALUES (?, ?, ?)",
                (key, entity_name, task_type)
            )
            self.conn.commit()

    def batch_filter_unprocessed(self, entity_list: List[str], task_type: str) -> List[str]:
        return [e for e in entity_list if not self.is_processed(e, task_type)]

    def batch_mark_processed(self, entity_list: List[str], task_type: str):
        for e in entity_list:
            self.mark_processed(e, task_type)

    def close(self):
        self.conn.close()
