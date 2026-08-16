#!/bin/bash
# sag-bootstrap.sh — MarxSphere 全栈一键启动（V373, ⑤持续运行）
# 启动顺序: PostgreSQL(Docker) → Neo4j×2 → OpenViking → SAG
# 用法: bash scripts/sag-bootstrap.sh [--stop] [--status]
# 保活: schtasks SAG-ProcessWatchdog 每 5 分钟检查，死了自动拉起

set -u
LOG="/tmp/sag-bootstrap.log"

log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG"; }

start_pg() {
  # PostgreSQL (Docker, sag_lite_postgres)
  local running
  running=$("/c/Program Files/Docker/Docker/resources/bin/docker.exe" ps -q -f name=sag_lite_postgres 2>/dev/null)
  if [ -n "$running" ]; then log "PG 已在运行 (容器 $running)";
  else
    log "启动 PG (Docker)..."
    cd SAG_ROOT && docker compose up -d sag_lite_postgres 2>/dev/null \
      || "/c/Program Files/Docker/Docker/resources/bin/docker.exe" start sag_lite_postgres 2>/dev/null \
      || log "⚠️ PG 启动失败（请检查 Docker）"
  fi
}

start_neo4j() {
  for port in 11001 11003; do
    if netstat -ano 2>/dev/null | grep -q ":$port .*LISTENING"; then
      log "Neo4j :$port 已在运行"
    else
      log "启动 Neo4j :$port..."
      if [ "$port" = "11001" ]; then
        cd NEO4J_DIR/neo4j-community-5.26.27 && (bin/neo4j.bat console > /dev/null 2>&1 &)
      else
        cd NEO4J_DIR/neo4j-community-5.26.27-cognee && (bin/neo4j.bat console > /dev/null 2>&1 &)
      fi
      sleep 3
    fi
  done
}

start_openviking() {
  if netstat -ano 2>/dev/null | grep -q ":1933 .*LISTENING"; then
    log "OpenViking 已在运行 (1933)"
  else
    log "启动 OpenViking (1933) 静默..."
    cscript //nologo SAG_ROOT\\scripts\\ov-start.vbs
    sleep 5
  fi
}

start_sag() {
  if netstat -ano 2>/dev/null | grep -q ":4173 .*LISTENING"; then
    log "SAG 已在运行 (4173)"
  else
    log "启动 SAG (4173) 静默..."
    cscript //nologo SAG_ROOT\\scripts\\sag-start.vbs
    sleep 8
  fi
}

status_all() {
  echo "=== MarxSphere 服务状态 ==="
  for port in 4173 1933 11001 11003 5540; do
    if netstat -ano 2>/dev/null | grep -q ":$port .*LISTENING"; then
      echo "  [OK] :$port"
    else
      echo "  [DOWN] :$port"
    fi
  done
  echo "  PG容器: $("/c/Program Files/Docker/Docker/resources/bin/docker.exe" ps -q -f name=sag_lite_postgres 2>/dev/null | head -c 12)"
}

case "${1:-}" in
  --stop)
    log "停止 SAG/OpenViking (Neo4j/PG 保留)..."
    # 用 PID 杀（不用 taskkill /IM 防误杀 Claude Code）
    for port in 4173 1933; do
      pid=$(netstat -ano 2>/dev/null | grep ":$port .*LISTENING" | head -1 | awk '{print $NF}')
      [ -n "$pid" ] && taskkill //PID "$pid" //F 2>/dev/null
    done
    ;;
  --status) status_all ;;
  *)
    log "启动全部服务..."
    start_pg
    start_neo4j
    start_openviking
    start_sag
    status_all
    ;;
esac
