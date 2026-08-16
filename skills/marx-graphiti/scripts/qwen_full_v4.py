#!/usr/bin/env python3
"""
Qwen3.7-Max v4：修复文件匹配 + Cypher 兼容 Neo4j 5.x
匹配文件名用中文关键词，不清空数据库，每篇都重新处理
"""
import sys, json, os
from pathlib import Path
from collections import Counter
sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("qwen_v4")
neo4j = Neo4jConnection()
llm = QwenMaxClient()

BASE_DIR = Path(r"D:\Desktop\ov_import")

# ── 用实际文件名中的中文关键词匹配 ──
# 实际文件名格式：xxx.original.md / 摘要.md / 术语表.md / 问答.md
FILE_KEYS = [".original.", "摘要", "术语", "问答"]  # 匹配文件名中的关键词

all_dirs = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])

def read_literature(folder):
    """按关键词匹配读取4个文件"""
    texts = {}
    for f in folder.glob("*.md"):
        fname = f.name
        if ".original." in fname or "original" in fname:
            texts["original"] = f.read_text(encoding="utf-8")[:8000]
        elif "摘要" in fname:
            texts["摘要"] = f.read_text(encoding="utf-8")[:8000]
        elif "术语" in fname:
            texts["术语"] = f.read_text(encoding="utf-8")[:8000]
        elif "问答" in fname or "問答" in fname:
            texts["问答"] = f.read_text(encoding="utf-8")[:8000]
    return texts

valid = []
for d in all_dirs:
    texts = read_literature(d)
    if len(texts) >= 4:
        valid.append(d)
    if len(valid) >= 5:
        break

logger.info(f"Valid folders: {len(valid)}")
for v in valid:
    logger.info(f"  {v.name}")

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

REL_TYPES_HELP = """- PROPOSED_BY: 提出者（某人/某著作提出了某理论）
- PUBLISHED_IN: 载于著作（某理论发表于某经典著作）
- INHERITS_FROM: 继承发展（某理论继承自前人理论）
- CRITIQUES: 批判（某人对某理论持批判态度）
- DEVELOPS_INTO: 发展为（某理论后续发展为某新理论）
- LEAD_TO: 导致/带来（某行为/现象导致某后果）
- BELONG_TO: 从属/归属（某概念属于某更大范畴）
- CONTRAST_WITH: 对立（两概念存在理论对立关系）"""
VALID_REL_TYPES = {"PROPOSED_BY","PUBLISHED_IN","INHERITS_FROM","CRITIQUES",
                   "DEVELOPS_INTO","LEAD_TO","BELONG_TO","CONTRAST_WITH"}

relation_stats = Counter()

