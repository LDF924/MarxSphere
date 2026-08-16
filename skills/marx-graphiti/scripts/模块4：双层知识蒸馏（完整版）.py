#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块4：双层知识蒸馏（完整版）
功能：
1. 第一层：单文献蒸馏 LiteratureDistill
2. 第二层：跨文献全局知识蒸馏 DomainKnowledge
3. 增量蒸馏机制
"""

import os
import sys
import json
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, RUN_ENV, DEEPSEEK_API_KEY, QWEN_API_KEY,
    Neo4jConnection, get_logger, TextCache,
    DeepSeekClient, QwenEmbeddingClient, CostMonitor
)

logger = get_logger("module4")

# ======================== 配置 ========================
BASE_PATH = Path("D:\\Desktop\\ov_import")
CHECKPOINT_DIR = Path("D:\\checkpoints")
try:
    CHECKPOINT_DIR.mkdir(exist_ok=True)
except PermissionError:
    import tempfile
    CHECKPOINT_DIR = Path(tempfile.gettempdir()) / "pipeline_checkpoints"
    CHECKPOINT_DIR.mkdir(exist_ok=True)

# ======================== 通用工具 ========================
def split_markdown_by_chapter(text: str, max_chars: int = 3000) -> List[str]:
    if len(text) <= max_chars:
        return [text]
    chapters = re.split(r'(?=##\s+)', text)
    chunks = []
    current_chunk = ""
    for chap in chapters:
        if not chap.strip():
            continue
        if len(current_chunk) + len(chap) <= max_chars:
            current_chunk += chap
        else:
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = chap
    if current_chunk:
        chunks.append(current_chunk)
    return chunks


def merge_distill_results(results: List[Dict]) -> Dict:
    merged = {
        "core_concept_definition": [],
        "theoretical_system_and_innovation": {
            "rely_on_theory": [], "inherit_theory": [], "sublate_theory": [], "innovation_point": []
        },
        "analysis_paradigm_and_interpretation": {
            "research_perspective": "", "analysis_framework": "", "demonstration_method": "", "interpretation_path": ""
        },
        "dialectical_logic_chain": [],
        "theoretical_limitation_and_expansion": {
            "interpretation_deficiency": "", "academic_controversy_unresolved": "",
            "future_theoretical_deepening": "", "future_practical_extension": ""
        }
    }
    concept_names = set()
    logic_keys = set()
    for res in results:
        for concept in res.get("core_concept_definition", []):
            name = concept.get("concept_name", "")
            if name and name not in concept_names:
                concept_names.add(name)
                merged["core_concept_definition"].append(concept)
        for key in ["rely_on_theory", "inherit_theory", "sublate_theory", "innovation_point"]:
            for item in res.get("theoretical_system_and_innovation", {}).get(key, []):
                if item not in merged["theoretical_system_and_innovation"][key]:
                    merged["theoretical_system_and_innovation"][key].append(item)
        for key in ["research_perspective", "analysis_framework", "demonstration_method", "interpretation_path"]:
            val = res.get("analysis_paradigm_and_interpretation", {}).get(key, "")
            if len(val) > len(merged["analysis_paradigm_and_interpretation"][key]):
                merged["analysis_paradigm_and_interpretation"][key] = val
        for chain in res.get("dialectical_logic_chain", []):
            lk = f"{chain.get('theory_subject_a','')}|{chain.get('theory_subject_b','')}|{chain.get('logic_relation_type','')}"
            if lk not in logic_keys:
                logic_keys.add(lk)
                merged["dialectical_logic_chain"].append(chain)
        for key in ["interpretation_deficiency", "academic_controversy_unresolved", "future_theoretical_deepening", "future_practical_extension"]:
            val = res.get("theoretical_limitation_and_expansion", {}).get(key, "")
            if len(val) > len(merged["theoretical_limitation_and_expansion"][key]):
                merged["theoretical_limitation_and_expansion"][key] = val
    return merged


# ======================== API 预检 ========================
def api_health_check() -> bool:
    logger.info("🔍 执行API健康预检...")
    all_ok = True
    try:
        client = DeepSeekClient()
        result = client.call("请回复'连接正常'", max_retries=2, timeout=15)
        if result:
            logger.info("   ✅ DeepSeek V4 Pro 正常")
        else:
            logger.error("   ❌ DeepSeek 异常")
            all_ok = False
    except Exception as e:
        logger.error(f"   ❌ DeepSeek 连接失败: {e}")
        all_ok = False
    try:
        qwen = QwenEmbeddingClient()
        vec = qwen.embed("ping")
        if vec:
            logger.info("   ✅ Qwen3-Embedding 正常")
        else:
            logger.error("   ❌ Qwen3-Embedding 异常")
            all_ok = False
    except Exception as e:
        logger.error(f"   ❌ Qwen3-Embedding 异常: {e}")
        all_ok = False
    return all_ok


# ======================== 第一层：单文献蒸馏 ========================
class LiteratureDistillation:
    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn
        self.cache = TextCache()
        self.monitor = CostMonitor()
        self.deepseek = DeepSeekClient(cache=self.cache, monitor=self.monitor)
        self.qwen = QwenEmbeddingClient(cache=self.cache, monitor=self.monitor)
        self.total_tokens = 0
        self.total_cost = 0

    def read_literature_files(self, folder_path: Path) -> Tuple[Dict, bool]:
        """Read paper MD files with flexible naming matching"""
        content = {"原文": "", "术语表": "", "问答": "", "摘要": ""}

        for f in folder_path.glob("*.md"):
            name = f.name
            if "摘要" in name or "摘" in name:
                content["摘要"] = f.read_text(encoding="utf-8")
            elif "术语" in name:
                content["术语表"] = f.read_text(encoding="utf-8")
            elif "问答" in name or "問答" in name or "问" in name:
                content["问答"] = f.read_text(encoding="utf-8")
            elif "original" in name.lower():
                content["原文"] = f.read_text(encoding="utf-8")
            elif any(k in name for k in ["摘要", "术语", "问答", "original"]):
                pass  # already matched above
            else:
                # unnamed md file with paper title - treat as original
                if not content["原文"]:
                    content["原文"] = f.read_text(encoding="utf-8")

        valid = bool(content.get("摘要", "").strip() and content.get("术语表", "").strip())
        return content, valid

    def _build_distill_prompt(self, content: Dict, folder_name: str) -> str:
        few_shot = """
