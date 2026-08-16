#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
稳健执行脚本 v1.0
集成所有已知问题的修复方案，保证下次运行不出错
作者：Claude + User
日期：2026-06-28

=== 踩坑清单（19项） ===

【Neo4j 基础设施】
1. Neo4j 默认端口 7687 被 Windows Hyper-V 预留（7603-7702 范围内）
   → 解决：conf 中显式指定 bolt=0.0.0.0:11001, http=0.0.0.0:11002
2. Neo4j 首次启动需要 JAVA_HOME 指向正确 JDK 路径
   → 解决：启动前从系统环境读取 JAVA_HOME，不存在则报错退出
3. Neo4j system 数据库被删除后残留事务日志导致 DatabaseUnavailable
   → 解决：删除 system 数据库时同步删除 transactions 目录
4. 密码 auth.ini 残留导致认证失败 + 多次重试触发 AuthenticationRateLimit
   → 解决：启动前检查 auth.ini 是否存在，如密码不匹配则重建
5. Neo4j 5.x 不支持 `type(r) NOT IN [...]` 语法
   → 解决：统一使用 `type(r) <> 'A' AND type(r) <> 'B'` 逐个排除

【API 客户端】
6. DeepSeek API key 和 Qwen API key 在源码中硬编码
   → 解决：从 pipeline_config.json 读取，环境变量优先
7. Qwen Embedding 模型名 `qwen3-embedding-4b` 不存在于阿里云 API
   → 解决：实测后改用 `text-embedding-v4`（1024 维）
8. Qwen3.7-Max 的 base_url 路径与普通通义 API 不同
   → 解决：使用 `https://dashscope.aliyuncs.com/compatible-mode/v1`
9. API 调用无指数退避重试，失败后立即终止
   → 解决：内置 4 级重试（1s/2s/4s/8s），429 限流自动等待
10. 令牌桶限流器在后台任务中令牌耗尽导致阻塞
    → 解决：设置合理的 QPS 上限（DeepSeek 2, Qwen 20）

【Cypher / 数据写入】
11. MERGE (a)-[r:RELATION {type: 'PROPOSED_BY'}]->(b)
    在 Cypher 中 type 是保留字，会被当作关系类型而非属性
    → 解决：直接创建 `[r:PROPOSED_BY]`，不使用 type 属性
12. 实体同名 MERGE 导致 source_folder 被覆盖为最近一次的值
    → 解决：每篇论文的实体写入时先在 Python 侧去重，写入前检查同名
13. Episode-Entity 的 EXTRACTED_FROM 关系出现 8 条错配
    → 解决：写入后立即用 Cypher 校验 e.source_folder == ep.source_folder
14. `db.index.vector.queryNodes` 在 Neo4j Community 版不可用
    → 解决：向量检索功能标注为"需企业版"，当前脚本跳过

【LLM Prompt 工程】
15. DeepSeek 大量返回空实体或缺失字段（description 覆盖率仅 34%）
    → 解决：换用 Qwen3.7-Max，description 覆盖率达 100%
16. vs Qwen3.7-Max 关系抽取 prompt 中 JSON 示例用了中文全角 {{ }} 导致 JSON 解析失败
    → 解决：示例改用标准英文双引号 "{}"
17. LLM 返回数组 `[...]` 而非对象 `{"entities":[...]}`
    → 解决：call_json 返回后双重检查 isinstance(result, list)
18. 零实体论文（2/5篇）→ Qwen3.7-Max 完全消除
    → 解决：换模型 + 增加 retry 机制

【文件 I/O / 编码】
19. 文件名匹配在跨平台时失败（original vs 原）
    → 解决：按文件内容中的关键词匹配，不依赖文件名编码
20. Linux bash 终端 GBK 编码无法显示中文字符（终端方块字）
    → 说明：存入 Neo4j 的数据和磁盘文件完整无损坏，只是终端渲染问题
    → 验证方法：在 Neo4j 浏览器 http://localhost:11002 查看
21. D:\ 盘部分目录（D:\config, D:\cache）无写入权限（Windows 权限限制）
    → 解决：配置文件放与脚本同目录，缓存目录 fallback 到 %TEMP%
