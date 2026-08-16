#!/usr/bin/env python3
"""重抽 45 篇零实体论文 — 基于稳健流水线逐篇抽取"""
import sys, json, os, time
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(r"D:\Desktop\执行流程")
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, QwenMaxClient

BATCH_TAG = "v3_retry_45_zero_entity"
BASE_DIR = Path(r"D:\Desktop\ov_import")

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"
VALID_REL_TYPES = {"PROPOSED_BY","PUBLISHED_IN","INHERITS_FROM","CRITIQUES","DEVELOPS_INTO","LEAD_TO","BELONG_TO","CONTRAST_WITH"}
MIN_ENTITY_THRESHOLD = 5

logger = get_logger("retry45")

# ── 读取文件（兼容论文目录内命名差异） ──
def read_literature(folder: Path):
    result = {}
    for key, kws in [("摘要",["摘要","摘"]), ("问答",["问答","問答","问"]), ("术语",["术语"]), ("original",["original"])]:
        for f in folder.glob("*.md"):
            if any(k in f.name for k in kws):
                result[key] = f.read_text(encoding="utf-8")
                break
    return result

# ── 连接 ──
try:
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    test = nc.execute_query("RETURN 1 AS t")[0]["t"]
    assert test == 1
except Exception as e:
    logger.error(f"Neo4j 连接失败: {e}")
    sys.exit(1)

try:
    llm = QwenMaxClient()
    r = llm.call("回复数字1", timeout=15)
    assert r is not None
except Exception as e:
    logger.error(f"Qwen3.7-Max 连接失败: {e}")
    sys.exit(1)

# ── 从 Neo4j 获取无实体论文 ──
no_ent = nc.execute_query(
    "MATCH (ep:Episode) WHERE NOT (ep)-[:EXTRACTED_FROM]-(:Entity) RETURN ep.source_folder AS f ORDER BY ep.source_folder"
)
retry_list = [row["f"] for row in no_ent]
logger.info(f"待重抽论文: {len(retry_list)} 篇")

# ── 逐篇处理 ──
success = 0
fail_list = []
start_time = time.time()