for idx, folder in enumerate(valid):
    fname = folder.name
    logger.info(f"[{idx+1}/5] {fname}")

    texts = read_literature(folder)

    # 跳过已有 Episode（避免重复创建）
    # 确保 Episode 存在（MERGE：不存在则创建，存在则复用）——不做跳过
    neo4j.execute_write("MERGE (ep:Episode {source_folder: $f}) ON CREATE SET ep.title=$t, ep.content=$c, ep.created_at=datetime()",
                       {"f": fname, "t": fname, "c": texts.get("摘要","")[:2000]})

    # ── 实体抽取 ──
    prompt_e = f"""你是马克思主义理论领域知识抽取专家。从以下文献中抽取实体节点。

【十大分类】{ENTITY_CATEGORIES}

【规则】
1. 优先抽取核心范畴和核心理论，不抽取过细短句
2. 区分"一级概念"和"二级子概念"
3. 每个实体必须填写所有字段：name/category/level/description/subcategory/aliases/context
4. 空值用空数组[]或空字符串""占位

文献内容：
摘要：{texts.get('摘要','')[:1500]}
术语：{texts.get('术语','')[:1500]}
原文：{texts.get('original','')[:3000]}
问答：{texts.get('问答','')[:1000]}

输出格式：
{{"entities": [
  {{"name": "唯物史观", "category": "理论概念", "subcategory": "基础理论学说", "level": "一级概念",
    "description": "社会存在决定社会意识的历史唯物主义核心理论", "aliases": ["历史唯物主义"], "context": "马哲核心"}}
]}}"""

    entities = []
    for retry in range(2):
        r = llm.call_json(prompt_e, system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。", max_retries=1, timeout=120)
        if isinstance(r, dict) and r.get("entities"):
            entities = r["entities"]
            break
        elif isinstance(r, list) and len(r) > 0 and isinstance(r[0], dict):
            entities = r
            break
        if retry == 0:
            logger.warning("  entity retry...")

    logger.info(f"  Entities: {len(entities)}")

    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name","")
        if not name:
            continue
        # 先确认 Episode 存在
        neo4j.execute_write("MERGE (ep:Episode {source_folder: $f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
                           {"f": fname})
        neo4j.execute_write("""
            MERGE (e:Entity {name: $n})
            SET e.category=$c, e.subcategory=$s, e.level=$l, e.description=$d,
                e.aliases=$a, e.context=$x, e.source_folder=$f, e.created_at=datetime()
            WITH e MATCH (ep:Episode {source_folder: $f})
            MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {"n": name, "c": ent.get("category",""), "s": ent.get("subcategory",""), "l": ent.get("level",""),
              "d": ent.get("description",""), "a": ent.get("aliases",[]), "x": ent.get("context",""), "f": fname})

    # ── 关系抽取 ──
    ent_names = [e.get("name","") if isinstance(e,dict) else str(e)
                 for e in entities if isinstance(e,dict) and e.get("name","")][:20]

    if len(ent_names) >= 2:
        prompt_r = f"""你是关系抽取专家。从以下马理论实体列表中找出所有逻辑关系。

实体列表: {', '.join(ent_names)}
文献摘要: {texts.get('摘要','')[:1000]}

关系类型（必须选以下之一）: PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH

直接输出JSON响应，格式:
{{"relations":[{{"source":"A","relation_type":"LEAD_TO","target":"B","confidence":0.9,"description":"关系描述"}}]}}"""

        r = llm.call_json(prompt_r, system_prompt="你是马理论关系抽取专家。使用标准英文关系类型。", max_retries=1, timeout=120)
        relations = []
        if isinstance(r, dict) and r.get("relations"):
            relations = r["relations"]
        elif isinstance(r, list):
            relations = r

        valid_rels = 0
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
            if not src or not tgt or rtype not in VALID_REL_TYPES:
                continue
            # 验证实体存在（可能用别名写入，允许部分失败）
            sc = neo4j.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) as c", {"n": src})
            tc = neo4j.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) as c", {"n": tgt})
            if sc[0]['c'] == 0 or tc[0]['c'] == 0:
                continue
            try:
                with neo4j.driver.session() as s:
                    s.run(f"""
                        MATCH (a:Entity {{name: $src}})
                        MATCH (b:Entity {{name: $tgt}})
                        MERGE (a)-[r:{rtype} {{source_folder: $f}}]->(b)
                        SET r.confidence=$conf, r.description=$desc, r.created_at=datetime()
                    """, {"src":src,"tgt":tgt,"f":fname,
                          "conf":rel.get("confidence",0.8),"desc":rel.get("description","")})
                valid_rels += 1
                relation_stats[rtype] += 1
            except Exception as e:
                logger.warning(f"    rel fail: {src}--[{rtype}]-->{tgt}: {e}")

        logger.info(f"  Relations: {valid_rels} (LLM raw: {len(relations)})")
    else:
        logger.info(f"  Relations: skip (< 2 entities)")

# ── 全局消歧 ──
logger.info("=== 消歧 ===")
all_e = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.description as d, e.category as c")
logger.info(f"Entities: {len(all_e)}")
if len(all_e) >= 4:
    r = llm.call_json(
        f"实体消歧（同义合并+同名异义拆分）。实体：{json.dumps(all_e[:50], ensure_ascii=False, indent=1)}。输出JSON：{{merge_groups:[],split_groups:[]}}",
        system_prompt="你是实体消歧专家。", max_retries=1, timeout=120)
    if isinstance(r, dict):
        for g in r.get("merge_groups", []):
            can = g.get("canonical_name","")
            if not can:
                continue
            neo4j.execute_write("MERGE (e:Entity {name: $n}) SET e.is_canonical=true", {"n": can})
            for a in g.get("aliases", []):
                neo4j.execute_write("""
                    MATCH (a:Entity {name: $a}) MATCH (c:Entity {name: $c})
                    OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity
                    FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END | MERGE (c)-[nr:RELATION]->(n) SET nr=properties(r))
                    DETACH DELETE a
                """, {"a": a, "c": can})
        logger.info(f"  Merges: {len(r.get('merge_groups',[]))}, Splits: {len(r.get('split_groups',[]))}")

# ── 冲突（Neo4j 5.x 兼容语法）──
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
    r = llm.call_json(f"时序冲突校验:{json.dumps(candidates,ensure_ascii=False,indent=1)[:3000]}。输出JSON:{{conflicts:[]}}",
                      max_retries=1, timeout=120)
    if isinstance(r, dict):
        for cf in r.get("conflicts", []):
            neo4j.execute_write("CREATE (c:Conflict {concept:$c, conflict_level:$l, description:$d, created_at:datetime()}) WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                               {"c":cf.get("concept",""),"l":cf.get("conflict_level",""),"d":cf.get("description","")})
        logger.info(f"  Conflicts: {len(r.get('conflicts',[]))}")

# ── 聚类 ──
logger.info("=== 聚类 ===")
ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.category as c, e.description as d")
logger.info(f"Entities: {len(ce)}")
if len(ce) >= 5:
    r = llm.call_json(
        f"二级体系聚类（一级:马哲/政治经济学/科学社会主义/马理论中国化/西方马克思主义/思想史）。实体:{json.dumps(ce[:30],ensure_ascii=False,indent=1)}。输出JSON:{{clusters:[]}}",
        system_prompt="你是领域聚类专家。", max_retries=1, timeout=120)
    if isinstance(r, dict):
        for cl in r.get("clusters", []):
            cid = cl.get("community_id","")
            if not cid: continue
            neo4j.execute_write("MERGE (c:Community {community_id:$cid}) SET c.level=$l, c.created_at=datetime()",
                               {"cid":cid,"l":cl.get("level","二级")})
            for en in cl.get("entities", []):
                neo4j.execute_write("MATCH (e:Entity {name:$n}) MATCH (c:Community {community_id:$cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                   {"n":en,"cid":cid})
        logger.info(f"  Clusters: {len(r.get('clusters',[]))}")

# ── 统计 ──
logger.info("=== 最终统计 ===")
total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
total_r_result = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c")
total_r = total_r_result[0].get('c',0) if total_r_result else 0
logger.info(f"  Entities: {total_e}")
logger.info(f"  Relations: {total_r}")
logger.info(f"  Types: {dict(relation_stats)}")

# 质量
ed = neo4j.execute_query("MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> '' RETURN count(e) as c")[0]['c']
ec = neo4j.execute_query("MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> '' RETURN count(e) as c")[0]['c']
el = neo4j.execute_query("MATCH (e:Entity) WHERE e.level IS NOT NULL AND e.level <> '' RETURN count(e) as c")[0]['c']
logger.info(f"  Quality: desc={ed}/{total_e}, cat={ec}/{total_e}, level={el}/{total_e}")

# 每篇论文
r3 = neo4j.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN ep.source_folder as f, count(e) as c ORDER BY c DESC")
logger.info("  Per paper:")
for row in r3:
    logger.info(f"    {row['c']} entities: {row['f'][:60]}")

neo4j.close()
logger.info("DONE v4!")
