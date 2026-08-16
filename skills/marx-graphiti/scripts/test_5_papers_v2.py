#!/usr/bin/env python3
"""
端到端冒烟测试 v2：5篇文献
修复：关系写入、JSON重试、实体字段完整性
"""

import sys, json, time, os
from pathlib import Path
from collections import Counter

sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, DeepSeekClient

logger = get_logger("e2e_v2")

BASE_DIR = Path(r"D:\Desktop\ov_import")
neo4j = Neo4jConnection()
ds = DeepSeekClient()

# ── 枚举文献 ──
MD_KEYS = ["original", "术语", "问答", "摘要"]
all_folders = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])
valid = []
for folder in all_folders:
    md_names = [f.name for f in folder.glob("*.md")]
    if all(any(k in n for n in md_names) for k in MD_KEYS):
        valid.append(folder)
    if len(valid) >= 5:
        break
logger.info(f"Valid folders: {len(valid)}")

# ── 强化的实体抽取 schema ──
ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

ENTITY_SCHEMA = {
    "type": "object",
    "required": ["entities"],
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "category", "description", "level", "subcategory", "context"],
                "properties": {
                    "name": {"type": "string", "description": "实体标准名称"},
                    "category": {"type": "string", "description": "必须从十大分类中选择"},
                    "subcategory": {"type": "string"},
                    "level": {"type": "string", "description": "必须填写：一级概念 或 二级子概念"},
                    "description": {"type": "string", "description": "必须填写实体的核心释义，不少于10字"},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                    "context": {"type": "string", "description": "文献中出现语境"}
                }
            }
        }
    }
}

ENTITY_EXAMPLE = {
    "entities": [
        {
            "name": "唯物史观",
            "category": "理论概念",
            "subcategory": "基础理论学说",
            "level": "一级概念",
            "description": "社会存在决定社会意识的历史唯物主义核心理论，是马克思主义哲学的理论基石",
            "aliases": ["历史唯物主义", "唯物主义历史观"],
            "context": "马克思在《政治经济学批判》序言中系统阐述"
        },
        {
            "name": "社会存在决定社会意识",
            "category": "理论概念",
            "subcategory": "核心命题",
            "level": "二级子概念",
            "description": "唯物史观的基本命题，指物质生活的生产方式制约着整个社会生活、政治生活和精神生活的过程",
            "aliases": [],
            "context": "作为唯物史观的核心原理被反复引用"
        }
    ]
}

# ── 处理 ──
total_entities = 0
total_relations = 0
relation_stats = Counter()

