#!/bin/bash
# sag-process-watchdog.sh — MarxSphere 保活（V388, 改为只保 OpenViking）
# 2026-08-14 用户要求: 双模式用户自由选择, 只保活 OpenViking(1933), SAG/Neo4j/PG 手动拉起
# schtasks 每 5 分钟调用
LOG="/tmp/sag-watchdog.log"

check_and_start() {
  local port="$1" name="$2"
  if netstat -ano 2>/dev/null | grep -q ":$port .*LISTENING"; then
    return 0  # 活着
  fi
  echo "$(date +%H:%M:%S) $name(:$port) 不在线，拉起..." >> "$LOG"
  case "$port" in
    # V388: 改用直接 bash 后台启动（cscript/vbs 静默启动曾被回收导致拉起失败）
    1933) cd SAG_ROOT && (cognee/.venv312/Scripts/openviking-server.exe --config OPENVIKING_DIR/ov.conf > /tmp/ov-start.log 2>&1 &) ;;
  esac
  sleep 3
}

# V388: 只保 OpenViking — SAG/Neo4j/PG 手动拉起（用户双模式自由选择）
check_and_start 1933 "OpenViking"

# V381: 记忆层健康探针（配置校验 + 抽取失败扫描）— 只检查不拉起
if bash SAG_ROOT/scripts/sag-memory-probe.sh >> "$LOG" 2>&1; then
  :
else
  echo "$(date +%H:%M:%S) [FAIL] 记忆层探针发现故障（详见上方输出）" >> "$LOG"
fi
