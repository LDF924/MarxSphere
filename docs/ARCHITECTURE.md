# MarxSphere 全链路检索流程 (V88K) + eval-22-metrics V40 评测体系

> 入口: `POST /api/reason/query` (Fastify :4173) → reasonWithFallback (V80自愈闭环)
> 核心: `InferenceService` (src/services/inference-service.ts, 1682行)
> 评测: `scripts/eval-22-metrics.ts` (1059行, V41 — 32指标, A9-A12新增)

## 1. 整体架构 — 四层检索管道

```
                             ┌───────────────────────────┐
                             │     用户 Query (HTTP)      │
                             │  概念定义/事实检索/多跳推理/政策评估 │
                             └─────────────┬─────────────┘
                                           │
                             ┌─────────────▼─────────────┐
                             │    detectQuestionType()    │
                             │  4路分类 + 7降级规则       │
                             └─────────────┬─────────────┘
                                           │
                             ┌─────────────▼─────────────┐
                             │  V50 expandQuery() 查询扩展  │
                             │  L1: external_entities.name │
                             │  L2: external_entities.desc │
                             │  L3: source_chunks.heading  │
                             │  +V88B LLM同义句            │
                             │  +V88C type过滤             │
                             │  +V88K heading extract     │
                             └─────────────┬─────────────┘
                                           │
┌──────────────────────────────────────────┼──────────────────────────────────────────┐
│                                          │                                          │
│  ┌───────────────────────┐  ┌────────────▼───────────────┐  ┌────────────────────┐ │
│  │ 阶段2: 粗检索           │  │ 阶段3: Graphiti精炼        │  │ 阶段4: 融合生成  │ │
│  │ stage2_cogneeCoarse    │  │ stage3_graphitiRefine     │  │ reason() 主流程     │ │
│  │                        │  │                           │  │                     │ │
│  │ Cognee MCP (3路并行):   │  │ Phase A (并行):            │  │ V85 Graphiti→PG     │ │
│  │  CHUNKS (topK=25)      │  │  chunk_search_entities    │  │   交叉信号          │ │
│  │  RAG_COMPLETION (15)   │  │  search_literature        │  │                     │ │
│  │  HYBRID_COMPLETION(15) │  │  get_entity_info          │  │ V42 fuseResults     │ │
│  │                        │  │  search_by_concept        │  │   按来源配额融合:    │ │
│  │ PG 本地双路 (并行):     │  │                           │  │   Cognee  35% 2100  │ │
│  │  pgvector entity (20)  │  │ Phase B (并行):            │  │   PG      25% 1500  │ │
│  │  pgvector chunk (20)   │  │  hybrid_search_entities   │  │   Graphiti25% 1500  │ │
│  │  V47 ILIKE keyword(10) │  │  get_distill_content      │  │   PG全文  10% 600   │ │
│  │  V88A document boost   │  │  get_domain_knowledge     │  │   实体名   5% 300   │ │
│  │  V63 HyDE双向量        │  │                           │  │                     │ │
│  │                        │  │ Entity合并+展开(1-hop)     │  │ generateHypothesis  │ │
│  │ Cognee词法 (仅factual): │  │                           │  │  LLM: DS/DashScope  │ │
│  │  CHUNKS_LEXICAL (15)   │  │                           │  │                     │ │
│  │                        │  │                           │  │ evaluateHypothesis  │ │
│  │ Cognee Neo4j直连:       │  │                           │  │  LLM Judge 交叉校验  │ │
│  │  Entity CONTAINS查询    │  │                           │  │                     │ │
│  └───────────────────────┘  └───────────────────────────┘  └────────────────────┘ │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. V80 检索自愈闭环 (reasonWithFallback)

```
策略1: reason() 全栈检索 ──成功→ standard 返回
  │失败
  ▼
策略2: reason(expandedQuery) 全栈+180s超时 ──成功→ expandedQuery 返回
  │超时
  ▼ reasonFast回退
策略3: reason(hydeAnswer) 全栈+180s超时 ──成功→ hyde 返回
  │超时
  ▼ reasonFast回退
策略4: reason(query+entityNames) 全栈+180s超时 ──成功→ entityBoost 返回
  │超时
  ▼ reasonFast回退
  
