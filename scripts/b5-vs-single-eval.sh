#!/usr/bin/env bash
# b5-vs-single-eval.sh — V405-B5: "集成超越单模型"评测门(子集)
# 对照: deepseek-v4-pro 单模型 vs qwen3.7-max 单模型 vs B5 融合(默认阵容)
# 用法: 在 full 模式(有 LLM key)下:  B5_ENABLED=1 bash scripts/b5-vs-single-eval.sh
# 原理: 取 53 题子集(默认 10 题难题: 比较/引证/机制类), 三路各自作答,
#       LLM judge 双盲打分(1-5), 输出均值表 → 看 B5 是否 > 两单模型。
set -uo pipefail
cd "$(dirname "$0")/.."
N="${B5_EVAL_N:-10}"
echo "═══ B5 vs 单模型评测(子集 ${N} 题) ═══"
B5_ENABLED=1 npx tsx scripts/b5-vs-single-eval.ts --n "$N"
