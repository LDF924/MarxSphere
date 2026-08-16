#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 资本下乡知识图谱流水线 — 全流程踩坑日志 & 解决方案
 v6.0 Final | 2026-07-01
================================================================================

【目录】
  一、API 密钥层 (坑 1-3)
  二、模型参数层 (坑 4-5)
  三、JSON 解析层 (坑 6)
  四、断点/状态管理层 (坑 7)
  五、文件系统层 (坑 8)
  六、Neo4j Cypher 层 (坑 9-11)
  七、编码/环境层 (坑 12-13)
  八、数据质控层 (坑 14)
  九、知识蒸馏层 (坑 15-18)
  十、向量化层 (坑 19)
  十一、成本管控层 (坑 20)
  十二、运维自动化脚本
  十三、最终数据质量校验

================================================================================

一、API 密钥层
──────────────────────────────────────────────────────────────────────────────
坑1:  主密钥欠费 (Arrearage)
      现象: compatible-mode 返回 400 + "Access denied, account in good standing"
      根因: 阿里云百炼账户余额不足
      解决: 准备备用密钥 sk-ws-H.RXMHHLH...，同时更新 qwen_max.key 和
            qwen_embedding.key，统一使用同一工作空间密钥

坑2:  备用密钥 compatible-mode 终结点不可用
      现象: /compatible-mode/v1/chat/completions 始终返回 400
      根因: qwen3.7-max 推理模型与 OpenAI-compatible 接口部分不兼容
      解决: curl 直调用原生 DashScope API:
            /api/v1/services/aigc/text-generation/generation
            Python SDK (QwenMaxClient) 内部仍用 compatible-mode 但经过
            max_tokens 和 timeout 修复后可用

坑3:  DeepSeek V4 Pro 原 key 的 base_url 错误
      现象: 模块4 调用 DeepSeek 始终失败
      根因: 配置文件 deepseek.base_url = "https://api.deepseek.com/v1"
            但该 key 实际通过阿里云 DashScope 调用，正确 URL 是
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
      解决: 统一 base_url 和 key，所有 API 都通过阿里云工作空间调用

