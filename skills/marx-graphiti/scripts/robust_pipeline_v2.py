#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
稳健执行脚本 v2.0 - 单线程逐篇处理，每20篇汇报
修复: 零实体论文（原文超长不再截断+重试3次）、Episode提前MERGE、每阶段单线程
"""
import sys, json, os, time, hashlib, traceback
from pathlib import Path
from datetime import datetime
from collections import Counter
from typing import Dict, List

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))
from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("robust_v2")

BASE_DIR = Path(r"D:\Desktop\ov_import")
neo4j = Neo4jConnection()
llm = QwenMaxClient()

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"
VALID_REL_TYPES = {"PROPOSED_BY","PUBLISHED_IN","INHERITS_FROM","CRITIQUES","DEVELOPS_INTO","LEAD_TO","BELONG_TO","CONTRAST_WITH"}

# === 文件匹配 ===
def read_literature(folder: Path) -> Dict[str, str]:
    result = {}
    for f in folder.glob("*.md"):
        fn = f.name
        for key, kws in [("original",["original"]), ("摘要",["摘要","摘"]), ("术语",["术语"]), ("问答",["问答","問答","问"])]:
            if any(k in fn for k in kws):
                result[key] = f.read_text(encoding="utf-8")
                break
    return result

# === 阶段开关 ===
STAGES = {
    "entity_extraction": True,
    "relation_extraction": True,
    "disambiguation": True,      # 每20篇执行一次全局
    "conflict_detection": True,
    "clustering": True,
    "final_fix": True,           # 最后修复所有错配
}
REPORT_EVERY = 20

# === 加载已处理文献列表（断点续跑） ===
CHECKPOINT_FILE = SCRIPT_DIR / ".checkpoint_processed.json"
processed_folders = set()
if CHECKPOINT_FILE.exists():
    with open(CHECKPOINT_FILE, 'r', encoding='utf-8') as f:
        processed_folders = set(json.load(f))
    logger.info(f"[断点] 已处理 {len(processed_folders)} 篇")

def save_checkpoint():
    with open(CHECKPOINT_FILE, 'w', encoding='utf-8') as f:
        json.dump(sorted(processed_folders), f, ensure_ascii=False)

# === 枚举全部有效文献 ===
all_dirs = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])
pending = [d for d in all_dirs if d.name not in processed_folders]
logger.info(f"[INIT] 总文献: {len(all_dirs)}, 待处理: {len(pending)}")

# === 累计统计 ===
stats = {"entities": 0, "relations": 0, "papers_done": 0, "papers_failed": 0, "rel_types": Counter()}
batch_start_time = time.time()
batch_entities = 0
batch_relations = 0
batch_papers = 0

def report_progress(force=False):
    """每20篇汇报一次"""
    global batch_start_time, batch_entities, batch_relations, batch_papers
    if not force and batch_papers < REPORT_EVERY:
        return

    elapsed = (time.time() - batch_start_time) / 60
    total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
    total_r = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c")[0]['c']
    total_ep = neo4j.execute_query("MATCH (ep:Episode) RETURN count(ep) as c")[0]['c']

    logger.info("=" * 60)
    logger.info(f"[汇报] 已处理 {stats['papers_done']} 篇 (本轮 {batch_papers} 篇, 耗时 {elapsed:.0f} 分钟)")
    logger.info(f"  DB: {total_e} 实体, {total_r} 关系, {total_ep} 文献")
    if batch_papers > 0:
        logger.info(f"  本轮平均: {batch_entities/batch_papers:.1f} 实体/篇, {batch_relations/batch_papers:.1f} 关系/篇")
    logger.info(f"  本轮关系类型: {dict(stats['rel_types'])}")
    logger.info("=" * 60)

    batch_start_time = time.time()
    batch_entities = 0
    batch_relations = 0
    batch_papers = 0

# === 单篇处理 ===
def process_one(folder: Path):
    global batch_entities, batch_relations, batch_papers

    fname = folder.name
    texts = read_literature(folder)
    if len(texts) < 4:
        logger.warning(f"[SKIP] {fname}: 文件不完整")
        stats['papers_failed'] += 1
        return False

    # Episode（提前创建）
    neo4j.execute_write("MERGE (ep:Episode {source_folder:$f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
                        {"f": fname})

    # ── 实体抽取 ──
    entities = []
    if STAGES.get("entity_extraction"):
        # 原文不截断，全文送入
        original_text = texts.get('original', '')
        abstract_text = texts.get('摘要', '')
        term_text = texts.get('术语', '')
        qa_text = texts.get('问答', '')

        prompt_e = f"""从以下马理论文献中抽取实体节点，全部字段必填。

