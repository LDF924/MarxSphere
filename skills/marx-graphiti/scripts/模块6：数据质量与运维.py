#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块6：数据质量与运维
功能（完全对齐文档要求）：
1. 全流程分级日志 + Token/成本/耗时统计
2. 数据一致性校验（批次自动触发）
3. 人工审核队列（消歧/冲突/聚类）
4. 标准化混合检索接口（向量粗筛 + LLM 逻辑重排）
5. 全节点引用溯源
6. 写作模板与领域知识预绑定
7. 溯源跳转URI预留
"""

import os
import sys
import json
import time
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any, Callable, Tuple
from datetime import datetime
from dataclasses import dataclass, field

import requests

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, RUN_ENV, DEEPSEEK_API_KEY, QWEN_API_KEY,
    Neo4jConnection, get_logger, LoggerManager, LogLevel,
    TextCache, DeepSeekClient, QwenEmbeddingClient, CostMonitor
)

logger = get_logger("module6")

# ======================== 配置 ========================
API_ENV = RUN_ENV
QWEN_EMBEDDING_MODEL = CONFIG.get("api", {}).get("qwen_embedding", {}).get("model", "qwen3-embedding-4b")
QWEN_EMBEDDING_DIM = CONFIG.get("api", {}).get("qwen_embedding", {}).get("dimension", 1024)
BATCH_VALIDATION_SIZE = CONFIG.get("pipeline", {}).get("batch_validation_size", 50)
REVIEW_THRESHOLD = CONFIG.get("pipeline", {}).get("review_confidence_threshold", 0.7)


def md5_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


# ======================== 数据一致性校验 ========================
class DataValidator:
    def __init__(self, neo4j_conn: Neo4jConnection, logger_manager: LoggerManager = None):
        self.neo4j = neo4j_conn
        self.lm = logger_manager
        self.last_validated_count = 0

    def should_run_batch_validation(self, current_count: int) -> bool:
        return current_count - self.last_validated_count >= BATCH_VALIDATION_SIZE

    def run_batch_validation_if_needed(self, current_count: int) -> Optional[Dict]:
        if self.should_run_batch_validation(current_count):
            result = self.run_full_validation()
            self.last_validated_count = current_count
            return result
        return None

    def run_full_validation(self) -> Dict:
        logger.info("开始全量数据一致性校验")
        start = time.time()
        results = {
            "orphan_entities": self._check_orphan_entities(),
            "orphan_relations": self._check_orphan_relations(),
            "episode_distill_mapping": self._check_episode_distill_mapping(),
            "vector_integrity": self._check_vector_integrity(),
            "entity_relation_consistency": self._check_entity_relation_consistency(),
            "community_entity_mapping": self._check_community_entity_mapping(),
            "timestamp": datetime.now().isoformat(),
            "duration": round(time.time() - start, 2)
        }
        self._generate_quality_report(results)
        logger.info(f"校验完成，耗时 {results['duration']}s")
        return results

    def _check_orphan_entities(self) -> Dict:
        result = self.neo4j.execute_query(
            "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) RETURN count(e) as count, collect(e.name)[..10] as samples"
        )
        count = result[0].get("count", 0) if result else 0
        samples = result[0].get("samples", []) if result else []
        return {"status": "PASS" if count == 0 else "FAIL", "count": count, "samples": samples}

    def _check_orphan_relations(self) -> Dict:
        result = self.neo4j.execute_query(
            "MATCH (a)-[r]->(b) WHERE NOT a:Entity OR NOT b:Entity RETURN count(r) as count"
        )
        count = result[0].get("count", 0) if result else 0
        return {"status": "PASS" if count == 0 else "FAIL", "count": count}

    def _check_episode_distill_mapping(self) -> Dict:
        result = self.neo4j.execute_query(
            "MATCH (ep:Episode) WHERE NOT (ep)<-[:DISTILL_FROM]-(:LiteratureDistill) "
            "RETURN count(ep) as count, collect(ep.source_folder)[..10] as samples"
        )
        count = result[0].get("count", 0) if result else 0
        samples = result[0].get("samples", []) if result else []
        return {"status": "PASS" if count == 0 else "WARN", "count": count, "samples": samples}

    def _check_vector_integrity(self) -> Dict:
        e = self.neo4j.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NULL OR e.vectorized <> true RETURN count(e) as count")
        ld = self.neo4j.execute_query("MATCH (ld:LiteratureDistill) WHERE ld.distill_vector IS NULL OR ld.vectorized <> true RETURN count(ld) as count")
        dk = self.neo4j.execute_query("MATCH (dk:DomainKnowledge) WHERE dk.domain_vector IS NULL OR dk.vectorized <> true RETURN count(dk) as count")
        em = e[0].get("count", 0) if e else 0
        lm = ld[0].get("count", 0) if ld else 0
        dm = dk[0].get("count", 0) if dk else 0
        total = em + lm + dm
        return {"status": "PASS" if total == 0 else "WARN", "entity_missing": em, "distill_missing": lm, "domain_missing": dm, "total_missing": total}

    def _check_entity_relation_consistency(self) -> Dict:
        result = self.neo4j.execute_query("MATCH (e1:Entity)-[r]->(e2:Entity) WHERE type(r) IS NULL RETURN count(r) as count")
        count = result[0].get("count", 0) if result else 0
        return {"status": "PASS" if count == 0 else "FAIL", "count": count}

    def _check_community_entity_mapping(self) -> Dict:
        result = self.neo4j.execute_query(
            "MATCH (c:Community) WHERE NOT (c)<-[:BELONGS_TO_COMMUNITY]-(:Entity) "
            "RETURN count(c) as count, collect(c.community_id)[..10] as samples"
        )
        count = result[0].get("count", 0) if result else 0
        samples = result[0].get("samples", []) if result else []
        return {"status": "PASS" if count == 0 else "WARN", "count": count, "samples": samples}

    def _generate_quality_report(self, results: Dict):
        report_dir = Path("D:\\reports")
        report_dir.mkdir(exist_ok=True)
        report_path = report_dir / f"quality_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

        failed = sum(1 for k, v in results.items() if k not in ("timestamp", "duration") and v.get("status") == "FAIL")
        warnings = sum(1 for k, v in results.items() if k not in ("timestamp", "duration") and v.get("status") == "WARN")
        total = len([k for k in results if k not in ("timestamp", "duration")])
        score = max(0, 100 - (failed * 15 + warnings * 5))
        grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D"

        report = {**results, "summary": {"total_checks": total, "failed_items": failed, "warning_items": warnings, "quality_score": score, "quality_grade": grade}}
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        logger.info(f"质量报告已生成: {report_path} (评分: {score}, 等级: {grade})")


# ======================== 人工审核队列 ========================
@dataclass
class ReviewItem:
    id: str
    type: str
    data: Dict
    confidence: float
    status: str = "pending"
    review_notes: str = ""
    modified_data: Dict = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.now)
    reviewed_at: Optional[datetime] = None


class ReviewQueue:
    def __init__(self, neo4j_conn: Neo4jConnection, logger_manager: LoggerManager = None):
        self.neo4j = neo4j_conn
        self.lm = logger_manager
        self.review_file = Path("D:\\reviews\\review_queue.json")
        self.feedback_samples_file = Path("D:\\reviews\\prompt_feedback_samples.json")
        self.review_file.parent.mkdir(exist_ok=True)
        self.queue: List[ReviewItem] = []
        self._load_queue()

    def _load_queue(self):
        if self.review_file.exists():
            with open(self.review_file, 'r', encoding='utf-8') as f:
                for item in json.load(f):
                    item["created_at"] = datetime.fromisoformat(item["created_at"])
                    if item.get("reviewed_at"):
                        item["reviewed_at"] = datetime.fromisoformat(item["reviewed_at"])
                    self.queue.append(ReviewItem(**item))

    def _save_queue(self):
        data = [{"id": i.id, "type": i.type, "data": i.data, "confidence": i.confidence,
                 "status": i.status, "review_notes": i.review_notes, "modified_data": i.modified_data,
                 "created_at": i.created_at.isoformat(),
                 "reviewed_at": i.reviewed_at.isoformat() if i.reviewed_at else None} for i in self.queue]
        with open(self.review_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def collect_low_confidence_items(self):
        logger.info("开始收集低置信度审核项")
        # 消歧
        for item in self.neo4j.execute_query(
            "MATCH (e:Entity) WHERE e.disambiguation_confidence IS NOT NULL AND e.disambiguation_confidence < $t "
            "AND (e.disambiguation_status IS NULL OR e.disambiguation_status = 'pending') "
            "RETURN e.name as name, e.disambiguation_confidence as confidence, e.context as context",
            {"t": REVIEW_THRESHOLD}
        ):
            self.add_item("disambiguation", {"name": item["name"], "context": item.get("context", "")}, item["confidence"])
        # 冲突
        for item in self.neo4j.execute_query(
            "MATCH (c:Conflict) WHERE c.confidence IS NOT NULL AND c.confidence < $t "
            "AND (c.review_status IS NULL OR c.review_status = 'pending') "
            "RETURN c.concept as concept, c.conflict_level as level, c.confidence as confidence",
            {"t": REVIEW_THRESHOLD}
        ):
            self.add_item("conflict", {"concept": item["concept"], "level": item["level"]}, item["confidence"])
        # 聚类
        for item in self.neo4j.execute_query(
            "MATCH (c:Community) WHERE c.clustering_confidence IS NOT NULL AND c.clustering_confidence < $t "
            "AND (c.review_status IS NULL OR c.review_status = 'pending') "
            "RETURN c.community_id as community_id, c.clustering_confidence as confidence",
            {"t": REVIEW_THRESHOLD}
        ):
            self.add_item("clustering", {"community_id": item["community_id"]}, item["confidence"])
        logger.info(f"收集完成，待审核项共 {len(self.get_pending_items())} 条")

    def add_item(self, item_type: str, data: Dict, confidence: float) -> str:
        existing = [i for i in self.queue if i.type == item_type and i.data == data]
        if existing:
            return existing[0].id
        item_id = f"review_{item_type}_{int(time.time())}_{len(self.queue)}"
        self.queue.append(ReviewItem(id=item_id, type=item_type, data=data, confidence=confidence))
        self._save_queue()
        return item_id

    def get_pending_items(self, item_type: str = None) -> List[ReviewItem]:
        if item_type:
            return [i for i in self.queue if i.status == "pending" and i.type == item_type]
        return [i for i in self.queue if i.status == "pending"]

    def is_stage_passable(self) -> bool:
        if not CONFIG.get("pipeline", {}).get("enable_review_gate", True):
            return True
        return len(self.get_pending_items()) == 0

    def approve_item(self, item_id: str, notes: str = ""):
        for item in self.queue:
            if item.id == item_id:
                item.status = "approved"
                item.review_notes = notes
                item.reviewed_at = datetime.now()
                self._save_queue()
                if item.type == "disambiguation":
                    self.neo4j.execute_write("MATCH (e:Entity {name: $n}) SET e.disambiguation_status = 'approved', e.reviewed_at = datetime()", {"n": item.data.get("name")})
                elif item.type == "conflict":
                    self.neo4j.execute_write("MATCH (c:Conflict {concept: $n}) SET c.review_status = 'approved', c.reviewed_at = datetime()", {"n": item.data.get("concept")})
                elif item.type == "clustering":
                    self.neo4j.execute_write("MATCH (c:Community {community_id: $id}) SET c.review_status = 'approved', c.reviewed_at = datetime()", {"id": item.data.get("community_id")})
                return True
        return False

    def reject_item(self, item_id: str, notes: str = ""):
        for item in self.queue:
            if item.id == item_id:
                item.status = "rejected"
                item.review_notes = notes
                item.reviewed_at = datetime.now()
                self._save_queue()
                if item.type == "disambiguation":
                    self.neo4j.execute_write("MATCH (e:Entity {name: $n}) SET e.disambiguation_status = 'rejected'", {"n": item.data.get("name")})
                return True
        return False

    def modify_item(self, item_id: str, modified_data: Dict, notes: str = ""):
        for item in self.queue:
            if item.id == item_id:
                item.modified_data = modified_data
                item.review_notes = notes
                item.status = "modified"
                item.reviewed_at = datetime.now()
                self._save_queue()
                self._add_feedback_sample(item)
                if item.type == "disambiguation" and modified_data:
                    self.neo4j.execute_write(
                        "MATCH (e:Entity {name: $old}) SET e.name = $new, e.description = $desc, e.disambiguation_status = 'modified', e.modified_at = datetime()",
                        {"old": item.data.get("name"), "new": modified_data.get("name", item.data.get("name")), "desc": modified_data.get("description", "")}
                    )
                return True
        return False

    def _add_feedback_sample(self, item: ReviewItem):
        samples = []
        if self.feedback_samples_file.exists():
            with open(self.feedback_samples_file, 'r', encoding='utf-8') as f:
                samples = json.load(f)
        samples.append({"type": item.type, "original": item.data, "corrected": item.modified_data, "notes": item.review_notes, "timestamp": datetime.now().isoformat()})
        with open(self.feedback_samples_file, 'w', encoding='utf-8') as f:
            json.dump(samples, f, ensure_ascii=False, indent=2)

    def get_statistics(self) -> Dict:
        stats = {"total": len(self.queue), "pending": 0, "approved": 0, "rejected": 0, "modified": 0, "by_type": {}}
        for item in self.queue:
            stats[item.status] = stats.get(item.status, 0) + 1
            if item.type not in stats["by_type"]:
                stats["by_type"][item.type] = {"total": 0, "pending": 0, "approved": 0, "rejected": 0, "modified": 0}
            stats["by_type"][item.type]["total"] += 1
            stats["by_type"][item.type][item.status] = stats["by_type"][item.type].get(item.status, 0) + 1
        return stats


# ======================== 标准化混合检索接口 ========================
class HybridSearchEngine:
    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn
        self.cache = TextCache()
        self.qwen = QwenEmbeddingClient(cache=self.cache)
        self.deepseek = DeepSeekClient()

    def _call_deepseek_rerank(self, query: str, candidates: List[Dict]) -> List[Dict]:
        if not candidates:
            return []

        candidate_text = "\n".join([
            f"{i+1}. 名称: {c.get('name')}\n   类型: {c.get('type')}\n   描述: {str(c.get('description',''))[:200]}"
            for i, c in enumerate(candidates)
        ])

        prompt = f"""
