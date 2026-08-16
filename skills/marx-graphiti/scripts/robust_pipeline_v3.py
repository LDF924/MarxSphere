#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
稳健执行脚本 v5.0 - 四层架构 + 安全全量重跑 + 批次标记
1. 启动时从 Neo4j 同步断点（DB 为权威源）
2. 单篇处理全局 try-except，失败不入断点
3. 断点写入在该篇所有入库操作完成后
4. 每轮结束用 Cypher 校验真实存量
5. 启动前杀旧进程（排除自身 PID），防并发重复写入
6. 数据库连接异常捕获并退出
7. 日志自动备份防覆盖
8. 配置文件路径可覆盖（环境变量优先）
9. 四层架构：摘要(最高优先级) → 问答(轻量化概念) → 术语(标准命名) → 原文(论证据细节)
10. 校验规则：摘要+术语 存在即可处理，缺失次要文件告警不跳过
11. 安全全量模式：不删除历史关系，仅MERGE新建，batch_run字段区分新旧
"""

# ====== 可配置变量（支持环境变量覆盖） ======
import os as _os
import sys as _sys
import json as _json
from datetime import datetime as _dt_cfg
from datetime import datetime as _dt
from pathlib import Path as _Path

# ══════════════════════════════════════════════════════════════════
# LAYER 0: graphiti-pipeline 专属自愈 — 只修 robust_pipeline 遇到的坑
#   踩坑: Neo4j 11001 不可达 / checkpoint JSON 损坏 /
#         LLM API 429 阶梯退避失效 / batch_run 标记冲突 /
#         zombie 子进程残留 / 摘要文件缺失导致整篇跳过
# ══════════════════════════════════════════════════════════════════

def _pflog(msg):
    print(f"[{_dt.now().strftime('%H:%M:%S')}] [PREFLIGHT] {msg}", flush=True)

def preflight_robust_pipeline(cfg):
    fixes = 0

    # ── 1. Neo4j 11001 连通性 + 版本检查 ──
    neo4j_uri = cfg.get("NEO4J_URI", "bolt://127.0.0.1:11001")
    neo4j_user = cfg.get("NEO4J_USER", "neo4j")
    neo4j_pwd = cfg.get("NEO4J_PASSWORD", "neo4j123")
    try:
        from neo4j import GraphDatabase as _N4
        _d = _N4.driver(neo4j_uri, auth=(neo4j_user, neo4j_pwd))
        _d.verify_connectivity()
        _s = _d.session()
        _td = _s.run("MATCH (n:TextDocument) RETURN count(n) AS c").single()["c"]
        _ep = _s.run("MATCH (n:Entity) RETURN count(n) AS c").single()["c"]
        _s.close(); _d.close()
        _pflog(f"INFO: Neo4j {neo4j_uri} reachable (TextDocs={_td}, Entities={_ep})")
    except Exception as _e:
        _pflog(f"FATAL: Neo4j {neo4j_uri} unreachable — {str(_e)[:100]}")
        return fixes  # let the main pipeline handle the error with proper exit

    # ── 2. checkpoint JSON 健康 ──
    _cp_path = _Path(cfg.get("CHECKPOINT_PATH", r"D:\Desktop\执行流程\.checkpoint_processed._json"))
    if _cp_path.exists():
        try:
            _data = _json.loads(_cp_path.read_text("utf-8"))
            if isinstance(_data, list):
                _pflog(f"INFO: checkpoint valid ({len(_data)} entries)")
            else:
                _pflog("FIX: checkpoint type wrong — reset to []")
                _cp_path.write_text("[]", "utf-8")
                fixes += 1
        except (_json.JSONDecodeError, UnicodeDecodeError):
            _pflog("FIX: checkpoint JSON corrupt — reset to []")
            _cp_path.parent.mkdir(parents=True, exist_ok=True)
            _cp_path.write_text("[]", "utf-8")
            fixes += 1

    # ── 3. 源目录存在 + 论文文件夹完整性 ──
    _base = _Path(cfg.get("BASE_DIR", r"D:\Desktop\ov_import"))
    if not _base.exists():
        _pflog(f"FATAL: BASE_DIR not found: {_base}")
        return fixes
    _paper_dirs = [d for d in _base.iterdir() if d.is_dir() and not d.name.startswith(".")]
    if len(_paper_dirs) < 200:
        _pflog(f"WARN: only {len(_paper_dirs)} paper dirs in {_base} (expected 290+)")
    else:
        # 抽样检查：前 5 个文件夹是否至少含摘要+术语
        _missing = 0
        for _d in _paper_dirs[:5]:
            _files = {f.name for f in _d.iterdir() if f.is_file()}
            if "摘要.md" not in _files and "术语表.md" not in _files:
                _missing += 1
        if _missing:
            _pflog(f"WARN: {_missing}/5 sampled dirs missing 摘要.md or 术语表.md")
    _pflog(f"INFO: {len(_paper_dirs)} paper dirs in source")

    if fixes:
        _pflog(f"{fixes} fixes applied")
    return fixes

# 全局批次标记：本轮全量重跑的统一标识
BATCH_TAG = _os.environ.get("PIPELINE_BATCH_TAG", f"v3_incremental_{_dt_cfg.now().strftime('%Y%m%d')}")
logger_placeholder = None  # will be set after get_logger

DEFAULT_CONFIG = {
    "BASE_DIR":         _os.environ.get("PIPELINE_BASE_DIR",       r"D:\Desktop\ov_import"),
    "NEO4J_URI":        _os.environ.get("PIPELINE_NEO4J_URI",      "bolt://127.0.0.1:11001"),
    "NEO4J_USER":       _os.environ.get("PIPELINE_NEO4J_USER",     "neo4j"),
    "NEO4J_PASSWORD":   _os.environ.get("PIPELINE_NEO4J_PASSWORD", "neo4j123"),
}

CONFIG = type("Config", (), DEFAULT_CONFIG)()

import subprocess as _sp

def _kill_old_pipeline():
    """启动前终止旧 robust_pipeline_v3.py 进程（排除自身）"""
    import os as _os_kill
    from pathlib import Path as _Path_kill
    pid = _os_kill.getpid()
    script_name = _Path_kill(__file__).name

    try:
        result = _sp.run(
            ['cmd.exe', '/c', 'wmic process where "name=python.exe" get commandline,processid /format:csv'],
            capture_output=True, text=True
        )
        for line in result.stdout.split(chr(10)):
            if script_name in line and str(pid) not in line:
                parts = line.strip().split(',')
                if len(parts) >= 2:
                    target_pid = parts[-1].strip('\"')
                    if target_pid.isdigit():
                        _sp.run(['taskkill', '/F', '/PID', target_pid], capture_output=True)
    except Exception:
        pass

_kill_old_pipeline()
from pathlib import Path
from datetime import datetime as _dt2
from collections import Counter
from typing import Dict, List
import shutil as _shutil

SCRIPT_DIR = Path(__file__).parent
_sys.path.insert(0, str(SCRIPT_DIR.parent))
from pipeline import Neo4jConnection, get_logger, DeepSeekClient

logger = get_logger("robust_v3")
logger.info(f"[BATCH] 本轮批次标识: {BATCH_TAG}")

BASE_DIR = Path(CONFIG.BASE_DIR)

# ====== 前置条件检查 ======
# 1. 数据源必须存在
if not BASE_DIR.exists():
    logger.error(f"[FATAL] 数据源目录不存在: {BASE_DIR}")
    _sys.exit(1)
paper_dirs = [d for d in BASE_DIR.iterdir() if d.is_dir() and not d.name.startswith(".")]
if len(paper_dirs) < 200:
    logger.warning(f"[WARN] 数据源仅 {len(paper_dirs)} 个论文文件夹 (预期 290+)")
else:
    logger.info(f"[OK] 数据源: {len(paper_dirs)} 个论文文件夹")

# 2. checkpoint JSON 损坏自动修复
CHECKPOINT_PATH = r"D:\Desktop\执行流程\.checkpoint_processed.json"
cp = Path(CHECKPOINT_PATH)
if cp.exists():
    try:
        _json.loads(cp.read_text("utf-8"))
    except (_json.JSONDecodeError, UnicodeDecodeError):
        cp.write_text("[]", "utf-8")
        logger.warning(f"[AUTO-HEAL] 重置损坏的 checkpoint JSON")

# ====== 数据库连接异常捕获 ======
try:
    neo4j = Neo4jConnection(uri=CONFIG.NEO4J_URI, user=CONFIG.NEO4J_USER, password=CONFIG.NEO4J_PASSWORD)
    test = neo4j.execute_query("RETURN 1 AS test")
    assert test[0]["test"] == 1
except Exception as e:
    logger.error(f"[FATAL] Neo4j 连接失败: {e}")
    _sys.exit(1)

try:
    llm = DeepSeekClient()
    r = llm.call("回一个数字: 1", timeout=15)
    assert r is not None
except Exception as e:
    logger.error(f"[FATAL] DeepSeek-v4-pro 连接失败: {e}")
    _sys.exit(1)

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"
VALID_REL_TYPES = {"PROPOSED_BY","PUBLISHED_IN","INHERITS_FROM","CRITIQUES","DEVELOPS_INTO","LEAD_TO","BELONG_TO","CONTRAST_WITH"}

STAGES = {
    "entity_extraction": True,
    "relation_extraction": True,
    "disambiguation": True,
    "conflict_detection": True,
    "clustering": True,
}
REPORT_EVERY = 20

# ====== 1. 从 Neo4j 同步断点（DB 为权威源） ======
CHECKPOINT_FILE = SCRIPT_DIR / ".checkpoint_processed.json"

db_folders = set()
try:
    records = neo4j.execute_query("MATCH (ep:Episode) RETURN ep.source_folder AS f")
    db_folders = set(r['f'] for r in records)
    logger.info(f"[SYNC] Neo4j 历史合格文献: {len(db_folders)} 篇")
except Exception as e:
    logger.error(f"[FATAL] 无法读取 Neo4j Episode: {e}")
    _sys.exit(1)

# 不从 DB 覆盖 checkpoint，而是用 DB 作为兜底验证
# processed_folders 从本地 checkpoint 文件加载（保留断点）
processed_folders = set()
if CHECKPOINT_FILE.exists():
    try:
        content = CHECKPOINT_FILE.read_text("utf-8").strip()
        if content:
            processed_folders = set(_json.loads(content))
            logger.info(f"[断点] 从本地 checkpoint 加载: {len(processed_folders)} 篇")
        else:
            logger.warning("[断点] checkpoint 文件为空，将用 DB 初始化")
            CHECKPOINT_FILE.unlink()
    except (_json.JSONDecodeError, Exception) as e:
        logger.warning(f"[断点] checkpoint 损坏 ({e})，丢弃历史记录，用 DB 初始化")
        CHECKPOINT_FILE.unlink(missing_ok=True)

if not CHECKPOINT_FILE.exists():
    # 首次运行或 checkpoint 损坏：用 DB 初始化
    processed_folders = db_folders
    tmp_cp = CHECKPOINT_FILE.with_suffix(".tmp")
    tmp_cp.write_text(_json.dumps(sorted(processed_folders), ensure_ascii=False), encoding="utf-8")
    tmp_cp.replace(CHECKPOINT_FILE)
    logger.info(f"[断点] 初始化: {len(processed_folders)} 篇")

# ====== 2. 枚举待处理文献 ======
all_dirs = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and d.name != "batch_clean.py" and not d.name.startswith('.')])

def save_checkpoint():
    """持久化断点：先写临时文件，再原子覆盖，防中断损坏"""
    tmp_cp = CHECKPOINT_FILE.with_suffix(".tmp")
    tmp_cp.write_text(_json.dumps(sorted(processed_folders), ensure_ascii=False), encoding="utf-8")
    tmp_cp.replace(CHECKPOINT_FILE)

def verify_db_counts():
    """从 Neo4j 校验当前图库真实存量"""
    ep = neo4j.execute_query("MATCH (ep:Episode) RETURN count(ep) as c")[0]['c']
    ent = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) as c")[0]['c']
    rel = neo4j.execute_query("MATCH ()-[r]->() WHERE type(r)<>'EXTRACTED_FROM' AND type(r)<>'BELONGS_TO_COMMUNITY' AND type(r)<>'HAS_CONFLICT' RETURN count(r) as c")[0]['c']
    return ep, ent, rel

# 正常增量模式：仅处理 checkpoint 中未标记的文献
pending = [d for d in all_dirs if d.name not in processed_folders]

# 分批入库：环境变量或命令行参数控制每轮最大处理数（默认30）
_BATCH_SIZE_ARG = None
for _i, _a in enumerate(_sys.argv):
    if _a == "--batch-size" and _i + 1 < len(_sys.argv):
        _BATCH_SIZE_ARG = int(_sys.argv[_i + 1])
        break
BATCH_SIZE = _BATCH_SIZE_ARG or int(_os.environ.get("PIPELINE_BATCH_SIZE", 30))
pending = pending[:BATCH_SIZE]

logger.info(f"[INIT] 总文献: {len(all_dirs)}, 已处理: {len(processed_folders)}, 待处理(全量): {len([d for d in all_dirs if d.name not in processed_folders])}, 本轮: {len(pending)}")

if not pending:
    logger.info("全部论文已处理完毕！")
    run_global_tasks()
    fix_all_mismatches()
    save_checkpoint()
    ep, ent, rel = verify_db_counts()
    logger.info(f"[最终校验] Episode={ep}, Entity={ent}, Relation={rel}")
    neo4j.close()
    _sys.exit(0)

# ====== 文件读取（固定优先级：摘要 → 问答 → 术语 → 原文） ======
def read_literature(folder: Path) -> Dict[str, str]:
    priority_map = [
        ("摘要",    ["摘要","摘"]),
        ("问答",    ["问答","問答","问"]),
        ("术语",    ["术语"]),
        ("original", ["original"]),
    ]
    result = {}
    for key, kws in priority_map:
        for f in folder.glob("*.md"):
            fn = f.name
            if any(k in fn for k in kws):
                result[key] = f.read_text(encoding="utf-8")
                break
    return result

# ====== 3. 全局异常捕获 ====
# ====== 日志备份（保留历史运行日志） ======
import shutil as _shutil
_V3_LOG = Path(os.environ.get('TEMP','')) / "robust_v3_console.log"
if _V3_LOG.exists():
    _backup = Path(str(_V3_LOG).replace('.log', f'_backup_{len(db_folders)}papers.log'))
    _shutil.copy(_V3_LOG, _backup)
    logger.info(f"[BACKUP] 历史日志已备份: {_backup}")

# ====== 3. 全局异常捕获 ======
def process_one_safe(folder: Path) -> bool:
    try:
        return process_one(folder)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        logger.error(f"[FAIL] {folder.name}: {type(e).__name__}: {e}")
        logger.debug(traceback.format_exc())
        return False

def process_one(folder: Path) -> bool:
    fname = folder.name
    texts = read_literature(folder)
    # 校验：摘要 + 术语存在即可处理，缺失次要文件告警但不跳过
    required_keys = ["摘要", "术语"]
    missing_required = [k for k in required_keys if k not in texts or not texts[k]]
    if missing_required:
        logger.warning(f"[SKIP] {fname}: 缺失核心文件 {missing_required}")
        return False

    missing_optional = [k for k in ["问答", "original"] if k not in texts or not texts[k]]
    if missing_optional:
        logger.warning(f"[WARN] {fname}: 缺失次要文件 {missing_optional}，继续处理")

    # Episode
    neo4j.execute_write("MERGE (ep:Episode {source_folder:$f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
                        {"f": fname})

    # ── 实体抽取（输入顺序：摘要 → 问答 → 术语 → 原文）──
    entities = []
    if STAGES.get("entity_extraction"):
        prompt_e = (
            f"【文献摘要 - 最高优先级】{texts.get('摘要','')[:2000]}\n"
            f"【配套问答知识点 - 轻量化概念】{texts.get('问答','')[:2000]}\n"
            f"【专业术语表 - 标准化名词库】{texts.get('术语','')[:2000]}\n"
            f"【原文全文 - 补充论证细节】{texts.get('original','')[:10000]}\n"
            f"\n"
            f"你是马克思主义理论领域知识抽取专家。从以上文献中抽取实体节点，全部字段必填。\n"
            f"十大实体分类: {ENTITY_CATEGORIES}\n"
            f"\n"
            f"规则:\n"
            f"- name/category/level/description/subcategory/aliases/context 全部必填\n"
            f"- level 只能是「一级概念」或「二级子概念」\n"
            f"- description 不少于15字\n"
            f"- 空值填空数组[]或空字符串\"\"\n"
            f"- 优先核心范畴，不抽细碎短句\n"
            f"- 摘要中的核心论点、核心人物、核心理论、创新点、研究结论一个都不能少\n"
            f"- 术语表中的概念全称、简称、别名、所属分类必须全部抽取\n"
            f"- 输出JSON格式: {{\"entities\":[{{\"name\":\"唯物史观\",\"category\":\"理论概念\",\"level\":\"一级概念\",\"description\":\"社会存在决定社会意识的历史唯物主义核心理论\",\"subcategory\":\"基础理论学说\",\"aliases\":[\"历史唯物主义\"],\"context\":\"马哲核心\"}}]}}"
        )

        for retry in range(3):
            r = llm.call_json(prompt_e,
                              system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
                              max_retries=1, timeout=300)
            if isinstance(r, dict) and r.get("entities"): entities = r["entities"]; break
            elif isinstance(r, list): entities = r; break
            if retry < 2:
                logger.warning(f"  [实体重试 {retry+1}/3]")
                prompt_e += "\n务必输出 entities 数组，所有字段都填完整。"

    valid_ent = 0
    for ent in entities:
        if not isinstance(ent, dict): continue
        name = ent.get("name", "")
        if not name: continue
        props = {
            "category": ent.get("category", ""), "subcategory": ent.get("subcategory", ""),
            "level": ent.get("level", "二级子概念"), "description": ent.get("description", ""),
            "aliases": ent.get("aliases", []), "context": ent.get("context", ""), "source_folder": fname,
        }
        neo4j.execute_write("""
            MERGE (e:Entity {name: $name})
            SET e += $props, e.created_at = COALESCE(e.created_at, datetime())
            WITH e MATCH (ep:Episode {source_folder:$folder})
            MERGE (e)-[rf:EXTRACTED_FROM]->(ep)
            SET rf.source_folder = $folder, rf.batch_run = $batch_tag
        """, {"name": name, "props": props, "folder": fname, "batch_tag": BATCH_TAG})
        valid_ent += 1

    logger.info(f"  [{fname[:40]}] 实体: {valid_ent}")

    # === 最小实体阈值：实体太少不推进断点 ===
    MIN_ENTITY_THRESHOLD = 5
    if valid_ent < MIN_ENTITY_THRESHOLD:
        logger.warning(f"  [{fname[:40]}] 实体数 {valid_ent} < {MIN_ENTITY_THRESHOLD}，不标记完成，下次自动重试")
        return False

    # ── 关系抽取 ──
    valid_rel = 0
    if STAGES.get("relation_extraction") and valid_ent >= 2:
        ent_names = neo4j.execute_query(
            "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder:$f}) RETURN e.name AS n ORDER BY e.created_at DESC LIMIT 20",
            {"f": fname})
        names = [r['n'] for r in ent_names]

        rel_prompt = (
            f"基于以下实体列表以及文献的四层内容，抽取实体间的逻辑关系三元组。\n"
            f"\n"
            f"【文献摘要 - 全局认知】{texts.get('摘要','')[:1200]}\n"
            f"【配套问答 - 概念区分】{texts.get('问答','')[:1200]}\n"
            f"【术语表 - 标准命名】{texts.get('术语','')[:1200]}\n"
            f"【原文片段 - 论证支撑】{texts.get('original','')[:2000]}\n"
            f"\n"
            f"已知实体: {', '.join(names)}\n"
            f"关系类型（必须选以下之一）: PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH\n"
            f"输出JSON: {{\"relations\":[{{\"source\":\"...\",\"relation_type\":\"BELONG_TO\",\"target\":\"...\",\"confidence\":0.9,\"description\":\"...\"}}]}}\n"
            f"至少输出3条关系。优先从摘要和问答中抽取明确提出的关系。"
        )

        r = llm.call_json(rel_prompt,
                          system_prompt="你是马理论关系抽取专家。严格输出JSON，至少3条关系。",
                          max_retries=1, timeout=300)
        relations = []
        if isinstance(r, dict) and r.get("relations"): relations = r["relations"]
        elif isinstance(r, list): relations = r

        for rel in relations:
            if not isinstance(rel, dict): continue
            src, tgt, rtype = rel.get("source",""), rel.get("target",""), rel.get("relation_type","")
            if not src or not tgt or rtype not in VALID_REL_TYPES: continue
            sc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) AS c", {"n":src})
            tc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) AS c", {"n":tgt})
            if sc[0]['c'] == 0 or tc[0]['c'] == 0: continue
            try:
                with neo4j.driver.session() as s:
                    s.run(f"""
                        MATCH (a:Entity {{name:$s}}) MATCH (b:Entity {{name:$t}})
                        MERGE (a)-[rr:{rtype} {{source_folder:$f}}]->(b)
                        SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime(), rr.batch_run=$batch_tag
                    """, {"s":src, "t":tgt, "f":fname, "c":rel.get("confidence",0.8), "d":rel.get("description",""), "batch_tag": BATCH_TAG})
                valid_rel += 1
            except Exception as e:
                logger.warning(f"    rel fail: {src}--[{rtype}]-->{tgt}: {e}")

        logger.info(f"  [{fname[:40]}] 关系: {valid_rel}/{len(relations)}")

    # === 原则：process_one 只负责返回 True/False，不接触 processed_folders
    # process_one_safe 在外层控制断点写入，仅 ok=True 时写入
    # 实体不足会提前返回 False，不会推进断点
    return True


# ====== 全局任务 ======
def run_global_tasks():
    ep, ent, rel = verify_db_counts()
    logger.info(f"[全局校验] Episode={ep}, Entity={ent}, Relation={rel}")

    # 消歧
    if STAGES.get("disambiguation") and ent >= 10:
        logger.info("[全局] 实体消歧...")
        all_e = neo4j.execute_query("MATCH (e:Entity) RETURN e.name AS n, e.description AS d, e.category AS c")
        r = llm.call_json(f"实体消歧（同义合并+同名异义拆分）。{_json.dumps(all_e[:60], ensure_ascii=False, indent=1)}。输出:{{merge_groups:[],split_groups:[]}}",
                          system_prompt="你是实体消歧专家。", max_retries=1, timeout=120)
        if isinstance(r, dict):
            for g in r.get("merge_groups", []):
                if not isinstance(g, dict):
                    continue
                can = g.get("canonical_name","")
                if not can: continue
                neo4j.execute_write("MERGE (e:Entity {name:$n}) SET e.is_canonical=true", {"n":can})
                for a in g.get("aliases", []):
                    neo4j.execute_write("MATCH (a:Entity {name:$a}) MATCH (c:Entity {name:$c}) OPTIONAL MATCH (a)-[r]->(n) WHERE n:Entity FOREACH (_ IN CASE WHEN r IS NOT NULL THEN [1] ELSE [] END | MERGE (c)-[nr:RELATION]->(n) SET nr=properties(r)) DETACH DELETE a", {"a":a,"c":can})
            logger.info(f"[全局] 消歧: 合并{len(r.get('merge_groups',[]))}, 拆分{len(r.get('split_groups',[]))}")

    # 冲突
    if STAGES.get("conflict_detection"):
        cd = neo4j.execute_query("MATCH (e:Entity)-[r]->(other:Entity) WHERE type(r)<>'EXTRACTED_FROM' AND type(r)<>'BELONGS_TO_COMMUNITY' AND type(r)<>'HAS_CONFLICT' RETURN e.name AS entity, collect(DISTINCT {type:type(r), target:other.name}) AS rels LIMIT 30")
        candidates = [row for row in cd if row.get("rels") and any(r.get("type") for r in row["rels"])]
        if len(candidates) >= 3:
            r = llm.call_json(f"时序冲突校验:{_json.dumps(candidates,ensure_ascii=False,indent=1)[:3000]}。输出:{{conflicts:[]}}", max_retries=1, timeout=120)
            if isinstance(r, dict):
                for cf in r.get("conflicts", []):
                    neo4j.execute_write("CREATE (c:Conflict {concept:$c,conflict_level:$l,description:$d,created_at:datetime()}) WITH c MATCH (e:Entity {name:$c}) MERGE (e)-[:HAS_CONFLICT]->(c)", {"c":cf.get("concept",""),"l":cf.get("conflict_level",""),"d":cf.get("description","")})
                logger.info(f"[全局] 冲突: {len(r.get('conflicts',[]))}")

    # 聚类
    if STAGES.get("clustering") and ent >= 10:
        ce = neo4j.execute_query("MATCH (e:Entity) RETURN e.name AS n, e.category AS c, e.description AS d")
        r = llm.call_json(f"二级体系聚类（马哲/政治经济学/科学社会主义/马理论中国化/西方马克思主义/思想史）。{_json.dumps(ce[:40],ensure_ascii=False,indent=1)}。输出:{{clusters:[]}}", system_prompt="你是领域聚类专家。", max_retries=1, timeout=120)
        if isinstance(r, dict):
            for cl in r.get("clusters", []):
                cid = cl.get("community_id","")
                if not cid: continue
                neo4j.execute_write("MERGE (c:Community {community_id:$cid}) SET c.level=$l, c.created_at=datetime()", {"cid":cid, "l":cl.get("level","二级")})
                for en in cl.get("entities", []):
                    neo4j.execute_write("MATCH (e:Entity {name:$n}) MATCH (c:Community {community_id:$cid}) MERGE (e)-[:BELONGS_TO_COMMUNITY]->(c)", {"n":en,"cid":cid})
            logger.info(f"[全局] 聚类: {len(r.get('clusters',[]))}")


def fix_all_mismatches():
    mm = neo4j.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder RETURN count(e) AS c")[0]['c']
    if mm > 0:
        logger.info(f"[修复] 错配: {mm}")
        neo4j.execute_query("MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder DELETE r")
        neo4j.execute_query("MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->(:Episode) MERGE (ep:Episode {source_folder:e.source_folder}) ON CREATE SET ep.title=e.source_folder, ep.created_at=datetime() MERGE (e)-[:EXTRACTED_FROM]->(ep)")
    return mm


# ====== 主循环 ======
logger.info(f"[开始] 单线程逐篇处理 {len(pending)} 篇...")
start_time = time.time()
papers_done = 0
papers_failed = 0

for idx, folder in enumerate(pending):
    try:
        ok = process_one_safe(folder)
        if ok:
            # 只有整篇无报错、DB 全部写入完成后，才标记为已处理
            processed_folders.add(folder.name)
            save_checkpoint()
            papers_done += 1
        else:
            papers_failed += 1
    except KeyboardInterrupt:
        logger.info("[中断] 用户手动中止")
        save_checkpoint()
        break

    # 每20篇：校验 + 全局任务
    if papers_done > 0 and papers_done % REPORT_EVERY == 0:
        ep, ent, rel = verify_db_counts()
        elapsed = (time.time() - start_time) / 60
        remaining = len(all_dirs) - ep
        est_h = remaining * (elapsed / papers_done) / 60 if papers_done > 0 else 0
        logger.info(f"=== MILESTONE {ep}/{len(all_dirs)} === {ent} 实体, {rel} 关系 | {elapsed:.0f}min | ~{est_h:.1f}h remaining ===")
        run_global_tasks()
        fix_all_mismatches()

# 最后一轮
ep, ent, rel = verify_db_counts()
elapsed = (time.time() - start_time) / 60
logger.info(f"=== FINAL === {ep}/{len(all_dirs)} papers, {ent} entities, {rel} relations | {elapsed:.0f}min total ===")
run_global_tasks()
fix_all_mismatches()
save_checkpoint()

# 最终校验
ep2, ent2, rel2 = verify_db_counts()
logger.info(f"[校验] DB: {ep2} papers, {ent2} entities, {rel2} relations, 错配={fix_all_mismatches()}")

neo4j.close()
logger.info("全流程完成！")