【检查脚本】
"""
import sys, json, os, time, re as _re, argparse
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger, QwenMaxClient, DeepSeekClient, QwenEmbeddingClient

logger = get_logger("pipeline_ops")


# ============================================================================
# 步骤 1: API 密钥健康检测
# ============================================================================
def check_api_keys():
    """检测所有 API 密钥的可用性"""
    import requests as _r

    config_file = SCRIPT_DIR / "pipeline_config.json"
    if not config_file.exists():
        logger.error("pipeline_config.json not found")
        return False

    config = json.loads(config_file.read_text(encoding="utf-8"))
    api_section = config.get("api", {})

    results = {}
    all_ok = True

    # 测试 Qwen Max
    qwen_key = api_section.get("qwen_max", {}).get("key", "")
    if qwen_key:
        resp = _r.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
            headers={"Authorization": f"Bearer {qwen_key.strip()}",
                     "Content-Type": "application/json"},
            json={"model": "qwen3.7-max",
                  "input": {"messages": [{"role": "user", "content": "hi"}]},
                  "parameters": {"max_tokens": 5}},
            timeout=30
        )
        ok = resp.status_code == 200
        results["qwen_max"] = ok
        if not ok:
            body = resp.text[:200]
            logger.warning(f"  qwen_max: FAIL ({resp.status_code}) {body}")
            if "Arrearage" in body:
                logger.error("  >>> 欠费 (Arrearage) — 需充值或切换密钥")
            all_ok = False
        else:
            logger.info("  qwen_max: OK")
    else:
        logger.warning("  qwen_max: 密钥未配置")
        all_ok = False

    # 测试 DeepSeek V4 Pro
    ds_key = api_section.get("deepseek", {}).get("key", "")
    if ds_key:
        resp = _r.post(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            headers={"Authorization": f"Bearer {ds_key.strip()}",
                     "Content-Type": "application/json"},
            json={"model": "deepseek-v4-pro",
                  "messages": [{"role": "user", "content": "hi"}],
                  "max_tokens": 5},
            timeout=30
        )
        ok = resp.status_code == 200
        results["deepseek"] = ok
        if not ok:
            logger.warning(f"  deepseek_v4: FAIL ({resp.status_code}) {resp.text[:200]}")
            all_ok = False
        else:
            logger.info("  deepseek_v4: OK")
    else:
        logger.warning("  deepseek_v4: 密钥未配置")
        all_ok = False

    # 测试 Embedding
    emb_key = api_section.get("qwen_embedding", {}).get("key", "")
    if emb_key:
        resp = _r.post(
            "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
            headers={"Authorization": f"Bearer {emb_key.strip()}",
                     "Content-Type": "application/json"},
            json={"model": "text-embedding-v4",
                  "input": {"texts": ["hello"]},
                  "parameters": {"output_type": "dense", "dimension": 1024}},
            timeout=30
        )
        ok = resp.status_code == 200
        results["embedding"] = ok
        if not ok:
            logger.warning(f"  embedding: FAIL ({resp.status_code}) {resp.text[:200]}")
            all_ok = False
        else:
            logger.info("  embedding: OK")
    else:
        logger.warning("  embedding: 密钥未配置")
        all_ok = False

    return all_ok, results


# ============================================================================
# 步骤 2: Neo4j 连接 & 断点同步
# ============================================================================
def sync_checkpoint():
    """从 Neo4j 权威同步断点文件（解决坑7: 多进程并发写破坏）"""
    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        nc.execute_query("RETURN 1 AS t")
    except Exception as e:
        logger.error(f"Neo4j 连接失败: {e}")
        return None, set()

    # 从 DB 读取所有已有实体的论文
    done = nc.execute_query(
        "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) "
        "RETURN DISTINCT ep.source_folder AS f ORDER BY f"
    )
    done_folders = sorted(r["f"] for r in done)

    # 写回 checkpoint
    cp_file = SCRIPT_DIR / ".checkpoint_processed.json"
    cp_file.write_text(json.dumps(done_folders, ensure_ascii=False), encoding="utf-8")

    logger.info(f"Checkpoint synced: {len(done_folders)} papers from Neo4j")
    return nc, set(done_folders)


# ============================================================================
# 步骤 3: 清理僵尸进程
# ============================================================================
def kill_zombie_processes():
    """杀掉所有 python 进程（排除自身）"""
    import subprocess as _sp
    my_pid = os.getpid()
    try:
        result = _sp.run(
            ['cmd.exe', '/c',
             'wmic process where "name=\'python.exe\' or name=\'python3.exe\'" get processid /format:csv'],
            capture_output=True, text=True
        )
        for line in result.stdout.split(chr(10)):
            for part in line.split(','):
                pid = part.strip().strip('"')
                if pid.isdigit() and int(pid) != my_pid:
                    try:
                        _sp.run(['taskkill', '/F', '/PID', pid], capture_output=True)
                    except:
                        pass
    except Exception:
        pass
    logger.info("Zombie processes cleaned")


# ============================================================================
# 步骤 4: 数据质量全量校验
# ============================================================================
def run_quality_check():
    """10 项数据质量校验"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    checks = {}

    # 1. 同名实体冲突
    checks["duplicate_entities"] = nc.execute_query(
        "MATCH (e1:Entity),(e2:Entity) WHERE e1.name = e2.name "
        "AND elementId(e1) < elementId(e2) RETURN count(e1) AS c"
    )[0]["c"]

    # 2-3. 孤儿
    checks["orphan_entities"] = nc.execute_query(
        "MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->() RETURN count(e) AS c"
    )[0]["c"]
    checks["orphan_episodes"] = nc.execute_query(
        "MATCH (ep:Episode) WHERE NOT (ep)<-[:EXTRACTED_FROM]-() RETURN count(ep) AS c"
    )[0]["c"]

    # 4. EXTRACTED_FROM 错配
    checks["extracted_from_mismatch"] = nc.execute_query(
        "MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) "
        "WHERE e.source_folder <> ep.source_folder RETURN count(r) AS c"
    )[0]["c"]

    # 5-7. Null 字段
    checks["null_category"] = nc.execute_query(
        "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN count(e) AS c"
    )[0]["c"]
    checks["null_level"] = nc.execute_query(
        "MATCH (e:Entity) WHERE e.level IS NULL OR e.level = '' RETURN count(e) AS c"
    )[0]["c"]
    checks["null_description"] = nc.execute_query(
        "MATCH (e:Entity) WHERE e.description IS NULL OR size(e.description) < 10 RETURN count(e) AS c"
    )[0]["c"]

    # 8. 关系缺 source_folder
    checks["relations_missing_source"] = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY',"
        "'CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] "
        "AND r.source_folder IS NULL RETURN count(r) AS c"
    )[0]["c"]

    # 9. 空冲突概念
    checks["empty_conflicts"] = nc.execute_query(
        "MATCH (c:Conflict) WHERE c.concept IS NULL OR c.concept = '' RETURN count(c) AS c"
    )[0]["c"]

    # 10. 向量覆盖率
    total_ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
    vec_ent = nc.execute_query(
        "MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS c"
    )[0]["c"]
    checks["vector_coverage"] = f"{vec_ent}/{total_ent}"

    # Totals
    totals = {
        "episodes": nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"],
        "entities": total_ent,
        "relations": nc.execute_query(
            "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY',"
            "'CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] "
            "RETURN count(r) AS c"
        )[0]["c"],
        "communities": nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"],
        "distills": nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"],
        "domain_knowledge": nc.execute_query("MATCH (dk:DomainKnowledge) RETURN count(dk) AS c")[0]["c"],
        "timeline_nodes": nc.execute_query("MATCH (tn:TimelineNode) RETURN count(tn) AS c")[0]["c"],
    }

    nc.close()

    # Print report
    print("\n" + "=" * 55)
    print("  DATA QUALITY REPORT")
    print("=" * 55)
    for k, v in checks.items():
        is_ok = (v == 0) or (isinstance(v, str) and v.split("/")[0] == v.split("/")[1])
        status = "PASS" if is_ok else "WARN"
        print(f"  [{status}] {k}: {v}")

    print(f"\n  Totals: {totals['episodes']} ep | {totals['entities']} ent | "
          f"{totals['relations']} rel | {totals['communities']} comm")
    print(f"  Distill: {totals['distills']} | DomainKn: {totals['domain_knowledge']} | "
          f"Timeline: {totals['timeline_nodes']}")

    issues = [v for v in checks.values() if isinstance(v, int) and v > 0]
    if not issues:
        print("\n  All checks PASSED")
    else:
        print(f"\n  {sum(issues)} issues found")

    return checks, totals


