#!/usr/bin/env python3
"""
Qwen3.7-Max 完整流水线 v3：
修复关系类型限制（8种固定英文名 + 中文说明），清空数据库重跑5篇
"""
import sys, json, os, subprocess, time
from pathlib import Path
from collections import Counter
sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("qwen_full")
neo4j = Neo4jConnection()
llm = QwenMaxClient()

logger.info("DB connected (NOT clearing existing data)")

BASE_DIR = Path(r"D:\Desktop\ov_import")
MD_KEYS = ["original", "术语", "问答", "摘要"]

# 枚举
all_folders = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])
valid = [f for f in all_folders if all(any(k in n for n in [x.name for x in f.glob("*.md")]) for k in MD_KEYS)][:5]
logger.info(f"Papers: {len(valid)}")

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

# 关系类型：给中文说明
REL_TYPES_CN = {
    "PROPOSED_BY": "提出者（某人/某著作提出了某理论）",
    "PUBLISHED_IN": "载于著作（某理论发表于某经典著作）",
    "INHERITS_FROM": "继承发展（某理论继承自前人理论）",
    "CRITIQUES": "批判（某人对某理论持批判态度）",
    "DEVELOPS_INTO": "发展为（某理论后续发展为某新理论）",
    "LEAD_TO": "导致/带来（某行为/现象导致某后果）",
    "BELONG_TO": "从属/归属（某概念属于某更大范畴）",
    "CONTRAST_WITH": "对立（两概念存在理论对立关系）",
}
REL_TYPES_HELP = "\n".join([f"- {k}: {v}" for k, v in REL_TYPES_CN.items()])

relation_stats = Counter()

for idx, folder in enumerate(valid):
    fname = folder.name
    logger.info(f"[{idx+1}/5] {fname}")

    md_files = {f.name: f.read_text(encoding="utf-8") for f in folder.glob("*.md")}
    texts = {}
    for key in ["original", "术语", "问答", "摘要"]:
        for name, content in md_files.items():
            if key in name:
                texts[key] = content[:8000]
                break

    # ── Episode ──
    neo4j.execute_write("MERGE (ep:Episode {source_folder: $f}) SET ep.title=$t, ep.content=$c, ep.created_at=datetime()",
                       {"f": fname, "t": fname, "c": texts.get("摘要","")[:2000]})

    # ── 实体抽取 ──
    prompt_e = f"""从以下马理论文献中抽取实体节点。

【十大分类】{ENTITY_CATEGORIES}

【规则】优先核心范畴与核心理论；区分为"一级概念"或"二级子概念"；每个实体必须填写完整的category、level、description、subcategory、aliases、context字段。

文献：
摘要：{texts.get('摘要','')[:1500]}
术语：{texts.get('术语','')[:1500]}
原文：{texts.get('original','')[:3000]}"""

    entities = []
    for retry in range(2):
        r = llm.call_json(prompt_e, system_prompt="你是马理论领域知识抽取专家。严格输出JSON，所有字段必填。", max_retries=1, timeout=120)
        if isinstance(r, dict) and r.get("entities"):
            entities = r["entities"]
            break
        if isinstance(r, list):
            entities = r
            break
        if retry == 0:
            prompt_e += "\n\n上次未输出实体。请一定输出 entities 数组。"

    logger.info(f"  Entities: {len(entities)}")

    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name","")
        if not name:
            continue
        neo4j.execute_write("""
            MERGE (e:Entity {name: $n})
            SET e.category=$c, e.subcategory=$s, e.level=$l, e.description=$d,
                e.aliases=$a, e.context=$x, e.source_folder=$f, e.created_at=datetime()
            WITH e MATCH (ep:Episode {source_folder:$f}) MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {"n":name,"c":ent.get("category",""),"s":ent.get("subcategory",""),"l":ent.get("level",""),
              "d":ent.get("description",""),"a":ent.get("aliases",[]),"x":ent.get("context",""),"f":fname})

    # ── 关系抽取 ──
    if len(entities) >= 2:
        ent_names = [e.get("name","") if isinstance(e,dict) else str(e)
                     for e in entities if (isinstance(e,dict) and e.get("name"))][:20]

        prompt_r = f"""从以下马理论文献的实体列表中找出所有逻辑关系。

【实体列表】{', '.join(ent_names)}

【文献摘要】{texts.get('摘要','')[:1200]}
【原文片段】{texts.get('original','')[:2000]}

【允许的关系类型（必须严格使用以下英文标识）】
{REL_TYPES_HELP}

【输出示例】
{{"relations":[
  {{"source":"资本下乡","relation_type":"BELONG_TO","target":"乡村振兴","confidence":0.92,"description":"资本下乡是乡村振兴战略的重要抓手和实现路径之一"}},
  {{"source":"资本下乡","relation_type":"LEAD_TO","target":"农民增收","confidence":0.85,"description":"工商资本进入农村带动土地流转和产业发展，间接促进农民非农收入增加"}}
]}}

请找出所有可能的关系并输出JSON。即使只有一条也要输出。"""

        rel_result = llm.call_json(prompt_r, system_prompt="你是马理论领域关系抽取专家。仔细分析每对实体间的逻辑关系，使用标准英文关系类型。", max_retries=1, timeout=120)
        relations = []
        if isinstance(rel_result, dict) and rel_result.get("relations"):
            relations = rel_result["relations"]
        elif isinstance(rel_result, list):
            relations = rel_result

        valid_rels = 0
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
            if not src or not tgt:
                continue
            # 修正关系类型 — 只接受标准类型，否则跳过
            if rtype not in REL_TYPES_CN:
                continue
            # 验证实体存在
            sc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n":src})
            tc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n":tgt})
            if sc[0]['c'] == 0 or tc[0]['c'] == 0:
                continue

            try:
                with neo4j.driver.session() as s:
                    s.run(f"""
                        MATCH (a:Entity {{name:$src}})
                        MATCH (b:Entity {{name:$tgt}})
                        MERGE (a)-[r:{rtype} {{source_folder:$f}}]->(b)
                        SET r.confidence=$conf, r.description=$desc, r.created_at=datetime()
                    """, {"src":src,"tgt":tgt,"rtype":rtype,"f":fname,
                          "conf":rel.get("confidence",0.8),"desc":rel.get("description","")})
                valid_rels += 1
                relation_stats[rtype] += 1
            except Exception as e:
                logger.warning(f"    rel fail: {src}--[{rtype}]-->{tgt}: {e}")

        logger.info(f"  Relations: {valid_rels} (LLM output {len(relations)} raw)")
    else:
        logger.info(f"  Relations: skip (< 2 entities)")

# ── 全局消歧 ──
logger.info("=== 消歧 ===")
all_e = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.description as d, e.category as c")
logger.info(f"Entities: {len(all_e)}")
if len(all_e) >= 4:
    r = llm.call_json(f"实体消歧（同义合并+同名异义拆分）。{json.dumps(all_e[:50], ensure_ascii=False, indent=1)}。输出JSON：{{merge_groups:[]}}",
                      system_prompt="你是实体消歧专家。")
    if isinstance(r, dict):
        for g in r.get("merge_groups",[]):
            can = g.get("canonical_name","")
            if not can: continue
            neo4j.execute_write("MERGE (e:Entity {name:$n}) SET e.is_canonical=true", {"n":can})
            for a in g.get("aliases",[]):
                neo4j.execute_write("""
                    MATCH (a:Entity {name:$a}) MATCH (c:Entity {name:$c})
                    OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity
                    FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END | MERGE (c)-[nr:RELATION]->(n) SET nr=properties(r))
                    DETACH DELETE a
                """, {"a":a,"c":can})
        logger.info(f"  Merges: {len(r.get('merge_groups',[]))}, Splits: {len(r.get('split_groups',[]))}")

# ── 冲突 ──
logger.info("=== 冲突 ===")
cd = neo4j.execute_query("""
    MATCH (e:Entity)-[r]->(other:Entity)
    WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT'
    RETURN e.name as entity, e.source_folder as folder,
           collect(DISTINCT {type:type(r), target:other.name}) as rels LIMIT 20
