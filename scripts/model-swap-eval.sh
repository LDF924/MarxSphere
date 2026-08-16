#!/bin/bash
# model-swap-eval.sh — 模型替换实验（BOOK-GAP-ROADMAP P0-5）
# 固定 Harness 只换 reason 模型, 判断"模型不行" vs "Harness 不行"
#   - 换强模型分数不涨 → 瓶颈在 Harness
#   - 换弱模型大跌 → 瓶颈在模型
# 原理: getRoleModel 支持 MODEL_SWAP_ROLE 环境变量覆盖 (llm-model-registry.ts),
#       评测脚本和推理服务都走 getRoleModel, 所以只改环境变量即可换模型, 不改代码
#
# 用法:
#   MODEL_SWAP_ROLE=reason:deepseek-v4-pro bash scripts/model-swap-eval.sh pro
#   MODEL_SWAP_ROLE=reason:qwen3.7-max bash scripts/model-swap-eval.sh qwen
#   bash scripts/model-swap-eval.sh baseline          # 默认 reason 模型 (deepseek-v4-flash)
#
# 前置: SAG 服务运行中 (src/index.ts, 端口 4173), 数据库检索链路可用
set -e
cd "$(dirname "$0")/.."

LABEL="${1:-baseline}"
OUTPUT="eval_32metrics_model_${LABEL}.json"
PERQ="eval_32metrics_perq_model_${LABEL}.json"

echo "═══════════════════════════════════════════"
echo " 模型替换实验: ${LABEL}"
echo " MODEL_SWAP_ROLE=${MODEL_SWAP_ROLE:-'(默认 reason 模型)'}"
echo " 输出: ${OUTPUT}"
echo "═══════════════════════════════════════════"

EVAL_OUTPUT="${OUTPUT}" EVAL_PERQ_OUTPUT="${PERQ}" npx tsx scripts/eval-32-metrics.ts

echo ""
echo "模型替换实验完成: ${LABEL}"
echo "结果: ${OUTPUT} | 逐题: ${PERQ}"
echo "对照: 用 scripts/significance.ts 与基线 eval_32metrics.json 做配对检验"
