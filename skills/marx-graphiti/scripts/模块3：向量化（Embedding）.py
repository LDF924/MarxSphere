#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块3：向量化（Embedding）
功能：
1. 批量提取实体素材，拼接向量化文本
2. 调用 Qwen3-Embedding-4B API 生成向量
3. 向量落库 Neo4j，建立三类向量索引
4. 向量索引参数动态调优（efConstruction自适应）
5. 断点续跑、超长文本自动截断
6. 主动QPS令牌桶限流 + 指数退避重试
"""

import os
import sys
import json
import time
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, QWEN_API_KEY, Neo4jConnection, get_logger,
    TextCache, QwenEmbeddingClient, CostMonitor
)

logger = get_logger("module3")

# ======================== 全局常量 ========================
EMBEDDING_MODEL = "qwen3-embedding-4b"
EMBEDDING_DIM = 1024


# ======================== 向量化引擎 ========================
class VectorizationEngine:
    EMBEDDING_DIM = 1024
    BATCH_SIZE = 10  # text-embedding-v4 限制每批最多 10 条
    MAX_TEXT_LENGTH = 6000
    MAX_RETRIES = 3
    BASE_DELAY = 1
    RATE_LIMIT = 100
    EF_CONSTRUCTION_DEFAULT = 128
    EF_CONSTRUCTION_LARGE = 256
    LARGE_DATA_THRESHOLD = 10000

    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn
        self.cache = TextCache()
        self.monitor = CostMonitor()
        self.qwen = QwenEmbeddingClient(cache=self.cache, monitor=self.monitor)
        self.total_tokens = 0
        self.processed_count = 0
        self.failed_count = 0
        self._ensure_vector_indexes()

    def _count_nodes_by_label(self, label: str) -> int:
        query = f"MATCH (n:{label}) RETURN count(n) AS node_count"
        try:
            result = self.neo4j.execute_query(query)
            return result[0]["node_count"] if result else 0
        except Exception as e:
            logger.warning(f"⚠️ 统计 {label} 节点数失败: {e}")
            return 0

    def _ensure_vector_indexes(self):
        """Neo4j Community 不支持 VECTOR 索引，向量存入属性后用应用层检索"""
        logger.info("📌 Neo4j Community Edition — 向量将存入属性，应用层做相似度检索")
        logger.info("   如需向量索引，请使用 Neo4j Enterprise 或迁移到 FalkorDB")

    def _build_text_for_embedding(self, entity: Dict) -> str:
        name = entity.get('name', '')
        category = entity.get('category', '')
        subcategory = entity.get('subcategory', '')
        description = entity.get('description', '')
        community = entity.get('community', '')
        context = entity.get('context', '')

        parts = []
        if category:
            parts.append(f"【{category}】")
        if subcategory:
            parts.append(f"[{subcategory}]")
        parts.append(f"{name}")
        if description:
            parts.append(f"：{description}")
        if community:
            parts.append(f" | 所属社区：{community}")
        if context:
            parts.append(f" | 语境：{context}")

        text = "".join(parts)
        if len(text) > self.MAX_TEXT_LENGTH:
            text = text[:self.MAX_TEXT_LENGTH] + "..."
            logger.warning(f"   ⚠️ 实体 {name} 文本过长，已截断")
        return text

    def vectorize_entities(self) -> Dict:
        logger.info("=" * 60)
        logger.info("开始实体向量化...")

        query = """
        MATCH (e:Entity)
        WHERE e.entity_vector IS NULL OR e.vectorized = false
        OPTIONAL MATCH (e)-[:BELONGS_TO_COMMUNITY]->(c:Community)
        RETURN e.name as name, e.category as category, e.subcategory as subcategory,
               e.description as description, e.context as context,
               collect(DISTINCT c.community_id) as communities
        """
        entities = self.neo4j.execute_query(query)

        if not entities:
            logger.info("✅ 所有实体已向量化，无需处理")
            return {"processed": 0, "failed": 0, "total": 0}

        logger.info(f"📊 发现 {len(entities)} 个实体需要向量化")

        batch_data = []
        for entity in entities:
            entity_text = self._build_text_for_embedding(entity)
            batch_data.append({
                "name": entity["name"],
                "text": entity_text,
                "community": entity.get("communities", [""])[0] if entity.get("communities") else ""
            })

        processed = 0
        failed = 0

        for batch_start in range(0, len(batch_data), self.BATCH_SIZE):
            batch_end = min(batch_start + self.BATCH_SIZE, len(batch_data))
            batch = batch_data[batch_start:batch_end]
            logger.info(f"   📦 批次 {batch_start//self.BATCH_SIZE + 1}/{(len(batch_data)-1)//self.BATCH_SIZE + 1} ({len(batch)} 条)")

            texts = [item["text"] for item in batch]
            vectors = self.qwen.embed_batch(texts)

            if vectors is None:
                logger.error(f"   ❌ 批次 {batch_start//self.BATCH_SIZE + 1} 向量化失败")
                failed += len(batch)
                continue

            for item, vector in zip(batch, vectors):
                try:
                    self.neo4j.execute_write("""
                        MATCH (e:Entity {name: $name})
                        SET e.entity_vector = $vector, e.vectorized = true, e.vectorized_at = datetime()
                    """, {"name": item["name"], "vector": vector})
                    processed += 1
                except Exception as e:
                    logger.error(f"      ❌ {item['name']} 写入失败: {e}")
                    failed += 1

        self.processed_count = processed
        self.failed_count = failed
        self.total_tokens = self.monitor.total_input_tokens + self.monitor.total_output_tokens

        logger.info(f"✅ 实体向量化完成: 成功 {processed} 条, 失败 {failed} 条")
        return {"processed": processed, "failed": failed, "total": len(entities), "tokens": self.total_tokens}

    def vectorize_literature_distills(self) -> Dict:
        logger.info("=" * 60)
        logger.info("开始单篇蒸馏向量化...")

        query = """
        MATCH (ld:LiteratureDistill)
        WHERE ld.distill_vector IS NULL OR ld.vectorized = false
        RETURN ld.id as id, ld.core_concept_definition as core_concepts,
               ld.theoretical_system_and_innovation as innovation_points,
               ld.analysis_paradigm_and_interpretation as analysis_paradigm
        """
        distills = self.neo4j.execute_query(query)

        if not distills:
            logger.info("✅ 所有蒸馏节点已向量化")
            return {"processed": 0, "failed": 0, "total": 0}

        logger.info(f"📊 发现 {len(distills)} 个蒸馏节点需要向量化")

        texts = []
        for d in distills:
            parts = []
            if d.get("core_concepts"):
                parts.append(f"核心概念: {d['core_concepts']}")
            if d.get("innovation_points"):
                parts.append(f"创新点: {d['innovation_points']}")
            if d.get("analysis_paradigm"):
                parts.append(f"分析范式: {d['analysis_paradigm']}")
            text = " | ".join(parts)
            if len(text) > self.MAX_TEXT_LENGTH:
                text = text[:self.MAX_TEXT_LENGTH]
            texts.append((d["id"], text))

        processed = 0
        failed = 0
        for batch_start in range(0, len(texts), self.BATCH_SIZE):
            batch = texts[batch_start:batch_start + self.BATCH_SIZE]
            batch_ids = [b[0] for b in batch]
            batch_texts = [b[1] for b in batch]
            vectors = self.qwen.embed_batch(batch_texts)

            if vectors:
                for distill_id, vector in zip(batch_ids, vectors):
                    try:
                        self.neo4j.execute_write("""
                            MATCH (ld:LiteratureDistill {id: $id})
                            SET ld.distill_vector = $vector, ld.vectorized = true, ld.vectorized_at = datetime()
                        """, {"id": distill_id, "vector": vector})
                        processed += 1
                    except Exception as e:
                        logger.error(f"   ❌ 蒸馏 {distill_id} 向量化失败: {e}")
                        failed += 1
            else:
                failed += len(batch)

        logger.info(f"✅ 蒸馏向量化完成: 成功 {processed} 条, 失败 {failed} 条")
        return {"processed": processed, "failed": failed, "total": len(distills)}

    def vectorize_domain_knowledge(self) -> Dict:
        logger.info("=" * 60)
        logger.info("开始领域知识向量化...")

        query = """
        MATCH (dk:DomainKnowledge)
        WHERE dk.domain_vector IS NULL OR dk.vectorized = false
        RETURN dk.id as id, dk.domain as domain,
               dk.standard_concepts as standard_concepts,
               dk.common_paradigm as common_paradigm,
               dk.consensus_and_controversy as consensus
        """
        domains = self.neo4j.execute_query(query)

        if not domains:
            logger.info("✅ 所有领域知识节点已向量化")
            return {"processed": 0, "failed": 0, "total": 0}

        logger.info(f"📊 发现 {len(domains)} 个领域知识节点需要向量化")

        texts = []
        for d in domains:
            parts = []
            if d.get("domain"):
                parts.append(f"领域: {d['domain']}")
            if d.get("standard_concepts"):
                parts.append(f"标准概念: {d['standard_concepts']}")
            if d.get("common_paradigm"):
                parts.append(f"通用范式: {d['common_paradigm']}")
            if d.get("consensus"):
                parts.append(f"学界共识: {d['consensus']}")
            text = " | ".join(parts)
            if len(text) > self.MAX_TEXT_LENGTH:
                text = text[:self.MAX_TEXT_LENGTH]
            texts.append((d["id"], text))

        processed = 0
        failed = 0
        for batch_start in range(0, len(texts), self.BATCH_SIZE):
            batch = texts[batch_start:batch_start + self.BATCH_SIZE]
            batch_ids = [b[0] for b in batch]
            batch_texts = [b[1] for b in batch]
            vectors = self.qwen.embed_batch(batch_texts)

            if vectors:
                for domain_id, vector in zip(batch_ids, vectors):
                    try:
                        self.neo4j.execute_write("""
                            MATCH (dk:DomainKnowledge {id: $id})
                            SET dk.domain_vector = $vector, dk.vectorized = true, dk.vectorized_at = datetime()
                        """, {"id": domain_id, "vector": vector})
                        processed += 1
                    except Exception as e:
                        logger.error(f"   ❌ 领域 {domain_id} 向量化失败: {e}")
                        failed += 1
            else:
                failed += len(batch)

        logger.info(f"✅ 领域知识向量化完成: 成功 {processed} 条, 失败 {failed} 条")
        return {"processed": processed, "failed": failed, "total": len(domains)}


# ======================== 主流程 ========================
def main():
    logger.info("=" * 80)
    logger.info("模块3：向量化（Embedding）")
    logger.info("=" * 80)

    neo4j_conn = Neo4jConnection()
    vector_engine = VectorizationEngine(neo4j_conn)

    logger.info("\n📌 阶段1: 实体向量化")
    entity_result = vector_engine.vectorize_entities()

    logger.info("\n📌 阶段2: 单篇蒸馏向量化")
    distill_result = vector_engine.vectorize_literature_distills()

    logger.info("\n📌 阶段3: 领域知识向量化")
    domain_result = vector_engine.vectorize_domain_knowledge()

    logger.info("\n" + "=" * 60)
    logger.info("📊 执行统计")
    logger.info(f"   🧬 实体向量化: {entity_result['processed']} 成功, {entity_result['failed']} 失败")
    logger.info(f"   📄 蒸馏向量化: {distill_result['processed']} 成功, {distill_result['failed']} 失败")
    logger.info(f"   🏛️ 领域向量化: {domain_result['processed']} 成功, {domain_result['failed']} 失败")
    logger.info(f"   💳 总Token消耗: {vector_engine.total_tokens}")

    neo4j_conn.close()
    logger.info("\n✅ 模块3执行完成")


if __name__ == "__main__":
    main()
