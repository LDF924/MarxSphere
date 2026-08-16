#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
  资本下乡知识图谱流水线 — 全流程复盘与自动化执行脚本
  v5.0 | 2026-06-30
============================================================

【踩坑日志 & 解决方案】

一、API 密钥层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑1: 主密钥欠费 (Arrearage)                                   │
  │   现象: compatible-mode 返回 400 + "Access denied, account    │
  │         is not in good standing"                              │
  │   根因: 阿里云百炼账户余额不足                                 │
  │   解决: 准备备用密钥，写入 pipeline_config.json 的 qwen_max   │
  │        .key 字段；同时更新 qwen_embedding.key                 │
  │                                                              │
  │ 坑2: 备用密钥 compatible-mode 返回 400 (InvalidParameter)     │
  │   现象: /compatible-mode/v1/chat/completions 始终 400         │
  │   根因: qwen3.7-max 推理模型与 OpenAI-compatible 接口不兼容   │
  │   解决: 使用原生 DashScope API:                                │
  │        /api/v1/services/aigc/text-generation/generation       │
  │        注意: Python SDK (QwenMaxClient) 当前使用              │
  │        compatible-mode，但仍能正常工作（超时/maxtoken         │
  │        修复后）；curl 直调建议用原生 API                       │
  └──────────────────────────────────────────────────────────────┘

二、模型参数层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑3: max_tokens=4096 导致 JSON 输出被截断                    │
  │   现象: 单篇论文成功调用 LLM，实体数返回 0（实际是            │
  │        json.loads 失败）                                      │
  │   根因: qwen3.7-max 是推理模型，reasoning_tokens 占 2000-     │
  │        4000 token，4096 减去思考 token 后只剩几百给 JSON，   │
  │        必然截断                                               │
  │   解决: max_tokens → 16384                                    │
  │                                                              │
  │ 坑4: timeout=120 秒不够                                      │
  │   现象: call_json 返回 None，failed_tasks 显示 "Timeout"      │
  │   根因: qwen3.7-max 思考 + 长 prompt (~16000 字符) +          │
  │        16384 token 输出，单次调用需要 60-120 秒，高峰         │
  │        超 120 秒                                              │
  │   解决: timeout → 300 秒                                      │
  └──────────────────────────────────────────────────────────────┘

三、JSON 解析层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑5: qwen3.7-max 输出包裹 markdown 代码块                    │
  │   现象: raw call 返回有效 JSON，但 call_json 返回 None        │
  │   根因: 输出格式为 ```json\n{...}\n``` 而非纯 JSON            │
  │   解决: call_json 中先用 re.sub 清洗 markdown 标记再解析     │
  └──────────────────────────────────────────────────────────────┘

四、断点/状态管理层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑6: checkpoint 被并发写破坏，从 148 条变成 2 条              │
  │   现象: _kill_old_pipeline() 杀旧进程时，旧进程正在写         │
  │        checkpoint，导致文件被覆盖为空或残缺                    │
  │   根因: 多进程并发写同一 JSON 文件无锁保护                     │
  │   解决: 每次启动前从 Neo4j 权威重新同步 checkpoint:           │
  │        MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode)       │
  │        RETURN DISTINCT ep.source_folder AS f                  │
  └──────────────────────────────────────────────────────────────┘

五、文件系统层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑7: .obsidian 隐藏文件夹污染待处理列表                       │
  │   现象: 流水线卡在 ".obsidian: 缺失核心文件" 后退出           │
  │   根因: ov_import 目录下存在 Obsidian 配置目录，没有          │
  │        有效的摘要/术语 MD 文件                                │
  │   解决: all_dirs 过滤中添加 `not d.name.startswith('.')`     │
  └──────────────────────────────────────────────────────────────┘