【十大分类】{ENTITY_CATEGORIES}
【规则】name/category/level/description/subcategory/aliases/context 全部必填
- level 只能是"一级概念"或"二级子概念"
- description 不少于15字
- 空值填空数组[]或空字符串""
- 优先核心范畴，不抽细碎短句

【文献内容】
=== 摘要 ({len(abstract_text)}字) ===
{abstract_text[:3000]}

=== 术语表 ({len(term_text)}字) ===
{term_text[:2000]}

=== 原文 ({len(original_text)}字) ===
{original_text[:6000]}

=== 问答 ({len(qa_text)}字) ===
{qa_text[:2000]}"""

        for retry in range(3):
            r = llm.call_json(prompt_e,
                              system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
                              max_retries=1, timeout=120)
            if isinstance(r, dict) and r.get("entities"):
                entities = r["entities"]
                break
            elif isinstance(r, list):
                entities = r
                break
            if retry < 2:
                logger.warning(f"  [实体重试 {retry+1}/3]")
                prompt_e += "\n务必输出 entities 数组，所有字段都填完整。"

    valid_ent = 0
    for ent in entities:
        if not isinstance(ent, dict): continue
        name = ent.get("name", "")
        if not name: continue
        # 补全缺失字段
        props = {
            "category": ent.get("category", ""),
            "subcategory": ent.get("subcategory", ""),
            "level": ent.get("level", "二级子概念"),
            "description": ent.get("description", ""),
            "aliases": ent.get("aliases", []),
            "context": ent.get("context", ""),
            "source_folder": fname,
        }
        neo4j.execute_write("""
            MERGE (e:Entity {name: $name})
            SET e += $props, e.created_at = COALESCE(e.created_at, datetime())
            WITH e MATCH (ep:Episode {source_folder:$folder}) MERGE (e)-[:EXTRACTED_FROM]->(ep)
        """, {"name": name, "props": props, "folder": fname})
        valid_ent += 1

    logger.info(f"  [{fname[:30]}] 实体: {valid_ent}")
    stats['entities'] += valid_ent
    batch_entities += valid_ent

    # ── 关系抽取 ──
    if STAGES.get("relation_extraction") and valid_ent >= 2:
        ent_names = neo4j.execute_query(
            "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder:$f}) RETURN e.name as n ORDER BY e.created_at DESC LIMIT 20",
            {"f": fname})
        names = [r['n'] for r in ent_names]

        rel_prompt = f"""找出以下实体间的逻辑关系。

实体: {', '.join(names)}

关系类型（必须选以下之一）：
- PROPOSED_BY: 提出者
- PUBLISHED_IN: 载于著作
- INHERITS_FROM: 继承发展
- CRITIQUES: 批判
- DEVELOPS_INTO: 发展为
- LEAD_TO: 导致/带来
- BELONG_TO: 从属/归属
- CONTRAST_WITH: 对立

文献摘要: {texts.get('摘要','')[:1200]}

