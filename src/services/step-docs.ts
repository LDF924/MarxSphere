// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// step-docs.ts — 检索步骤详情文档（GBrain 教学台：面板 echo 后端真实代码）
// 每步关联：真实 SQL / 公式 / 代码片段 / 说明。前端步骤展开时展示。
// 与 search-service 的 emitSearchStep key 对齐。

export interface StepDoc {
  key: string;
  title: string;
  /** 该步做了什么（一句话） */
  what: string;
  /** 真实 SQL（keyword/vector 召回等） */
  sql?: string;
  /** 算法公式 */
  formula?: string;
  /** 关键代码片段 */
  code?: string;
}

export const STEP_DOCS: StepDoc[] = [
  {
    key: "step0AliasNormalize",
    title: "别名消解",
    what: "查询词归一：把同义/别名实体名映射到规范名（如\"工商资本\"→\"资本\"）。",
    code: `// alias.ts aliasNormalize
// 别名表：normalized_name ↔ 常见别名
const ALIASES = new Map([
  ["资本", ["工商资本", "社会资本", "民间资本"]],
  ["土地流转", ["农地流转", "土地经营权流转"]]
]);
// 查询中出现别名 → 替换为规范名，并记录 replacements 供下游使用`,
    formula: "query → aliasMap(query)  命中则替换 + 记录"
  },
  {
    key: "step1Bm25Entities",
    title: "BM25 匹配查询实体",
    what: "直接用用户问题在实体库做全文/BM25 匹配，不调用 LLM 抽取 key（fast 模式）。",
    sql: `-- searchEntitiesByText（repositories.ts）
with q as (
  select websearch_to_tsquery('simple', $2) as tsq,
         lower($2) as raw_query
)
select ent.id, ent.name, ent.normalized_name,
       greatest(
         coalesce(ts_rank_cd(ent.search_text, q.tsq), 0),     -- 全文
         similarity(ent.normalized_name, q.raw_query),        -- 模糊
         case when q.raw_query like '%' || ent.normalized_name || '%' then 1.0 else 0 end,
         case when ent.normalized_name = q.raw_query then 1.2 else 0 end
       ) as score
from entities ent cross join q
where ent.search_text @@ q.tsq
   or ent.normalized_name % q.raw_query`,
    formula: "score = max(ts_rank_cd, similarity, 1.0 if 包含, 1.2 if 精确)"
  },
  {
    key: "step1ExtractEntities",
    title: "抽取查询实体（LLM）",
    what: "用 LLM 识别用户问题中的关键实体（deepseek-v4-flash）。",
    code: `// llm-client.extractNamedEntities
const result = await this.chatJson(settings, {
  system: "Extract named entities important for answering the question. Return JSON only.",
  user: JSON.stringify({ question: query, schema: { named_entities: ["string"] } })
});
// 失败时回退本地正则抽取 localNamedEntities(query)`
  },
  {
    key: "step2AliasHop",
    title: "权威实体注入（别名跳转）",
    what: "查询命中别名时，把权威实体（知识页沉淀实体）注入召回集。",
    code: `// search-service step2AliasHop
// 别名命中 → 查知识页关联的权威实体 → 注入 recalledEntities`,
    formula: "alias_hit → authoritative_entity 注入"
  },
  {
    key: "step2Relational",
    title: "关系臂召回",
    what: "从查询中解析实体关系（谁投资谁/谁创办谁），按关系类型召回事件。",
    code: `// search-service step2Relational
const isRelational = /与|和|关系|关联|连接|联系|谁.*投资|谁.*创办|谁.*合作/.test(query);
// 命中 → relationalFanout 沿事件超图扇出`,
    formula: "relation_pattern → fanout(event_entities)"
  },
  {
    key: "step2RetrieveEntities",
    title: "召回相关实体",
    what: "按实体名称精确匹配 + 实体向量召回（多路合并去重）。",
    sql: `-- searchEntitiesByName（repositories.ts）
select ent.id, ent.name, ent.normalized_name
from entities ent
where ent.source_id = any($1::uuid[])
  and ent.normalized_name = any($2::text[])
-- 再按每个实体向量做 searchEntitiesByVector：
--   1 - (ent.embedding <=> $query_vec) as score`,
    formula: "exact_name ∪ vector_sim 去重"
  },
  {
    key: "step3EntityEvents",
    title: "实体关联事件",
    what: "按召回实体的 id 查关联事件（事件图谱边）。",
    sql: `-- getEventIdsByEntityIds（repositories.ts）
select ee.event_id, count(*) as entity_hits
from event_entities ee
where ee.entity_id = any($1::uuid[])
group by ee.event_id
order by entity_hits desc
limit $2`
  },
  {
    key: "step3QueryEvents",
    title: "标题向量召回事件",
    what: "把问题向量化，按事件标题向量召回相关事件。",
    sql: `-- searchEventsByTitleVector（repositories.ts）
select e.id, e.title, e.summary,
       1 - (e.title_embedding <=> $2::vector) as score  -- cosine
from events e
join documents d on d.id = e.document_id
where e.source_id = any($1::uuid[])
  and e.deleted_at is null
order by e.title_embedding <=> $2::vector
limit $3`,
    formula: "cosine(q, title_vec) = 1 - (q <=> v)"
  },
  {
    key: "step3MultiQuery",
    title: "多查询变体召回",
    what: "LLM 生成多个等价改写（如\"资本下乡对集体经济的影响\"→\"资本如何影响农村集体经济\"），每路独立召回补充。",
    code: `// llm-client generateQueryVariants（deepseek-v4-flash）
// 提示词：把用户问题改写为 3 个等价问题（不同表达、更口语/更书面/更具体）
const variants = await this.generateQueryVariants(query, 3);
// 每路跑 title 向量召回 → 合并去重`,
    formula: "query → {v1, v2, v3} → Σ recall(v_i)"
  },
  {
    key: "step3Cognee",
    title: "Cognee 检索臂",
    what: "三库融合：Cognee（Neo4j 11003）语义检索，结果转统一结构。",
    code: `// retrieval-sources loadSourceConfig + cognee MCP
// cognee_search（hybrid/entities/chunks 多 search_type）`,
    formula: "cognee_hybrid(q) → RetrievalHit[]"
  },
  {
    key: "step3Graphiti",
    title: "Graphiti 检索臂",
    what: "三库融合：Graphiti（Neo4j 11001）实体+事件检索。",
    code: `// retrieval-sources + graphiti MCP
// hybrid_search_entities → 实体命中转 RetrievalHit`,
    formula: "graphiti_hybrid(q) → RetrievalHit[]"
  },
  {
    key: "step4FetchDetails",
    title: "事件详情回取",
    what: "按候选事件 id 批量回取完整事件（含实体列表）。",
    sql: `-- getEventsWithEntityIds（repositories.ts）
select e.*, coalesce(
  array_agg(ee.entity_id) filter (where ee.entity_id is not null),
  '{}'
) as entity_ids
from events e
left join event_entities ee on ee.event_id = e.id
where e.id = any($1::uuid[])
group by e.id`
  },
  {
    key: "step5Expand",
    title: "事件扩展",
    what: "对种子事件做关联扩展：同文档事件 + 共现实体事件（GBrain expansion）。",
    code: `// search-service expandEvents
// 1. 同 document_id 的其他事件
// 2. 与种子事件共享实体的其他事件（超图一跳）`,
    formula: "seed_events → {same_doc ∪ shared_entity}"
  },
  {
    key: "step5GraphTraversal",
    title: "图谱遍历",
    what: "递归 CTE 两跳遍历实体关系（事件超图）。",
    sql: `-- graphTraversalTwoHops（repositories.ts）
with recursive hops as (
  select ee.entity_id, 0 as depth
  from event_entities ee where ee.entity_id = any($1::uuid[])
  union all
  select ee2.entity_id, h.depth + 1
  from hops h
  join event_entities ee1 on ee1.entity_id = h.entity_id
  join events e on e.id = ee1.event_id
  join event_entities ee2 on ee2.event_id = e.id
  where h.depth < $2
)
select distinct entity_id from hops`
  },
  {
    key: "step6CoarseRank",
    title: "粗排序（RRF 融合）",
    what: "加权 RRF 多路融合：内容向量/标题向量/BM25 三路，意图调 k + 归一。",
    code: `// gbrain-boosts rrfFusionWeighted
rrf_score = Σ 1/(k + rank_i)   // k 按意图：entity/event → kwK 降低
// 归一化后与 cosine 7:3 混合（cosineReScore）`,
    formula: "rrf = Σ 1/(k + rank_i),  k = 60 (intent 调)"
  },
  {
    key: "step6CompiledTruth",
    title: "Compiled Truth 检索",
    what: "检索知识页已沉淀结论，命中项 ×2.0 boost（权威版本优先）。",
    code: `// gbrain-boosts / search-service
const boost = chunk_source === 'compiled_truth' ? 2.0 : 1.0;
e.score *= boost;   // 权威版本 ×2.0`,
    formula: "score *= (chunk_source === 'compiled_truth' ? 2.0 : 1.0)"
  },
  {
    key: "step7LlmRerank",
    title: "LLM 重排",
    what: "让 reranker 从 top-30 候选中打分选择（rerank_score 连续分）。",
    code: `// rerank-client.remoteRerank
// DashScope 原生端点（qwen3-rerank）
POST https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
{
  model: "qwen3-rerank",
  input: { query, documents },
  parameters: { top_n: topN, return_documents: false }
}`
  },
  {
    key: "step8FetchChunks",
    title: "回取关联切片",
    what: "读取最终事件关联的原文切片作为上下文。",
    sql: `-- getSectionsForEvents（repositories.ts）
select sc.id as chunk_id, sc.heading, sc.content
from source_chunks sc
where sc.id = any($1::uuid[])
order by array_position($1::uuid[], sc.id)`
  },
  {
    key: "step8Neo4jSections",
    title: "Neo4j 证据补充",
    what: "三库融合落点：Graphiti/Cognee 臂的命中追加为补充证据片段。",
    code: `// search-service BUG#2 修复
// graphitiHits + cogneeHits → 去重后追加进 sections
sections.push({ chunkId: \`neo4j-\${hit.source}-\${n}\`, ... })`,
    formula: "neo4j_hits 追加（content 去重）"
  },
  {
    key: "step8TruthGuarantee",
    title: "权威版本保底",
    what: "知识页命中即使被切片淹没也硬保一席（Compiled Truth Guarantee）。",
    code: `// search-service step8TruthGuarantee
// compiledTruth 命中未进 sections → 强制追加（score 999 最高优先级）
sections.push({
  chunkId: \`truth-guarantee-\${n}\`,
  heading: \`[知识页] \${title}\`,
  score: 999
})`,
    formula: "truth_hit → 保底一席（score 999）"
  },
  {
    key: "fallback",
    title: "降级路径",
    what: "多路检索失败/空结果时降级回纯向量检索。",
    code: `// search-service fallback
// multiSearch 异常或 RRF 全空 → vectorSearch（单路向量）
const fallback = await this.vectorSearch({ ...input, strategy: "vector" })`
  }
];

const DOC_MAP = new Map(STEP_DOCS.map((d) => [d.key, d]));

/** 按步骤 key 取文档（无则返回 null） */
export function getStepDoc(key: string): StepDoc | undefined {
  return DOC_MAP.get(key);
}

export const stepDocs = { list: STEP_DOCS, get: getStepDoc };
