# 模型替换对照矩阵（P0-5）

> 状态: **待数据** —— PG 向量恢复完成后执行（当前检索链路返回 0 结果，评测不可用）
> 方法: 固定 Harness，只换 reason 模型，跑同一 50 题。换强模型分数不涨 → 瓶颈在 Harness；换弱模型大跌 → 瓶颈在模型。

## 配置矩阵

| 配置 | reason 模型 | 命令 | 预期结论 |
|---|---|---|---|
| 基线 | deepseek-v4-flash（默认） | `bash scripts/model-swap-eval.sh baseline` | 当前基准分（历史 0.870） |
| 强模型 | deepseek-v4-pro | `MODEL_SWAP_ROLE=reason:deepseek-v4-pro bash scripts/model-swap-eval.sh pro` | 涨 → 模型有提升空间；不涨 → Harness 瓶颈 |
| 异源 | qwen3.7-max | `MODEL_SWAP_ROLE=reason:qwen3.7-max bash scripts/model-swap-eval.sh qwen` | 涨 → 偏见/能力互补；不涨 → 链路本身 |

## 结论处置

- 模型不涨的维度 → 对应 Harness 项（P0-2 归因输出直接告诉你是哪一步）
- 三个配置跑完后，决定"是否升级默认 reason 模型"

## 实现

- `llm-model-registry.ts` `getRoleModel()` 支持 `MODEL_SWAP_ROLE=角色:模型` 环境变量覆盖（分号分隔多对）
- 评测脚本与推理服务统一走 `getRoleModel`，换模型零代码改动
- 验证: `MODEL_SWAP_ROLE=reason:qwen3.7-max node -e "import('./src/services/llm-model-registry.js').then(m=>console.log(m.getRoleModel('reason')))"` → 输出 qwen3.7-max

## 结果记录（跑完后填写）

| 配置 | 均值 | 与基线差 | 显著(p) | 结论 |
|---|---|---|---|---|
| 基线 deepseek-v4-flash | - | - | - | - |
| deepseek-v4-pro | - | - | - | - |
| qwen3.7-max | - | - | - | - |