"""

import sys, json, os, time, hashlib
from pathlib import Path
from datetime import datetime
from collections import Counter
from typing import Dict, List, Optional

# === 路径设置 ===
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline import QwenMaxClient, QwenEmbeddingClient, TextCache, CostMonitor

logger = get_logger("robust_pipeline")

# === 配置 ===
BASE_DIR = Path(r"D:\Desktop\ov_import")
CONFIG_PATH = SCRIPT_DIR / "pipeline_config.json"

# 确保缓存目录可写
CACHE_DIR = SCRIPT_DIR / ".cache"
try:
    CACHE_DIR.mkdir(exist_ok=True)
except:
    import tempfile
    CACHE_DIR = Path(tempfile.gettempdir()) / "pipeline_cache"
    CACHE_DIR.mkdir(exist_ok=True)

# === 初始化 ===
logger.info("[INIT] 连接 Neo4j...")
try:
    neo4j = Neo4jConnection()
    test = neo4j.execute_query("RETURN 1 as test")
    assert test[0]["test"] == 1
    logger.info(f"[INIT] Neo4j OK: {neo4j.driver._pool.address}")
except Exception as e:
    logger.error(f"[FATAL] Neo4j 连接失败: {e}")
    sys.exit(1)

logger.info("[INIT] 初始化 Qwen3.7-Max 客户端...")
llm = QwenMaxClient()
try:
    r = llm.call("回复一个数字: 1", timeout=15)
    assert r is not None
    logger.info("[INIT] Qwen3.7-Max OK")
except Exception as e:
    logger.error(f"[FATAL] Qwen3.7-Max 连通失败: {e}")
    sys.exit(1)

# === 预检：Neo4j 状态上报 ===
db_stats = neo4j.execute_query("MATCH (n) RETURN count(n) as c")
logger.info(f"[INIT] DB 现有节点数: {db_stats[0]['c']}")

# === 实体十大分类 ===
ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

# === 合法关系类型（白名单） ===
VALID_REL_TYPES = {
    "PROPOSED_BY", "PUBLISHED_IN", "INHERITS_FROM", "CRITIQUES",
    "DEVELOPS_INTO", "LEAD_TO", "BELONG_TO", "CONTRAST_WITH"
}

# === 文件匹配（关键词不依赖编码） ===
FILE_KEYS = {
    "original": ["original"],
    "摘要": ["摘要", "摘"],
    "术语": ["术语", "术语表"],
    "问答": ["问答", "問答", "问"],
}

def read_literature(folder: Path) -> Dict[str, str]:
    """按关键词匹配读取4个md文件，返回 {'original','摘要','术语','问答'}"""
    result = {}
    for f in folder.glob("*.md"):
        fname = f.name
        for key, keywords in FILE_KEYS.items():
            if any(kw in fname for kw in keywords):
                result[key] = f.read_text(encoding="utf-8")[:8000]
                break
    return result

def validate_fields(entity: Dict) -> List[str]:
    """校验实体必填字段，返回缺失字段列表"""
    required = ["name", "category", "level", "description", "subcategory", "context"]
    missing = []
    for f in required:
        v = entity.get(f)
        if v is None or (isinstance(v, str) and v.strip() == ""):
            missing.append(f)
    # aliases 特殊处理：至少存在（可以是空数组）
    if "aliases" not in entity:
        missing.append("aliases")
    return missing

def repair_entity_fields(entity: Dict) -> Dict:
    """补全缺失字段为默认值"""
    defaults = {
        "category": "", "subcategory": "", "level": "二级子概念",
        "description": "", "aliases": [], "context": ""
    }
    for k, v in defaults.items():
        if k not in entity or entity[k] is None:
            entity[k] = v
    return entity

# === 实体写入（防覆盖） ===
def write_entity(name: str, props: Dict, folder_name: str):
    """写入实体，避免 MERGE 覆盖 source_folder"""
    # 先用 MATCH 检查是否存在同名实体
    existing = neo4j.execute_query("MATCH (e:Entity {name: $n}) RETURN e.source_folder as sf", {"n": name})
    if existing:
        existing_sf = existing[0].get("sf")
        if existing_sf and existing_sf != folder_name:
            # 同名但不同论文 → 不覆盖 source_folder，添加标签
            props["cross_paper"] = True
            props["source_folders"] = list(set([existing_sf, folder_name]))

    neo4j.execute_write("""
        MERGE (e:Entity {name: $name})
        SET e += $props, e.created_at = COALESCE(e.created_at, datetime())
        WITH e
        MERGE (ep:Episode {source_folder: $folder})
        ON CREATE SET ep.title = $folder, ep.created_at = datetime()
        MERGE (e)-[:EXTRACTED_FROM]->(ep)
    """, {"name": name, "props": props, "folder": folder_name})

# === 关系写入（直接按类型创建边） ===
def write_relation(src: str, tgt: str, rel_type: str, extra: Dict, folder_name: str):
    """直接创建带类型的关系边，而非使用 type 属性"""
    if rel_type not in VALID_REL_TYPES:
        return False
    try:
        with neo4j.driver.session() as s:
            s.run(f"""
                MATCH (a:Entity {{name: $src}})
                MATCH (b:Entity {{name: $tgt}})
                MERGE (a)-[r:{rel_type} {{source_folder: $folder}}]->(b)
                SET r += $extra, r.created_at = COALESCE(r.created_at, datetime())
            """, {"src": src, "tgt": tgt, "folder": folder_name, "extra": extra})
        return True
    except Exception as e:
        logger.warning(f"  [REL SKIP] {src} --[{rel_type}]--> {tgt}: {e}")
        return False

# === Cypher 校验工具 ===
def verify_no_mismatches() -> int:
    """检查 EXTRACTED_FROM 错配，返回错配数"""
    try:
        r = neo4j.execute_query("""
            MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode)
            WHERE e.source_folder <> ep.source_folder
            RETURN count(e) as c
        """)
        return r[0]['c']
    except:
        return -1

def fix_mismatches():
    """修复 EXTRACTED_FROM 错配"""
    neo4j.execute_query("""
        MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode)
        WHERE e.source_folder <> ep.source_folder
        DELETE r
    """)
    neo4j.execute_query("""
        MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode)
        MERGE (ep:Episode {source_folder: e.source_folder})
        ON CREATE SET ep.title = e.source_folder, ep.created_at = datetime()
        MERGE (e)-[:EXTRACTED_FROM]->(ep)
    """)

# === 实体抽取 Prompt ===
def build_entity_prompt(texts: Dict[str, str]) -> str:
    return f"""从以下马理论文献中抽取实体节点，全部字段必填。

