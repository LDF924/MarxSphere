import sys, json, os, time
from pathlib import Path
from collections import Counter

sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("qwen_e2e")
nc = Neo4jConnection()
llm = QwenMaxClient()

BASE_DIR = Path(r"D:\Desktop\ov_import")
MD_KEYS = ["original", "术语", "问答", "摘要"]
all_folders = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])
valid = []
for d in all_folders:
    if all(any(k in f for k in MD_KEYS) for f in os.listdir(d)):
        valid.append(d)
    if len(valid) >= 5:
        break

ENTITY_CATS = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"
total_rel = 0
rel_stats = Counter()
results = []

for idx, folder in enumerate(valid):
    fname = folder.name
    logger.info(f"[{idx+1}/5] {fname}")

    md_files = {}
    for ff in folder.glob("*.md"):
        md_files[ff.name] = ff.read_text(encoding="utf-8")[:8000]

    texts = {}
    for k in ["original", "术语", "问答", "摘要"]:
        for n, c in md_files.items():
            if k in n:
                texts[k] = c
                break

    nc.execute_write(
        "MERGE (ep:Episode {source_folder: $f}) SET ep.title=$t, ep.content=$c, ep.created_at=datetime()",
        {"f": fname, "t": fname, "c": texts.get("摘要", "")[:2000]})

    ent_prompt = f"""你是马克思主义理论领域的知识抽取专家。从以下文献中抽取实体节点。

规则：
1. 优先抽取核心范畴、核心理论，不要抽取过细短句或普通名词
2. 区分一级概念和二级子概念
3. 每个实体必须填写：name、category（{ENTITY_CATS}）、level（一级概念或二级子概念）、description（不少于15字）、subcategory、context
4. 空值用[]或""占位，禁止省略字段

文献内容：
摘要：{texts.get('摘要','')[:1200]}
术语：{texts.get('术语','')[:1200]}
原文：{texts.get('original','')[:2500]}
问答：{texts.get('问答','')[:800]}

输出JSON：{{"entities":[{{"name":"标准名","category":"...","subcategory":"...","level":"一级概念","description":"不少于15字的释义","aliases":[],"context":"出现语境"}}]}}"""

    entities = []
    for retry in range(2):
        r = llm.call_json(ent_prompt, system_prompt="你是知识抽取专家，严格JSON输出，所有字段必填。", max_retries=1)
        if isinstance(r, dict) and r.get("entities"):
            entities = r["entities"]
            break
        elif isinstance(r, list):
            entities = r
            break

    logger.info(f"  Entities: {len(entities)}")

    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name", "")
        if not name:
            continue
        nc.execute_write("""
            MERGE (e:Entity {name: $n})
            SET e.category=$c, e.subcategory=$s, e.level=$l,
                e.description=$d, e.aliases=$a, e.context=$x,
                e.source_folder=$f, e.created_at=datetime()
            WITH e MATCH (ep:Episode {source_folder: $f})
            MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {"n": name, "c": ent.get("category", ""), "s": ent.get("subcategory", ""),
              "l": ent.get("level", ""), "d": ent.get("description", ""),
              "a": ent.get("aliases", []), "x": ent.get("context", ""), "f": fname})

    # Relations
    if len(entities) >= 2:
        names = [e.get("name", "") if isinstance(e, dict) else str(e)
                 for e in entities if (isinstance(e, dict) and e.get("name"))][:15]
        rel_prompt = f"""基于实体列表抽取逻辑关系三元组。
关系类型严格使用：PROPOSED_BY、PUBLISHED_IN、INHERITS_FROM、CRITIQUES、DEVELOPS_INTO、LEAD_TO、BELONG_TO、CONTRAST_WITH

实体：{', '.join(names)}
摘要：{texts.get('摘要','')[:800]}
原文：{texts.get('original','')[:1500]}

输出JSON：{{"relations":[{{"source":"主体","relation_type":"PROPOSED_BY","target":"客体","confidence":0.9,"temporal_context":"背景","description":"说明"}}]}}"""

        rr = llm.call_json(rel_prompt, system_prompt="你是关系抽取专家，严格JSON输出。", max_retries=1)
        relations = []
        if isinstance(rr, dict) and rr.get("relations"):
            relations = rr["relations"]
        elif isinstance(rr, list):
            relations = rr

        for rel in relations:
            if not isinstance(rel, dict):
                continue
            src, tgt, rt = rel.get("source", ""), rel.get("target", ""), rel.get("relation_type", "")
            if not src or not tgt or not rt:
                continue
            with nc.driver.session() as s:
                s.run(
                    f"MATCH (a:Entity {{name: $s}}), (b:Entity {{name: $t}}) "
                    f"MERGE (a)-[r:{rt} {{source_folder: $f}}]->(b) "
                    f"SET r.confidence=$cf, r.temporal_context=$tc, r.description=$d, r.created_at=datetime()",
                    {"s": src, "t": tgt, "f": fname,
                     "cf": rel.get("confidence", 0.8),
                     "tc": rel.get("temporal_context", ""),
                     "d": rel.get("description", "")})
            rel_stats[rt] += 1
            total_rel += 1

        logger.info(f"  Relations: {len(relations)}")
    else:
        relations = []
        logger.info("  Relations: skipped")

    results.append({"folder": fname, "entities": len(entities), "relations": len(relations)})

# Disambiguation
logger.info("=== 消歧 ===")
edb = nc.execute_query("MATCH (e:Entity) RETURN e.name as n, e.description as d, e.category as c")
if len(edb) >= 4:
    r = llm.call_json(
        f"实体消歧。{json.dumps(edb[:40], ensure_ascii=False)}。"
        '输出：{"merge_groups":[...]}',
        system_prompt="你是实体消歧专家。")
    if isinstance(r, dict):
        for g in r.get("merge_groups", []):
            if not isinstance(g, dict):
                continue
            canonical = g.get("canonical_name", "")
            if canonical:
                nc.execute_write("MERGE (e:Entity {name: $n}) SET e.is_canonical=true", {"n": canonical})
        logger.info(f"  Merges: {len(r.get('merge_groups',[]))}")

# Clustering
logger.info("=== 聚类 ===")
ce = nc.execute_query("MATCH (e:Entity) RETURN e.name as n, e.category as c LIMIT 30")
if len(ce) >= 5:
    r = llm.call_json(
        f"二级聚类。{json.dumps(ce, ensure_ascii=False)}。"
        '输出：{"clusters":[...]}',
        system_prompt="你是领域聚类专家。")
    if isinstance(r, dict):
        for cl in r.get("clusters", []):
            cid = cl.get("community_id", "")
            if cid:
                nc.execute_write(
                    "MERGE (c:Community {community_id: $i}) SET c.level=$l, c.created_at=datetime()",
                    {"i": cid, "l": cl.get("level", "二级")})
                for en in cl.get("entities", []):
                    nc.execute_write(
                        "MATCH (e:Entity {name: $n}), (c:Community {community_id: $i}) "
                        "MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                        {"n": en, "i": cid})
        logger.info(f"  Clusters: {len(r.get('clusters',[]))}")

# Final Stats
logger.info("=== 最终统计 ===")
for label, q in [
    ("Entities", "MATCH (e:Entity) RETURN count(e) as c"),
    ("Relations", "MATCH ()-[r]->() WHERE NOT type(r) IN ['EXTRACTED_FROM','BELONGS_TO_COMMUNITY','HAS_CONFLICT'] RETURN count(r) as c"),
    ("Episodes", "MATCH (ep:Episode) RETURN count(ep) as c"),
    ("Communities", "MATCH (c:Community) RETURN count(c) as c"),
]:
    r = nc.execute_query(q)
    logger.info(f"  {label}: {r[0]['c']}")

rt = nc.execute_query("""
    MATCH ()-[r]->() WHERE NOT type(r) IN ['EXTRACTED_FROM','BELONGS_TO_COMMUNITY','HAS_CONFLICT']
    RETURN DISTINCT type(r) as t, count(r) as c ORDER BY c DESC
""")
logger.info("  关系类型:")
for r in rt:
    logger.info(f"    [{r['t']}]: {r['c']}")

total_e = nc.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
ed = nc.execute_query("MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> '' RETURN count(e) as c")[0]['c']
ec = nc.execute_query("MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> '' RETURN count(e) as c")[0]['c']
el = nc.execute_query("MATCH (e:Entity) WHERE e.level IS NOT NULL AND e.level <> '' RETURN count(e) as c")[0]['c']
logger.info(f"  质量: desc={ed}/{total_e} cat={ec}/{total_e} level={el}/{total_e}")

logger.info("=== 单篇对比 ===")
for s in results:
    logger.info(f"  {s['folder']}: entities={s['entities']}, relations={s['relations']}")

nc.close()