# ============================================================================
# 步骤 5: 清理重复 LiteratureDistill 节点
# ============================================================================
def clean_duplicate_distills():
    """删除同一 source_folder 下 id 较大的重复蒸馏节点"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    before = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"]
    r = nc.execute_query(
        "MATCH (a:LiteratureDistill), (b:LiteratureDistill) "
        "WHERE a.source_folder = b.source_folder AND a.id > b.id "
        "RETURN count(DISTINCT a) AS c"
    )[0]["c"]

    if r > 0:
        d = nc.execute_query(
            "MATCH (a:LiteratureDistill), (b:LiteratureDistill) "
            "WHERE a.source_folder = b.source_folder AND a.id > b.id "
            "DETACH DELETE a RETURN count(a) AS c"
        )[0]["c"]
        logger.info(f"Cleaned {d} duplicate distill nodes")
    else:
        logger.info("No duplicate distills found")

    after = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"]
    unq = nc.execute_query(
        "MATCH (ld:LiteratureDistill) RETURN count(DISTINCT ld.source_folder) AS c"
    )[0]["c"]
    logger.info(f"Distills: {before} -> {after} ({unq} unique)")
    nc.close()


# ============================================================================
# 步骤 6: 检查所有隐藏文件夹
# ============================================================================
def check_hidden_folders():
    """检查 Base Dir 下是否还有隐藏文件夹污染"""
    base = Path(r"D:\Desktop\ov_import")
    hidden = [d for d in base.iterdir() if d.is_dir() and d.name.startswith(".")]
    if hidden:
        logger.warning(f"Found {len(hidden)} hidden folders: {[h.name for h in hidden]}")
    else:
        logger.info("No hidden folders found")
    return hidden


# ============================================================================
# 步骤 7: 空冲突概念清理
# ============================================================================
def clean_empty_conflicts():
    """删除 concept 为空的 Conflict 节点"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    r = nc.execute_query(
        "MATCH (c:Conflict) WHERE c.concept IS NULL OR c.concept = '' "
        "DETACH DELETE c RETURN count(c) AS c"
    )[0]["c"]
    if r > 0:
        logger.info(f"Cleaned {r} empty conflicts")
    nc.close()


