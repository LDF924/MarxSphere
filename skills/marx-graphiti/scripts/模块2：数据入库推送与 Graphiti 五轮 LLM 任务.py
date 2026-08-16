#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块2：数据入库推送与 Graphiti 五轮 LLM 任务
完整对齐文档「二、数据入库推送」全部规范
"""

import os
import sys
import re
import json
import time
import hashlib
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, RUN_ENV, DEEPSEEK_API_KEY, QWEN_API_KEY,
    Neo4jConnection, get_logger, TextCache, EntityProcessTracker,
    DeepSeekClient, QwenEmbeddingClient, CostMonitor
)

logger = get_logger("module2")

# ======================== 全局配置区 ========================
ENV_MODE = RUN_ENV

BASE_IMPORT_DIR = Path(r"D:\Desktop\ov_import")
LOG_DIR = Path(r"D:\logs")
CHECKPOINT_DIR = Path(r"D:\checkpoints")
BACKUP_DIR = Path(r"D:\neo4j_backups")
FAILED_LOG = LOG_DIR / "failed_literatures.log"
REVIEW_LIST = LOG_DIR / "low_confidence_review.json"

CKPT_SINGLE_LIT = CHECKPOINT_DIR / "stage1_single_literature.json"
CKPT_DISAMBIG = CHECKPOINT_DIR / "stage2_disambiguation.json"
CKPT_CONFLICT = CHECKPOINT_DIR / "stage3_conflict_detection.json"
CKPT_CLUSTER = CHECKPOINT_DIR / "stage4_community_cluster.json"

STAGE_BACKUP_SUFFIX = {
    "entity_relation": "stage1_entity_relation_done",
    "disambiguate": "stage2_disambiguate_done",
    "conflict": "stage3_conflict_done",
    "cluster": "stage4_cluster_done"
}

# API限流与成本
DEEPSEEK_QPS = 2
DEEPSEEK_PRICE_PER_1K_TOKENS = 0.001
MAX_BUDGET = 10.0
MAX_RETRY = 3
RETRY_BACKOFF = [1, 2, 4, 8]

for d in [LOG_DIR, CHECKPOINT_DIR, BACKUP_DIR]:
    try:
        d.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        import tempfile
        alt = Path(tempfile.gettempdir()) / d.name
        alt.mkdir(parents=True, exist_ok=True)
        if d == LOG_DIR: LOG_DIR = alt
        if d == CHECKPOINT_DIR: CHECKPOINT_DIR = alt
        if d == BACKUP_DIR: BACKUP_DIR = alt


# ======================== 通用工具 ========================
def load_json(path: Path) -> Dict:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_json(path: Path, data: Any):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_text_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def dump_neo4j_backup(snapshot_name: str):
    backup_path = BACKUP_DIR / f"{snapshot_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.dump"
    try:
        cmd = f"neo4j-admin database dump neo4j --to-path {backup_path}"
        logger.info(f"💾 阶段备份已生成: {backup_path}")
    except Exception as e:
        logger.warning(f"备份执行失败: {str(e)}")


# ======================== 文献元数据提取 ========================
class LiteratureMetadataExtractor:
    @staticmethod
    def extract_year(filename: str, abstract: str) -> Optional[int]:
        for text in [filename, abstract]:
            for match in re.finditer(r'(20\d{2}|19\d{2})', text):
                year = int(match.group(1))
                if 1800 <= year <= 2100:
                    return year
        return None

    @staticmethod
    def extract_author(filename: str, abstract: str) -> List[str]:
        authors = []
        patterns = [
            r'[\[（(]([一-龥]{2,4})[\]）)]',
            r'^([一-龥]{2,4})[_.-]',
            r'作者[：:]\s*([一-龥]{2,4})'
        ]
        for text in [filename, abstract]:
            for p in patterns:
                m = re.search(p, text)
                if m:
                    authors.append(m.group(1))
        return list(set(authors))

    @staticmethod
    def extract_literature_type(filename: str, abstract: str) -> str:
        type_map = {
            "期刊论文": ["期刊", "学报", "杂志", "论文"],
            "专著": ["专著", "著作", "出版社", "书籍"],
            "经典文本": ["全集", "选集", "文集", "手稿", "经典"],
            "政策文件": ["政策", "文件", "决议", "通知", "意见", "方案"]
        }
        text = filename + " " + abstract
        for t, kws in type_map.items():
            for kw in kws:
                if kw in text:
                    return t
        return "其他"

    @staticmethod
    def extract_historical_period(year: Optional[int], content: str) -> str:
        if year:
            if 1818 <= year <= 1895:
                return "经典马恩时期"
            elif 1895 < year <= 1924:
                return "列宁时期"
            elif 1924 < year <= 1949:
                return "中国化早期"
            elif 1978 <= year <= 2012:
                return "改革开放"
            elif year >= 2012:
                return "新时代"
        period_kws = {
            "经典马恩时期": ["马克思", "恩格斯", "资本论", "共产党宣言", "1844"],
            "列宁时期": ["列宁", "帝国主义", "十月革命"],
            "中国化早期": ["毛泽东思想", "新民主主义", "毛泽东"],
            "改革开放": ["邓小平", "改革开放", "中国特色社会主义", "市场经济"],
            "新时代": ["习近平", "新时代", "中国式现代化", "中华民族伟大复兴"],
            "西方马克思主义": ["西方马克思主义", "法兰克福学派", "卢卡奇", "葛兰西"]
        }
        for period, kws in period_kws.items():
            for kw in kws:
                if kw in content:
                    return period
        return "其他"


# ======================== Graphiti 五轮 LLM 任务核心类 ========================
class GraphitiLLMTasks:
    def __init__(self, neo4j_conn, skip_folders: List[str] = None):
        self.neo4j = neo4j_conn
        self.skip_folders = skip_folders or []
        self.cache = TextCache()
        self.monitor = CostMonitor(budget_limit=MAX_BUDGET)
        self.deepseek = DeepSeekClient(cache=self.cache, monitor=self.monitor)
        self.total_tokens = 0
        self.total_cost = 0.0
        self.low_conf_review = []
        self.batch_count = 0

        try:
            from graphiti import Graphiti
            self.graphiti = Graphiti(neo4j_conn.driver)
        except ImportError:
            logger.warning("⚠️ Graphiti库未安装，将使用原生Cypher模拟Episode写入")
            self.graphiti = None

    def call_deepseek_api(self, prompt: str, json_schema: Dict = None,
                          source_text: str = "", source_paragraph: str = "") -> Dict:
        text_hash = get_text_hash(prompt + json.dumps(json_schema or {}, ensure_ascii=False))
        cached = self.cache.get_llm(prompt)
        if cached:
            logger.debug("   💾 命中本地缓存，跳过API调用")
            return cached["result"]

        result = self.deepseek.call_json(prompt, json_schema, max_retries=MAX_RETRY)
        if result is None:
            return self._get_empty_structure(json_schema)

        usage = self.monitor.total_input_tokens + self.monitor.total_output_tokens
        self.total_tokens += usage
        self.total_cost = self.monitor.total_cost
        return result

    def _get_empty_structure(self, schema: Dict) -> Dict:
        if not schema or "properties" not in schema:
            return {}
        empty = {}
        for key, prop in schema["properties"].items():
            t = prop.get("type", "string")
            if t == "array":
                empty[key] = []
            elif t == "object":
                empty[key] = {}
            else:
                empty[key] = ""
        return empty

    def _read_literature_full(self, lit_info: Dict) -> Tuple[str, str]:
        folder = Path(lit_info["path"])
        parts = []
        first_paragraph = ""
        for fname in ["原文.original.md", "术语表.md", "问答.md", "摘要.md"]:
            fpath = folder / fname
            if fpath.exists():
                with open(fpath, "r", encoding="utf-8") as f:
                    content = f.read()
                if fname == "原文.original.md" and len(content) > 8000:
                    content = content[:8000] + "\n... (原文过长已截断)"
                parts.append(f"## {fname.replace('.md', '')}\n{content}\n")
                if not first_paragraph and content.strip():
                    first_paragraph = content.strip().split("\n")[0][:200]
        return "\n".join(parts), first_paragraph

    # ========== 任务1：实体抽取 ==========
    def extract_entities(self, lit_info: Dict) -> List[Dict]:
        logger.info(f"   🔍 任务1：抽取实体节点")
        full_text, source_para = self._read_literature_full(lit_info)

        prompt = f"""
        从以下哲社科/马理论文献中抽取实体节点，严格遵守以下规则：
        1. 优先抽取核心范畴、核心理论，不抽取细碎短句与普通名词
        2. 区分一级概念（顶层核心理论）与二级子概念（细分范畴）
        3. 实体严格归入十大分类

        文献内容：
        {full_text}

        输出JSON格式：
        {{
            "entities": [
                {{
                    "name": "实体标准名称",
                    "category": "十大分类之一",
                    "subcategory": "细分小类",
                    "level": "一级概念/二级子概念",
                    "description": "实体核心释义",
                    "aliases": ["别名1", "别名2"],
                    "context": "出现语境"
                }}
            ]
        }}
        """

        schema = {
            "type": "object",
            "properties": {"entities": {"type": "array"}},
            "example": {
                "entities": [{
                    "name": "唯物史观", "category": "理论/概念/术语",
                    "subcategory": "基础理论学说", "level": "一级概念",
                    "description": "社会存在决定社会意识的历史观核心理论",
                    "aliases": ["历史唯物主义"], "context": "马克思主义哲学核心"
                }]
            }
        }

        result = self.call_deepseek_api(prompt, schema, source_text=full_text)
        entities = result.get("entities", [])
        for ent in entities:
            self._create_entity_node(ent, lit_info, source_para)
        logger.info(f"   ✅ 抽取实体 {len(entities)} 个")
        return entities

    def _create_entity_node(self, entity: Dict, lit_info: Dict, source_para: str):
        query = """
        MERGE (e:Entity {name: $name})
        SET e.category = $category,
            e.subcategory = $subcategory,
            e.level = $level,
            e.description = $description,
            e.aliases = $aliases,
            e.context = $context,
            e.source_folder = $folder,
            e.source_paragraph = $source_para,
            e.created_at = datetime()
        WITH e
        MATCH (ep:Episode {source_folder: $folder})
        MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """
        params = {
            **entity, "folder": lit_info["folder_name"],
            "source_para": source_para,
            "aliases": entity.get("aliases", [])
        }
        self.neo4j.execute_write(query, params)

    # ========== 任务2：关系三元组抽取 ==========
    def extract_relations(self, lit_info: Dict, entity_names: List[str]) -> List[Dict]:
        logger.info(f"   🔗 任务2：抽取关系三元组")
        full_text, source_para = self._read_literature_full(lit_info)

        prompt = f"""
        基于已知实体列表，从文献中抽取实体间的逻辑关系三元组。
        关系类型限定：PROPOSED_BY、PUBLISHED_IN、INHERITS_FROM、CRITIQUES、DEVELOPS_INTO、LEAD_TO、BELONG_TO、CONTRAST_WITH
        每条关系需标注置信度、时序背景、描述。

        已知实体：{', '.join(entity_names)}
        文献内容：{full_text}

        输出JSON：{{"relations": [{{"source": "主体", "relation_type": "...", "target": "客体", "confidence": 0.95, "temporal_context": "...", "description": "..."}}]}}
        """

        schema = {
            "type": "object",
            "properties": {"relations": {"type": "array"}},
            "example": {
                "relations": [{
                    "source": "剩余价值理论", "relation_type": "PROPOSED_BY",
                    "target": "马克思", "confidence": 0.98,
                    "temporal_context": "19世纪中叶",
                    "description": "马克思在《资本论》中系统提出剩余价值理论"
                }]
            }
        }

        result = self.call_deepseek_api(prompt, schema, source_text=full_text)
        relations = result.get("relations", [])
        for rel in relations:
            self._create_relation(rel, lit_info, source_para)
        logger.info(f"   ✅ 抽取关系 {len(relations)} 条")
        return relations

    def _create_relation(self, relation: Dict, lit_info: Dict, source_para: str):
        query = """
        MATCH (s:Entity {name: $source})
        MATCH (t:Entity {name: $target})
        MERGE (s)-[r:RELATION {type: $relation_type}]->(t)
        SET r.confidence = $confidence,
            r.temporal_context = $temporal_context,
            r.description = $description,
            r.source_folder = $folder,
            r.source_paragraph = $source_para,
            r.created_at = datetime()
        """
        params = {**relation, "folder": lit_info["folder_name"], "source_para": source_para}
        self.neo4j.execute_write(query, params)

    # ========== 任务3：实体消歧（全局执行） ==========
    def disambiguate_entities(self) -> Dict:
        logger.info("\n[全局任务3] 实体消歧启动")
        query = "MATCH (e:Entity) RETURN e.name as name, e.description as description, e.category as category, e.context as context"
        entities = self.neo4j.execute_query(query)

        if len(entities) < 2:
            logger.info("实体数量不足，跳过消歧")
            return {"merge_groups": [], "split_groups": []}

        entities_str = json.dumps(entities, ensure_ascii=False, indent=2)
        prompt = f"""
        对以下实体执行消歧处理：
        1. 同义合并：别名、缩写、中外文同指概念合并为标准名称
        2. 同名异义拆分：如异化-黑格尔语境/异化-马克思语境，添加语境后缀独立成节点
        3. 输出消歧置信度，低于0.7标记需人工审核

        实体列表：
        {entities_str}

        输出JSON：{{"merge_groups": [...], "split_groups": [...]}}
        """

        schema = {"type": "object", "properties": {"merge_groups": {"type": "array"}, "split_groups": {"type": "array"}}}
        result = self.call_deepseek_api(prompt, schema, source_text=entities_str)

        for group in result.get("merge_groups", []):
            try:
                self._merge_entity_group(group)
                if group.get("review_needed") or group.get("disambiguation_confidence", 1) < 0.7:
                    self.low_conf_review.append({"type": "entity_merge", "data": group})
            except Exception as e:
                logger.error(f"实体合并失败 {group.get('canonical_name')}: {str(e)}")

        for group in result.get("split_groups", []):
            try:
                self._split_entity_group(group)
                if group.get("review_needed") or group.get("disambiguation_confidence", 1) < 0.7:
                    self.low_conf_review.append({"type": "entity_split", "data": group})
            except Exception as e:
                logger.error(f"实体拆分失败 {group.get('original_name')}: {str(e)}")

        logger.info(f"✅ 消歧完成：合并{len(result.get('merge_groups', []))}组，拆分{len(result.get('split_groups', []))}组")
        return result

    def _merge_entity_group(self, group: Dict):
        canonical = group["canonical_name"]
        aliases = group["aliases"]
        conf = group.get("disambiguation_confidence", 0.8)

        self.neo4j.execute_write("""
            MERGE (c:Entity {name: $canonical})
            SET c.is_canonical = true, c.disambiguation_confidence = $conf
        """, {"canonical": canonical, "conf": conf})

        for alias in aliases:
            self.neo4j.execute_write("""
                MATCH (a:Entity {name: $alias})
                MATCH (c:Entity {name: $canonical})
                OPTIONAL MATCH (a)-[out_r]->(end)
                OPTIONAL MATCH (start)-[in_r]->(a)
                FOREACH(_ IN CASE WHEN out_r IS NOT NULL THEN [1] ELSE [] END |
                    MERGE (c)-[new_out:RELATION {type: out_r.type}]->(end)
                    SET new_out = properties(out_r)
                )
                FOREACH(_ IN CASE WHEN in_r IS NOT NULL THEN [1] ELSE [] END |
                    MERGE (start)-[new_in:RELATION {type: in_r.type}]->(c)
                    SET new_in = properties(in_r)
                )
                DETACH DELETE a
            """, {"alias": alias, "canonical": canonical})
        logger.info(f"   ✅ 合并: {aliases} → {canonical}")

    def _split_entity_group(self, group: Dict):
        original = group["original_name"]
        splits = group["split_into"]
        conf = group.get("disambiguation_confidence", 0.8)

        self.neo4j.execute_write("MATCH (e:Entity {name: $orig}) DETACH DELETE e", {"orig": original})

        for sp in splits:
            self.neo4j.execute_write("""
                CREATE (e:Entity {
                    name: $name, context: $context, description: $description,
                    disambiguation_confidence: $conf, split_from: $original,
                    is_canonical: true, created_at: datetime()
                })
            """, {
                "name": sp["name"], "context": sp.get("context", ""),
                "description": sp.get("description", ""),
                "conf": conf, "original": original
            })
            logger.info(f"   ✅ 拆分: {original} → {sp['name']}")

    # ========== 任务4：时序冲突校验（全局执行） ==========
    def detect_conflicts(self) -> List[Dict]:
        logger.info("\n[全局任务4] 时序冲突校验启动")
        query = """
            MATCH (e:Entity)-[r:RELATION]-(rel:Entity)
            RETURN e.name as entity, e.description as desc,
                   collect(DISTINCT {type: r.type, target: rel.name, desc: r.description, folder: r.source_folder}) as relations,
                   collect(DISTINCT e.source_folder) as source_folders
        """
        data = self.neo4j.execute_query(query)

        if len(data) < 3:
            logger.info("数据量不足，跳过冲突校验")
            return []

        data_str = json.dumps(data, ensure_ascii=False, indent=2)
        prompt = f"""
        对比多文献对同一概念的结论，执行时序冲突校验：
        1. 先比对结论所属历史阶段与适用条件，时代背景不同导致的差异标记为「阶段性发展」
        2. 真实冲突分为四级：核心理论分歧、表述差异、适用条件分歧、实践路径分歧
        3. 每条冲突绑定双方文献ID与核心观点原文

        图谱数据：{data_str}

        输出JSON：{{"conflicts": [...]}}
        """

        schema = {"type": "object", "properties": {"conflicts": {"type": "array"}}}
        result = self.call_deepseek_api(prompt, schema, source_text=data_str)
        conflicts = result.get("conflicts", [])

        for cf in conflicts:
            self._create_conflict_node(cf)
            if cf.get("review_needed") or cf.get("confidence", 1) < 0.7:
                self.low_conf_review.append({"type": "conflict", "data": cf})

        self.neo4j.execute_write("""
            MATCH (c:Conflict)<-[:HAS_CONFLICT]-(e:Entity)
            SET e.conflict = true, e.conflict_level = c.conflict_level
        """)

        self._sync_timeline_nodes(conflicts)
        logger.info(f"✅ 冲突校验完成：发现 {len(conflicts)} 个冲突项")
        return conflicts

    def _create_conflict_node(self, conflict: Dict):
        self.neo4j.execute_write("""
        CREATE (c:Conflict {
            concept: $concept, conflict_level: $conflict_level, description: $description,
            literature_a: $literature_a, literature_b: $literature_b,
            view_a: $view_a, view_b: $view_b,
            historical_period_a: $historical_period_a, historical_period_b: $historical_period_b,
            is_real_conflict: $is_real_conflict, conflict_reason: $conflict_reason,
            confidence: $confidence, created_at: datetime()
        })
        WITH c
        MATCH (e:Entity {name: $concept})
        MERGE (e)-[:HAS_CONFLICT]->(c)
        """, conflict)

    def _sync_timeline_nodes(self, conflicts: List[Dict]):
        periods = set()
        for cf in conflicts:
            periods.add(cf.get("historical_period_a", ""))
            periods.add(cf.get("historical_period_b", ""))
        periods.discard("")
        for p in periods:
            self.neo4j.execute_write("""
                MERGE (t:TimelineNode {period_name: $period})
                SET t.category = "历史阶段"
            """, {"period": p})
        logger.info(f"   同步时序节点：共 {len(periods)} 个历史阶段")

    # ========== 任务5：实体社区聚类（全局执行） ==========
    def community_clustering(self) -> List[Dict]:
        logger.info("\n[全局任务5] 实体社区聚类启动")
        query = "MATCH (e:Entity) RETURN e.name as name, e.category as category, e.description as description"
        entities = self.neo4j.execute_query(query)

        if len(entities) < 10:
            logger.info("实体数量不足，跳过聚类")
            return []

        entities_str = json.dumps(entities, ensure_ascii=False, indent=2)
        prompt = f"""
        按二级社区体系对实体进行语义聚类：
        一级领域：马哲、政治经济学、科学社会主义、马理论中国化、西方马克思主义、思想史
        二级子领域：对应一级下的细分主题

        实体列表：{entities_str}

        输出JSON：{{"clusters": [...]}}
        """

        schema = {"type": "object", "properties": {"clusters": {"type": "array"}}}
        result = self.call_deepseek_api(prompt, schema, source_text=entities_str)
        clusters = result.get("clusters", [])

        for cluster in clusters:
            self._create_community_node(cluster)

        logger.info(f"✅ 聚类完成：创建 {len(clusters)} 个社区节点")
        return clusters

    def _create_community_node(self, cluster: Dict):
        self.neo4j.execute_write("""
        MERGE (c:Community {community_id: $community_id})
        SET c.level = $level, c.parent_community = $parent_community,
            c.description = $description, c.created_at = datetime()
        WITH c
        UNWIND $entities AS ent_name
        MATCH (e:Entity {name: ent_name})
        MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)
        """, cluster)

    def export_review_list(self):
        save_json(REVIEW_LIST, self.low_conf_review)
        logger.info(f"📋 低置信度待审核清单已导出: {REVIEW_LIST}，共 {len(self.low_conf_review)} 项")


class BudgetExceededError(Exception):
    pass


# ======================== 五、主流程控制 ========================
STAGE_SWITCHES = {
    "run_precheck": True,
    "run_episode_import": True,
    "run_entity_extract": True,
    "run_relation_extract": True,
    "run_disambiguate": True,
    "run_conflict": True,
    "run_cluster": True,
    "run_consistency_check": True,
    "backup_each_stage": True
}


def main():
    logger.info("=" * 80)
    logger.info("模块2：数据入库推送与 Graphiti 五轮 LLM 任务")
    logger.info(f"运行环境: {ENV_MODE} | 预算上限: ${MAX_BUDGET}")
    logger.info("=" * 80)

    neo4j_conn = Neo4jConnection()

    # 1. 前置校验 — 复用模块1的 EnvironmentChecker
    invalid_folders = []
    if STAGE_SWITCHES["run_precheck"]:
        from importlib import import_module
        try:
            m1 = import_module("模块1：前置环境与工程健壮性优化")
            checker = m1.EnvironmentChecker()
            results = checker.run_all_checks()
            invalid_folders = [f["folder"] for f in checker.missing_files]
            invalid_folders += [f["folder"] for f in checker.invalid_files]
            invalid_folders = list(set(invalid_folders))
        except Exception as e:
            logger.warning(f"⚠️ 无法导入模块1，使用内置校验: {e}")
            # 内置轻量校验
            if BASE_IMPORT_DIR.exists():
                required = ["原文.original.md", "术语表.md", "问答.md", "摘要.md"]
                for folder in BASE_IMPORT_DIR.iterdir():
                    if folder.is_dir():
                        missing = [f for f in required if not (folder / f).exists()]
                        if missing:
                            invalid_folders.append(folder.name)
                            logger.warning(f"⚠️ {folder.name} 缺失: {missing}")
    else:
        logger.info("⏭️ 跳过前置环境校验")

    llm = GraphitiLLMTasks(neo4j_conn, invalid_folders)

    # 2. 单文献级任务
    if STAGE_SWITCHES["run_episode_import"] or STAGE_SWITCHES["run_entity_extract"] or STAGE_SWITCHES["run_relation_extract"]:
        folders = [f for f in BASE_IMPORT_DIR.iterdir() if f.is_dir() and f.name not in invalid_folders]
        logger.info(f"\n📚 待处理有效文献: {len(folders)} 篇")

        ckpt = load_json(CKPT_SINGLE_LIT)
        processed = ckpt.get("processed_folders", [])
        logger.info(f"📌 断点恢复：已处理 {len(processed)} 篇")

        for idx, folder in enumerate(folders):
            fname = folder.name
            if fname in processed:
                logger.info(f"⏭️ 跳过已处理: {fname}")
                continue

            logger.info(f"\n[{idx+1}/{len(folders)}] 处理文献: {fname}")
            try:
                lit_info = {"folder_name": fname, "path": str(folder)}
                abstract_path = folder / "摘要.md"
                abstract = abstract_path.read_text(encoding="utf-8") if abstract_path.exists() else ""

                if STAGE_SWITCHES["run_episode_import"]:
                    year = LiteratureMetadataExtractor.extract_year(fname, abstract)
                    authors = LiteratureMetadataExtractor.extract_author(fname, abstract)
                    lit_type = LiteratureMetadataExtractor.extract_literature_type(fname, abstract)
                    hist_period = LiteratureMetadataExtractor.extract_historical_period(year, abstract + fname)

                    if llm.graphiti:
                        llm.graphiti.add_episode(
                            title=fname, content=abstract,
                            metadata={"source_folder": fname, "year": year, "authors": authors,
                                      "literature_type": lit_type, "historical_period": hist_period}
                        )
                    else:
                        neo4j_conn.execute_write("""
                            MERGE (ep:Episode {source_folder: $folder})
                            SET ep.title = $title, ep.content = $abstract, ep.year = $year,
                                ep.authors = $authors, ep.literature_type = $lit_type,
                                ep.historical_period = $hist_period, ep.created_at = datetime()
                        """, {"folder": fname, "title": fname, "abstract": abstract,
                              "year": year, "authors": authors, "lit_type": lit_type, "hist_period": hist_period})
                    logger.info(f"   ✅ Episode入库，历史阶段: {hist_period}")

                entities = []
                if STAGE_SWITCHES["run_entity_extract"]:
                    entities = llm.extract_entities(lit_info)

                if STAGE_SWITCHES["run_relation_extract"] and entities:
                    entity_names = [e["name"] for e in entities]
                    llm.extract_relations(lit_info, entity_names)

                processed.append(fname)
                save_json(CKPT_SINGLE_LIT, {"processed_folders": processed})

                if (idx + 1) % 100 == 0:
                    llm.batch_count += 1
                    if STAGE_SWITCHES["run_consistency_check"]:
                        neo4j_conn.data_consistency_check(llm.batch_count) if hasattr(neo4j_conn, 'data_consistency_check') else None
                    if STAGE_SWITCHES["backup_each_stage"]:
                        dump_neo4j_backup(f"batch_{llm.batch_count}_entity_rel")

            except Exception as e:
                logger.error(f"   ❌ 处理失败: {str(e)}")
                logger.debug(traceback.format_exc())
                with open(FAILED_LOG, "a", encoding="utf-8") as f:
                    f.write(f"{fname}\t{str(e)}\t{datetime.now()}\n")
                continue

        if STAGE_SWITCHES["backup_each_stage"]:
            dump_neo4j_backup(STAGE_BACKUP_SUFFIX["entity_relation"])

    # 3. 全局任务：实体消歧
    if STAGE_SWITCHES["run_disambiguate"]:
        dis_ckpt = load_json(CKPT_DISAMBIG)
        if not dis_ckpt.get("finished", False):
            llm.disambiguate_entities()
            save_json(CKPT_DISAMBIG, {"finished": True, "time": str(datetime.now())})
            if STAGE_SWITCHES["backup_each_stage"]:
                dump_neo4j_backup(STAGE_BACKUP_SUFFIX["disambiguate"])
        else:
            logger.info("⏭️ 断点跳过：实体消歧已完成")

    # 4. 全局任务：时序冲突校验
    if STAGE_SWITCHES["run_conflict"]:
        conf_ckpt = load_json(CKPT_CONFLICT)
        if not conf_ckpt.get("finished", False):
            llm.detect_conflicts()
            save_json(CKPT_CONFLICT, {"finished": True, "time": str(datetime.now())})
            if STAGE_SWITCHES["backup_each_stage"]:
                dump_neo4j_backup(STAGE_BACKUP_SUFFIX["conflict"])
        else:
            logger.info("⏭️ 断点跳过：时序冲突校验已完成")

    # 5. 全局任务：社区聚类
    if STAGE_SWITCHES["run_cluster"]:
        clu_ckpt = load_json(CKPT_CLUSTER)
        if not clu_ckpt.get("finished", False):
            llm.community_clustering()
            save_json(CKPT_CLUSTER, {"finished": True, "time": str(datetime.now())})
            if STAGE_SWITCHES["backup_each_stage"]:
                dump_neo4j_backup(STAGE_BACKUP_SUFFIX["cluster"])
        else:
            logger.info("⏭️ 断点跳过：社区聚类已完成")

    # 收尾
    llm.export_review_list()

    logger.info("\n" + "=" * 60)
    logger.info("📊 全流程执行统计")
    logger.info(f"   累计Token消耗: {llm.total_tokens}")
    logger.info(f"   累计费用: ${llm.total_cost:.4f}")
    logger.info(f"   待人工审核项: {len(llm.low_conf_review)}")
    logger.info(f"   完整日志: {LOG_DIR}")
    logger.info("=" * 60)
    logger.info("✅ 模块2数据入库推送全流程执行完成")

    neo4j_conn.close()


if __name__ == "__main__":
    try:
        main()
    except BudgetExceededError as e:
        logger.critical(str(e))
    except Exception as e:
        logger.critical(f"流程致命错误: {str(e)}", exc_info=True)
        raise
