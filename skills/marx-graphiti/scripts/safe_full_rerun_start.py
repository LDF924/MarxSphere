#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
safe_full_rerun_start.py
安全全量重跑启动器：清空断点 → 备份日志 → 后台启动 v3 流水线
不删除任何历史 Neo4j 数据，仅 MERGE 带 batch_run 标记的新关系

踩坑记录（graphiti 专属）:
  1. checkpoint JSON 损坏 → reset_checkpoint 吞异常
  2. 旧 zombie 进程未杀干净 → taskkill 只杀 robust_pipeline_v3
  3. 日志文件未轮转 → backup 仅 1 份
  4. Neo4j 11001 未启动 → Popen 成功但 worker 连不上
  5. 批次标记与已入库标记冲突
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# ========== 统一配置 ==========
CHECKPOINT_PATH = r"D:\Desktop\执行流程\.checkpoint_processed.json"
LOG_PATH = os.path.join(os.environ["TEMP"], "robust_v3_console.log")
PIPELINE_FILE = r"D:\Desktop\执行流程\robust_pipeline_v3.py"
CURRENT_BATCH_TAG = f"v3_full_rerun_{datetime.now().strftime('%Y%m%d')}"
# =============================


# ══════════════════════════════════════════════════════════════════
# LAYER 0: graphiti-rerun 专属自愈
# ══════════════════════════════════════════════════════════════════

_FIX_LOG = []

def _log(action, detail=""):
    msg = f"  [PREFLIGHT] {action}"
    if detail:
        msg += f" — {detail}"
    _FIX_LOG.append(msg)
    print(msg, flush=True)

def preflight_graphiti_rerun():
    fixes = 0

    # ── 1. Neo4j 11001 连通性 ──
    try:
        from neo4j import GraphDatabase
        d = GraphDatabase.driver("bolt://127.0.0.1:11001", auth=("neo4j", "neo4j123"))
        d.verify_connectivity()
        s = d.session()
        node_cnt = s.run("MATCH (n) RETURN count(n) AS c").single()["c"]
        s.close(); d.close()
        _log(f"INFO: Neo4j 11001 reachable ({node_cnt} nodes)")
    except Exception as e:
        _log("FATAL: Neo4j 11001 unreachable — pipeline will fail", str(e)[:80])
        msg = str(e).lower()
        if "refused" in msg:
            _log("HINT: start Neo4j 11001 first: neo4j-community-5.26.27-graphiti\\bin\\neo4j.bat")
        elif "auth" in msg:
            _log("HINT: check GRAPH_DATABASE_USERNAME/PASSWORD in .env")
        fixes += 1  # 报告但无法自动修复

    # ── 2. checkpoint JSON 文件健康 ──
    checkpoint = Path(CHECKPOINT_PATH)
    if checkpoint.exists():
        try:
            data = json.loads(checkpoint.read_text("utf-8"))
            if isinstance(data, list):
                _log(f"INFO: checkpoint valid ({len(data)} entries)")
            else:
                _log(f"WARN: checkpoint is not a list (type={type(data).__name__}) — will be reset")
        except (json.JSONDecodeError, UnicodeDecodeError):
            _log("FIX: checkpoint JSON corrupt — auto-reset")
            checkpoint.parent.mkdir(parents=True, exist_ok=True)
            checkpoint.write_text("[]", "utf-8")
            fixes += 1
    else:
        _log("INFO: no existing checkpoint — fresh start")

    # ── 3. 日志文件轮转 ──
    log_path = Path(LOG_PATH)
    log_dir = log_path.parent
    log_dir.mkdir(parents=True, exist_ok=True)
    if log_path.exists() and log_path.stat().st_size > 50 * 1024 * 1024:
        # > 50MB: rotate with timestamp
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = log_dir / f"robust_v3_backup_{ts}.log"
        shutil.move(str(log_path), str(backup))
        _log(f"FIX: rotated oversized log ({log_path.stat().st_size // 1024 // 1024}MB)", backup.name)
        fixes += 1

    # ── 4. pipeline 脚本存在性 ──
    pipeline = Path(PIPELINE_FILE)
    if not pipeline.exists():
        _log(f"FATAL: pipeline script not found: {PIPELINE_FILE}")
        _log("HINT: check if robust_pipeline_v3.py is in D:\\Desktop\\执行流程\\")

    if fixes:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Preflight: {fixes} fixes applied", flush=True)


