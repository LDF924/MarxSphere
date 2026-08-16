#!/usr/bin/env python3
"""
端到端冒烟测试：5篇文献
直接用 os.listdir 枚举文件夹和文件（绕过终端编码问题）
"""

import sys, json, time, os
from pathlib import Path
sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, DeepSeekClient

logger = get_logger("e2e_test")

BASE_DIR = Path(r"D:\Desktop\ov_import")

# ── 枚举有效文件夹 ──
MD_KEYS = ["original", "术语", "问答", "摘要"]  # 关键词匹配
all_folders = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])

valid = []
for folder in all_folders:
    md_names = [f.name for f in folder.glob("*.md")]
    if all(any(k in n for n in md_names) for k in MD_KEYS):
        valid.append(folder)
    if len(valid) >= 5:
        break

print(f"Valid folders found: {len(valid)}")
for i, f in enumerate(valid):
    md_list = [x.name for x in f.glob("*.md")]
    print(f"  {i+1}. {f.name}")
    for m in md_list:
        print(f"     - {m}")

# ── Neo4j ──
neo4j = Neo4jConnection()
print("\nOK - Neo4j connected")

# ── DeepSeek ──
ds = DeepSeekClient()

# ── 单文献处理 ──
ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

ENTITY_SCHEMA = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}, "category": {"type": "string"},
                    "subcategory": {"type": "string"}, "level": {"type": "string"},
                    "description": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}},
                    "context": {"type": "string"}
                },
                "required": ["name", "category", "description"]
            }
        }
    }
}

RELATION_SCHEMA = {
    "type": "object",
    "properties": {
        "relations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"}, "relation_type": {"type": "string"},
                    "target": {"type": "string"}, "confidence": {"type": "number"},
                    "temporal_context": {"type": "string"}, "description": {"type": "string"}
                },
                "required": ["source", "relation_type", "target"]
            }
        }
    }
}

all_entity_names = []

for idx, folder in enumerate(valid):
    fname = folder.name
    print(f"\n── [{idx+1}/5] {fname} ──")

    # Read files by keyword matching
    md_files = {f.name: f.read_text(encoding="utf-8") for f in folder.glob("*.md")}
    texts = {}
    for key in ["original", "术语", "问答", "摘要"]:
        for name, content in md_files.items():
            if key in name:
                texts[key] = content[:6000]
                break

    # Episode
    neo4j.execute_write("""
        MERGE (ep:Episode {source_folder: $folder})
        SET ep.title = $title, ep.content = $abstract, ep.created_at = datetime()
    """, {"folder": fname, "title": fname, "abstract": texts.get("摘要", "")[:1000]})
    print(f"  OK Episode")

    # Entities
    prompt = f"""从以下哲社科文献中抽取实体节点。
规则：优先抽取核心范畴、核心理论，不抽取细碎短句与普通名词；区分一级概念与二级子概念。
实体归入十大分类：{ENTITY_CATEGORIES}

文献内容：
摘要：{texts.get('摘要', '')[:1000]}
术语：{texts.get('术语', '')[:1000]}
原文：{texts.get('原', '')[:2000]}
问答：{texts.get('问答', '')[:1000]}

输出严格JSON。"""

    result = ds.call_json(prompt, ENTITY_SCHEMA,
                          system_prompt="你是马克思主义理论领域知识抽取专家，严格按JSON格式输出。")
    entities = result.get("entities", []) if result else []
    print(f"  OK Entities: {len(entities)}")

    for ent in entities:
        name = ent.get("name", "")
        if not name:
            continue
        all_entity_names.append(name)
        neo4j.execute_write("""
            MERGE (e:Entity {name: $name})
            SET e.category = $category, e.subcategory = $subcategory,
                e.level = $level, e.description = $description,
                e.aliases = $aliases, e.context = $context,
                e.source_folder = $folder, e.created_at = datetime()
            WITH e MATCH (ep:Episode {source_folder: $folder})
            MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {"name": name, "category": ent.get("category",""), "subcategory": ent.get("subcategory",""),
              "level": ent.get("level",""), "description": ent.get("description",""),
              "aliases": ent.get("aliases",[]), "context": ent.get("context",""), "folder": fname})

    # Relations
    if len(entities) >= 2:
        ent_names = [e.get("name","") for e in entities if e.get("name")][:15]
        prompt2 = f"""基于实体列表抽取关系三元组。
类型：PROPOSED_BY、PUBLISHED_IN、INHERITS_FROM、CRITIQUES、DEVELOPS_INTO、LEAD_TO、BELONG_TO、CONTRAST_WITH
实体：{', '.join(ent_names)}
摘要：{texts.get('摘要', '')[:800]}
输出JSON。"""

        result2 = ds.call_json(prompt2, RELATION_SCHEMA,
                               system_prompt="你是马理论关系抽取专家。")
        relations = result2.get("relations", []) if result2 else []
        print(f"  OK Relations: {len(relations)}")

        for rel in relations:
            src, tgt = rel.get("source",""), rel.get("target","")
            if not src or not tgt:
                continue
            neo4j.execute_write("""
                MATCH (s:Entity {name: $source})
                MATCH (t:Entity {name: $target})
                MERGE (s)-[r:RELATION {type: $relation_type}]->(t)
                SET r.confidence = $confidence, r.temporal_context = $tc,
                    r.description = $desc, r.source_folder = $folder, r.created_at = datetime()
            """, {"source": src, "target": tgt, "relation_type": rel.get("relation_type",""),
                  "confidence": rel.get("confidence",0.8), "tc": rel.get("temporal_context",""),
                  "desc": rel.get("description",""), "folder": fname})

# ── 全局：消歧 ──
print("\n" + "=" * 50)
print("PHASE 2: Disambiguation")
entities_db = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as name, e.description as description, e.category as category")
e_list = [row for row in entities_db[0]] if entities_db[0] else []
print(f"Entities: {len(e_list)}")

if len(e_list) >= 2:
    prompt3 = f"""实体消歧：同义合并+同名异义拆分。
实体列表（{len(e_list)}个）：
{json.dumps(e_list[:40], ensure_ascii=False, indent=1)}

输出JSON：{{"merge_groups": [{{"canonical_name": "标准名", "aliases": ["别名"], "disambiguation_confidence": 0.95}}], "split_groups": []}}"""
    r3 = ds.call_json(prompt3, system_prompt="你是实体消歧专家。")
    if r3:
        for g in r3.get("merge_groups", []):
            canonical = g.get("canonical_name","")
            if canonical:
                neo4j.execute_write("MERGE (c:Entity {name: $n}) SET c.is_canonical = true", {"n": canonical})
                for alias in g.get("aliases", []):
                    neo4j.execute_write("""
                        MATCH (a:Entity {name: $alias})
                        MATCH (c:Entity {name: $canonical})
                        OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity
                        FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END |
                            MERGE (c)-[:RELATION {type: type(r)}]->(n)
                        )
                        DETACH DELETE a
                    """, {"alias": alias, "canonical": canonical})
        print(f"  Merges: {len(r3.get('merge_groups',[]))} / Splits: {len(r3.get('split_groups',[]))}")

# ── 全局：冲突 ──
print("\n" + "=" * 50)
print("PHASE 3: Conflict Detection")
cd = neo4j.execute_query("""
    MATCH (e:Entity)-[r:RELATION]-(rel:Entity)
    RETURN e.name as entity, collect(DISTINCT {type: type(r), target: rel.name}) as relations,
           collect(DISTINCT e.source_folder) as folders LIMIT 20
