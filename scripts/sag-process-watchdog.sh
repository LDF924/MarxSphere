#!/bin/bash
# sag-process-watchdog.sh — MarxSphere 保活（只保 OpenViking）
# 2026-08-14 用户要求: 双模式用户自由选择, 只保活 OpenViking(1933), SAG/Neo4j/PG 手动拉起
# schtasks 每 5 分钟调用
#
# V417 修一个"拉不起来"的真故障(2026-09-15 实测):
#   OpenViking 起不来时, 进程**不会退出** —— 它抢到 vectordb 的 LOCK 之后卡在初始化,
#   端口没监听、进程还在。于是:
#     ① 旧脚本"看端口没监听就再拉一个" → 新实例抢 LOCK 必失败 → 起来又死 → 无限拉、无一存活
#     ② 老实例一直占着 LOCK, 后续任何拉起都失败 —— 这就是 1933 离线 11 天的真实原因
#   现在: 拉起前先**清掉占着数据目录的残留实例**(只清 openviking-server, 不碰 python/cognee
#   之外的进程), 拉起后**确认端口真的监听了**才算成功, 失败写明确日志。
LOG="${SAG_WATCHDOG_LOG:-/tmp/sag-watchdog.log}"
OV_PORT=1933

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

port_listening() {
  netstat -ano 2>/dev/null | grep -q ":$1 .*LISTENING"
}

ov_bin() {
  echo "${COGNEE_PY:-${COGNEE_HOME:-$HOME/cognee}/.venv312/Scripts/openviking-server.exe}"
}
ov_cfg() {
  echo "${OPENVIKING_HOME:-$HOME}/.openviking/ov.conf"
}

kill_stale_ov() {
  # Windows: 按镜像名杀(只匹配 openviking-server, 不会误伤 cognee 的 python 进程)
  taskkill //IM openviking-server.exe //F >/dev/null 2>&1 || true
  # 等句柄释放 —— LOCK 是文件锁, 进程死后内核释放需要一点时间
  sleep 3
}

start_ov() {
  local bin cfg
  bin="$(ov_bin)"; cfg="$(ov_cfg)"
  if [ ! -x "$bin" ]; then
    log "[FAIL] OpenViking 可执行文件不存在: $bin"
    return 1
  fi
  (cd "$HOME" && "$bin" --config "$cfg" >> "$HOME/openviking_data/ov-serve.log" 2>&1 &)
  # 启动要读向量库, 给足时间; 期间每秒看一眼端口
  local i
  for i in $(seq 1 30); do
    sleep 1
    if port_listening "$OV_PORT"; then
      log "[OK] OpenViking 已拉起(等待 ${i}s)"
      return 0
    fi
  done
  log "[FAIL] OpenViking 拉起后 30s 内 $OV_PORT 仍未监听 —— 见 ~/openviking_data/ov-serve.log"
  return 1
}

# ── 主流程: 保证 1933 在线且**没有残留占位进程** ──
if port_listening "$OV_PORT"; then
  :   # 正常在跑
else
  # 端口没监听 → 先清残留(可能有卡住的老实例占着 LOCK), 再拉
  if pgrep -f "openviking-server" >/dev/null 2>&1 || tasklist //FI "IMAGENAME eq openviking-server.exe" 2>/dev/null | grep -qi openviking; then
    log "OpenViking 未监听但存在残留进程 —— 清理后重启(防 LOCK 占用导致拉起必失败)"
    kill_stale_ov
  else
    log "OpenViking(:$OV_PORT) 不在线，拉起..."
  fi
  start_ov
fi

# ── 记忆层健康探针（配置校验 + 抽取失败扫描）— 只检查不拉起 ──
# 探针就在本脚本旁边, 用脚本位置取(原来写死 C:/Users/<某台机器>/SAG-main/...)
PROBE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sag-memory-probe.sh"
if [ -f "$PROBE" ]; then
  if bash "$PROBE" >> "$LOG" 2>&1; then
    :
  else
    log "[FAIL] 记忆层探针发现故障（详见上方输出）"
  fi
fi