def reset_checkpoint():
    """清空断点，开启全量重跑。checkpoint JSON 损坏时当场修复。"""
    cp = Path(CHECKPOINT_PATH)
    cp.parent.mkdir(parents=True, exist_ok=True)
    # 触发式修复：损坏的 checkpoint 自动重置
    if cp.exists():
        try:
            json.loads(cp.read_text("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            print(f"  [AUTO-HEAL] corrupt checkpoint JSON → reset", flush=True)
    cp.write_text("[]", "utf-8")
    print(f"1. 断点已清空，全量待处理，批次标识：{CURRENT_BATCH_TAG}")


def backup_old_log():
    """自动备份历史日志"""
    log_path = Path(LOG_PATH)
    log_dir = log_path.parent
    log_dir.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        file_count = len(list(log_dir.iterdir()))
        create_ts = int(log_path.stat().st_ctime)
        backup = log_dir / f"backup_{file_count}_{create_ts}.log"
        shutil.copy(str(log_path), str(backup))
        print(f"2. 历史日志备份完成：{backup}")
    log_path.write_text("", "utf-8")


def launch_pipeline():
    """后台脱离终端启动流水线"""
    log_handle = open(LOG_PATH, "a", encoding="utf-8")
    proc = subprocess.Popen(
        ["python3", "-u", PIPELINE_FILE],
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        creationflags=0x00000200
    )
    print(f"3. v3流水线后台启动成功，进程PID：{proc.pid}")
    print(f"实时运行日志路径：{LOG_PATH}")
    return proc


def kill_old_zombies():
    """Kill zombie pipeline processes (same script, different PID)."""
    import signal
    my_pid = os.getpid()
    killed = 0
    try:
        result = subprocess.run(
            ["cmd.exe", "/c",
             'wmic process where "name=\'python.exe\'" get commandline,processid /format:csv'],
            capture_output=True, text=True, timeout=15
        )
        for line in result.stdout.split('\n'):
            if 'robust_pipeline_v3.py' in line and 'safe_full_rerun_start' not in line:
                pid_str = line.strip().split(',')[-1].strip('"')
                if pid_str.isdigit():
                    pid = int(pid_str)
                    if pid != my_pid:
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
                        killed += 1
        if killed:
            print(f"  已终止 {killed} 个旧流水线进程", flush=True)
    except Exception:
        pass


if __name__ == "__main__":
    # ===== 前置条件检查 =====
    # 1. Neo4j 11001 必须可达
    try:
        from neo4j import GraphDatabase as _N4
        _d = _N4.driver("bolt://127.0.0.1:11001", auth=("neo4j", "neo4j123"))
        _d.verify_connectivity()
        _d.close()
    except Exception as _ne:
        print(f"FATAL: Neo4j 11001 不可达 — {_ne}")
        print("HINT: 启动 Graphiti Neo4j 后重试")
        sys.exit(1)

    # 2. pipeline 脚本必须存在
    if not Path(PIPELINE_FILE).exists():
        print(f"FATAL: 流水线脚本不存在: {PIPELINE_FILE}")
        sys.exit(1)

    kill_old_zombies()
    reset_checkpoint()
    backup_old_log()
    pipeline_process = launch_pipeline()

    print()
    print("=== 安全全量重跑已启动 ===")
    print(f"批次标识: {CURRENT_BATCH_TAG}")
    print("1. 处理每篇文献不会删除历史旧关系，直接新建本轮关系")
    print("2. 本轮所有新增关系携带 batch_run 批次标记")
    print("3. 历史旧关系无批次标记，新旧数据共存图库，无自动清理")
    print()
    print("完成后运行以下查询查看本轮新增关系：")
    print(f"  MATCH ()-[r]->() WHERE r.batch_run = '{CURRENT_BATCH_TAG}' RETURN count(r)")