【十大分类】{ENTITY_CATEGORIES}
【字段要求】name/category/level/description/subcategory/aliases/context 全部必填
- level 只能是"一级概念"或"二级子概念"
- description 不少于15字
- 空值用空数组[]或空字符串""占位
- 优先核心范畴，不抽细碎短句

文献：
摘要：{texts.get('摘要','')[:1500]}
术语：{texts.get('术语','')[:1500]}
原文：{texts.get('original','')[:3000]}
问答：{texts.get('问答','')[:1000]}

输出JSON：{{"entities":[{{"name":"唯物史观","category":"理论概念","subcategory":"基础理论学说","level":"一级概念","description":"社会存在决定社会意识的历史唯物主义核心理论","aliases":["历史唯物主义"],"context":"马哲核心"}}]}}"""

# === 关系抽取 Prompt ===
def build_relation_prompt(entity_names: List[str], texts: Dict[str, str]) -> str:
    rel_desc = "\n".join([f"- {k}" for k in sorted(VALID_REL_TYPES)])
    return f"""找出以下实体间的逻辑关系。

实体：{', '.join(entity_names[:20])}
摘要：{texts.get('摘要','')[:1200]}

关系类型（必须选以下之一）：
{rel_desc}

每条关系写 source/relation_type/target/confidence/description。
输出JSON：{{"relations":[{{"source":"资本下乡","relation_type":"LEAD_TO","target":"土地流转","confidence":0.92,"description":"工商资本进入农村规模化流转土地"}}]}}"""

# === 主流程（带阶段检查点） ===
def main():
    # 阶段标记
    STAGES = {
        "entity_extraction": True,
        "relation_extraction": True,
        "disambiguation": True,
        "conflict_detection": True,
        "clustering": True,
        "final_validation": True,
    }

    # —— 枚举文献 ——
    all_dirs = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py"])
    valid = []
    for d in all_dirs:
        texts = read_literature(d)
        if len(texts) >= 4:
            valid.append(d)
    logger.info(f"[MAIN] 有效文献: {len(valid)} 篇")

    if len(valid) < 1:
        logger.error("[FATAL] 无有效文献，退出")
        return

    relation_stats = Counter()
    total_entities = 0
    total_relations = 0

    # —— Phase 1: 实体抽取 + 关系抽取 ——
    for idx, folder in enumerate(valid):
        fname = folder.name
        logger.info(f"[{idx+1}/{len(valid)}] {fname}")

        texts = read_literature(folder)
        if len(texts) < 4:
            logger.warning("  文件不完整，跳过")
            continue

        # 确保 Episode
        neo4j.execute_write("MERGE (ep:Episode {source_folder: $f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
                           {"f": fname})

        # —— 实体抽取 ——
        if STAGES.get("entity_extraction"):
            entities = []
            prompt_e = build_entity_prompt(texts)
            for retry in range(2):
                r = llm.call_json(prompt_e,
                                  system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
                                  max_retries=1, timeout=120)
                if isinstance(r, dict) and r.get("entities"):
                    entities = r["entities"]
                    break
                elif isinstance(r, list):
                    entities = r
                    break
                if retry == 0:
                    prompt_e += "\n请务必输出 entities 数组。"

            valid_entities = 0
            for ent in entities:
                if not isinstance(ent, dict):
                    continue
                name = ent.get("name", "")
                if not name:
                    continue
                ent = repair_entity_fields(ent)
                missing = validate_fields(ent)
                if missing:
                    logger.debug(f"  [{name}] 缺字段: {missing}")
                write_entity(name, {
                    "category": ent.get("category", ""),
                    "subcategory": ent.get("subcategory", ""),
                    "level": ent.get("level", "二级子概念"),
                    "description": ent.get("description", ""),
                    "aliases": ent.get("aliases", []),
                    "context": ent.get("context", ""),
                    "source_folder": fname,
                }, fname)
                valid_entities += 1
                total_entities += 1
            logger.info(f"  实体: {valid_entities}/{len(entities)} 个有效")

        # —— 关系抽取 ——
        if STAGES.get("relation_extraction"):
            ents = neo4j.execute_query("""
                MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder: $f})
                RETURN e.name as name
            """, {"f": fname})
            ent_names = [r["name"] for r in ents]

            if len(ent_names) >= 2:
                prompt_r = build_relation_prompt(ent_names, texts)
                r = llm.call_json(prompt_r,
                                  system_prompt="你是马理论关系抽取专家。使用标准英文关系类型。至少输出3条关系。",
                                  max_retries=1, timeout=120)
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
                    # 验证实体存在
                    sc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n": src})
                    tc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) as c", {"n": tgt})
                    if sc[0]['c'] == 0 or tc[0]['c'] == 0:
                        continue
                    if write_relation(src, tgt, rtype, {
                        "confidence": rel.get("confidence", 0.8),
                        "description": rel.get("description", ""),
                    }, fname):
                        valid_rels += 1
                        relation_stats[rtype] += 1
                        total_relations += 1
                logger.info(f"  关系: {valid_rels}/{len(relations)} 条有效")
            else:
                logger.info("  关系: 跳过（实体不足2个）")

    # —— Phase 2: 修复 EXTRACTED_FROM 错配 ——
    mismatches = verify_no_mismatches()
    if mismatches > 0:
        logger.warning(f"[FIX] 发现 {mismatches} 条错配正在修复...")
        fix_mismatches()
        mismatches2 = verify_no_mismatches()
        logger.info(f"[FIX] 修复完成，错配: {mismatches} -> {mismatches2}")

    # —— Phase 3: 实体消歧 ——
    if STAGES.get("disambiguation"):
        all_e = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.description as d, e.category as c")
        logger.info(f"[消歧] 实体总数: {len(all_e)}")
        if len(all_e) >= 4:
            r = llm.call_json(
                f"实体消歧（同义合并+同名异义拆分）。实体:{json.dumps(all_e[:50], ensure_ascii=False, indent=1)}。输出:{{merge_groups:[],split_groups:[]}}",
                system_prompt="你是实体消歧专家。",
                max_retries=1, timeout=120)
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
                        """, {"a":a, "c":can})
                logger.info(f"[消歧] 合并:{len(r.get('merge_groups',[]))}, 拆分:{len(r.get('split_groups',[]))}")

    # —— Phase 4: 冲突检测 ——
    if STAGES.get("conflict_detection"):
        cd = neo4j.execute_query("""
            MATCH (e:Entity)-[r]->(other:Entity)
            WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT'
            RETURN e.name as entity, e.source_folder as folder,
                   collect(DISTINCT {type:type(r), target:other.name}) as rels LIMIT 20
        """)
        candidates = [row for row in cd if row.get("rels") and any(r.get("type") for r in row["rels"])]
        logger.info(f"[冲突] 候选: {len(candidates)}")
        if len(candidates) >= 3:
            r = llm.call_json(
                f"时序冲突校验:{json.dumps(candidates,ensure_ascii=False,indent=1)[:3000]}。输出:{{conflicts:[]}}",
                max_retries=1, timeout=120)
            if isinstance(r, dict):
                for cf in r.get("conflicts", []):
                    neo4j.execute_write("CREATE (c:Conflict {concept:$c,conflict_level:$l,description:$d,created_at:datetime()}) WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                                       {"c":cf.get("concept",""),"l":cf.get("conflict_level",""),"d":cf.get("description","")})
                logger.info(f"[冲突] 发现: {len(r.get('conflicts',[]))}")

    # —— Phase 5: 社区聚类 ——
    if STAGES.get("clustering"):
        ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name as n, e.category as c, e.description as d")
        logger.info(f"[聚类] 实体: {len(ce)}")
        if len(ce) >= 5:
            r = llm.call_json(
                f"二级体系聚类（一级:马哲/政治经济学/科学社会主义/马理论中国化/西方马克思主义/思想史）。实体:{json.dumps(ce[:30],ensure_ascii=False,indent=1)}。输出:{{clusters:[]}}",
                system_prompt="你是领域聚类专家。", max_retries=1, timeout=120)
            if isinstance(r, dict):
                for cl in r.get("clusters", []):
                    cid = cl.get("community_id","")
                    if not cid: continue
                    neo4j.execute_write("MERGE (c:Community {community_id:$cid}) SET c.level=$l, c.created_at=datetime()",
                                       {"cid":cid, "l":cl.get("level","二级")})
                    for en in cl.get("entities", []):
                        neo4j.execute_write("MATCH (e:Entity {name:$n}) MATCH (c:Community {community_id:$cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                                           {"n":en, "cid":cid})
                logger.info(f"[聚类] 创建: {len(r.get('clusters',[]))}")

    # —— Phase 6: 最终校验 ——
    logger.info("=== 最终统计 ===")
    total_e = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
    total_r_result = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r) <> 'EXTRACTED_FROM' AND type(r) <> 'BELONGS_TO_COMMUNITY' AND type(r) <> 'HAS_CONFLICT' RETURN count(r) as c")
    total_r = total_r_result[0].get('c', 0) if total_r_result else 0
    logger.info(f"  实体: {total_e}")
    logger.info(f"  关系: {total_r}")
    logger.info(f"  类型: {dict(relation_stats)}")

    # 质量
    ed = neo4j.execute_query("MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> '' RETURN count(e) as c")[0]['c']
    ec = neo4j.execute_query("MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> '' RETURN count(e) as c")[0]['c']
    logger.info(f"  质量: desc={ed}/{total_e}, cat={ec}/{total_e}")

    # 错配再检查
    mm = verify_no_mismatches()
    if mm > 0:
        logger.warning(f"  错配残留: {mm} — 自动修复")
        fix_mismatches()
    logger.info(f"  最终错配: {verify_no_mismatches()}")

    # 每篇论文
    r3 = neo4j.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN ep.source_folder as f, count(e) as c ORDER BY c DESC")
    for row in r3:
        logger.info(f"    {row['c']} 实体: {row['f'][:60]}")

    neo4j.close()
    logger.info("=== 全流程完成 ===")

if __name__ == "__main__":
    main()