# ============================================================================
# 步骤 8: 向量覆盖率检查 & 补漏
# ============================================================================
def fix_missing_vectors():
    """检查并补全缺失的 Distill / Entity 向量"""
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()

    # Entity vectors
    missing_e = nc.execute_query(
        "MATCH (e:Entity) WHERE e.entity_vector IS NULL RETURN count(e) AS c"
    )[0]["c"]
    if missing_e > 0:
        logger.warning(f"Entities missing vectors: {missing_e}")
        # Too many to fix individually here — need pipeline-level fix
    else:
        logger.info("All entities have vectors")

    # Distill vectors
    missing_d = nc.execute_query(
        "MATCH (ld:LiteratureDistill) WHERE ld.distill_vector IS NULL "
        "RETURN ld.id AS id, ld.core_concept_definition AS ccd LIMIT 20"
    )
    logger.info(f"Distills missing vectors: {len(missing_d)}")

    fixed = 0
    for row in missing_d:
        try:
            ccd = json.loads(row["ccd"]) if isinstance(row["ccd"], str) else row["ccd"]
        except:
            ccd = []
        cnames = [c.get("concept_name", "") for c in ccd if isinstance(c, dict)][:5]
        text = f"core: {cnames}"
        vec = emb.embed(text)
        if vec:
            nc.execute_write(
                "MATCH (ld:LiteratureDistill {id: $id}) "
                "SET ld.distill_vector = $v, ld.vectorized = true",
                {"id": row["id"], "v": json.dumps(vec)}
            )
            fixed += 1

    logger.info(f"Fixed {fixed} missing distill vectors")
    nc.close()


# ============================================================================
# 步骤 9: 成本仪表盘
# ============================================================================
def show_cost_dashboard():
    """展示累计成本"""
    import sqlite3
    from pipeline.cache import CACHE_DIR
    db = CACHE_DIR / "text_cache.db"

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

    # LLM cache
    llm_calls = 0
    llm_tokens = 0
    if db.exists():
        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT total_tokens, hit_count FROM llm_cache").fetchall()
        llm_calls = len(rows)
        llm_tokens = sum((r["total_tokens"] or 0) for r in rows)
        conn.close()

    # Embedding cache
    emb_calls = 0
    if db.exists():
        conn = sqlite3.connect(str(db))
        emb_calls = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
        conn.close()

    # Cost
    llm_cost = (llm_tokens * 0.2 / 1000) * 0.004 + (llm_tokens * 0.8 / 1000) * 0.012
    emb_cost = (emb_calls * 200 / 1000) * 0.0007
    total = llm_cost + emb_cost

    # Graph
    ep = nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
    nc.close()

    print("\n" + "=" * 50)
    print("  COST DASHBOARD")
    print("=" * 50)
    print(f"  LLM calls:          {llm_calls:>8}")
    print(f"  LLM tokens:         {llm_tokens:>8}")
    print(f"  Embedding calls:    {emb_calls:>8}")
    print(f"  Graph:              {ep} ep / {ent} ent")
    print(f"  LLM cost:           RMB {llm_cost:.4f}")
    print(f"  Embedding cost:     RMB {emb_cost:.4f}")
    print(f"  TOTAL COST:         RMB {total:.4f}")
    print("=" * 50)