for idx, folder in enumerate(valid):
    fname = folder.name
    logger.info(f"[{idx+1}/5] {fname}")

    # Read files
    md_files = {f.name: f.read_text(encoding="utf-8") for f in folder.glob("*.md")}
    texts = {}
    for key in ["original", "术语", "问答", "摘要"]:
        for name, content in md_files.items():
            if key in name:
                texts[key] = content[:8000]
                break

    # ── Episode ──
    neo4j.execute_write("""
        MERGE (ep:Episode {source_folder: $f})
        SET ep.title = $t, ep.content = $c, ep.created_at = datetime()
    """, {"f": fname, "t": fname, "c": texts.get("摘要", "")[:2000]})

    # ── 实体抽取（JSON重试最多3次，每次都追加格式约束）──
    base_prompt = f"""从以下文献中抽取实体节点，严格遵守所有字段约束。

【字段约束 - 极其重要】
- name: 实体标准名称（必填）
- category: 必须从十大分类中选择：{ENTITY_CATEGORIES}（必填）
- level: 必须填写"一级概念"或"二级子概念"（必填）
- description: 必须填写实体核心释义，不少于15字（必填）
- aliases: 别名列表，无则填空数组[]
- subcategory: 细分小类（必填）
- context: 出现语境（必填）

【内容约束】
- 优先抽取核心范畴、核心理论，不抽取过细短句与普通名词
- 每个实体每个字段都不得为空

文献内容：
摘要：{texts.get('摘要', '')[:1500]}
术语：{texts.get('术语', '')[:1500]}
原文：{texts.get('original', '')[:3000]}
问答：{texts.get('问答', '')[:1000]}"""

    entities = []
    for retry in range(3):
        prompt = base_prompt
        if retry > 0:
            prompt += f"\n\n【第{retry+1}次重试 - 上一次输出格式不符合要求】请务必为每个实体填写完整的category、level、description、subcategory、context字段。空字符串、缺失字段都是不可接受的。"

        result = ds.call_json(prompt, ENTITY_SCHEMA,
                              system_prompt="你是马克思主义理论领域知识抽取专家。严格按JSON Schema输出，所有字段必填，空值用空数组[]或空字符串，禁止省略任何键名。",
                              max_retries=2)
        if isinstance(result, dict) and result.get("entities"):
            entities = result["entities"]
            break
        elif isinstance(result, list):
            logger.warning(f"  重试 {retry+1}/3: LLM 返回了数组而非对象, retrying...")
        logger.warning(f"  重试 {retry+1}/3: 实体为空, retrying...")

    logger.info(f"  Entities: {len(entities)}")
    total_entities += len(entities)

    # Write entities to Neo4j
    for ent in entities:
        name = ent.get("name", "")
        if not name:
            continue
        neo4j.execute_write("""
            MERGE (e:Entity {name: $name})
            SET e.category = $cat, e.subcategory = $sub, e.level = $lvl,
                e.description = $desc, e.aliases = $aliases, e.context = $ctx,
                e.source_folder = $f, e.created_at = datetime()
            WITH e MATCH (ep:Episode {source_folder: $f})
            MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {
            "name": name, "cat": ent.get("category", ""), "sub": ent.get("subcategory", ""),
            "lvl": ent.get("level", ""), "desc": ent.get("description", ""),
            "aliases": ent.get("aliases", []), "ctx": ent.get("context", ""), "f": fname
        })

    # ── 关系抽取 ──
    if len(entities) >= 2:
        ent_names = [e.get("name", "") for e in entities if e.get("name")][:15]

        rel_prompt = f"""基于以下实体列表和文献内容，抽取实体间的逻辑关系三元组。

有效关系类型（必须严格使用以下8种之一）：PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH

已知实体：{', '.join(ent_names)}
文献摘要：{texts.get('摘要', '')[:1000]}
原文前段：{texts.get('original', '')[:2000]}

每条关系必须填写：
- source: 主体实体（必填）
- relation_type: 关系类型（必填，从上述8种中选择）
- target: 客体实体（必填）
- confidence: 置信度0-1（必填）
- temporal_context: 时序背景（必填）
- description: 关系说明（必填，不少于10字）

输出严格JSON。"""

        REL_SCHEMA = {
            "type": "object", "required": ["relations"],
            "properties": {
                "relations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["source", "relation_type", "target", "confidence", "description"],
                        "properties": {
                            "source": {"type": "string"}, "relation_type": {"type": "string"},
                            "target": {"type": "string"}, "confidence": {"type": "number"},
                            "temporal_context": {"type": "string"}, "description": {"type": "string"}
                        }
                    }
                }
            }
        }

        rel_result = ds.call_json(rel_prompt, REL_SCHEMA,
                                  system_prompt="你是马理论领域关系抽取专家，严格按JSON输出。",
                                  max_retries=2)
        relations = rel_result.get("relations", []) if rel_result else []

        for rel in relations:
            src, tgt, rtype = rel.get("source", ""), rel.get("target", ""), rel.get("relation_type", "")
            if not src or not tgt or not rtype:
                continue
            # Use session directly to create the relationship by TYPE (not property)
            with neo4j.driver.session() as s:
                s.run(f"""
                    MATCH (a:Entity {{name: $src}})
                    MATCH (b:Entity {{name: $tgt}})
                    MERGE (a)-[r:{rtype} {{source_folder: $f}}]->(b)
                    SET r.confidence = $conf, r.temporal_context = $tc,
                        r.description = $desc, r.created_at = datetime()
                """, {"src": src, "tgt": tgt, "f": fname,
                      "conf": rel.get("confidence", 0.8),
                      "tc": rel.get("temporal_context", ""),
                      "desc": rel.get("description", "")})
            relation_stats[rtype] += 1
            total_relations += 1

        logger.info(f"  Relations: {len(relations)}")
    else:
        logger.info("  Relations: skipped (< 2 entities)")

# ── 全局消歧 ──
logger.info("=== Global: Disambiguation ===")
entities_db = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as name, e.description as desc, e.category as cat")
logger.info(f"Entities: {len(entities_db)}")

if len(entities_db) >= 4:
    prompt = f"""实体消歧：同义合并 + 同名异义拆分。
实体列表（{len(entities_db)}个）：
{json.dumps(entities_db[:50], ensure_ascii=False, indent=1)}

输出JSON：{{"merge_groups": [{{"canonical_name": "标准名", "aliases": ["别名"], "disambiguation_confidence": 0.95}}], "split_groups": []}}"""
    r = ds.call_json(prompt, system_prompt="你是实体消歧专家。")
    if r:
        for g in r.get("merge_groups", []):
            canonical = g.get("canonical_name", "")
            if not canonical:
                continue
            neo4j.execute_write("MERGE (e:Entity {name: $n}) SET e.is_canonical = true", {"n": canonical})
            for alias in g.get("aliases", []):
                neo4j.execute_write("""
                    MATCH (a:Entity {name: $alias})
                    MATCH (c:Entity {name: $canonical})
                    OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity
                    FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END |
                        MERGE (c)-[nr:RELATION]->(n)
                        SET nr = properties(r)
                    )
                    DETACH DELETE a
                """, {"alias": alias, "canonical": canonical})
        logger.info(f"  Merges: {len(r.get('merge_groups',[]))}, Splits: {len(r.get('split_groups',[]))}")

# ── 冲突检测 ──
logger.info("=== Global: Conflict Detection ===")
conflict_data = neo4j.execute_query("""
    MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->() IS NULL
    OPTIONAL MATCH (e)-[r]->(other:Entity)
    RETURN e.name as entity, e.source_folder as folder,
           collect(DISTINCT {type: type(r), target: other.name}) as rels
    LIMIT 30