你是马克思主义理论领域的专业知识检索助手。
用户查询: {query}

以下是向量召回的候选结果，请从理论逻辑、时序合理性、概念相关性三个维度进行校验和重排：
1. 剔除逻辑矛盾、时序错误、不相关的结果
2. 按相关度从高到低排序
3. 为每条结果给出简短的重排理由（1-2句话说明为什么排在这个位置）

候选结果:
{candidate_text}

输出JSON格式，包含rank（排序后的编号列表）和reasons（每条的重排理由）：
{{"rank": [3, 1, 5], "reasons": {{"3": "最相关，直接涉及...", "1": "次相关，关联理论为...", "5": "相关性较弱但涉及..."}}}}
"""

        result = self.deepseek.call_json(prompt, max_retries=2, timeout=30)
        ranked_indices = result.get("rank", list(range(1, len(candidates)+1))) if result else list(range(1, len(candidates)+1))
        reasons = result.get("reasons", {}) if result else {}

        ranked = []
        for idx in ranked_indices:
            if 1 <= idx <= len(candidates):
                c = candidates[idx-1].copy()
                c["rerank_reason"] = reasons.get(str(idx), "")
                ranked.append(c)

        for i, c in enumerate(candidates):
            if c not in ranked:
                ranked.append(c)
        return ranked

    def hybrid_search(self, query: str, top_k: int = 10, scope: str = "all", filters: Dict = None) -> List[Dict]:
        logger.info(f"执行混合检索: {query[:50]}... (scope={scope}, top_k={top_k})")
        vector_candidates = self._vector_retrieval(query, top_k * 3, scope, filters)
        if not vector_candidates:
            return []
        graph_expanded = self._graph_expansion(vector_candidates, top_k * 2)
        reranked = self._call_deepseek_rerank(query, graph_expanded)
        return self._format_results(reranked, top_k)

    def _vector_retrieval(self, query: str, top_k: int, scope: str, filters: Dict) -> List[Dict]:
        query_vector = self.qwen.embed(query)
        if query_vector is None:
            return []
        results = []

        if scope in ["entity", "all"]:
            try:
                er = self.neo4j.execute_query(
                    "CALL db.index.vector.queryNodes('entity_vector_idx', $top_k, $vector) YIELD node, score "
                    "WHERE score > 0.6 RETURN node.name as name, node.category as category, node.description as description, score, 'entity' as type",
                    {"top_k": top_k, "vector": query_vector}
                )
                results.extend(er)
            except Exception:
                pass

        if scope in ["literature", "all"]:
            try:
                lr = self.neo4j.execute_query(
                    "CALL db.index.vector.queryNodes('literature_distill_vector_idx', $top_k, $vector) YIELD node, score "
                    "WHERE score > 0.6 RETURN node.source_folder as name, 'literature' as type, score, node.core_concept_definition as description",
                    {"top_k": top_k, "vector": query_vector}
                )
                results.extend(lr)
            except Exception:
                pass

        if scope in ["domain", "all"]:
            try:
                dr = self.neo4j.execute_query(
                    "CALL db.index.vector.queryNodes('domain_knowledge_vector_idx', $top_k, $vector) YIELD node, score "
                    "WHERE score > 0.6 RETURN node.domain as name, 'domain' as type, score, node.common_paradigm as description",
                    {"top_k": top_k, "vector": query_vector}
                )
                results.extend(dr)
            except Exception:
                pass

        if filters:
            results = [r for r in results if all(r.get(k) == v for k, v in filters.items())]
        return sorted(results, key=lambda x: x.get("score", 0), reverse=True)

    def _graph_expansion(self, vector_results: List[Dict], max_expand: int) -> List[Dict]:
        entity_names = [r.get("name") for r in vector_results if r.get("type") == "entity"]
        if not entity_names:
            return vector_results[:max_expand]

        try:
            relations = self.neo4j.execute_query(
                "MATCH (e:Entity)-[r]-(related:Entity) WHERE e.name IN $names "
                "RETURN e.name as source, type(r) as relation_type, related.name as target, related.description as target_desc",
                {"names": entity_names}
            )

            expanded = list(vector_results)
            base_score = max([r.get("score", 0.5) for r in vector_results], default=0.5)
            for rel in relations:
                expanded.append({
                    "name": rel["target"], "type": "entity", "score": base_score * 0.75,
                    "description": rel.get("target_desc", ""), "relation": rel["relation_type"], "from_entity": rel["source"]
                })

            seen = set()
            unique = []
            for item in expanded:
                key = f"{item['type']}_{item['name']}"
                if key not in seen:
                    seen.add(key)
                    unique.append(item)
            return sorted(unique, key=lambda x: x.get("score", 0), reverse=True)[:max_expand]
        except Exception as e:
            logger.warning(f"图拓展失败: {e}")
            return vector_results[:max_expand]

    def _format_results(self, results: List[Dict], top_k: int) -> List[Dict]:
        formatted = []
        for r in results[:top_k]:
            formatted.append({
                "id": r.get("id", r.get("name", "")),
                "name": r.get("name", ""),
                "type": r.get("type", "unknown"),
                "relevance_score": round(r.get("score", 0.0), 4),
                "description": r.get("description", ""),
                "rerank_reason": r.get("rerank_reason", ""),
                "metadata": {"category": r.get("category", ""), "relation_type": r.get("relation", ""), "source_entity": r.get("from_entity", "")}
            })
        return formatted


# ======================== 引用溯源 ========================
class CitationTracker:
    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn

    def generate_standard_citation(self, literature_id: str) -> str:
        result = self.neo4j.execute_query(
            "MATCH (ep:Episode {source_folder: $id}) "
            "RETURN ep.authors as authors, ep.title as title, ep.year as year, ep.literature_type as type, ep.journal as journal, ep.publisher as publisher",
            {"id": literature_id}
        )
        if not result:
            return f"[{literature_id}] 文献信息缺失"
        info = result[0]
        authors = info.get("authors", "佚名")
        if isinstance(authors, list):
            authors = ", ".join(authors)
        title = info.get("title", literature_id)
        year = info.get("year", "")
        lit_type = info.get("type", "期刊论文")
        if lit_type == "期刊论文":
            return f"{authors}. {title}[J]. {info.get('journal', '')}, {year}."
        elif lit_type == "专著":
            return f"{authors}. {title}[M]. {info.get('publisher', '')}, {year}."
        else:
            return f"{authors}. {title}[Z]. {year}."

    def get_paragraph_sources(self, node_type: str, node_id: str) -> List[Dict]:
        if node_type == "Entity":
            result = self.neo4j.execute_query(
                "MATCH (e:Entity {name: $id}) RETURN e.source_paragraphs as paragraphs, e.paragraph_positions as positions, e.source_literature as lit_id",
                {"id": node_id}
            )
        elif node_type == "LiteratureDistill":
            result = self.neo4j.execute_query(
                "MATCH (ld:LiteratureDistill {id: $id}) RETURN ld.source_paragraphs as paragraphs, ld.paragraph_positions as positions, ld.source_literature as lit_id",
                {"id": node_id}
            )
        else:
            return []
        if not result:
            return []
        data = result[0]
        paragraphs = data.get("paragraphs", []) or []
        positions = data.get("positions", []) or []
        lit_id = data.get("lit_id", "")
        return [{"literature_id": lit_id, "paragraph": para, "position": positions[i] if i < len(positions) else 0, "citation": self.generate_standard_citation(lit_id)} for i, para in enumerate(paragraphs)]


# ======================== 写作模板管理 ========================
class WritingTemplateManager:
    TEMPLATES = {
        "综述类": {
            "structure": ["摘要", "研究背景与意义", "核心概念梳理", "主要流派与观点演进", "研究共识与争议", "研究趋势与未来展望", "参考文献"],
            "template": "# {title}\n\n## 摘要\n{abstract}\n\n## 一、研究背景与意义\n{background}\n\n## 二、核心概念梳理\n{concepts}\n\n## 三、主要流派与观点演进\n{theories}\n\n## 四、学界共识与争议焦点\n{consensus_controversy}\n\n## 五、研究趋势与未来展望\n{trends}\n\n## 参考文献\n{references}\n"
        },
        "理论阐释类": {
            "structure": ["理论起源与思想史脉络", "核心内涵与界定", "关键概念辨析", "理论创新与突破", "当代价值与现实意义"],
            "template": "# {title}\n\n## 一、理论起源与思想史脉络\n{origin}\n\n## 二、核心内涵与理论界定\n{core_meaning}\n\n## 三、关键概念辨析\n{concept_analysis}\n\n## 四、理论创新与突破\n{innovation}\n\n## 五、当代价值与现实意义\n{contemporary_value}\n"
        },
        "对比分析类": {
            "structure": ["对比对象概述", "理论基础异同", "历史背景差异", "核心分歧点", "综合评述与启示"],
            "template": "# {title}\n\n## 一、对比对象概述\n{objects}\n\n## 二、理论基础异同\n{similarities_differences}\n\n## 三、历史背景分析\n{historical_background}\n\n## 四、核心分歧点\n{divergence_points}\n\n## 五、综合评述\n{evaluation}\n"
        },
        "实践路径类": {
            "structure": ["实践背景与问题提出", "路径选择与理论依据", "实施机制与关键环节", "效果评估与现实困境", "优化建议与未来方向"],
            "template": "# {title}\n\n## 一、实践背景与问题提出\n{practice_background}\n\n## 二、路径选择与理论依据\n{path_selection}\n\n## 三、实施机制与关键环节\n{implementation_mechanism}\n\n## 四、效果评估与现实困境\n{effect_evaluation}\n\n## 五、优化建议与未来方向\n{optimization_suggestions}\n"
        }
    }

    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn

    def auto_bind_all_domains(self):
        domains = self.neo4j.execute_query("MATCH (dk:DomainKnowledge) RETURN dk.domain as domain")
        count = 0
        for d in domains:
            domain_name = d.get("domain", "")
            if any(k in domain_name for k in ["唯物史观", "辩证法", "剩余价值", "异化", "理论体系"]):
                tt = "理论阐释类"
            elif any(k in domain_name for k in ["中国化", "新时代", "中国式现代化", "实践", "治理"]):
                tt = "实践路径类"
            elif any(k in domain_name for k in ["西方马克思主义", "思想史", "流派", "对比", "思潮"]):
                tt = "对比分析类"
            else:
                tt = "综述类"
            self.neo4j.execute_write(
                "MATCH (dk:DomainKnowledge {domain: $d}) SET dk.writing_template = $tt, dk.template_updated_at = datetime()",
                {"d": domain_name, "tt": tt}
            )
            count += 1
        logger.info(f"批量模板绑定完成，共处理 {count} 个领域节点")

    def get_template(self, domain: str) -> Optional[Dict]:
        result = self.neo4j.execute_query(
            "MATCH (dk:DomainKnowledge {domain: $d}) RETURN dk.writing_template as template_type", {"d": domain}
        )
        if not result:
            return None
        tt = result[0].get("template_type", "综述类")
        return self.TEMPLATES.get(tt)


# ======================== 溯源跳转URI ========================
class URILinkGenerator:
    PROTOCOL = "openviking"

    @staticmethod
    def generate_uri(literature_id: str, paragraph_index: int = None, file_name: str = None) -> str:
        if URILinkGenerator.PROTOCOL == "openviking":
            base = f"openviking://literature/{literature_id}"
            if file_name:
                base += f"/{file_name}"
            if paragraph_index is not None:
                base += f"?paragraph={paragraph_index}"
            return base
        else:
            base = f"obsidian://open?vault=ov_import&file={literature_id}/{file_name}" if file_name else f"obsidian://open?vault=ov_import&file={literature_id}"
            if paragraph_index is not None:
                base += f"&line={paragraph_index}"
            return base

    @classmethod
    def batch_all_nodes(cls, neo4j_conn: Neo4jConnection):
        logger.info("开始全量节点溯源URI批量写入")
        # Entity
        entities = neo4j_conn.execute_query(
            "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_uri IS NULL "
            "RETURN e.name as name, ep.source_folder as folder LIMIT 1000"
        )
        for e in entities:
            uri = cls.generate_uri(e["folder"])
            neo4j_conn.execute_write(
                "MATCH (e:Entity {name: $n}) SET e.source_uri = $u, e.literature_ref = $f",
                {"n": e["name"], "u": uri, "f": e["folder"]}
            )
        # LiteratureDistill
        neo4j_conn.execute_write(
            "MATCH (ld:LiteratureDistill)-[:DISTILL_FROM]->(ep:Episode) WHERE ld.source_uri IS NULL "
            "SET ld.source_uri = 'openviking://literature/' + ep.source_folder, ld.literature_ref = ep.source_folder"
        )
        # DomainKnowledge
        neo4j_conn.execute_write(
            "MATCH (dk:DomainKnowledge) WHERE dk.source_uri IS NULL "
            "SET dk.source_uri = 'openviking://domain/' + dk.domain"
        )
        logger.info("全量节点溯源URI写入完成")


# ======================== 主流程 ========================
def main():
    logger.info("=" * 80)
    logger.info("模块6：数据质量与运维（完整版）")
    logger.info(f"当前环境: {API_ENV} | 批次校验阈值: 每{BATCH_VALIDATION_SIZE}篇")
    logger.info("=" * 80)

    neo4j_conn = Neo4jConnection()
    logger.info("Neo4j 连接成功")

    logger_manager = LoggerManager()
    logger_manager.log(LogLevel.INFO, "MODULE6", "模块6启动")

    # 1. 数据一致性校验
    logger.info("\n一、数据一致性校验")
    validator = DataValidator(neo4j_conn, logger_manager)
    validation_results = validator.run_full_validation()

    # 2. 人工审核队列
    logger.info("\n二、人工审核队列管理")
    review_queue = ReviewQueue(neo4j_conn, logger_manager)
    review_queue.collect_low_confidence_items()
    review_stats = review_queue.get_statistics()
    logger.info(f"审核队列统计: 总计 {review_stats['total']} 条，待审核 {review_stats['pending']} 条")
    if CONFIG.get("pipeline", {}).get("enable_review_gate", True) and review_stats["pending"] > 0:
        logger.warning("⚠️ 存在待审核项，阶段门禁未通过")
    else:
        logger.info("✅ 审核阶段门禁通过")

    # 3. 混合检索测试
    logger.info("\n三、混合检索引擎测试")
    search_engine = HybridSearchEngine(neo4j_conn)
    try:
        search_results = search_engine.hybrid_search("唯物史观的理论演进与当代发展", top_k=5, scope="all")
        logger.info(f"检索测试完成，返回 {len(search_results)} 条结果:")
        for idx, r in enumerate(search_results[:3], 1):
            reason = r.get("rerank_reason", "")
            logger.info(f"   {idx}. {r['name']} ({r['type']}) - 相关度: {r['relevance_score']}" + (f" - {reason}" if reason else ""))
    except Exception as e:
        logger.error(f"检索测试失败: {e}")

    # 4. 写作模板批量绑定
    logger.info("\n四、写作模板与领域知识预绑定")
    template_manager = WritingTemplateManager(neo4j_conn)
    template_manager.auto_bind_all_domains()

    # 5. 引用溯源
    logger.info("\n五、引用溯源系统就绪")
    citation_tracker = CitationTracker(neo4j_conn)

    # 6. URI批量写入
    logger.info("\n六、溯源跳转URI批量写入")
    URILinkGenerator.batch_all_nodes(neo4j_conn)

    # 统计
    logger.info("\n📊 运维统计汇总")
    cost_summary = logger_manager.get_cost_summary()
    logger.info(f"   累计Token消耗: {cost_summary['total_token']:,}")
    logger.info(f"   累计调用成本: {cost_summary['total_cost']:.4f} 元")

    stats_queries = [
        ("实体总数", "MATCH (e:Entity) RETURN count(e) as count"),
        ("关系总数", "MATCH ()-[r]->() RETURN count(r) as count"),
        ("单篇蒸馏节点", "MATCH (ld:LiteratureDistill) RETURN count(ld) as count"),
        ("领域知识节点", "MATCH (dk:DomainKnowledge) RETURN count(dk) as count"),
        ("社区节点数", "MATCH (c:Community) RETURN count(c) as count"),
        ("冲突标记数", "MATCH (con:Conflict) RETURN count(con) as count"),
        ("时间线节点", "MATCH (tn:TimelineNode) RETURN count(tn) as count")
    ]
    for label, cypher in stats_queries:
        try:
            result = neo4j_conn.execute_query(cypher)
            logger.info(f"   {label}: {result[0].get('count', 0):,}")
        except Exception:
            pass

    failure_file = logger_manager.export_failure_list()
    logger.info(f"\n📋 失败清单已导出: {failure_file}")

    neo4j_conn.close()
    logger.info("\n✅ 模块6全部功能执行完成")


if __name__ == "__main__":
    main()