【输出示例】
{
  "core_concept_definition": [{"concept_name": "异化劳动", "concept_alias": ["劳动异化"], "concept_connotation": "...", "concept_boundary": "...", "source_paragraph": "..."}],
  "theoretical_system_and_innovation": {"rely_on_theory": [...], "inherit_theory": [...], "sublate_theory": [...], "innovation_point": [...]},
  "analysis_paradigm_and_interpretation": {"research_perspective": "...", "analysis_framework": "...", "demonstration_method": "...", "interpretation_path": "..."},
  "dialectical_logic_chain": [{"theory_subject_a": "...", "theory_subject_b": "...", "logic_relation_type": "扬弃", "causal_background": "...", "dialectical_content": "...", "source_paragraph": "..."}],
  "theoretical_limitation_and_expansion": {"interpretation_deficiency": "...", "academic_controversy_unresolved": "...", "future_theoretical_deepening": "...", "future_practical_extension": "..."}
}
"""
        return f"""
你是一位马克思主义理论、哲学、社会科学领域的资深学者，请对以下文献进行深度知识蒸馏。

## 文献信息
- 文献名称：{folder_name}
- 摘要：{content.get('摘要', '')[:1000]}
- 术语表：{content.get('术语表', '')}
- 问答：{content.get('问答', '')}
- 原文内容：{content.get('原文', '')[:3000]}