for idx, fname in enumerate(retry_list):
    folder = BASE_DIR / fname
    if not folder.exists():
        logger.warning(f"[SKIP] 目录不存在: {fname}")
        fail_list.append(fname)
        continue

    logger.info(f"[{idx+1}/{len(retry_list)}] {fname[:60]}")

    texts = read_literature(folder)
    if "摘要" not in texts or not texts["摘要"]:
        logger.warning(f"  缺失摘要，跳过")
        fail_list.append(fname)
        continue
    if "术语" not in texts or not texts["术语"]:
        logger.warning(f"  缺失术语，跳过")
        fail_list.append(fname)
        continue

    # ── 实体抽取 ──
    prompt_e = (
        f"【文献摘要 - 最高优先级】{texts.get('摘要','')[:2000]}\n"
        f"【配套问答知识点 - 轻量化概念】{texts.get('问答','')[:2000]}\n"
        f"【专业术语表 - 标准化名词库】{texts.get('术语','')[:2000]}\n"
        f"【原文全文 - 补充论证细节】{texts.get('original','')[:10000]}\n"
        f"\n"
        f"十大实体分类: {ENTITY_CATEGORIES}\n"
        f"规则: name/category/level/description/subcategory/aliases/context 全部必填，level=一级概念或二级子概念，description>=15字\n"
        f'输出JSON: {{"entities":[{{"name":"...","category":"...","level":"...","description":"...","subcategory":"...","aliases":[],"context":"..."}}]}}'
    )

    entities = []
    for retry in range(3):
        r = llm.call_json(prompt_e,
                          system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
                          max_retries=1, timeout=300)
        if isinstance(r, dict) and r.get("entities"):
            entities = r["entities"]
            break
        elif isinstance(r, list):
            entities = r
            break
        if retry < 2:
            logger.warning(f"  实体重试 {retry+1}/3")
            prompt_e += "\n务必输出 entities 数组，所有字段都填完整。"

    valid_ent = 0
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name", "")
        if not name:
            continue
        props = {
            "category": ent.get("category", ""),
            "subcategory": ent.get("subcategory", ""),
            "level": ent.get("level", "二级子概念"),
            "description": ent.get("description", ""),
            "aliases": ent.get("aliases", []),
            "context": ent.get("context", ""),
            "source_folder": fname,
        }
        nc.execute_write(
            "MERGE (e:Entity {name: $name}) "
            "SET e += $props, e.created_at = COALESCE(e.created_at, datetime()), e.batch_run = $bt "
            "WITH e MATCH (ep:Episode {source_folder: $folder}) "
            "MERGE (e)-[rf:EXTRACTED_FROM]->(ep) "
            "SET rf.source_folder = $folder, rf.batch_run = $bt",
            {"name": name, "props": props, "folder": fname, "bt": BATCH_TAG}
        )
        valid_ent += 1

    logger.info(f"  实体: {valid_ent}")

    if valid_ent < MIN_ENTITY_THRESHOLD:
        logger.warning(f"  实体数 {valid_ent} < {MIN_ENTITY_THRESHOLD}，保留记录但标记待后续重试")
        fail_list.append(fname)
        continue

    # ── 关系抽取 ──
    if valid_ent >= 2:
        ent_names = nc.execute_query(
            "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder: $f}) RETURN e.name AS n ORDER BY e.created_at DESC LIMIT 20",
            {"f": fname}
        )
        names = [r["n"] for r in ent_names]

        rel_prompt = (
            f"基于实体列表抽取关系三元组。"
            f"关系类型: PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH\n"
            f"实体: {', '.join(names)}\n"
            f"摘要: {texts.get('摘要','')[:800]}\n"
            f"术语: {texts.get('术语','')[:800]}\n"
            f'输出JSON: {{"relations":[{{"source":"...","relation_type":"BELONG_TO","target":"...","confidence":0.9,"description":"..."}}]}}'
        )

        rr = llm.call_json(rel_prompt,
                           system_prompt="你是关系抽取专家。严格输出JSON。",
                           max_retries=1, timeout=300)
        relations = []
        if isinstance(rr, dict) and rr.get("relations"):
            relations = rr["relations"]
        elif isinstance(rr, list):
            relations = rr

        valid_rel = 0
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            src, tgt, rt = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
            if not src or not tgt or rt not in VALID_REL_TYPES:
                continue
            sc = nc.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) AS c", {"n": src})
            tc = nc.execute_query("MATCH (e:Entity {name: $n}) RETURN count(e) AS c", {"n": tgt})
            if sc[0]["c"] == 0 or tc[0]["c"] == 0:
                continue
            try:
                with nc.driver.session() as s:
                    s.run(
                        f"MATCH (a:Entity {{name: $s}}) MATCH (b:Entity {{name: $t}}) "
                        f"MERGE (a)-[rr:{rt} {{source_folder: $f}}]->(b) "
                        f"SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime(), rr.batch_run=$bt",
                        {"s": src, "t": tgt, "f": fname, "c": rel.get("confidence",0.8), "d": rel.get("description",""), "bt": BATCH_TAG}
                    )
                valid_rel += 1
            except Exception as e:
                logger.warning(f"    rel fail: {src}--[{rt}]-->{tgt}: {e}")

        logger.info(f"  关系: {valid_rel}/{len(relations)}")

    success += 1

# ── 结果汇总 ──
elapsed = (time.time() - start_time) / 60
ent_total = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
done = nc.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN COUNT(DISTINCT ep) AS c")[0]["c"]
remaining = nc.execute_query("MATCH (ep:Episode) WHERE NOT (ep)-[:EXTRACTED_FROM]-(:Entity) RETURN COUNT(ep) AS c")[0]["c"]
retry_ents = nc.execute_query("MATCH (e:Entity {batch_run: $bt}) RETURN COUNT(e) AS c", {"bt": BATCH_TAG})[0]["c"]

logger.info("=" * 60)
logger.info(f"重抽完成 | 耗时 {elapsed:.0f}min | 成功 {success}/{len(retry_list)} | 失败 {len(fail_list)}")
logger.info(f"全库: {ent_total} 实体, {done} 篇有实体, {remaining} 篇缺实体")
logger.info(f"本轮新增实体: {retry_ents}")
if fail_list:
    logger.info(f"失败清单 ({len(fail_list)}):")
    for f in fail_list:
        logger.info(f"  {f[:80]}")

nc.close()
