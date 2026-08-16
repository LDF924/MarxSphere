#!/usr/bin/env bash
# sag-env-healthcheck.sh — SAG 环境健康检查
# 一键核对：核心服务端口 / 进程白名单 / 内存 / 残留 runner
# 用法: bash scripts/sag-env-healthcheck.sh
# 2026-08-02 V1 — 环境固化

set -u

echo "========== SAG 环境健康检查 =========="
echo ""

# ─── 1. 核心服务端口 ───
echo "[1] 核心服务端口"
check_port() {
  local name="$1" port="$2"
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":$port .*LISTENING" | head -1 | awk '{print $NF}')
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    local proc
    proc=$(tasklist //FI "PID eq $pid" 2>/dev/null | tail -1 | awk '{print $1}')
    echo "  ✅ $name (:${port}) → PID $pid ($proc)"
  else
    echo "  ⚠️  $name (:${port}) → 未监听"
  fi
}
check_port "SAG后端" "4173"
check_port "Neo4j Graphiti" "11001"
check_port "Neo4j Cognee" "11003"
check_port "Postgres" "5540"

echo ""

# ─── 2. 进程白名单核对 ───
echo "[2] 进程状态"
# Graphiti 入库 python（可能正在跑，不强制要求）
echo "  Graphiti 入库进程:"
ps_runner=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object {\$_.CommandLine -match 'runner'} | Measure-Object | Select-Object -ExpandProperty Count" 2>/dev/null | tr -d '\r')
echo "    当前 MCP runner 进程数: ${ps_runner:-?}  (0=后端未运行, 40=后端运行含池实例)"

echo ""

# ─── 3. 内存 ───
echo "[3] 内存"
powershell -NoProfile -Command "\$os = Get-CimInstance Win32_OperatingSystem; Write-Output ('  可用: ' + [math]::Round(\$os.FreePhysicalMemory/1MB,1) + ' GB / ' + [math]::Round(\$os.TotalVisibleMemorySize/1MB,1) + ' GB')" 2>&1 | head -1

echo ""

# ─── 4. SAG 前端构建状态 ───
echo "[4] 前端构建"
if [ -f "web/dist/index.html" ]; then
  echo "  ✅ web/dist 已构建（可静态服务）"
else
  echo "  ⚠️  web/dist 缺失，需先 npx vite build"
fi

echo ""

# ─── 5. 关键 skill 就位 ───
echo "[5] skill 检查"
for skill in marx-agent sciverse sciverse-zhs marx-sag; do
  if [ -f "$HOME/.claude/skills/$skill/SKILL.md" ]; then
    echo "  ✅ $skill"
  else
    echo "  ⚠️  $skill 缺失"
  fi
done

echo ""
echo "========== 检查完成 =========="