## 强制约束
1. 全局禁用理工科词汇
2. 所有JSON键名固定不变，空内容填空数组/空字符串
3. 每个核心概念与逻辑链必须附带 source_paragraph

{few_shot}

请直接输出JSON，不要任何额外说明文字。
"""

    def call_deepseek_distill(self, content: Dict, folder_name: str, retry: int = 3) -> Dict:
        prompt = self._build_distill_prompt(content, folder_name)
        result = self.deepseek.call_json(prompt, max_retries=retry, timeout=180)
        if result is None:
            logger.warning(f"   DeepSeek call_json returned None, falling back to empty")
            return self._get_empty_distill()
        result = self._validate_json_fields(result)
        self.total_tokens = self.monitor.total_input_tokens + self.monitor.total_output_tokens
        self.total_cost = self.monitor.total_cost
        return result

    def _validate_json_fields(self, data: Dict) -> Dict:
        required = {
            "core_concept_definition": [],
            "theoretical_system_and_innovation": {"rely_on_theory": [], "inherit_theory": [], "sublate_theory": [], "innovation_point": []},
            "analysis_paradigm_and_interpretation": {"research_perspective": "", "analysis_framework": "", "demonstration_method": "", "interpretation_path": ""},
            "dialectical_logic_chain": [],
            "theoretical_limitation_and_expansion": {"interpretation_deficiency": "", "academic_controversy_unresolved": "", "future_theoretical_deepening": "", "future_practical_extension": ""}
        }
        for key, val in required.items():
            if key not in data:
                data[key] = val
            elif isinstance(val, dict):
                for k, v in val.items():
                    if k not in data[key]:
                        data[key][k] = v
        for concept in data.get("core_concept_definition", []):
            if isinstance(concept, dict):
                concept.setdefault("concept_name", "")
                concept.setdefault("concept_alias", [])
                concept.setdefault("concept_connotation", "")
                concept.setdefault("concept_boundary", "")
                concept.setdefault("source_paragraph", "")
        for chain in data.get("dialectical_logic_chain", []):
            if isinstance(chain, dict):
                chain.setdefault("theory_subject_a", "")
                chain.setdefault("theory_subject_b", "")
                chain.setdefault("logic_relation_type", "")
                chain.setdefault("causal_background", "")
                chain.setdefault("dialectical_content", "")
                chain.setdefault("source_paragraph", "")
        return data

    def _get_empty_distill(self) -> Dict:
        return self._validate_json_fields({})

    def process_literature(self, folder_path: Path) -> bool:
        folder_name = folder_path.name
        logger.info(f"📖 蒸馏文献: {folder_name}")

        content, valid = self.read_literature_files(folder_path)
        if not valid:
            logger.warning(f"   ⚠️ 文件无效，跳过该文献")
            return False

        existing = self.neo4j.execute_query(
            "MATCH (ep:Episode {source_folder: $f})-[:DISTILL_FROM]->(ld:LiteratureDistill) RETURN ld.id as id",
            {"f": folder_name}
        )
        if existing:
            logger.info(f"   ⏭️ 已存在蒸馏节点，跳过")
            return True

        original_text = content.get("原文", "")
        if len(original_text) > 3000:
            logger.info("   📄 原文超长，按章节分段蒸馏...")
            chunks = split_markdown_by_chapter(original_text, max_chars=3000)
            chunk_results = []
            for i, chunk in enumerate(chunks):
                logger.info(f"   处理分段 {i+1}/{len(chunks)}")
                chunk_content = content.copy()
                chunk_content["原文"] = chunk
                chunk_results.append(self.call_deepseek_distill(chunk_content, folder_name))
            distill_data = merge_distill_results(chunk_results)
        else:
            distill_data = self.call_deepseek_distill(content, folder_name)

        distill_id = self._create_distill_node(folder_name, distill_data)
        if not distill_id:
            logger.error("   ❌ 蒸馏节点创建失败")
            return False

        self.neo4j.execute_write(
            "MATCH (ep:Episode {source_folder: $f}) MATCH (ld:LiteratureDistill {id: $did}) MERGE (ld)-[:DISTILL_FROM]->(ep)",
            {"f": folder_name, "did": distill_id}
        )
        self._link_to_entities(distill_id, distill_data)
        self._vectorize_distill(distill_id, content, distill_data)

        logger.info(f"   ✅ 蒸馏完成: {distill_id}")
        return True

    def _create_distill_node(self, folder_name: str, data: Dict) -> str:
        distill_id = f"distill_{folder_name}_{int(time.time())}"
        self.neo4j.execute_write("""
        CREATE (ld:LiteratureDistill {
            id: $id, source_folder: $folder_name,
            core_concept_definition: $ccd, theoretical_system_and_innovation: $tsi,
            analysis_paradigm_and_interpretation: $api, dialectical_logic_chain: $dlc,
            theoretical_limitation_and_expansion: $tle, vectorized: false, created_at: datetime()
        })
        """, {
            "id": distill_id, "folder_name": folder_name,
            "ccd": json.dumps(data.get("core_concept_definition", []), ensure_ascii=False),
            "tsi": json.dumps(data.get("theoretical_system_and_innovation", {}), ensure_ascii=False),
            "api": json.dumps(data.get("analysis_paradigm_and_interpretation", {}), ensure_ascii=False),
            "dlc": json.dumps(data.get("dialectical_logic_chain", []), ensure_ascii=False),
            "tle": json.dumps(data.get("theoretical_limitation_and_expansion", {}), ensure_ascii=False)
        })
        return distill_id

    def _link_to_entities(self, distill_id: str, data: Dict):
        concepts = []
        for concept in data.get("core_concept_definition", []):
            name = concept.get("concept_name", "")
            if name:
                concepts.append(name)
                concepts.extend(concept.get("concept_alias", []))
        concepts = list(set(concepts))
        linked = 0
        for concept_name in concepts:
            try:
                self.neo4j.execute_write(
                    "MATCH (e:Entity) WHERE e.name = $cn OR $cn IN e.aliases "
                    "MATCH (ld:LiteratureDistill {id: $did}) MERGE (ld)-[:CORRESPONDS_TO]->(e)",
                    {"cn": concept_name, "did": distill_id}
                )
                linked += 1
            except Exception:
                pass
        if linked > 0:
            logger.info(f"   linked={linked}")
        else:
            logger.info(f"   linked=0 (no matching entities)")

    def _vectorize_distill(self, distill_id: str, content: Dict, distill_data: Dict):
        distill_text = (
            f"[LiteratureDistill] core_concepts: {[c['concept_name'] for c in distill_data['core_concept_definition']]} "
            f"theory: {distill_data['theoretical_system_and_innovation']['rely_on_theory']} "
            f"paradigm: {distill_data['analysis_paradigm_and_interpretation']['analysis_framework']}"
        )
        vec = self.qwen.embed(distill_text)
        if vec:
            self.neo4j.execute_write(
                "MATCH (ld:LiteratureDistill {id: $id}) SET ld.distill_vector = $v, ld.vectorized = true",
                {"id": distill_id, "v": json.dumps(vec)}
            )


# ======================== 第二层：跨文献全局知识蒸馏 ========================
class DomainKnowledgeDistillation:
    VALID_LOGIC_RELATIONS = {"继承发展", "修正偏离", "创新拓展", "批判扬弃"}

    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn
        self.cache = TextCache()
        self.monitor = CostMonitor()
        self.deepseek = DeepSeekClient(cache=self.cache, monitor=self.monitor)
        self.qwen = QwenEmbeddingClient(cache=self.cache, monitor=self.monitor)
        self.total_tokens = 0
        self.total_cost = 0

    def get_unprocessed_domains(self) -> List[str]:
        """Return list of parent communities (一级领域) that need DomainKnowledge built"""
        query = """
        MATCH (c:Community)
        WHERE c.parent_community IS NOT NULL AND c.parent_community <> ''
        RETURN DISTINCT c.parent_community AS domain
        """
        domains = self.neo4j.execute_query(query)
        domain_names = sorted(set(d.get("domain") for d in domains if d.get("domain")))
        processed_q = "MATCH (dk:DomainKnowledge) RETURN dk.domain as domain"
        processed = self.neo4j.execute_query(processed_q)
        processed_domains = {p.get("domain") for p in processed}
        return [d for d in domain_names if d not in processed_domains]

    def collect_literature_distills(self, domain: str, limit: int = 100) -> List[Dict]:
        """Find LiteratureDistill nodes linked to entities in communities under this parent domain"""
        query = """
        MATCH (e:Entity)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: $domain})
        MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e)
        RETURN DISTINCT ld.id as id, ld.core_concept_definition as core_concepts,
               ld.theoretical_system_and_innovation as theory_system,
               ld.analysis_paradigm_and_interpretation as analysis_paradigm,
               ld.dialectical_logic_chain as logic_chain,
               ld.theoretical_limitation_and_expansion as limitations
        LIMIT 100
        """
        return self.neo4j.execute_query(query, {"domain": domain, "limit": limit})

    def process_domain(self, domain: str, incremental: bool = False) -> bool:
        logger.info(f"🏛️ 领域蒸馏: {domain} ({'增量更新' if incremental else '全量构建'})")

        distills = self.collect_literature_distills(domain, limit=50)
        if len(distills) < 2 and not incremental:
            logger.info(f"   ⏭️ 文献不足 (仅 {len(distills)} 篇)，跳过")
            return False

        distills_text = ""
        for idx, d in enumerate(distills):
            distills_text += f"### 文献 {idx+1}\n- 核心概念: {d.get('core_concepts', '')[:500]}\n- 理论创新: {d.get('theory_system', '')[:500]}\n- 逻辑链: {d.get('logic_chain', '')[:500]}\n"

        existing_data = None
        if incremental:
            res = self.neo4j.execute_query(
                "MATCH (dk:DomainKnowledge {domain: $d}) RETURN dk.standard_concepts as sc, dk.timeline as tl, "
                "dk.common_paradigm as cp, dk.consensus_and_controversy as cc ORDER BY dk.created_at DESC LIMIT 100",
                {"d": domain}
            )
            if res:
                existing_data = {
                    "standard_concepts": json.loads(res[0]["sc"]) if res[0]["sc"] else {},
                    "timeline": json.loads(res[0]["tl"]) if res[0]["tl"] else [],
                    "common_paradigm": json.loads(res[0]["cp"]) if res[0]["cp"] else {},
                    "consensus_and_controversy": json.loads(res[0]["cc"]) if res[0]["cc"] else {}
                }

        prompt = f"""
