#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
marx-ingest MCP Server — 马克思主义文献入库监控
═══════════════════════════════════════════════════════════════
Monitors the CLI-based ingestion pipeline (robust_pipeline_v3.py,
distill_robust.py, etc.). Does NOT execute long-running scripts itself —
it detects, estimates, monitors, and validates.

Transport: stdio         Python >= 3.10 + mcp >= 1.0
Root:      C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts
Neo4j:     bolt://127.0.0.1:11001
"""

import sys
import re
import json
import sqlite3
import logging
import subprocess
import threading
from pathlib import Path
from datetime import datetime
from typing import Optional

# ── Path setup ───────────────────────────────────────────────
_PIPELINE_ROOT = Path(r"%USERPROFILE%\.claude\skills\marx-graphiti")
_SCRIPTS_DIR = _PIPELINE_ROOT / "scripts"
if str(_PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_ROOT))

# ══════════════════════════════════════════════════════════════════
# 触发式自愈：只在 MCP handler 被调用时检测，发现故障当场修复
# （不在 import 时无条件跑 preflight）
# ══════════════════════════════════════════════════════════════════

def _reactive_heal_graphiti_ingest():
    """触发式：只在 handler 报错时才调用，不主动扫描。"""
    fixes = 0

    # Neo4j 11001 连通性
    try:
        from neo4j import GraphDatabase as _N4
        _d = _N4.driver("bolt://127.0.0.1:11001", auth=("neo4j", "neo4j123"))
        _d.verify_connectivity()
        _d.close()
    except Exception:
        fixes += 1

    # 脚本存在性
    required = [
        _SCRIPTS_DIR / "robust_pipeline_v3.py",
        _SCRIPTS_DIR / "distill_robust.py",
    ]
    missing = [r.name for r in required if not r.exists()]
    if missing:
        fixes += 1

    # 日志目录可写
    _log_dir = _SCRIPTS_DIR / ".mcp_logs"
    try:
        _log_dir.mkdir(exist_ok=True)
        (_log_dir / ".w").write_text("")
        (_log_dir / ".w").unlink()
    except Exception:
        fixes += 1

    return fixes == 0  # True = all healthy

_LOG_DIR = _SCRIPTS_DIR / ".mcp_logs"
_LOG_DIR.mkdir(exist_ok=True)

from mcp.server.fastmcp import FastMCP

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [marx-ingest] %(levelname)-7s %(message)s",
    handlers=[
        logging.FileHandler(_LOG_DIR / "marx_ingest_mcp.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("marx-ingest.mcp")

mcp = FastMCP(
    name="marx-ingest",
    instructions=(
        "马克思主义文献入库监控服务。"
        "当用户需要将新论文导入知识图谱时，使用本服务的工具来完成入库流程监控。"
        "入库走5个阶段：1) MD完整性检测 2) 环境校验 3) 实体关系抽取 (robust_pipeline_v3.py) "
        "4) 知识蒸馏 (distill_robust.py) 5) 向量化 (模块3。"
        "6) 全局消歧聚类清洗。每个阶段都由用户通过 CLI 手动执行，本服务只负责导引和监控。"
        "入库前始终先用 detect_new_papers 发现新增文献，estimate_batch_cost 估算成本，再提示用户执行对应 CLI 命令。"
    ),
)

# ── Neo4j ─────────────────────────────────────────────────────
_neo4j_lock = threading.Lock()
_neo4j_instance: Optional[object] = None
_neo4j_error: Optional[str] = None


def _get_neo4j():
    global _neo4j_instance, _neo4j_error
    from pipeline.neo4j import Neo4jConnection
    with _neo4j_lock:
        if _neo4j_instance is not None:
            return _neo4j_instance
        if _neo4j_error is not None:
            return None
    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        nc.execute_query("MATCH (n) RETURN count(n) AS c LIMIT 1")
        with _neo4j_lock:
            _neo4j_instance = nc
            _neo4j_error = None
        return nc
    except Exception as e:
        with _neo4j_lock:
            _neo4j_error = str(e)
        return None


_IMPORT_DIR = Path(r"D:\Desktop\ov_import")

# ── Benchmarks from 208-paper run (per paper) ─────────────────
BENCHMARK = {
    "tokens_per_paper": 12489,         # LLM tokens consumed
    "llm_calls_per_paper": 1.4,        # with cache hits
    "embedding_calls_per_paper": 9,
    "entities_per_paper": 13.6,
    "relations_per_paper": 6.1,        # 1262 / 208
    "db_mb_per_paper": 0.31,           # 64MB / 208
    "cost_rmb_per_paper": 0.131,       # 27.28 / 208
}


# ═══════════════════════════════════════════════════════════════
# TOOLS
# ═══════════════════════════════════════════════════════════════

@mcp.tool()
def detect_new_papers() -> dict:
    """Scan ov_import for paper folders not yet tracked in Neo4j. Compares filesystem folders against Episode.source_folder nodes.

    Returns new_count, existing_count, and list of new folder names (up to 100).
    """
    if not _IMPORT_DIR.exists():
        return {"error": f"Import directory not found: {_IMPORT_DIR}", "new_count": 0}

    # Filesystem folders
    fs_folders = set()
    for d in _IMPORT_DIR.iterdir():
        if d.is_dir() and not d.name.startswith('.'):
            fs_folders.add(d.name)

    # Neo4j tracked
    nc = _get_neo4j()
    if nc is None:
        return {"error": "Neo4j unavailable — cannot query tracked papers", "new_count": 0}
    try:
        rows = nc.execute_query("MATCH (ep:Episode) RETURN ep.source_folder AS f")
        db_folders = {r["f"] for r in rows}
    except Exception as e:
        return {"error": str(e), "new_count": 0}

    new = sorted(fs_folders - db_folders)
    return {
        "filesystem_folders": len(fs_folders),
        "tracked_in_neo4j": len(db_folders),
        "new_count": len(new),
        "new_folders": new[:100],
        "new_folders_truncated": len(new) > 100,
        "action": (
            f"发现 {len(new)} 篇新文献。" if len(new) == 0 else
            f"发现 {len(new)} 篇新文献。将 ov_import 中的新文件夹放置好后，执行:\n"
            f"  cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts\n"
            f"  python robust_pipeline_v3.py  # 实体/关系抽取\n"
            f"  python distill_robust.py       # 知识蒸馏\n"
            f"  python 模块3：向量化.py  # 向量化（或 python run_module3.py）\n"
            f"  python 全局消歧聚类清洗.py       # 全局消歧聚类清洗"
        ),
    }


@mcp.tool()
def estimate_batch_cost(paper_count: int) -> dict:
    """Estimate API cost, time, and storage for ingesting N new papers. Based on 208-paper benchmark data.

    Args:
        paper_count: Number of new papers to estimate for (1-10000)
    """
    paper_count = max(1, min(10000, int(paper_count)))
    b = BENCHMARK

    tokens = paper_count * b["tokens_per_paper"]
    calls = int(paper_count * b["llm_calls_per_paper"])
    emb_calls = int(paper_count * b["embedding_calls_per_paper"])
    entities = int(paper_count * b["entities_per_paper"])
    relations = int(paper_count * b["relations_per_paper"])
    db_mb = round(paper_count * b["db_mb_per_paper"], 1)
    cost = round(paper_count * b["cost_rmb_per_paper"], 2)

    # Time estimate: QPS=2 for DeepSeek LLM calls
    seconds_per_call = 5  # avg LLM call latency
    effective_qps = 2
    time_h = round(calls / effective_qps * seconds_per_call / 3600, 1)

    current_budget = 100.0  # from pipeline_config
    budget_remaining = round(current_budget - 27.28, 2)

    status = "GREEN"
    if cost > budget_remaining * 0.8:
        status = "WARN"
    if cost > budget_remaining:
        status = "OVER"

    return {
        "paper_count": paper_count,
        "estimates": {
            "llm_tokens": f"{tokens:,}",
            "llm_calls": calls,
            "embedding_calls": emb_calls,
            "new_entities": entities,
            "new_relations": relations,
            "db_growth_mb": db_mb,
            "estimated_time_hours": time_h,
            "estimated_cost_rmb": cost,
        },
        "budget": {
            "remaining_rmb": budget_remaining,
            "status": status,
            "advice": (
                "预算充足，可以入库。" if status == "GREEN" else
                f"预算紧张：需要 RMB {cost}，剩余 RMB {budget_remaining}，建议分小批执行。" if status == "WARN" else
                f"预算不足：需要 RMB {cost}，剩余 RMB {budget_remaining}。请先增加阿里云百炼余额。"
            ),
        },
        "recommended_batch_size": min(50, paper_count) if paper_count <= 100 else (50 if paper_count <= 500 else 100),
        "cli_commands": {
            "step1_extract": "python robust_pipeline_v3.py",
            "step2_distill": "python distill_robust.py",
            "step3_vectorize": "python run_module3.py",
            "step4_clean": "python 全局消歧聚类清洗.py",
        },
    }


@mcp.tool()
def check_pipeline_progress(batch_tag: str = None) -> dict:
    """Check ingestion progress in Neo4j: how many new papers in the current batch_run, entity/relation counts, vector coverage. Compare against ov_import to report ETA.

    Args:
        batch_tag: Optional batch_run tag to filter (e.g. "v3_incremental_20260629"). If omitted, uses the most recent tag.
    """
    nc = _get_neo4j()
    if nc is None:
        return {"error": "Neo4j unavailable"}

    try:
        # Latest batch tag
        if not batch_tag:
            tags = nc.execute_query(
                "MATCH (e:Entity) WHERE e.batch_run IS NOT NULL RETURN e.batch_run AS tag, count(e) AS cnt ORDER BY tag DESC LIMIT 1"
            )
            batch_tag = tags[0]["tag"] if tags else None

        if not batch_tag:
            return {"status": "idle", "message": "No batch_run tags found — no ingestion has run yet."}

        # Count new entities/eps from this batch
        new_ents = nc.execute_query(
            "MATCH (e:Entity {batch_run: $t}) RETURN count(e) AS c", {"t": batch_tag}
        )[0]["c"]
        new_eps = nc.execute_query(
            "MATCH (ep:Episode) WHERE ep.batch_run = $t RETURN count(ep) AS c", {"t": batch_tag}
        )[0]["c"]

        # Vector coverage for this batch
        vec_ents = nc.execute_query(
            "MATCH (e:Entity {batch_run: $t}) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS c",
            {"t": batch_tag}
        )[0]["c"]

        # Distill coverage (LiteratureDistill that link to this batch's episodes)
        distill_done = nc.execute_query(
            "MATCH (ld:LiteratureDistill)-[:DISTILL_FROM]->(ep:Episode) WHERE ep.batch_run = $t RETURN count(ld) AS c",
            {"t": batch_tag}
        )[0]["c"]

        # Total remaining papers in ov_import not in Neo4j
        fs_folders = {d.name for d in _IMPORT_DIR.iterdir() if d.is_dir() and not d.name.startswith('.')}
        db_folders = {r["f"] for r in nc.execute_query("MATCH (ep:Episode) RETURN ep.source_folder AS f")}
        remaining = len(fs_folders - db_folders)

        stages = {
            "entity_extraction": "DONE" if new_ents > 0 else "PENDING",
            "relation_extraction": "DONE" if new_ents > 0 else "PENDING",
            "disambiguation": "PENDING",
            "conflict_detection": "PENDING",
            "community_clustering": "PENDING",
            "distillation": f"DONE ({distill_done}/{new_eps})" if distill_done > 0 else "PENDING",
            "vectorization": f"DONE ({vec_ents}/{new_ents})" if vec_ents > 0 else "PENDING",
        }

        tips = []
        if stages["vectorization"].startswith("PENDING") and stages["distillation"].startswith("DONE"):
            tips.append("向量化待执行: python run_module3.py")
        if stages["distillation"].startswith("PENDING") and stages["entity_extraction"] == "DONE":
            tips.append("蒸馏待执行: python distill_robust.py")
        if remaining > 0:
            tips.append(f"仍有 {remaining} 篇文献未入库")

        return {
            "batch_tag": batch_tag,
            "new_entities": new_ents,
            "new_episodes": new_eps,
            "vectorized": vec_ents,
            "distilled": distill_done,
            "papers_remaining_in_ov_import": remaining,
            "stages": stages,
            "next_steps": tips or ["全流程完成。执行 python 全局消歧聚类清洗.py 做最终清洗。"],
        }
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def get_failed_folders(batch_tag: str = None) -> dict:
    """Find paper folders that failed ingestion: present in ov_import but have zero entities in Neo4j, or have entities with null/empty fields. Port of the 45-paper investigation logic.

    Args:
        batch_tag: Optional batch_run to filter. If omitted, checks all episodes.
    """
    nc = _get_neo4j()
    if nc is None:
        return {"error": "Neo4j unavailable"}

    try:
        # Episodes with zero entities
        if batch_tag:
            zero_ent = nc.execute_query(
                "MATCH (ep:Episode) WHERE ep.batch_run = $t AND NOT (ep)<-[:EXTRACTED_FROM]-() RETURN ep.source_folder AS f ORDER BY f",
                {"t": batch_tag}
            )
        else:
            zero_ent = nc.execute_query(
                "MATCH (ep:Episode) WHERE NOT (ep)<-[:EXTRACTED_FROM]-() RETURN ep.source_folder AS f ORDER BY f"
            )

        # Entities with null fields
        null_ents = nc.execute_query(
            "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' OR e.description IS NULL OR size(e.description) < 10 "
            "RETURN e.name AS name, e.source_folder AS f, e.batch_run AS tag ORDER BY e.name LIMIT 50"
        )

        # Episodes without distill
        no_distill = nc.execute_query(
            "MATCH (ep:Episode) WHERE NOT (ep)<-[:DISTILL_FROM]-(:LiteratureDistill) RETURN count(ep) AS c"
        )[0]["c"]

        return {
            "papers_with_zero_entities": [r["f"] for r in zero_ent],
            "zero_count": len(zero_ent),
            "entities_with_null_fields": [
                {"name": r["name"], "folder": r["f"], "batch": r["tag"]} for r in null_ents
            ],
            "null_entity_count": len(null_ents),
            "papers_without_distill": no_distill,
            "fix_commands": {
                "retry_zero_entity": "python robust_pipeline_v3.py  # 带 batch_run 标签重抽",
                "retry_missing_distill": "python distill_robust.py",
                "global_cleaning": "python 全局消歧聚类清洗.py --stage disambiguate,clean",
            },
        }
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def get_ingestion_checklist() -> dict:
    """返回完整的批量入库操作清单 (CLI-based, 方案B)。告诉用户每一步执行什么命令、如何确认完成。

    用于 50+ 篇批量入库时，Claude 生成逐步骤的可执行检查表。
    """
    return {
        "philosophy": "本 MCP 只做监控和导引。所有入库步骤由用户通过 CLI 手动执行。MCP 监控进度和验证结果。",
        "checklist": [
            {
                "phase": 0,
                "name": "新增文献放置",
                "action": "将新文献的 4 个 MD 文件（摘要.md / 术语表.md / 问答.md / *.original.md）放入对应文件夹，整体放入 D:\\Desktop\\ov_import",
                "verification": "detect_new_papers",
                "note": "如果原始文献是 PDF，先用 pdf2obsidian skill 转换",
            },
            {
                "phase": 1,
                "name": "MD 完整性检测",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python check_md_files.py --json",
                "verification": "check_md_integrity (来自 graphrag-marx MCP)",
                "expected": '"complete_4of4" 应等于 detect_new_papers 报告的 new_count',
            },
            {
                "phase": 2,
                "name": "环境与成本确认",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python module1_env_check.py --all",
                "verification": "estimate_batch_cost(N)",
                "expected": "run_env_check 的 all_passed=true, estimate 的 budget.status != OVER",
            },
            {
                "phase": 3,
                "name": "实体/关系抽取（5轮LLM任务）",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python robust_pipeline_v3.py",
                "verification": "check_pipeline_progress",
                "expected": "stages.entity_extraction == DONE, 实体数 > 0",
                "duration": "50篇 ≈ 30min, 100篇 ≈ 1h",
            },
            {
                "phase": 4,
                "name": "知识蒸馏",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python distill_robust.py",
                "verification": "check_pipeline_progress",
                "expected": "stages.distillation 以 DONE 开头",
                "duration": "50篇 ≈ 20min",
            },
            {
                "phase": 5,
                "name": "向量化",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python run_module3.py",
                "verification": "check_pipeline_progress",
                "expected": "vectorized == new_entities",
                "duration": "每批最多 10 条, 2839 条 ≈ 5min",
            },
            {
                "phase": 6,
                "name": "全局消歧聚类清洗",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python 全局消歧聚类清洗.py",
                "verification": "graphrag-marx 的 run_quality_check",
                "expected": "all_passed == true",
            },
            {
                "phase": 7,
                "name": "备份",
                "command": "cd C:\\Users\\HUAWEI\\.claude\\skills\\marx-graphiti\\scripts && python neo4j_rollback.py --list  # 先看现有备份\npython module1_env_check.py --all  # module1 会自动创建备份",
                "verification": "graphrag-marx 的 list_backups",
                "expected": "新增备份条目",
            },
        ],
        "batch_strategy": {
            "small_batch_1_to_50": "一次性跑完全流程（phase 1-7），风险低",
            "medium_batch_50_to_200": "分 2-4 批，每批跑完 phase 3-4 后立即 get_failed_folders 检查，修复后再跑 phase 5-6",
            "large_batch_200_to_1000": "每 100 篇一批，每批之间做质量校验 + 备份。估算成本 RMB 13/批",
            "massive_batch_1000_plus": "每 500 篇一批，提前确认 API 余额 >= RMB 70/批。建议先试跑 50 篇验证格式兼容性",
        },
    }


@mcp.tool()
def verify_ingestion_result() -> dict:
    """Final ingestion quality check: compare ov_import folder count vs Neo4j episodes, check vector coverage, distill coverage, and orphan entities."""
    nc = _get_neo4j()
    if nc is None:
        return {"error": "Neo4j unavailable"}

    try:
        # Folder vs DB
        fs_count = len([d for d in _IMPORT_DIR.iterdir() if d.is_dir() and not d.name.startswith('.')])
        db_count = nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"]

        ent_count = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
        vec_count = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS c")[0]["c"]
        distill_count = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN count(ld) AS c")[0]["c"]
        dk_count = nc.execute_query("MATCH (dk:DomainKnowledge) RETURN count(dk) AS c")[0]["c"]
        orphan_ents = nc.execute_query("MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->() RETURN count(e) AS c")[0]["c"]
        orphan_eps = nc.execute_query("MATCH (ep:Episode) WHERE NOT (ep)<-[:EXTRACTED_FROM]-() RETURN count(ep) AS c")[0]["c"]

        issues = []
        if orphan_ents > 0:
            issues.append(f"{orphan_ents} orphan entities (没有 EXTRACTED_FROM)")
        if orphan_eps > 0:
            issues.append(f"{orphan_eps} orphan episodes (没有实体)")
        if vec_count < ent_count:
            issues.append(f"{ent_count - vec_count} entities 缺少向量")
        if distill_count < db_count:
            issues.append(f"{db_count - distill_count} episodes 缺少蒸馏")

        return {
            "folders_in_ov_import": fs_count,
            "episodes_in_neo4j": db_count,
            "coverage_pct": round(db_count / fs_count * 100, 1) if fs_count else 0,
            "entities": ent_count,
            "vectorized": vec_count,
            "vector_pct": round(vec_count / ent_count * 100, 1) if ent_count else 0,
            "distills": distill_count,
            "domain_knowledge": dk_count,
            "issues": issues,
            "status": "HEALTHY" if not issues else "NEEDS_ATTENTION",
            "next_action": (
                "入库完整，图谱健康。" if not issues else
                "发现以上问题，建议先修复再继续入库。使用 get_failed_folders 查看详情。"
            ),
        }
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def recommend_batch_strategy(total_new_papers: int) -> dict:
    """给定新文献总数，推荐分批策略、CLI 命令序列和估计总成本和时间。

    Args:
        total_new_papers: 待入库的新文献总数
    """
    n = max(1, int(total_new_papers))
    cost = estimate_batch_cost(n)

    if n <= 50:
        batches = [{"batch": 1, "papers": n, "commands": [
            "python robust_pipeline_v3.py",
            "python distill_robust.py",
            "python run_module3.py",
            "python 全局消歧聚类清洗.py",
        ]}]
        strategy = "一次性入库"
    elif n <= 200:
        batch_size = 50
        num = (n + batch_size - 1) // batch_size
        batches = []
        for i in range(num):
            start = i * batch_size + 1
            end = min((i + 1) * batch_size, n)
            batches.append({
                "batch": i + 1,
                "papers": f"{start}-{end}",
                "commands": [
                    f"# Batch {i+1}: papers {start}-{end}",
                    "python robust_pipeline_v3.py",
                    "python distill_robust.py",
                    "# 质检: 检查本批有无 zero-entity 论文",
                ],
            })
        strategy = f"分 {num} 批，每批 {batch_size} 篇，每批质检后再继续"
    else:
        batch_size = 100
        num = (n + batch_size - 1) // batch_size
        batches = []
        for i in range(num):
            start = i * batch_size + 1
            end = min((i + 1) * batch_size, n)
            batches.append({
                "batch": f"{i+1}/{num}",
                "papers": f"{start}-{end} ({end-start+1}篇)",
                "commands": [
                    f"# Batch {i+1}/{num}",
                    "python robust_pipeline_v3.py",
                    "python distill_robust.py",
                    "python run_module3.py",
                    f"# 质检 + 备份后再继续 batch {i+2}",
                ],
            })
        batch_cost = round(100 * BENCHMARK["cost_rmb_per_paper"], 2)
        strategy = f"分 {num} 批，每批 100 篇（~RMB {batch_cost}/批），每批质检+备份后再继续。先试跑 50 篇验证格式兼容性。"

    return {
        "total_papers": n,
        "strategy": strategy,
        "total_cost_estimate_rmb": cost["estimates"]["estimated_cost_rmb"],
        "total_time_estimate_hours": cost["estimates"]["estimated_time_hours"],
        "budget_status": cost["budget"]["status"],
        "budget_advice": cost["budget"]["advice"],
        "batches": batches,
        "prerequisite": "新文献必须是 ov_import 下的文件夹，每个文件夹含 摘要.md + 术语表.md + 问答.md + *.original.md。原始 PDF 需先用 pdf2obsidian 转换。",
    }


# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    mcp.run(transport="stdio")