""")
candidates = [row for row in cd if row.get("rels") and any(r.get("type") for r in row["rels"])]
logger.info(f"Candidates: {len(candidates)}")
if len(candidates) >= 3:
    r = llm.call_json(f"时序冲突校验:{json.dumps(candidates,ensure_ascii=False,indent=1)[:3000]}。输出JSON:{{conflicts:[]}}")
    if isinstance(r,dict):
        for cf in r.get("conflicts",[]):
            neo4j.execute_write("CREATE (c:Conflict {concept:$c, conflict_level:$l, desc:$d, created_at:datetime()}) WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                               {"c":cf.get("concept",""),"l":cf.get("conflict_level",""),"d":cf.get("description","")})
        logger.info(f"  Conflicts: {len(r.get('conflicts',[]))}")

# ── 聚类 ──
logger.info("=== 聚类 ===")
ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.category as c, e.description as d")
logger.info(f"Entities: {len(ce)}")
if len(ce) >= 5:
    r = llm.call_json(f"二级体系聚类（一级：马哲/政治经济学/科学社会主义/马理论中国化/西方马克思主义/思想史）。{json.dumps(ce[:30],ensure_ascii=False,indent=1)}。输出JSON:{{clusters:[]}}",
                      system_prompt="你是领域聚类专家。")
    if isinstance(r,dict):
        for cl in r.get("clusters",[]):
            cid=cl.get("community_id","")
            if not cid: continue
            neo4j.execute_write("MERGE (c:Community {community_id:$cid}) SET c.level=$l, c.created_at=datetime()",
                               {"cid":cid,"l":cl.get("level","二级")})
            for en in cl.get("entities",[]):
                neo4j.execute_write("MATCH (e:Entity {name:$n}) MATCH (c:Community {community_id:$cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                   {"n":en,"cid":cid})
        logger.info(f"  Clusters: {len(r.get('clusters',[]))}")

# ── 统计 ──
logger.info("=== 最终统计 ===")
total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
total_r_result = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c")
total_r = total_r_result[0].get('c', 0) if total_r_result else 0
logger.info(f"  Entities: {total_e}")
logger.info(f"  Relations: {total_r}")
logger.info(f"  Types: {dict(relation_stats)}")

# 质量
ed = neo4j.execute_query("MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> '' RETURN count(e) as c")[0]['c']
ec = neo4j.execute_query("MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> '' RETURN count(e) as c")[0]['c']
logger.info(f"  Quality: desc={ed}/{total_e}, cat={ec}/{total_e}")

neo4j.close()
logger.info("DONE!")