六、Neo4j Cypher 层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑8: id() 在 Neo4j 5 中已废弃                                │
  │   现象: WARNING "id is deprecated"                            │
  │   解决: 改用 elementId()                                     │
  │                                                              │
  │ 坑9: length() 对字符串应使用 size()                           │
  │   现象: CypherSyntaxError "Expected Path but was String"      │
  │   解决: length(e.description) → size(e.description)          │
  │                                                              │
  │ 坑10: 关系类型不加引号被当成变量                              │
  │    现象: "Variable EXTRACTED_FROM not defined"                │
  │    解决: type(r)<>"EXTRACTED_FROM" (加双引号)                │
  └──────────────────────────────────────────────────────────────┘

七、编码/环境层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑11: Windows GBK 终端中文乱码                                │
  │    现象: Bash 工具输出中文为 ??? 或乱码                       │
  │    解决: Python 脚本统一使用 encoding='utf-8'，日志用         │
  │         logging 模块（自带 UTF-8 handler）                    │
  │                                                              │
  │ 坑12: 多个 python 进程残留                                    │
  │    现象: tasklist 显示 8+ 个 python.exe                       │
  │    解决: 启动前 taskkill /F /IM python.exe                    │
  └──────────────────────────────────────────────────────────────┘

八、数据质控层
  ┌──────────────────────────────────────────────────────────────┐
  │ 坑13: 45 篇论文实体为 0 的根因链                              │
  │   直接原因: max_tokens 不足 → JSON 截断 → json.loads 失败    │
  │           → call_json 返回 None → entities = []               │
  │   深层原因: 没有区分 "LLM 调用失败" 和 "论文真的抽不出实体"   │
  │   解决: (1) 修复 max_tokens + timeout (2) 添加 raw call       │
  │         fallback (3) 失败日志记录完整 error message           │
  └──────────────────────────────────────────────────────────────┘