""")
c_list = cd[0] if (cd and cd[0]) else []
print(f"Conflict candidates: {len(c_list)}")

if len(c_list) >= 3:
    r4 = ds.call_json(f"时序冲突校验。数据：{json.dumps(c_list, ensure_ascii=False, indent=1)[:3000]}\n输出JSON：{{\"conflicts\": [{{\"concept\":\"...\",\"conflict_level\":\"...\",\"description\":\"...\"}}]}}")
    if r4:
        for cf in r4.get("conflicts", []):
            neo4j.execute_write("CREATE (c:Conflict {concept: $c, conflict_level: $l, description: $d, created_at: datetime()}) WITH c MATCH (e:Entity {name: $c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                               {"c": cf.get("concept",""), "l": cf.get("conflict_level",""), "d": cf.get("description","")})
        print(f"  Conflicts: {len(r4.get('conflicts',[]))}")

# ── 全局：聚类 ──
print("\n" + "=" * 50)
print("PHASE 4: Clustering")
ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as name, e.category as category, e.description as description")
c_entities = ce[0] if (ce and ce[0]) else []
print(f"Entities to cluster: {len(c_entities)}")

if len(c_entities) >= 5:
    r5 = ds.call_json(f"""按二级体系聚类。一级：马哲、政治经济学、科学社会主义、马理论中国化、西方马克思主义、思想史
实体：{json.dumps(c_entities[:25], ensure_ascii=False, indent=1)}
输出JSON：{{"clusters": [{{"community_id": "马哲-唯物史观", "level": "二级", "parent_community": "马哲", "entities": ["..."]}}]}}""",
                      system_prompt="你是领域聚类专家。")
    if r5:
        for cl in r5.get("clusters", []):
            cid = cl.get("community_id","")
            if not cid:
                continue
            neo4j.execute_write("MERGE (c:Community {community_id: $cid}) SET c.level = $l, c.parent_community = $p, c.created_at = datetime()",
                               {"cid": cid, "l": cl.get("level","二级"), "p": cl.get("parent_community","")})
            for en in cl.get("entities", []):
                try:
                    neo4j.execute_write("MATCH (e:Entity {name: $n}) MATCH (c:Community {community_id: $cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                       {"n": en, "cid": cid})
                except:
                    pass
        print(f"  Clusters: {len(r5.get('clusters',[]))}")

# ── 统计 ──
print("\n" + "=" * 50)
print("DATABASE STATS")
for label, query in [("Entities","MATCH (e:Entity) RETURN count(e) as c"),
    ("Relations","MATCH ()-[r:RELATION]->() RETURN count(r) as c"),
    ("Episodes","MATCH (ep:Episode) RETURN count(ep) as c"),
    ("Conflicts","MATCH (c:Conflict) RETURN count(c) as c"),
    ("Communities","MATCH (c:Community) RETURN count(c) as c")]:
    records, _, _ = neo4j.execute_query(query)
    print(f"  {label}: {records[0]['c']}")

neo4j.close()
print("\nDONE!")
