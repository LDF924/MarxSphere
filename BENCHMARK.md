# Benchmarks（基准测试）

MarxSphere 的评测体系与基准结果。完整指标定义见 [docs/SCORING_STANDARD.md](docs/SCORING_STANDARD.md)。

## 主评测（53 题 · 31 评分项）

**评测方法**：双轨评测（规则评分 + LLM judge 三轮回合取中位数），53 题 4 类题型（概念定义 15 / 事实检索 13 / 多跳推理 14 / 政策评估 11）。

### 综合分数（`evaluation/eval_32metrics.json`）

| 指标 | 分数 |
|---|---|
| **overall 综合** | **0.884** |
| A 检索质量（12 项） | 0.795 |
| B 答案质量（9 项） | **0.985** |
| C 推理质量（3 项） | 0.886 |
| D 性能（7 项） | 观测 |
| 通过率 | **53/53（100%）** |

### 每题明细（`evaluation/eval_32metrics_perq.json`）

| 区间 | 分数 |
|---|---|
| 最高 | Q40 概念定义 0.965 |
| 最低 | Q39 政策评估 0.753 |

## 多源融合实证（为什么四源缺一不可）

53 题实际检索贡献分布（`_debugCoarse/_debugRefined` 统计）：

| 检索源 | 贡献占比 |
|---|---|
| Graphiti（实体/蒸馏/段落） | **37.4%** |
| PG（向量/实体补漏） | **36.7%** |
| Cognee（切片/粗检索） | **22.8%** |
| 论文定位 | 3.1% |

**结论**：单一检索技术最多覆盖约 1/3 检索需求——纯向量丢失图谱关系（37%），纯 GraphRAG 丢失切片语义（23%），纯词法丢失向量语义（37%）。只有四源融合才能达到 0.884。

## 消融评测（21 算子）

`scripts/ablation-eval.ts` 支持逐项关闭算子验证贡献（检索栈 12 + 推理链路 9）：

- 检索栈：compiled_truth / title / chronicle_type / backlink / cosine / dedup / alias / relational / expansion / graph_traversal / multi_query / rerank
- 推理链路：outline / expand / candidate_papers / cognee_arm / graphiti_arm / pg_arm / entity_extract / hypothesis / evaluate

## Agent 评测

- 轨迹指标：计划遵循度 / 工具准确率 / 推理质量（judge 打分）
- 回归集：16 题轨迹前缀 + 故障注入（429/超时/降级）
- 24h 自动回归 + 通过率告警
- 校准：kappa = 1.000（20 条金标，0 分歧）

## 单元测试

- **263 项** Vitest 测试（`npm test`）
- 覆盖：检索服务 / Agent 编排 / 工具路由 / 评测体系 / 记忆 / 日志脱敏

## 运行评测

```bash
# 全量 53 题
npx tsx scripts/eval-32-metrics.ts

# 指定题目 / 维度
EVAL_QUESTIONS=Q01,Q05,Q09 npx tsx scripts/eval-32-metrics.ts
EVAL_DIMS=A npx tsx scripts/eval-32-metrics.ts

# 消融
npx tsx scripts/ablation-eval.ts --operators rerank,title
```

评测数据、历史归档与报告见 `evaluation/` 与 `reports/` 目录。
