# MarxSphere RAGAS v3 评测标准 (2026-07-28 V41)

## 架构总览

| 属性 | 值 |
|------|-----|
| 评测脚本 | scripts/eval-22-metrics.ts (1059行) |
| 版本 | V41 (新增 A9 context_json_contamination) |
| 指标数 | 28 (A=9, B=9, C=3, D=7) |
| 维度权重 | A:0.40 B:0.35 C:0.25 D:0.00(纯观测) |
| LLM Judge | DeepSeek v4-flash + DashScope qwen-plus fallback |
| 并发控制 | 3并发 + semaphore + 指数退避 |
| 融合策略 | 5种可切换: rule_only, llm_only, max(默认), min, avg |

## A维度: 检索质量 (9指标, w=0.40)

| 指标 | 编号 | 评测方式 | 得分范围 | 双轨 |
|------|------|---------|---------|------|
| context_recall | A1 | gold_entities 7级模糊匹配 + embedding余弦兜底 (>=0.85) | 0-1 | rule+llm |
| context_precision | A2 | chunk与query相关度 (LLM逐条评分) | 0-1 | rule+llm |
| context_relevancy | A3 | 有效信息占比 (LLM section评分) | 0-1 | rule+llm |
| entity_utilization | A4 | uniqueEntities在fusedContext中出现比例 | 0-1 | rule+llm |
| mrr | A5 | 首个相关chunk排名倒数 | 0-1 | rule+llm |
| ndcg | A6 | 排序质量归一化折损累积增益 | 0-1 | rule+llm |
| context_diversity | A7 | 去YAML+取中部200字去重比例 | 0-1 | rule+llm |
| cross_doc_coverage | A8 | 检索覆盖的论文来源数 (min(1, count/5)) | 0-1 | rule+llm |
| context_json_contamination | A9 [V41新增] | fusedContext中JSON/YAML/元数据噪音行占比 | 0-1 | rule+llm |

## B维度: 答案质量 (9指标, w=0.35)

| 指标 | 编号 | 评测方式 | 得分范围 |
|------|------|---------|---------|
| answer_correctness | B1 | 答案与金标语义一致性 | 0-1 |
| answer_completeness | B2 | 覆盖金标核心要点 (拓展不扣分) | 0-1 |
| answer_relevancy | B3 | 直接针对提问，无无关发散 | 0-1 |
| faithfulness | B4 | 事实陈述在检索上下文中有依据 | 0-1 |
| hallucination_rate | B5 | 反幻觉 (1=无编造, 0=大量虚假) | 0-1 |
| factual_consistency | B6 | 回答内部事实逻辑不自相矛盾 | 0-1 |
| citation_f1 | B7 | 引用精确度与来源可验证 | 0-1 |
| conciseness | B8 | 文本简洁 (只扣重复/冗余/无信息填充) | 0-1 |
| answer_readability | B9 | 文本结构分层、表达清晰 | 0-1 |

## C维度: 推理质量 (3指标, w=0.25)

| 指标 | 编号 | 题型 | 评测方式 |
|------|------|------|---------|
| cot_quality | C1 | 所有类型 | 五级刻度 (0/0.3/0.5/0.7/1.0) |
| reasoning_depth | C2 | 所有类型 | 五级刻度 + [StepN]实际跳数计数 |
| multi_hop_accuracy | C3 | 仅多跳推理 | 多跳推理准确性 |

## D维度: 性能指标 (7指标, w=0.00)

| 指标 | 归一化方式 |
|------|-----------|
| stage2_latency_norm | 1 - min(1, latency/MAX_LATENCY_S2) |
| stage3_latency_norm | 1 - min(1, latency/MAX_LATENCY_S3) |
| stage4_latency_norm | 1 - min(1, latency/MAX_LATENCY_S4) |
| end_to_end_norm | 1 - min(1, e2e/MAX_E2E) |
| token_efficiency | min(1, max(0.1, gold_token_count/pred_token_count)) |
| neo4j_query_norm | 1 - min(1, neo4j_queries/MAX_NEO4J_QUERY) |
| pg_query_norm | 1 - min(1, pg_queries/MAX_PG_QUERY) |

## LLM Judge 架构

```
_llmJudgeOnce(prompt):
  DeepSeek v4-flash (DashScope qwen-plus fallback)
  → JSON { score: 0~1浮点数, reason: "一句话说明依据" }
  2次重试 (指数退避: 2s + 随机0-3s)
  自动检测分类错误: RateLimit→退避, Arrearage→fallback

runThreeRoundMedian(judgeFn):
  3轮独立调用 → 取中位数
  IQR过滤 (THRESHOLD=0.3, 可变)
  → { median, warning(variance大), sample_count }

mergeScore(rule_score, llm_score):
  5种策略: rule_only | llm_only | max(默认) | min | avg
```

## 评测入口

```bash
# 全量 50 题
npx tsx scripts/eval-22-metrics.ts

# 指定题目
EVAL_QUESTIONS=Q01,Q05,Q09 npx tsx scripts/eval-22-metrics.ts

# 指定维度
EVAL_DIMS=A npx tsx scripts/eval-22-metrics.ts

# 切换融合策略
EVAL_MERGE_POLICY=llm_only npx tsx scripts/eval-22-metrics.ts
```

## 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| MAX_CONTEXT_LEN | 6000 | fusedContext 截断长度 |
| FETCH_TIMEOUT_MS | 300000 | SAG HTTP 超时 |
| JUDGE_TIMEOUT_MS | 60000 | LLM Judge 超时 |
| CONCURRENCY_LIMIT | 3 | 并发限制 |
| SEMAPHORE_TIMEOUT_MS | 180000 | 信号量排队超时 |
| IQR_THRESHOLD | 0.3 | IQR 过滤阈值 |
| TOP_K | 15 | chunk 检索数量 |
| DIM_WEIGHTS | A:0.40 B:0.35 C:0.25 D:0.00 | 维度权重 |
| MERGE_POLICY | max | 双轨融合策略 |

## 评判者校准流程（2026-08-08 P0-4 新增）

**Judge prompt 或 Rubric 任何更新 → 重跑 judge-calibration → kappa ≥ 0.7 才放量。**

- 金标集: `data/judge_gold.json`（20 条起步, 每周 +10 条人工标注, 优先覆盖低分题和分歧题）
- 校准: `npx tsx scripts/judge-calibration.ts` → 输出 `kappa_report.md`
- 指标: Cohen's kappa（两档: 达标 ≥0.55 / 不达标）, kappa = (p_o - p_e) / (1 - p_e)
- 当前值: **kappa = 1.000**（2026-08-08, 20 条: 14 达标 + 6 不达标, 0 分歧）
- kappa < 0.7 → 禁止把新评测结果当发布依据, 先修 Judge prompt
- 定期人工抽检评分理由（看"理由 vs 分数"是否矛盾）

## 模型替换实验（2026-08-08 P0-5 新增）

- `MODEL_SWAP_ROLE=reason:qwen3.7-max` 环境变量覆盖 reason 角色模型（llm-model-registry.getRoleModel 支持）
- 固定 Harness 只换模型: 换强模型不涨 → Harness 瓶颈; 换弱模型大跌 → 模型瓶颈
- 用法: `MODEL_SWAP_ROLE=reason:deepseek-v4-pro bash scripts/model-swap-eval.sh pro`
- 对照矩阵与结论: `eval-archive/model-swap-20260807.md`
