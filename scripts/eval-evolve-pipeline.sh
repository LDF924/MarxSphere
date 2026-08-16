#!/bin/bash
# eval-evolve-pipeline.sh — 评测→归因→补丁进化自动流水线（V381, 2026-08-09）
# 把 BOOK-GAP-ROADMAP P0-2/P1-5 的三个零件串成闭环（此前需人工逐个跑）:
#   1. eval-32-metrics.ts        → 评测（生成 eval_32metrics_perq.json）
#   2. failure-attribution.ts    → 归因（低分题写 eval_failures 表）
#   3. min-diff-patch.ts         → 最小 diff 补丁候选（同类失败 → 四门槛 → canary）
# 用法:
#   bash scripts/eval-evolve-pipeline.sh            # 全流程（含评测）
#   bash scripts/eval-evolve-pipeline.sh --attrib-only   # 只做归因+补丁（复用已有评测结果）
#   bash scripts/eval-evolve-pipeline.sh --dry-run       # 补丁不写库
# 依赖: 需先在 scripts/ 下构建好 eval-32-metrics.ts（npm run build 或 npx tsx 直接跑）

set -e
cd SAG_ROOT
LOG="/tmp/eval-evolve-pipeline.log"
TS=$(date +%Y%m%d-%H%M%S)
ATTRIB_ONLY=""
DRY=""

for a in "$@"; do
  case "$a" in
    --attrib-only) ATTRIB_ONLY=1 ;;
    --dry-run) DRY="--dry-run" ;;
  esac
done

log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG"; }

log "══════ 评测→进化流水线 ${TS} ══════"

# ─── 1. 评测（可选） ───
if [ -z "$ATTRIB_ONLY" ]; then
  log "【1/3】评测 eval-32-metrics..."
  rm -f eval_32metrics.json
  npx tsx scripts/eval-32-metrics.ts 2>&1 | tail -8 | tee -a "$LOG"
  if [ ! -f eval_32metrics_perq.json ]; then
    log "  [WARN] 未生成 eval_32metrics_perq.json（评测可能失败或版本不支持），转归因时跳过"
  fi
else
  log "【1/3】跳过评测（--attrib-only，复用已有 eval_32metrics_perq.json）"
fi

# ─── 2. 归因（写入 eval_failures） ───
log "【2/3】失败归因 failure-attribution..."
if [ -f eval_32metrics_perq.json ]; then
  npx tsx scripts/failure-attribution.ts --run-id "pipeline-${TS}" 2>&1 | tail -15 | tee -a "$LOG"
else
  log "  [SKIP] 无 eval_32metrics_perq.json，跳过归因"
fi

# ─── 3. 最小 diff 补丁（按类别聚合，四门槛 → candidate） ───
log "【3/3】最小 diff 补丁 min-diff-patch..."
FAIL_CNT=$(docker exec sag_lite_postgres psql -U sag_lite -d sag_lite -t -c "SELECT count(*) FROM eval_failures;" 2>/dev/null | tr -d ' ')
if [ -n "$FAIL_CNT" ] && [ "$FAIL_CNT" -gt 0 ]; then
  # 对主要失败类别各生成一轮补丁候选（context/retrieval/reasoning/timeout）
  for cat in context retrieval reasoning; do
    log "  -- category: $cat"
    npx tsx scripts/min-diff-patch.ts --category "$cat" $DRY 2>&1 | tail -4 | tee -a "$LOG"
  done
else
  log "  [SKIP] eval_failures 无数据（先跑评测+归因）"
fi

log "══════ 流水线完成 ${TS} ══════"
log "补丁候选写入 prompt_patches(status=candidate)，需人工确认后 canary→released（PROMPT_CANARY 启用）"
