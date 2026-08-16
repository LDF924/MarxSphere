# SAG 全链路调用图谱 — V88K 最终版

## 推理链路

```
┌──────────────────────────────────────────────────────────────┐
│              POST /api/reason/query (Fastify :4173)           │
│                    ↓ P1-7c: 分级错误响应 (503/500)           │
│                                                              │
│ Stage 0: detectQuestionType (纯regex, 4-way)                 │
│ Stage 1: generateOutline (qwen-plus)                         │
│ Stage 2: Cognee粗检索 + PG并行查询 (V25三路并行)             │
│ 实体提取: 13路来源 → entityNames[30]                         │
│ Stage 3: Graphiti精炼 (callG 90s, DeepWalk 12-hop, 90s)     │
│ Stage 4: fuseResults(12 section) → generateHypothesis        │
│          → evaluateHypothesis (交叉校验)                     │
│                    ↓                                         │
│ trace → eval-22-metrics.ts (V88K, 1059行)                      │
│   → 28 metrics → overall (A:0.40 B:0.35 C:0.25 D:0.00)      │
└──────────────────────────────────────────────────────────────┘
```

## 评测链路 (eval-22-metrics.ts V88K)

```
┌──────────────────────────────────────────────────────────────┐
│                    SAG HTTP Response (Port 4173)              │
│     hypothesis / fusedContext / entityNames / timings         │
│     _debugCoarse (15+10 chunks, 300-char each)                │
│     _debugRefined (entities, distills, domain, papers)        │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    evalSingleSample()                         │
│  EVAL_DIMS env var: 空=全部, "A"=仅检索, "A,B"=A+B           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ A维度 (8项) — 检索质量                                       │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ A1 context_recall (mixed)                                │ │
│ │   7级cascade匹配 → embedding兜底 → LLM max               │ │
│ │                                                          │ │
│ │ A2 context_precision (judge) ★V88K升级                    │ │
│ │   逐个chunk llmJudgeSingle (top 10, chunkCount=10)       │ │
│ │   预处理: 去YAML → 取中段300字 → 连续分数(0-1)          │ │
│ │   → 加权累计 → relevantCnt / 10                          │ │
│ │                                                          │ │
│ │ A3 context_relevancy (judge) ★V88K升级                    │ │
│ │   split by '\n## ' → 前8个section各自llmJudgeSingle     │ │
│ │   → 取平均分                                             │ │
│ │                                                          │ │
│ │ A4 entity_utilization (rule) ★V88K升级                    │ │
│ │   归一化(小写+去标点)子串匹配                             │ │
│ │   未命中 → embedding cosine>=0.6兜底                     │ │
│ │                                                          │ │
│ │ A5 MRR (embedding) ★V88K升级                              │ │
│ │   cleanChunk去YAML → DashScope embedding                 │ │
│ │   BATCH_MAX=9 (API≤10限制)                                │ │
│ │   首个cosine>=0.5 → 1/rank                                │ │
│ │                                                          │ │
│ │ A6 NDCG (embedding) ★V88K升级                             │ │
│ │   Math.min(1, dcg/idcg) → 硬上限1.0                      │ │
│ │                                                          │ │
│ │ A7 context_diversity (rule)                              │ │
│ │   去YAML+取中部200字 → Set去重                            │ │
│ │                                                          │ │
│ │ A8 cross_doc_coverage (rule)                             │ │
│ │   paperTitle提取 → 去重论文数 / 5                        │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ B维度 (9项) — 答案质量 (batch JSON, hasAnyNonNull回退)      │
│ C维度 (3项) — 推理质量 (3-pass median + batch JSON)         │
│ D维度 (7项) — 效率指标 (权重0.00, 纯观测)                    │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│              综合分 = 0.40×A + 0.35×B + 0.25×C              │
│              D=0.00 纯观测不参与计算                          │
│                                                              │
│              METRIC_SPEC 逐指标明细 → eval_32metrics.json     │
└──────────────────────────────────────────────────────────────┘
```

## LLM Judge 调用图谱

```
┌──────────────────────────────────────────────────────────────┐
│           DeepSeek API (api.deepseek.com)                     │
│           model: deepseek-v4-flash, temperature=0.1           │
│           并发信号量: CONCURRENCY_LIMIT=3                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ llmJudgeSingle (max_tokens=5000, 3-pass median)              │
│   解析: /([01](?:\.\d+)?)/ → 整数0/1也能匹配               │
│   调用者:                                                    │
│   - A1 context_recall (3-pass)                               │
│   - A2 context_precision (逐个chunk, 连续分数) ★V88K          │
│   - A3 context_relevancy (逐section) ★V88K                    │
│   - C1 cot_quality (3-pass)                                  │
│   - C2 multi_hop_accuracy (3-pass, 条件)                     │
│   - B组 fallback (逐个单评, 4个维度注入上下文)               │
│                                                              │
│ llmJudgeBatchObject (max_tokens=5000)                        │
│   解析: /{[\s\S]*}/ → JSON.parse                              │
│   调用者:                                                    │
│   - B1-B9 (batch 9项, 随机打乱顺序)                          │
│   - C3 reasoning_depth (三项分评)                            │
│   回退: hasAnyNonNull=false → 逐个 llmJudgeSingle             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Embedding 调用图谱

```
┌──────────────────────────────────────────────────────────────┐
│        DashScope API (dashscope.aliyuncs.com)                 │
│        model: text-embedding-v4 (1024d)                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ A1/A4 实体语义兜底                                           │
│   输入: [fusedContext[:4000], entity1, entity2, ...]         │
│   判定: cosine(fcVec, entityVec) ≥ 0.85(A1) / 0.6(A4) → 命中│
│                                                              │
│ A5/A6 MRR + NDCG ★V88K升级                                    │
│   输入: [gold_answer, cleanChunk(chunk1), cleanChunk(chunk2)│
│   BATCH_MAX=9 (API≤10限制)                                   │
│   MRR: 首个cosine≥0.5 → 1/rank                               │
│   NDCG: Math.min(1, DCG/IDCG)                                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## V88K 版本标签

| 阶段 | Tag | 关键变化 |
|------|-----|----------|
| 问题分类 | V9 | 4路分调 |
| 实体提取 | V25 | NER阈值20, 短事实跳过 |
| Stage2 | V25 | 三路并行 + embedding复用 + external_entities embedding |
| Stage3 | V25 | callG 90s + DeepWalk 12-hop + entities/hybrid分离 |
| Stage4 | V25 | 全局去重 + COT增量 + 空上下文guard + JSON容错 + 引用交叉检查 |
| **评测** | **V88K** | **24项缺陷修复 + 1059行 + A2连续分/A3逐section/A4归一化/A5 cleanChunk/A6上限/EVAL_DIMS** |
| 基础设施 | V25 | MCP生命周期 + 分级错误 + DB重试 + PG超时 |