全部用尽 → fallback_exhausted 返回策略1结果
```

**reasonFast**: PG+ILIKE+LLM轻量检索(无CogneeMCP/GraphitiMCP), 5-15s, 仅在回退时调用

## 3. PG 双路检索详细

```
query + expandQuery扩展词
  │
  ├─ embeddingClient.generate(query) → queryVec
  │  └─ V63 HyDE (factual): LLM生成假设答案 → hydeVecStr || queryVecStr
  │
  ├─ entity_vec_search: ORDER BY embedding<=>(hydeVec||queryVec) LIMIT 20
  ├─ chunk_vec_search: ORDER BY embedding<=>(hydeVec||queryVec) LIMIT 20
  │
  └─ ILIKE keyword (V47, V60, V88A):
       expandKw = query拆词 ∪ entities扩展
       → ORDER BY hitCount DESC, LENGTH ASC LIMIT 10
       → V88A: 命中doc_id → 注入同doc其他chunks LIMIT 10
       → 去重合并到 result.pgChunks
```

## 4. fuseResults V42 配额引擎

```
maxTotal = 6000

QUOTA_COGNEE   = ceil(6000 × 0.35) = 2100
QUOTA_PG       = ceil(6000 × 0.25) = 1500
QUOTA_GRAPHITI = ceil(6000 × 0.25) = 1500
QUOTA_FT       = ceil(6000 × 0.10) = 600
QUOTA_NAMES    = ceil(6000 × 0.05) = 300

每个来源独立 appendWithCap(header, text, quota, priority)
  → 超限自动截断 → [TRUNCATED]
  → 最接近换行或句号处切断

处理顺序:
  1. Cognee chunks (body+QA) + RAG → QUOTA_COGNEE
  2. PG chunks (entity+vector+ILIKE) → QUOTA_PG
  3. PG fulltext → QUOTA_FT
  4. Graphiti entities+distills+domain+papers → QUOTA_GRAPHITI
  5. Entity names → QUOTA_NAMES

sections.sort(priority) → join('\n\n') → substring(0, maxTotal)
```

## 5. expandQuery 扩展链路

```
expandQuery(query, sourceId, profile)
  │
  ├─ Step 1: 分词 + 停用词过滤 → contentWords[前6]
  │
  ├─ Step 2: external_entities (V88C type过滤)
  │   SELECT name FROM external_entities
  │   WHERE (name ILIKE '%w%' OR description ILIKE '%w%')
  │   [AND type IN (政策类)] LIMIT 5
  │
  ├─ Step 3: source_chunks heading (V88K)
  │   如果 extensions.length < 5:
  │     SELECT heading FROM source_chunks
  │     WHERE content ILIKE '%kw1%' AND content ILIKE '%kw2%' LIMIT 5
  │
  ├─ Step 4: LLM同义句 (V88B)
  │   "请把以下问题改写成2个同义问句: {query}"
  │   → 提取新词注入
  │
  └─ return query + ' ' + unique(extensions).slice(0,15)
```

## 6. 评测架构 (eval-22-metrics V40)

```
32指标, 1119行
  A维度 (9, w=0.40): recall/precision/relevancy/entity/mrr/ndcg/diversity/
                     cross_doc_coverage/context_json_contamination(A9)
  B维度 (9, w=0.35): correctness/completeness/relevancy/faithfulness/
                     hallucination/factual_consistency/citation_f1/
                     conciseness/readability
  C维度 (3, w=0.25): cot_quality/reasoning_depth/multi_hop_accuracy
  D维度 (7, w=0.00): stage2/3/4 latency_norm, end_to_end_norm,
                     token_efficiency, neo4j_query_norm, pg_query_norm

overall = 0.40A + 0.35B + 0.25C + 0.00D

LLM Judge: _llmJudgeOnce → runThreeRoundMedian → mergeScore(rule, llm)
          双轨(rule_score + llm_score), 融合策略: max
```

## 7. 基础设施拓扑

```
SAG API (:4173, Fastify, tsx) → reasonWithFallback
  ├─ MCP stdio → Cognee Python → Neo4j Cognee (:11003, 38672 nodes)
  ├─ MCP stdio → Graphiti Python → Neo4j Graphiti (:11001, 31627 nodes)
  └─ PG :5540 (pgvector) → 6925 chunks + 34978 entities
```

## 8. 八题矩阵

| Q10 | ✅ standard | Q18 | ✅ standard | Q26 | ✅ standard |
| Q30 | ✅ standard | Q41 | ✅ standard | Q47 | ✅ standard |
| Q22 | ✅ hyde | Q44 | ⚠️ hyde(有答案,术语不精确) | | |