"""

import sys, json, os, time, re as _re
from pathlib import Path
from datetime import datetime
from collections import Counter

# ============================================================
# 环境配置
# ============================================================
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, QwenMaxClient

logger = get_logger("full_pipeline")

# ============================================================
# 可配置参数
# ============================================================
class Config:
    BASE_DIR           = Path(r"D:\Desktop\ov_import")
    NEO4J_URI          = "bolt://127.0.0.1:11001"
    NEO4J_USER         = "neo4j"
    NEO4J_PASSWORD     = "neo4j123"
    CONFIG_PATH        = SCRIPT_DIR / "pipeline_config.json"
    CHECKPOINT_PATH    = SCRIPT_DIR / ".checkpoint_processed.json"
    BATCH_TAG          = f"v5_full_{datetime.now().strftime('%Y%m%d')}"

    # 模型参数（依据踩坑经验调优）
    MAX_TOKENS         = 16384    # 坑3: 4096 太小
    TIMEOUT            = 300      # 坑4: 120 不够
    MAX_RETRIES        = 3        # 单篇实体抽取重试次数
    MIN_ENTITY_THRESHOLD = 5      # 实体数低于此值不推进断点
    REPORT_EVERY       = 20       # 每 N 篇汇报一次

    # 实体分类与关系类型
    ENTITY_CATEGORIES  = (
        "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、"
        "价值意识形态文化、研究要素学术工具、行为实践社会行动、"
        "权利规范法律、关系载体"
    )
    VALID_REL_TYPES    = {
        "PROPOSED_BY", "PUBLISHED_IN", "INHERITS_FROM", "CRITIQUES",
        "DEVELOPS_INTO", "LEAD_TO", "BELONG_TO", "CONTRAST_WITH"
    }

cfg = Config()

# ============================================================
# 步骤 1: 密钥健康检测（坑1/坑2）
# ============================================================
def step1_check_api_keys():
    """检测主密钥和备用密钥的可用性，自动切换到可用密钥"""
    logger.info("=" * 60)
    logger.info("[步骤1] API 密钥健康检测")

    import requests as _r

    api_config = json.loads(cfg.CONFIG_PATH.read_text(encoding="utf-8"))
    qwen_cfg = api_config.get("api", {}).get("qwen_max", {})
    current_key = qwen_cfg.get("key", "")

    def _test_key(sk: str, label: str) -> dict:
        headers = {"Authorization": f"Bearer {sk.strip()}", "Content-Type": "application/json"}
        payload = {
            "model": "qwen3.7-max",
            "input": {"messages": [{"role": "user", "content": "hi"}]},
            "parameters": {"max_tokens": 5}
        }
        try:
            resp = _r.post(
                "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
                headers=headers, json=payload, timeout=30
            )
            ok = resp.status_code == 200
            detail = resp.json() if ok else resp.text[:300]
            return {"label": label, "ok": ok, "http": resp.status_code, "detail": detail}
        except Exception as e:
            return {"label": label, "ok": False, "http": 0, "detail": str(e)[:200]}

    result = _test_key(current_key, "当前密钥")

    if result["ok"]:
        logger.info(f"  [OK] 当前密钥正常")
        return True

    # 密钥失效：检查是否欠费
    if "Arrearage" in str(result.get("detail", "")):
        logger.warning(f"  [欠费] 当前密钥已欠费: {result['detail'][:100]}")

    # 尝试读取备用密钥（通过环境变量或配置文件）
    backup_key = os.environ.get("QWEN_MAX_BACKUP_KEY", "")
    if not backup_key:
        # 尝试从 CSV 或其他来源读取
        csv_files = sorted(SCRIPT_DIR.glob("qwen*.csv"))
        if csv_files:
            for line in csv_files[0].read_text(encoding="utf-8").split("\n"):
                if "sk-ws-" in line:
                    backup_key = line.split(",")[-1].strip().strip('"')
                    break

    if backup_key and backup_key != current_key:
        backup_result = _test_key(backup_key, "备用密钥")
        if backup_result["ok"]:
            logger.info(f"  [SWITCH] 切换到备用密钥")
            api_config["api"]["qwen_max"]["key"] = backup_key
            api_config["api"]["qwen_embedding"]["key"] = backup_key
            cfg.CONFIG_PATH.write_text(json.dumps(api_config, ensure_ascii=False, indent=2), encoding="utf-8")
            return True

    logger.error("  [FATAL] 无可用的 API 密钥！")
    return False


# ============================================================
# 步骤 2: Neo4j 连接 & 从 DB 权威同步断点（坑6）
# ============================================================
def step2_sync_checkpoint():
    """从 Neo4j 权威同步断点，解决多进程并发写破坏"""
    logger.info("[步骤2] 从 Neo4j 同步断点")

    try:
        nc = Neo4jConnection(uri=cfg.NEO4J_URI, user=cfg.NEO4J_USER, password=cfg.NEO4J_PASSWORD)
        test = nc.execute_query("RETURN 1 AS t")[0]["t"]
        assert test == 1
    except Exception as e:
        logger.error(f"  [FATAL] Neo4j 连接失败: {e}")
        return None, set()

    # 权威断点：从 DB 读取所有已有实体的论文
    done = nc.execute_query(
        "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) "
        "RETURN DISTINCT ep.source_folder AS f ORDER BY f"
    )
    done_folders = sorted(r["f"] for r in done)

    # 写入 checkpoint 文件
    cfg.CHECKPOINT_PATH.write_text(
        json.dumps(done_folders, ensure_ascii=False), encoding="utf-8"
    )

    # 验证
    with open(cfg.CHECKPOINT_PATH, "r", encoding="utf-8") as f:
        verify = json.load(f)

    logger.info(f"  Checkpoint 已同步: {len(verify)} 篇已处理")

    # 计算待处理
    all_dirs = sorted([
        d.name for d in cfg.BASE_DIR.iterdir()
        if d.is_dir() and d.name != "batch_clean.py"
        and not d.name.startswith(".")  # 坑7: 排除隐藏文件夹
    ])
    done_set = set(verify)
    pending = [d for d in all_dirs if d not in done_set]
    logger.info(f"  总文献: {len(all_dirs)}, 待处理: {len(pending)}")

    return nc, done_set


# ============================================================
# 步骤 3: 读取论文（固定优先级）（坑7）
# ============================================================
def read_literature(folder: Path) -> dict:
    """
    按优先级读取 MD 文件: 摘要 → 问答 → 术语 → 原文
    排除 .obsidian 等隐藏目录（已在目录遍历中过滤）
    """
    priority_map = [
        ("摘要",     ["摘要", "摘"]),
        ("问答",     ["问答", "問答", "问"]),
        ("术语",     ["术语"]),
        ("original", ["original"]),
    ]
    result = {}
    for key, kws in priority_map:
        for f in folder.glob("*.md"):
            if any(k in f.name for k in kws):
                result[key] = f.read_text(encoding="utf-8")
                break
    return result


# ============================================================
# 步骤 4: 单篇实体抽取（坑3/坑4/坑5/坑13）
# ============================================================
def extract_entities(llm: QwenMaxClient, texts: dict, fname: str) -> list:
    """
    从单篇论文抽取实体。
    内置 3 次重试 + markdown 清洗 + max_tokens=16384 + timeout=300。
    """
    prompt = (
        f"【文献摘要 - 最高优先级】{texts.get('摘要','')[:2000]}\n"
        f"【配套问答知识点 - 轻量化概念】{texts.get('问答','')[:2000]}\n"
        f"【专业术语表 - 标准化名词库】{texts.get('术语','')[:2000]}\n"
        f"【原文全文 - 补充论证细节】{texts.get('original','')[:10000]}\n"
        f"\n"
        f"你是马克思主义理论领域知识抽取专家。从以上文献中抽取实体节点，全部字段必填。\n"
        f"十大实体分类: {cfg.ENTITY_CATEGORIES}\n"
        f"\n"
        f"规则:\n"
        f"- name/category/level/description/subcategory/aliases/context 全部必填\n"
        f"- level 只能是「一级概念」或「二级子概念」\n"
        f"- description 不少于15字\n"
        f"- 空值填空数组[]或空字符串\"\"\n"
        f"- 优先核心范畴，不抽细碎短句\n"
        f'- 输出JSON格式: {{"entities":[{{"name":"唯物史观","category":"理论概念","level":"一级概念","description":"...","subcategory":"...","aliases":["..."],"context":"..."}}]}}'
    )

    for retry in range(cfg.MAX_RETRIES):
        r = llm.call_json(
            prompt,
            system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
            max_retries=1,
            timeout=cfg.TIMEOUT,
        )

        if r is None:
            logger.warning(f"  [{fname[:40]}] call_json 返回 None (retry {retry+1}/{cfg.MAX_RETRIES})")
            # 检查是否有错误日志
            if llm.failed_tasks:
                last_error = llm.failed_tasks[-1]["error"][:200]
                logger.warning(f"    错误: {last_error}")
            prompt += "\n务必输出 entities 数组，所有字段都填完整。"
            continue

        if isinstance(r, dict) and r.get("entities"):
            return r["entities"]
        elif isinstance(r, list):
            return r
        else:
            logger.warning(f"  [{fname[:40]}] 返回格式异常: {type(r).__name__}")

    return []


# ============================================================
# 步骤 5: 单篇关系抽取
# ============================================================
def extract_relations(llm: QwenMaxClient, texts: dict, fname: str, nc: Neo4jConnection) -> int:
    """从已入库实体中抽取关系三元组"""
    ent_names = nc.execute_query(
        "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder: $f}) "
        "RETURN e.name AS n ORDER BY e.created_at DESC LIMIT 20",
        {"f": fname}
    )
    names = [r["n"] for r in ent_names]
    if len(names) < 2:
        return 0

    prompt = (
        f"基于实体列表抽取关系三元组。\n"
        f"关系类型（必须选以下之一）: {', '.join(sorted(cfg.VALID_REL_TYPES))}\n"
        f"\n"
        f"已知实体: {', '.join(names)}\n"
        f"摘要: {texts.get('摘要','')[:800]}\n"
        f"术语: {texts.get('术语','')[:800]}\n"
        f"\n"
        f'输出JSON: {{"relations":[{{"source":"主体","relation_type":"BELONG_TO","target":"客体","confidence":0.9,"description":"说明"}}]}}\n'
        f"至少输出3条关系。"
    )

    r = llm.call_json(
        prompt,
        system_prompt="你是马理论关系抽取专家。严格输出JSON，至少3条关系。",
        max_retries=1,
        timeout=cfg.TIMEOUT,
    )

    relations = []
    if isinstance(r, dict) and r.get("relations"):
        relations = r["relations"]
    elif isinstance(r, list):
        relations = r

    valid_rel = 0
    for rel in relations:
        if not isinstance(rel, dict):
            continue
        src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
        if not src or not tgt or rtype not in cfg.VALID_REL_TYPES:
            continue

        # 验证源/目标实体存在
        sc = nc.execute_query("MATCH (e:Entity {name: $n}) RETURN COUNT(e) AS c", {"n": src})
        tc = nc.execute_query("MATCH (e:Entity {name: $n}) RETURN COUNT(e) AS c", {"n": tgt})
        if sc[0]["c"] == 0 or tc[0]["c"] == 0:
            continue

        try:
            with nc.driver.session() as s:
                s.run(
                    f"MATCH (a:Entity {{name: $s}}) MATCH (b:Entity {{name: $t}}) "
                    f"MERGE (a)-[rr:{rtype} {{source_folder: $f}}]->(b) "
                    f"SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime(), rr.batch_run=$bt",
                    {"s": src, "t": tgt, "f": fname,
                     "c": rel.get("confidence", 0.8),
                     "d": rel.get("description", ""),
                     "bt": cfg.BATCH_TAG}
                )
            valid_rel += 1
        except Exception as e:
            logger.warning(f"    rel fail: {src}--[{rtype}]-->{tgt}: {e}")

    return valid_rel


# ============================================================
# 步骤 6: 写入实体到 Neo4j（MERGE 不覆盖历史节点）
# ============================================================
def write_entities_to_neo4j(nc: Neo4jConnection, entities: list, fname: str) -> int:
    """将抽取的实体 MERGE 写入 Neo4j，标记 batch_run"""
    valid = 0
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
            "SET e += $props, "
            "    e.created_at = COALESCE(e.created_at, datetime()), "
            "    e.batch_run = $bt "
            "WITH e "
            "MATCH (ep:Episode {source_folder: $folder}) "
            "MERGE (e)-[rf:EXTRACTED_FROM]->(ep) "
            "SET rf.source_folder = $folder, rf.batch_run = $bt",
            {"name": name, "props": props, "folder": fname, "bt": cfg.BATCH_TAG}
        )
        valid += 1
    return valid


# ============================================================
# 步骤 7: 逐篇处理主循环
# ============================================================
def process_single_paper(folder: Path, nc: Neo4jConnection, llm: QwenMaxClient) -> bool:
    """处理单篇论文：验证文件 → 抽取实体 → 写入 DB → 抽取关系"""
    fname = folder.name

    # 读取文件
    texts = read_literature(folder)

    # 验证必需文件
    if "摘要" not in texts or not texts["摘要"]:
        logger.warning(f"  [SKIP] {fname[:40]}: 缺失摘要")
        return False
    if "术语" not in texts or not texts["术语"]:
        logger.warning(f"  [SKIP] {fname[:40]}: 缺失术语")
        return False

    # 创建 Episode
    nc.execute_write(
        "MERGE (ep:Episode {source_folder: $f}) "
        "ON CREATE SET ep.title=$f, ep.created_at=datetime()",
        {"f": fname}
    )

    # 实体抽取
    entities = extract_entities(llm, texts, fname)
    valid_ent = write_entities_to_neo4j(nc, entities, fname)
    logger.info(f"  [{fname[:40]}] 实体: {valid_ent}")

    if valid_ent < cfg.MIN_ENTITY_THRESHOLD:
        logger.warning(f"    实体数 {valid_ent} < {cfg.MIN_ENTITY_THRESHOLD}，不标记完成")
        return False

    # 关系抽取
    valid_rel = extract_relations(llm, texts, fname, nc)
    logger.info(f"    关系: {valid_rel}")

    return True


# ============================================================
# 步骤 8: 全局后处理
# ============================================================
def run_global_tasks(nc: Neo4jConnection, llm: QwenMaxClient):
    """消歧 → 冲突检测 → 聚类 → 校验"""
    ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c"
    )[0]["c"]
    logger.info(f"  [全局校验] Episode={ep}, Entity={ent}, Relation={rel}")

    # 消歧
    if ent >= 10:
        logger.info("  [消歧] 实体消歧...")
        all_e = nc.execute_query(
            "MATCH (e:Entity) RETURN e.name AS n, e.description AS d, e.category AS c"
        )
        r = llm.call_json(
            f"实体消歧（同义合并+同名异义拆分）。{json.dumps(all_e[:60], ensure_ascii=False, indent=1)}。"
            '输出:{"merge_groups":[],"split_groups":[]}',
            system_prompt="你是实体消歧专家。",
            max_retries=1, timeout=cfg.TIMEOUT,
        )
        if isinstance(r, dict):
            for g in r.get("merge_groups", []):
                if not isinstance(g, dict):
                    continue
                can = g.get("canonical_name", "")
                if not can:
                    continue
                nc.execute_write("MERGE (e:Entity {name: $n}) SET e.is_canonical=true", {"n": can})
            logger.info(f"    合并组: {len(r.get('merge_groups',[]))}")

    # 冲突检测
    cd = nc.execute_query(
        "MATCH (e:Entity)-[r]->(other:Entity) "
        "WHERE type(r)<>\"EXTRACTED_FROM\" AND type(r)<>\"BELONGS_TO_COMMUNITY\" "
        "AND type(r)<>\"HAS_CONFLICT\" "
        "RETURN e.name AS entity, "
        "COLLECT(DISTINCT {type:type(r), target:other.name}) AS rels LIMIT 40"
    )
    candidates = [row for row in cd if row.get("rels")]
    if len(candidates) >= 3:
        r = llm.call_json(
            f"时序冲突校验:{json.dumps(candidates, ensure_ascii=False, indent=1)[:4000]}。"
            '输出:{"conflicts":[]}',
            max_retries=1, timeout=cfg.TIMEOUT,
        )
        if isinstance(r, dict):
            for cf in r.get("conflicts", []):
                if not isinstance(cf, dict):
                    continue
                nc.execute_write(
                    "CREATE (c:Conflict {concept:$c, conflict_level:$l, description:$d, created_at:datetime()}) "
                    "WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)",
                    {"c": cf.get("concept",""), "l": cf.get("conflict_level",""),
                     "d": cf.get("description","")}
                )
            logger.info(f"    冲突: {len(r.get('conflicts',[]))}")

    # 聚类
    if ent >= 10:
        ce = nc.execute_query(
            "MATCH (e:Entity) RETURN e.name AS n, e.category AS c, e.description AS d LIMIT 60"
        )
        r = llm.call_json(
            f"二级体系聚类。{json.dumps(ce, ensure_ascii=False, indent=1)}。"
            '输出:{"clusters":[]}',
            system_prompt="你是领域聚类专家。",
            max_retries=1, timeout=cfg.TIMEOUT,
        )
        if isinstance(r, dict):
            for cl in r.get("clusters", []):
                if not isinstance(cl, dict):
                    continue
                cid = cl.get("community_id", "")
                if not cid:
                    continue
                nc.execute_write(
                    "MERGE (c:Community {community_id: $cid}) SET c.level=$l, c.created_at=datetime()",
                    {"cid": cid, "l": cl.get("level", "二级")}
                )
                for en in cl.get("entities", []):
                    nc.execute_write(
                        "MATCH (e:Entity {name: $n}) MATCH (c:Community {community_id: $cid}) "
                        "MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)",
                        {"n": en, "cid": cid}
                    )
            logger.info(f"    聚类: {len(r.get('clusters',[]))}")

    # 数据一致性修复
    mm = nc.execute_query(
        "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) "
        "WHERE e.source_folder <> ep.source_folder RETURN COUNT(e) AS c"
    )[0]["c"]
    if mm > 0:
        nc.execute_query(
            "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) "
            "WHERE e.source_folder <> ep.source_folder DELETE r"
        )
        nc.execute_query(
            "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) "
            "MERGE (ep:Episode {source_folder: e.source_folder}) "
            "ON CREATE SET ep.title=e.source_folder, ep.created_at=datetime() "
            "MERGE (e)-[:EXTRACTED_FROM]->(ep)"
        )
    logger.info(f"    错配修复: {mm}")

    return ep, ent, rel


# ============================================================
# 步骤 9: 最终统计报告
# ============================================================
def print_final_report(nc: Neo4jConnection, start_time: float, papers_done: int, papers_failed: int):
    """输出完整统计报告"""
    elapsed = (time.time() - start_time) / 60

    ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" "
        "RETURN COUNT(r) AS c"
    )[0]["c"]
    comm = nc.execute_query("MATCH (c:Community) RETURN COUNT(c) AS c")[0]["c"]
    conflicts = nc.execute_query("MATCH (c:Conflict) RETURN COUNT(c) AS c")[0]["c"]
    orphans = nc.execute_query("MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) RETURN COUNT(e) AS c")[0]["c"]

    # 批次统计
    batches = nc.execute_query(
        "MATCH (e:Entity) WHERE e.batch_run IS NOT NULL "
        "RETURN DISTINCT e.batch_run AS bt, COUNT(e) AS cnt ORDER BY cnt DESC"
    )

    # 关系类型
    rel_types = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" "
        "RETURN DISTINCT type(r) AS t, COUNT(r) AS c ORDER BY c DESC"
    )

    # 质量
    desc_ok = nc.execute_query(
        "MATCH (e:Entity) WHERE e.description IS NOT NULL AND e.description <> \"\" "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    cat_ok = nc.execute_query(
        "MATCH (e:Entity) WHERE e.category IS NOT NULL AND e.category <> \"\" "
        "RETURN COUNT(e) AS c"
    )[0]["c"]
    lv_ok = nc.execute_query(
        "MATCH (e:Entity) WHERE e.level IS NOT NULL AND e.level <> \"\" "
        "RETURN COUNT(e) AS c"
    )[0]["c"]

    logger.info("=" * 70)
    logger.info("  全图库统计报告")
    logger.info("=" * 70)
    logger.info(f"  耗时: {elapsed:.0f} 分钟")
    logger.info(f"  处理: 成功 {papers_done}, 失败 {papers_failed}")
    logger.info(f"")
    logger.info(f"  文献 (Episode):    {ep:>6}")
    logger.info(f"  实体 (Entity):      {ent:>6}")
    logger.info(f"  关系 (Relation):    {rel:>6}")
    logger.info(f"  社区 (Community):   {comm:>6}")
    logger.info(f"  冲突 (Conflict):    {conflicts:>6}")
    logger.info(f"  孤儿实体:           {orphans:>6}")
    logger.info(f"")
    logger.info(f"  数据质量:")
    logger.info(f"    描述覆盖率: {desc_ok}/{ent} ({100*desc_ok/ent:.1f}%)")
    logger.info(f"    分类覆盖率: {cat_ok}/{ent} ({100*cat_ok/ent:.1f}%)")
    logger.info(f"    层级覆盖率: {lv_ok}/{ent} ({100*lv_ok/ent:.1f}%)")
    logger.info(f"")
    logger.info(f"  批次分布:")
    for b in batches:
        logger.info(f"    {b['bt']}: {b['cnt']} entities")
    logger.info(f"")
    logger.info(f"  关系类型:")
    for rt in rel_types:
        logger.info(f"    {rt['t']}: {rt['c']}")
    logger.info("=" * 70)

    # 输出到 JSON 报告
    report = {
        "timestamp": datetime.now().isoformat(),
        "elapsed_min": round(elapsed, 1),
        "papers_done": papers_done,
        "papers_failed": papers_failed,
        "totals": {
            "episodes": ep, "entities": ent, "relations": rel,
            "communities": comm, "conflicts": conflicts, "orphans": orphans,
        },
        "quality": {
            "description_coverage": f"{desc_ok}/{ent}",
            "category_coverage": f"{cat_ok}/{ent}",
            "level_coverage": f"{lv_ok}/{ent}",
        },
        "batches": [{"tag": b["bt"], "entities": b["cnt"]} for b in batches],
        "relation_types": [{"type": rt["t"], "count": rt["c"]} for rt in rel_types],
    }
    report_path = SCRIPT_DIR / f"pipeline_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"  报告已保存: {report_path}")


# ============================================================
# 主入口
# ============================================================
def main():
    logger.info(f"[BATCH] 批次标识: {cfg.BATCH_TAG}")

    # 步骤 1: 密钥检测
    if not step1_check_api_keys():
        sys.exit(1)

    # 步骤 2: 连接与同步
    result = step2_sync_checkpoint()
    if result[0] is None:
        sys.exit(1)
    nc, done_set = result

    # 连接 LLM
    try:
        llm = QwenMaxClient()
        r = llm.call("回复数字1", timeout=15)
        assert r is not None
        logger.info("[步骤3] Qwen3.7-Max 连接正常")
    except Exception as e:
        logger.error(f"  [FATAL] LLM 连接失败: {e}")
        nc.close()
        sys.exit(1)

    # 枚举待处理
    all_dirs = sorted([
        d for d in cfg.BASE_DIR.iterdir()
        if d.is_dir() and d.name != "batch_clean.py"
        and not d.name.startswith(".")  # 坑7
    ])
    pending = [d for d in all_dirs if d.name not in done_set]

    if not pending:
        logger.info("全部论文已处理完毕！执行最终校验...")
        run_global_tasks(nc, llm)
        print_final_report(nc, time.time(), len(done_set), 0)
        nc.close()
        return

    logger.info(f"[开始] 单线程处理 {len(pending)} 篇...")
    start_time = time.time()
    papers_done = 0
    papers_failed = 0
    processed = done_set.copy()

    for idx, folder in enumerate(pending):
        try:
            ok = process_single_paper(folder, nc, llm)
            if ok:
                processed.add(folder.name)
                # 写断点
                cfg.CHECKPOINT_PATH.write_text(
                    json.dumps(sorted(processed), ensure_ascii=False), encoding="utf-8"
                )
                papers_done += 1
            else:
                papers_failed += 1
        except KeyboardInterrupt:
            logger.info("[中断] 用户手动中止")
            break
        except Exception as e:
            logger.error(f"  [FAIL] {folder.name}: {type(e).__name__}: {e}")
            papers_failed += 1

        # 每 N 篇做一次全局处理
        if papers_done > 0 and papers_done % cfg.REPORT_EVERY == 0:
            ep, ent, rel = run_global_tasks(nc, llm)
            elapsed = (time.time() - start_time) / 60
            remaining = len(all_dirs) - len(processed)
            est_h = remaining * (elapsed / papers_done) / 60 if papers_done > 0 else 0
            logger.info(f"  === MILESTONE {len(processed)}/{len(all_dirs)} === "
                       f"{ent} 实体, {rel} 关系 | {elapsed:.0f}min | ~{est_h:.1f}h remaining ===")

    # 最后一轮
    run_global_tasks(nc, llm)
    print_final_report(nc, start_time, papers_done, papers_failed)

    nc.close()
    logger.info("全流程完成！")


if __name__ == "__main__":
    main()
