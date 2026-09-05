#!/usr/bin/env bash
# tier-router-eval.sh — V405 OpenSquilla 移植 P1: 三档路由"不降分"评测门
# 用法: 在 full 模式(三库+Neo4j 已起, .env DEEPSEEK_API_KEY 有效)下运行:
#   bash scripts/tier-router-eval.sh           # 全量 53 题(慢, 烧 token)
#   EVAL_QUESTIONS=Q01,Q05,Q09 bash scripts/tier-router-eval.sh   # 子集快速回归
# 原理: 同一题集跑两遍(路由开 vs 关), 各写独立输出文件(带 fingerprint 不污染基线产物),
#       overall 均值差 >= 阈值(默认 -0.010) → PASS; 否则 FAIL 提示保持关闭并查审计。
# 注意: 评测脚本自身按模式强制 template(与基线同口径), 路由对显式 template 不生效 —
#       因此本脚本验证的是"路由决策层不误伤"的回归门; lite 直答的绝对质量另跑 eval 模式 A/B。
set -uo pipefail
cd "$(dirname "$0")/.."

THRESHOLD="${TIER_EVAL_THRESHOLD:--0.010}"
QUESTIONS="${EVAL_QUESTIONS:-}"
TS=$(date +%Y%m%d_%H%M%S)
BASE_OUT="evaluation/eval_32metrics_tier_base_${TS}.json"
ON_OUT="evaluation/eval_32metrics_tier_on_${TS}.json"

echo "═══ 三档路由评测门 (阈值 ${THRESHOLD}) ═══"
[ -n "$QUESTIONS" ] && echo "题集: ${QUESTIONS} (子集快速回归)" || echo "题集: 全量 53 题"

mean_of() {
  node -e "const j=require('$1');const a=(Array.isArray(j)?j:j.results||[]).filter(r=>r.question_id!=='__fingerprint__'&&r.overall!=null);console.log((a.reduce((s,r)=>s+Number(r.overall),0)/Math.max(1,a.length)).toFixed(4))"
}

echo "── [1/3] 基线: 路由关闭 ──"
ROUTER_ENABLED=0 EVAL_OUTPUT="$BASE_OUT" EVAL_PERQ_OUTPUT="evaluation/eval_32metrics_tier_base_perq_${TS}.json" \
  ${QUESTIONS:+EVAL_QUESTIONS="$QUESTIONS"} npx tsx scripts/eval-32-metrics.ts >"/tmp/tier_eval_base_${TS}.log" 2>&1 \
  || { echo "基线评测失败, 见 /tmp/tier_eval_base_${TS}.log"; exit 1; }
BASE=$(mean_of "$BASE_OUT")
echo "  基线 overall = ${BASE}"

echo "── [2/3] 路由开启 ──"
ROUTER_ENABLED=1 EVAL_OUTPUT="$ON_OUT" EVAL_PERQ_OUTPUT="evaluation/eval_32metrics_tier_on_perq_${TS}.json" \
  ${QUESTIONS:+EVAL_QUESTIONS="$QUESTIONS"} npx tsx scripts/eval-32-metrics.ts >"/tmp/tier_eval_on_${TS}.log" 2>&1 \
  || { echo "路由评测失败, 见 /tmp/tier_eval_on_${TS}.log"; exit 1; }
ON=$(mean_of "$ON_OUT")
echo "  路由开 overall = ${ON}"

echo "── [3/3] 判定 ──"
DIFF=$(node -e "console.log((${ON} - ${BASE}).toFixed(4))")
echo "  Δ = ${DIFF} (阈值 ${THRESHOLD})"
if node -e "process.exit(Number('${DIFF}') >= Number('${THRESHOLD}') ? 0 : 1)"; then
  echo "  ✅ PASS: 三档路由不降分 — 可设置 ROUTER_ENABLED=1"
  echo "  参考: router_audit 表 lite 占比即省幅(≈ liteRate×80%); 观测:"
  echo "    select level, qtype, count(*) from router_audit group by 1,2 order by 3 desc;"
else
  echo "  ❌ FAIL: 路由导致降分超过阈值 — 保持 ROUTER_ENABLED=0, 检查被错误降档的题:"
  echo "    select query, qtype, level, reason from router_audit order by created_at desc limit 30;"
fi
echo "  产物: ${BASE_OUT} / ${ON_OUT} (未覆盖 evaluation/eval_32metrics.json 基线)"