# ============================================================================
# 步骤 10: 完整运维主流程
# ============================================================================
def main():
    parser = argparse.ArgumentParser(description="Pipeline Ops: API check, quality, cleanup, dashboard")
    parser.add_argument("--check-api", action="store_true", help="Check API key health")
    parser.add_argument("--quality", action="store_true", help="Run data quality check")
    parser.add_argument("--clean-duplicates", action="store_true", help="Clean duplicate distill nodes")
    parser.add_argument("--clean-conflicts", action="store_true", help="Clean empty conflict nodes")
    parser.add_argument("--fix-vectors", action="store_true", help="Fix missing distill vectors")
    parser.add_argument("--cost", action="store_true", help="Show cost dashboard")
    parser.add_argument("--sync-checkpoint", action="store_true", help="Sync checkpoint from Neo4j")
    parser.add_argument("--kill-zombies", action="store_true", help="Kill zombie python processes")
    parser.add_argument("--all", action="store_true", help="Run ALL maintenance tasks")
    args = parser.parse_args()

    # If no args, run --all
    if not any(vars(args).values()):
        args.all = True

    start = time.time()

    if args.kill_zombies or args.all:
        logger.info("=== Killing zombie processes ===")
        kill_zombie_processes()

    if args.check_api or args.all:
        logger.info("=== API Key Health Check ===")
        ok, results = check_api_keys()
        if not ok:
            logger.error("Some API checks FAILED. Fix before proceeding.")

    if args.sync_checkpoint or args.all:
        logger.info("=== Syncing Checkpoint ===")
        nc, done = sync_checkpoint()
        if nc:
            nc.close()

    if args.quality or args.all:
        logger.info("=== Data Quality Check ===")
        run_quality_check()

    if args.clean_duplicates or args.all:
        logger.info("=== Cleaning Duplicate Distills ===")
        clean_duplicate_distills()

    if args.clean_conflicts or args.all:
        logger.info("=== Cleaning Empty Conflicts ===")
        clean_empty_conflicts()

    if args.fix_vectors or args.all:
        logger.info("=== Fixing Missing Vectors ===")
        fix_missing_vectors()

    if args.cost or args.all:
        logger.info("=== Cost Dashboard ===")
        show_cost_dashboard()

    elapsed = time.time() - start
    logger.info(f"\nAll tasks completed in {elapsed:.0f}s")


if __name__ == "__main__":
    main()


# ============================================================================
# 附录: 完整踩坑清单速查表
# ============================================================================
"""
┌──────┬────────────────────────────────┬──────────────────────────────────────┐
│ 坑#  │ 问题                           │ 解决方案                              │
├──────┼────────────────────────────────┼──────────────────────────────────────┤
│  1   │ 主密钥欠费 (Arrearage)         │ 备用密钥 sk-ws-H.RXMHHLH...            │
│  2   │ 备用密钥 compatible-mode 不兼容 │ 使用原生 DashScope API                 │
│  3   │ DeepSeek base_url 指向错误      │ 统一为 dashscope.aliyuncs.com          │
│  4   │ max_tokens=4096 截断 JSON       │ → 16384                               │
│  5   │ timeout=120s 不够               │ → 300s                                │
│  6   │ qwen3.7-max 输出包裹 code block │ call_json 中 re.sub 清洗 markdown      │
│  7   │ checkpoint 被并发写破坏         │ 每次启动从 Neo4j 权威重新同步          │
│  8   │ .obsidian 隐藏文件夹污染        │ 过滤 not d.name.startswith('.')        │
│  9   │ Neo4j 5 id() 废弃              │ → elementId()                         │
│ 10   │ Neo4j 5 length() 仅用于 Path   │ → size() 用于字符串                   │
│ 11   │ 关系类型不加引号被当成变量      │ type(r)<>"EXTRACTED_FROM" (加双引号)   │
│ 12   │ Windows GBK 终端中文乱码        │ Python 脚本 + utf-8 + logging 模块     │
│ 13   │ 多个 python 进程残留            │ 启动前 taskkill /F /IM python.exe      │
│ 14   │ 45 篇论文实体=0 的根因          │ max_tokens 不足 → JSON 截断 → 修复    │
│ 15   │ D:\checkpoints 权限拒绝         │ → .checkpoints (脚本目录下)            │
│ 16   │ 蒸馏出现重复节点                │ 清理 a.id > b.id 的同 source_folder    │
│ 17   │ DomainKnowledge c.level='一级'   │ → c.parent_community 匹配替代          │
│ 18   │ LIMIT 语法被字符串替换破坏      │ 手动修复 LIMIT 100$limit → LIMIT 100   │
│ 19   │ Embedding batch_size=50 超限    │ text-embedding-v4 限制 10 条           │
│ 20   │ QwenMaxClient 成本记到 deepseek │ add_usage 类型改为 "qwen_max"          │
└──────┴────────────────────────────────┴──────────────────────────────────────┘

【常用运维命令】
  检查 API 密钥:     python pipeline_ops.py --check-api
  数据质量校验:      python pipeline_ops.py --quality
  清理重复蒸馏节点:  python pipeline_ops.py --clean-duplicates
  补全缺失向量:      python pipeline_ops.py --fix-vectors
  显示成本仪表盘:    python pipeline_ops.py --cost
  一键全量运维:      python pipeline_ops.py --all
  仅杀僵尸进程:      python pipeline_ops.py --kill-zombies
"""