你是一位马理论领域资深学者，请对以下同领域文献进行跨文献全局知识蒸馏。

领域: {domain}
文献蒸馏集合: {distills_text}

输出四层全局领域知识结构JSON：
1. standard_concepts: classical_core, school_derivatives, era_practice_concepts, dialectical_pairs
2. timeline: 每个节点含 stage_name, start_year, end_year, key_events, core_theories, representatives, logic_relation（继承发展/修正偏离/创新拓展/批判扬弃）
3. common_paradigm: analysis_paradigms, practice_paths, critique_paths
4. consensus_and_controversy: consensus (含 content, level, support_ids), controversies (含 content, level, support_ids, oppose_ids)

强制约束：禁止理工科词汇，所有字段必须存在，时间线logic_relation严格使用四类。
"""
        if incremental and existing_data:
            prompt += f"\n旧有领域知识（增量融合到其中）：{json.dumps(existing_data, ensure_ascii=False)[:3000]}"

        domain_data = self.deepseek.call_json(prompt, max_retries=3, timeout=180)
        if domain_data is None:
            domain_data = self._get_empty_domain_distill()
        domain_data = self._validate_domain_fields(domain_data)
        self.total_tokens = self.monitor.total_input_tokens + self.monitor.total_output_tokens
        self.total_cost = self.monitor.total_cost

        # 先建新节点，再删旧节点（原子性修复）
        new_domain_id = self._create_domain_knowledge(domain, domain_data, distills)

        if incremental and existing_data:
            # 先确认新节点创建成功，再删除旧节点
            check = self.neo4j.execute_query(
                "MATCH (dk:DomainKnowledge {id: $id}) RETURN dk.id", {"id": new_domain_id}
            )
            if check:
                self.neo4j.execute_write(
                    "MATCH (dk:DomainKnowledge {domain: $d}) WHERE dk.id <> $new_id DETACH DELETE dk",
                    {"d": domain, "new_id": new_domain_id}
                )

        self._create_timeline_nodes(domain, domain_data.get("timeline", []))
        self._vectorize_domain(new_domain_id, domain_data)
        logger.info(f"   ✅ 领域蒸馏完成: {domain}")
        return True

    def _validate_domain_fields(self, data: Dict) -> Dict:
        defaults = {
            "standard_concepts": {"classical_core": [], "school_derivatives": [], "era_practice_concepts": [], "dialectical_pairs": []},
            "timeline": [],
            "common_paradigm": {"analysis_paradigms": [], "practice_paths": [], "critique_paths": []},
            "consensus_and_controversy": {"consensus": [], "controversies": []}
        }
        for k, v in defaults.items():
            if k not in data:
                data[k] = v
            elif isinstance(v, dict):
                for kk, vv in v.items():
                    if kk not in data[k]:
                        data[k][kk] = vv
        for item in data.get("timeline", []):
            if isinstance(item, dict):
                rel = item.get("logic_relation", "")
                if rel not in self.VALID_LOGIC_RELATIONS:
                    item["logic_relation"] = "继承发展"
                item.setdefault("stage_name", "")
                item.setdefault("start_year", 0)
                item.setdefault("end_year", 0)
                item.setdefault("key_events", [])
                item.setdefault("core_theories", [])
                item.setdefault("representatives", [])
        return data

    def _get_empty_domain_distill(self) -> Dict:
        return self._validate_domain_fields({})

    def _create_domain_knowledge(self, domain: str, data: Dict, distills: List[Dict]) -> str:
        domain_id = f"domain_{domain}_{int(time.time())}"
        source_ids = [d.get("id") for d in distills if d.get("id")]
        self.neo4j.execute_write("""
        CREATE (dk:DomainKnowledge {
            id: $id, domain: $domain, standard_concepts: $sc, timeline: $tl,
            common_paradigm: $cp, consensus_and_controversy: $cc,
            source_distill_ids: $source_ids, distilled_count: $count,
            vectorized: false, created_at: datetime()
        })
        """, {
            "id": domain_id, "domain": domain,
            "sc": json.dumps(data.get("standard_concepts", {}), ensure_ascii=False),
            "tl": json.dumps(data.get("timeline", []), ensure_ascii=False),
            "cp": json.dumps(data.get("common_paradigm", {}), ensure_ascii=False),
            "cc": json.dumps(data.get("consensus_and_controversy", {}), ensure_ascii=False),
            "source_ids": source_ids, "count": len(source_ids)
        })
        for distill_id in source_ids:
            self.neo4j.execute_write(
                "MATCH (ld:LiteratureDistill {id: $di}) MATCH (dk:DomainKnowledge {id: $did}) MERGE (ld)-[:AGGREGATED_INTO]->(dk)",
                {"di": distill_id, "did": domain_id}
            )
        return domain_id

    def _create_timeline_nodes(self, domain: str, timeline_items: List[Dict]):
        self.neo4j.execute_write("MATCH (tn:TimelineNode {domain: $d}) DETACH DELETE tn", {"d": domain})
        for item in timeline_items:
            try:
                self.neo4j.execute_write("""
                CREATE (tn:TimelineNode {
                    domain: $domain, stage_name: $stage_name, start_year: $start_year, end_year: $end_year,
                    key_events: $key_events, core_theories: $core_theories,
                    representatives: $representatives, logic_relation: $logic_relation, created_at: datetime()
                })
                """, {
                    "domain": domain, "stage_name": item.get("stage_name", ""),
                    "start_year": item.get("start_year", 0), "end_year": item.get("end_year", 0),
                    "key_events": item.get("key_events", []), "core_theories": item.get("core_theories", []),
                    "representatives": item.get("representatives", []), "logic_relation": item.get("logic_relation", "继承发展")
                })
            except Exception as e:
                logger.warning(f"   ⚠️ 时间线节点创建失败: {e}")
        logger.info(f"   📅 创建时间线节点 {len(timeline_items)} 个")

    def _vectorize_domain(self, domain_id: str, domain_data: Dict):
        text = f"【领域知识】{domain_id} 核心概念：{domain_data['standard_concepts']['classical_core']} 研究范式：{domain_data['common_paradigm']['analysis_paradigms']}"
        vec = self.qwen.embed(text)
        if vec:
            self.neo4j.execute_write(
                "MATCH (dk:DomainKnowledge {id: $id}) SET dk.domain_vector = $v, dk.vectorized = true",
                {"id": domain_id, "v": json.dumps(vec)}
            )
            logger.info("   🧮 领域向量化完成")


# ======================== 增量蒸馏机制 ========================
class IncrementalDistillation:
    def __init__(self, neo4j_conn: Neo4jConnection):
        self.neo4j = neo4j_conn

    def get_unmerged_literatures(self) -> List[str]:
        query = """
        MATCH (ld:LiteratureDistill)
        WHERE NOT (ld)-[:AGGREGATED_INTO]->(:DomainKnowledge)
        RETURN ld.source_folder as folder
        """
        res = self.neo4j.execute_query(query)
        return [item.get("folder") for item in res if item.get("folder")]

    def merge_new_literature(self, folder_name: str) -> bool:
        query = """
        MATCH (ep:Episode {source_folder: $f})
        MATCH (ld:LiteratureDistill)-[:DISTILL_FROM]->(ep)
        MATCH (ld)-[:CORRESPONDS_TO]->(e:Entity)
        MATCH (e)-[:BELONGS_TO_COMMUNITY]->(c:Community)
        WHERE c.level = '一级'
        RETURN DISTINCT c.community_id as domain
        """
        domains = self.neo4j.execute_query(query, {"f": folder_name})
        if not domains:
            return False

        domain_engine = DomainKnowledgeDistillation(self.neo4j)
        for d in domains:
            domain = d.get("domain")
            if domain:
                domain_engine.process_domain(domain, incremental=True)
        return True

    def run_all_incremental(self) -> int:
        unmerged = self.get_unmerged_literatures()
        if not unmerged:
            logger.info("✅ 无新增文献需要合并")
            return 0
        logger.info(f"📌 发现 {len(unmerged)} 篇未合并文献，执行增量蒸馏...")
        success = 0
        for folder in unmerged:
            if self.merge_new_literature(folder):
                success += 1
        return success


# ======================== 主流程 ========================
def main():
    logger.info("=" * 80)
    logger.info(f"模块4：双层知识蒸馏 | 运行环境: {RUN_ENV}")
    logger.info("=" * 80)

    if not api_health_check():
        logger.error("❌ API预检未通过，终止执行")
        return

    neo4j_conn = Neo4jConnection()
    logger.info("✅ Neo4j连接成功")

    # 第一层：单文献蒸馏
    logger.info("\n" + "=" * 60)
    logger.info("第一层：单文献蒸馏 LiteratureDistill")
    logger.info("=" * 60)

    distill_engine = LiteratureDistillation(neo4j_conn)
    folders = [f for f in BASE_PATH.iterdir() if f.is_dir() and not f.name.startswith('.')]

    checkpoint_file = CHECKPOINT_DIR / "module4_distill_state.json"
    processed_folders = []
    if checkpoint_file.exists():
        with open(checkpoint_file, 'r', encoding='utf-8') as f:
            processed_folders = json.load(f).get("processed_folders", [])
        logger.info(f"📌 从断点恢复：已蒸馏 {len(processed_folders)} 篇")

    success_count = 0
    for folder in folders:
        if folder.name in processed_folders:
            logger.info(f"⏭️ 跳过已蒸馏: {folder.name}")
            continue
        if distill_engine.process_literature(folder):
            processed_folders.append(folder.name)
            success_count += 1
            with open(checkpoint_file, 'w', encoding='utf-8') as f:
                json.dump({"processed_folders": processed_folders}, f, ensure_ascii=False, indent=2)

    logger.info(f"✅ 单文献蒸馏完成，本次新增 {success_count} 篇，累计 {len(processed_folders)} 篇")

    # 第二层：跨文献全局知识蒸馏
    logger.info("\n" + "=" * 60)
    logger.info("第二层：跨文献全局知识蒸馏 DomainKnowledge")
    logger.info("=" * 60)

    domain_engine = DomainKnowledgeDistillation(neo4j_conn)
    domains = domain_engine.get_unprocessed_domains()

    if domains:
        logger.info(f"📊 发现 {len(domains)} 个待构建领域")
        checkpoint_domain_file = CHECKPOINT_DIR / "module4_domain_state.json"
        processed_domains = []
        if checkpoint_domain_file.exists():
            with open(checkpoint_domain_file, 'r', encoding='utf-8') as f:
                processed_domains = json.load(f).get("processed_domains", [])
        domain_success = 0
        for domain in domains:
            if domain in processed_domains:
                continue
            if domain_engine.process_domain(domain):
                processed_domains.append(domain)
                domain_success += 1
                with open(checkpoint_domain_file, 'w', encoding='utf-8') as f:
                    json.dump({"processed_domains": processed_domains}, f, ensure_ascii=False, indent=2)
        logger.info(f"✅ 领域知识构建完成，本次新增 {domain_success} 个领域")
    else:
        logger.info("✅ 所有领域均已构建，执行增量更新")

    # 增量蒸馏
    logger.info("\n" + "=" * 60)
    logger.info("增量蒸馏更新")
    logger.info("=" * 60)
    incremental_engine = IncrementalDistillation(neo4j_conn)
    incremental_engine.run_all_incremental()

    # 统计
    logger.info("\n" + "=" * 60)
    logger.info("📊 执行统计")
    distill_count = neo4j_conn.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) as count")[0].get("count", 0)
    domain_count = neo4j_conn.execute_query("MATCH (dk:DomainKnowledge) RETURN count(dk) as count")[0].get("count", 0)
    timeline_count = neo4j_conn.execute_query("MATCH (tn:TimelineNode) RETURN count(tn) as count")[0].get("count", 0)
    total_tokens = distill_engine.total_tokens + domain_engine.total_tokens
    total_cost = distill_engine.total_cost + domain_engine.total_cost

    logger.info(f"   📄 单篇蒸馏节点: {distill_count}")
    logger.info(f"   🏛️ 领域知识节点: {domain_count}")
    logger.info(f"   📅 时间线节点: {timeline_count}")
    logger.info(f"   💳 总Token消耗: {total_tokens}")
    logger.info(f"   💰 预估总费用: ${total_cost:.6f}")

    distill_engine.cache.close()
    neo4j_conn.close()
    logger.info("\n✅ 模块4全部执行完成")


if __name__ == "__main__":
    main()