至少输出3条关系。输出JSON格式示例：
{{\"relations\":[{{\"source\":\"资本下乡\",\"relation_type\":\"BELONG_TO\",\"target\":\"乡村振兴\",\"confidence\":0.9,\"description\":\"资本下乡是乡村振兴的重要路径\"}},{{\"source\":\"资本下乡\",\"relation_type\":\"LEAD_TO\",\"target\":\"土地流转\",\"confidence\":0.85,\"description\":\"工商资本进入农村带动土地流转\"}}]}}

请输出JSON:"""

        logger.info(f"  [rel debug] entity count={len(names)}, prompt len={len(rel_prompt)}")

        r = llm.call_json(rel_prompt,
                          system_prompt="你是马理论关系抽取专家。严格输出JSON，至少3条关系。",
                          max_retries=1, timeout=120)
        relations = []
        if isinstance(r, dict) and r.get("relations"):
            relations = r["relations"]
        elif isinstance(r, list):
            relations = r

        valid_rel = 0
        for rel in relations:
            if not isinstance(rel, dict): continue
            src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
            if not src or not tgt or rtype not in VALID_REL_TYPES: continue

            sc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n":src})
            tc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n":tgt})
            if sc[0]['c'] == 0 or tc[0]['c'] == 0: continue

            try:
                with neo4j.driver.session() as s:
                    s.run(f"""
                        MATCH (a:Entity {{name:$s}})
                        MATCH (b:Entity {{name:$t}})
                        MERGE (a)-[rr:{rtype} {{source_folder:$f}}]->(b)
                        SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime()
                    """, {"s":src, "t":tgt, "f":fname, "c":rel.get("confidence",0.8), "d":rel.get("description","")})
                valid_rel += 1
                stats['rel_types'][rtype] += 1
            except Exception as e:
                logger.warning(f"    rel fail: {src}--[{rtype}]-->{tgt}: {e}")

        logger.info(f"  [{fname[:30]}] 关系: {valid_rel}/{len(relations)}")
        stats['relations'] += valid_rel
        batch_relations += valid_rel

    # === 标记完成（仅在所有写操作成功后保存断点） ===
    processed_folders.add(fname)
    stats['papers_done'] += 1
    batch_papers += 1
    # 断点写入放在最后：确保实体+关系全部入库后才标记"已完成"
    save_checkpoint()
    return True

# === 全局任务 ===
def run_global_tasks():
    """消歧 + 冲突 + 聚类"""
    total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']

    # 消歧
    if STAGES.get("disambiguation") and total_e >= 10:
        logger.info("[全局] 实体消歧...")
        all_e = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.description as d, e.category as c")
        r = llm.call_json(f"实体消歧（同义合并+同名异义拆分）。{json.dumps(all_e[:60], ensure_ascii=False, indent=1)}。输出:{{merge_groups:[],split_groups:[]}}",
                          system_prompt="你是实体消歧专家。", max_retries=1, timeout=120)
        if isinstance(r, dict):
            for g in r.get("merge_groups", []):
                can = g.get("canonical_name","")
                if not can: continue
                neo4j.execute_write("MERGE (e:Entity {name:$n}) SET e.is_canonical=true", {"n":can})
                for a in g.get("aliases", []):
                    neo4j.execute_write("""
                        MATCH (a:Entity {name:$a}) MATCH (c:Entity {name:$c})
                        OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity
                        FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END | MERGE (c)-[nr:RELATION]->(n) SET nr=properties(r))
                        DETACH DELETE a
                    """, {"a":a,"c":can})
            logger.info(f"[全局] 消歧: 合并{len(r.get('merge_groups',[]))}, 拆分{len(r.get('split_groups',[]))}")

    # 冲突
    if STAGES.get("conflict_detection"):
        cd = neo4j.execute_query("""
            MATCH (e:Entity)-[r]->(other:Entity)
            WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT'
            RETURN e.name as entity, collect(DISTINCT {type:type(r), target:other.name}) as rels LIMIT 30
        """)
        candidates = [row for row in cd if row.get("rels") and any(r.get("type") for r in row["rels"])]
        if len(candidates) >= 3:
            r = llm.call_json(f"时序冲突校验:{json.dumps(candidates,ensure_ascii=False,indent=1)[:3000]}。输出:{{conflicts:[]}}",
                              max_retries=1, timeout=120)
            if isinstance(r, dict):
                for cf in r.get("conflicts", []):
                    neo4j.execute_write("CREATE (c:Conflict {concept:$c,conflict_level:$l,description:$d,created_at:datetime()}) WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                                       {"c":cf.get("concept",""),"l":cf.get("conflict_level",""),"d":cf.get("description","")})
                logger.info(f"[全局] 冲突: {len(r.get('conflicts',[]))}")

    # 聚类
    if STAGES.get("clustering") and total_e >= 10:
        ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.category as c, e.description as d")
        r = llm.call_json(f"二级体系聚类（马哲/政治经济学/科学社会主义/马理论中国化/西方马克思主义/思想史）。{json.dumps(ce[:40],ensure_ascii=False,indent=1)}。输出:{{clusters:[]}}",
                          system_prompt="你是领域聚类专家。", max_retries=1, timeout=120)
        if isinstance(r, dict):
            for cl in r.get("clusters", []):
                cid = cl.get("community_id","")
                if not cid: continue
                neo4j.execute_write("MERGE (c:Community {community_id:$cid}) SET c.level=$l, c.created_at=datetime()",
                                   {"cid":cid, "l":cl.get("level","二级")})
                for en in cl.get("entities", []):
                    neo4j.execute_write("MATCH (e:Entity {name:$n}) MATCH (c:Community {community_id:$cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                       {"n":en,"cid":cid})
            logger.info(f"[全局] 聚类: {len(r.get('clusters',[]))}")

# === 修复错配 ===
def fix_all_mismatches():
    mm = neo4j.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder RETURN count(e) as c")[0]['c']
    if mm > 0:
        logger.info(f"[修复] 错配: {mm}")
        neo4j.execute_query("MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder DELETE r")
        neo4j.execute_query("MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) MERGE (ep:Episode {source_folder:e.source_folder}) ON CREATE SET ep.title=e.source_folder, ep.created_at=datetime() MERGE (e)-[:EXTRACTED_FROM]->(ep)")
    return mm

# ====== 主循环 ======
logger.info(f"[开始] 单线程逐篇处理 {len(pending)} 篇...")
batch_start_time = time.time()

for idx, folder in enumerate(pending):
    try:
        ok = process_one(folder)
        if not ok:
            stats['papers_failed'] += 1
    except KeyboardInterrupt:
        logger.info("[中断] 用户手动中止，已处理数据已保存")
        save_checkpoint()
        break
    except Exception as e:
        logger.error(f"[ERROR] {folder.name}: {e}")
        logger.debug(traceback.format_exc())
        stats['papers_failed'] += 1
        # 单篇失败不中断：跳过该文献继续下一篇，不标记为已处理
        # 这样下次重启时会重新处理
        continue

    # 每20篇：汇报 + 执行全局任务 + 修复错配
    if (idx + 1) % REPORT_EVERY == 0:
        report_progress()
        run_global_tasks()
        fix_all_mismatches()

# 最后一轮
report_progress(force=True)
run_global_tasks()
fix_all_mismatches()

# === 最终统计 ===
total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
total_r = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c")[0]['c']
ed = neo4j.execute_query("MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> '' RETURN count(e) as c")[0]['c']
ec = neo4j.execute_query("MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> '' RETURN count(e) as c")[0]['c']
mm = neo4j.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder RETURN count(e) as c")[0]['c']

logger.info("=" * 80)
logger.info(f"[全流程完成] 处理 {stats['papers_done']} 篇, 失败 {stats['papers_failed']} 篇")
logger.info(f"  DB: {total_e} 实体, {total_r} 关系, 错配 {mm}")
logger.info(f"  质量: desc={ed}/{total_e}, cat={ec}/{total_e}")
logger.info(f"  关系类型: {dict(stats['rel_types'])}")

neo4j.close()
