#!/usr/bin/env bash
# SAG 22指标评测 — V9 标准工作流
# 用法: bash scripts/sag-eval.sh [--debug] [--restart]
#   --debug   启用 SAG_DEBUG_ENTITIES=1 诊断日志
#   --restart 先杀掉旧 SAG 进程并重启 (修改源码后必须用)
set -euo pipefail

SAG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SAG_DIR"

RESTART=false
DEBUG=false
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=true ;;
    --debug) DEBUG=true ;;
    *) echo "Unknown: $arg"; exit 1 ;;
  esac
done

echo "════════════════════════════════════════════════════════════"
echo "  SAG 22指标评测 V9 工作流"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════════════"

# ─── 1. 检查 SAG 服务 ───
if $RESTART; then
  echo ""
  echo "[1/4] 重启 SAG HTTP 服务..."
  OLD_PID=$(netstat -ano 2>/dev/null | grep ':4173.*LISTENING' | awk '{print $NF}' | head -1 || true)
  if [ -n "$OLD_PID" ]; then
    taskkill //F //PID "$OLD_PID" 2>/dev/null && echo "  ✓ 已杀掉旧进程 PID=$OLD_PID" || true
  fi
  npx tsx src/index.ts > /tmp/sag_eval_server.log 2>&1 &
  echo "  → 等待 MCP 预连接 (最多 60s)..."
  for i in $(seq 1 24); do
    sleep 5
    if grep -q "Cognee MCP 预连接完成" /tmp/sag_eval_server.log 2>/dev/null; then
      echo "  ✓ SAG 就绪 ($((i*5))s)"
      break
    fi
    if [ $i -eq 24 ]; then
      echo "  ✗ SAG 启动超时, 查看 /tmp/sag_eval_server.log"
      tail -12 /tmp/sag_eval_server.log
      exit 1
    fi
  done
else
  echo ""
  echo "[1/4] 检查 SAG HTTP 服务..."
  if curl -s http://localhost:4173/api/health > /dev/null 2>&1; then
    echo "  ✓ SAG 已运行在 :4173"
  else
    echo "  ✗ SAG 未运行。用 --restart 重启, 或手动启动: npx tsx src/index.ts &"
    exit 1
  fi
fi

# ─── 2. 清理旧结果 ───
echo ""
echo "[2/4] 清理旧评测数据..."
rm -f eval_22metrics.json
echo "  ✓"

# ─── 3. 运行评测 ───
echo ""
echo "[3/4] 运行 22 项指标评测 (预计 12-18 分钟)..."
START_TIME=$(date +%s)

ENV_PREFIX=""
$DEBUG && ENV_PREFIX="SAG_DEBUG_ENTITIES=1"

if $DEBUG; then
  eval "$ENV_PREFIX npx tsx scripts/eval-22-metrics.ts" 2>&1 | tee /tmp/sag_eval_output.log
else
  eval "$ENV_PREFIX npx tsx scripts/eval-22-metrics.ts" 2>&1 | tee /tmp/sag_eval_output.log
fi

ELAPSED=$(($(date +%s) - START_TIME))
echo ""
echo "  耗时: ${ELAPSED}s ($((ELAPSED/60))m $((ELAPSED%60))s)"

# ─── 4. 解析结果 ───
echo ""
echo "[4/4] 解析评测结果..."
if [ -f eval_22metrics.json ]; then
  python3 -c "
import json
with open('eval_22metrics.json', 'r') as f:
    data = json.load(f)

print()
print('─' * 60)
print('  评测结果摘要')
print('─' * 60)

for q in data:
    m = q.get('metrics', {})
    qid = q.get('id', q.get('question_id', '?'))
    a1 = m.get('entity_recall', 0)
    a6 = m.get('entity_name_accuracy', 0)
    a8 = m.get('chunk_recall', 0)
    c1 = m.get('cot_quality', 0)
    c3 = m.get('reasoning_depth', 0)
    overall = m.get('overall_22', 0)
    print(f'  {qid}: A1={a1:.3f} A6={a6:.3f} A8={a8:.3f} C1={c1:.3f} C3={c3:.3f} ★={overall:.3f}')

scores = [q.get('metrics', {}).get('overall_22', 0) for q in data]
avg = sum(scores)/len(scores) if scores else 0
print(f'  平均: {avg:.3f}')
print()
" 2>&1
  echo "  ✓"
else
  echo "  ✗ eval_22metrics.json 未生成, 评测可能失败"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  完成"
echo "════════════════════════════════════════════════════════════"