""")
conflict_candidates = [row for row in conflict_data if row.get("rels") and any(r.get("type") for r in row["rels"])]
logger.info(f"Candidates: {len(conflict_candidates)}")

if len(conflict_candidates) >= 3:
    r = ds.call_json(f"时序冲突校验。数据：{json.dumps(conflict_candidates, ensure_ascii=False, indent=1)[:3000]}。输出JSON：{{\"conflicts\": [{{\"concept\":\"...\",\"conflict_level\":\"...\",\"description\":\"...\"}}]}}")
    if r:
        for cf in r.get("conflicts", []):
            neo4j.execute_write("""
                CREATE (c:Conflict {concept: $c, conflict_level: $l, description: $d, created_at: datetime()})
                WITH c MATCH (e:Entity {name: $c}) MERGE (e)-[:HAS_CONFLICT]->(c)
            """, {"c": cf.get("concept",""), "l": cf.get("conflict_level",""), "d": cf.get("description","")})
        logger.info(f"  Conflicts: {len(r.get('conflicts',[]))}")

# ── 社区聚类 ──
logger.info("=== Global: Clustering ===")
cluster_entities = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as name, e.category as cat, e.description as desc")
logger.info(f"Entities: {len(cluster_entities)}")

if len(cluster_entities) >= 5:
    r = ds.call_json(f"""按二级体系聚类。一级：马哲、政治经济学、科学社会主义、马理论中国化、西方马克思主义、思想史
实体：{json.dumps(cluster_entities[:30], ensure_ascii=False, indent=1)}
输出JSON：{{"clusters": [{{"community_id": "马哲-唯物史观", "level": "二级", "entities": ["..."]}}]}}""",
                     system_prompt="你是领域聚类专家。")
    if r:
        for cl in r.get("clusters", []):
            cid = cl.get("community_id", "")
            if not cid:
                continue
            neo4j.execute_write("MERGE (c:Community {community_id: $cid}) SET c.level = $l, c.created_at = datetime()",
                               {"cid": cid, "l": cl.get("level", "二级")})
            for en in cl.get("entities", []):
                neo4j.execute_write("MATCH (e:Entity {name: $n}) MATCH (c:Community {community_id: $cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                   {"n": en, "cid": cid})
        logger.info(f"  Clusters: {len(r.get('clusters',[]))}")

# ── 统计 ──
logger.info("=== Final Stats ===")
for label, query in [
    ("Entities", "MATCH (e:Entity) RETURN count(e) as c"),
    ("Relations", "MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c"),
    ("Episodes", "MATCH (ep:Episode) RETURN count(ep) as c"),
    ("Conflicts", "MATCH (c:Conflict) RETURN count(c) as c"),
    ("Communities", "MATCH (c:Community) RETURN count(c) as c"),
]:
    r = neo4j.execute_query(query)
    logger.info(f"  {label}: {r[0]['c']}")

logger.info(f"Relation types: {dict(relation_stats)}")

# ── 质量检查 ──
empty_desc = neo4j.execute_query("MATCH (e:Entity) WHERE e.description IS NULL OR e.description = '' RETURN count(e) as c")
empty_cat = neo4j.execute_query("MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN count(e) as c")
empty_lvl = neo4j.execute_query("MATCH (e:Entity) WHERE e.level IS NULL OR e.level = '' RETURN count(e) as c")
total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
logger.info(f"Quality: missing_desc={empty_desc[0]['c']}/{total_e}, missing_cat={empty_cat[0]['c']}/{total_e}, missing_level={empty_lvl[0]['c']}/{total_e}")

neo4j.close()
logger.info("DONE!")
