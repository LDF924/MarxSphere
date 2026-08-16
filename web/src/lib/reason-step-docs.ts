// reason-step-docs.ts — 推理 52 步步骤详情文档（GBrain 教学台：面板 echo 后端真实实现）
// 每步关联：真实 SQL / 公式 / 代码片段。前端步骤展开时展示（与 Ask 的 step-docs 同款）。

export interface ReasonStepDoc {
  /** 步骤名（Record key 已含，此处冗余，可选） */
  name?: string;
  /** 该步做什么 */
  what: string;
  /** 真实 SQL */
  sql?: string;
  /** 算法公式 */
  formula?: string;
  /** 关键代码片段 */
  code?: string;
  /** 触发条件说明（该步骤在特定条件下才执行） */
  trigger?: string;
}

export const REASON_STEP_DOCS: Record<string, ReasonStepDoc> = {
  "问题分类": {
    what: "用正则把问题分成概念定义/事实检索/多跳推理/政策评估四类",
    formula: "detectQuestionType(q) → PROFILES[type]",
    code: `// inference-service detectQuestionType
// 概念定义/事实检索/多跳推理/政策评估 → 各自的 cogneeChunksTopK / cotMode`
  },
  "意图识别": {
    what: "识别问题意图（entity/temporal/event/general），决定检索配置",
    formula: "classifyQueryIntent(q) → { intent, suggestedDetail }",
    code: `// gbrain-boosts classifyQueryIntent（零 LLM 正则）
TEMPORAL_PATTERNS: /\\bwhen\\b|最近|何时|近年/
EVENT_PATTERNS: /宣布|推出|投资/`
  },
  "术语变体": {
    what: "生成领域术语变体（简称→全称），提升召回",
    code: `// aliasNormalize + external_entities 术语表`,
    formula: "term(q) → {简称, 全称, 别称}"
  },
  "拆分子问题": {
    what: "大纲生成：把主问题拆成子问题",
    code: `// generateOutline（LLM）
const outline = await this.generateOutline(input.query);
// → outlines 表：title + description + depth`,
    formula: "q → {子问题1, 子问题2, 子问题3}（depth 分层）"
  },
  "实体抽取": {
    what: "从粗检结果提取实体名（过滤噪声）",
    code: `// extractEntityNames
const names = new Set<string>();
// 学术后缀过滤 + 长度过滤 + 停用词过滤`,
    formula: "coarse_results → entities（去重+过滤）"
  },
  "Cognee HYBRID": {
    what: "Cognee 混合检索（语义+关键词）",
    code: `// stage2_cogneeCoarse → cogneeSearch('hybrid')
// MCP: cognee_search(search_type='hybrid')`,
    sql: `-- Cognee 内部（Neo4j 11003）
MATCH (c:Chunk)
WHERE c.text CONTAINS $term OR c.embedding <=> $vec < 0.8
RETURN c LIMIT 15`
  },
  "RAG补全": {
    what: "RAG 补全检索",
    code: `// cogneeSearch('rag')
const result = await this.cogneeMCP.callTool('cognee_search', { search_type: 'rag', query })`
  },
  "图遍历": {
    what: "知识图谱遍历",
    code: `// cogneeSearch('graph')
// Cognee 图谱节点遍历`,
    formula: "entity → 一跳/二跳邻居"
  },
  "关系三元组": {
    what: "三元组检索（subject-relation-object）",
    code: `// cogneeSearch('triplet')
// 返回 (主体, 关系, 客体) 结构化事实`
  },
  "摘要检索": {
    what: "摘要级语义检索",
    code: `// cogneeSearch('summary')
// 按文档摘要检索`,
    formula: "cosine(summary_vec, q_vec)"
  },
  "子问题推理": {
    what: "子问题级推理检索",
    code: `// cogneeSearch('subq') — 大纲子问题各检索一轮`
  },
  "上下文扩展": {
    what: "上下文扩展检索（邻居段落）",
    code: `// cogneeSearch('ctx') — 命中 chunk 的上下文窗口扩展`
  },
  "时序分析": {
    what: "时序检索（时间属性问题）",
    code: `// cogneeSearch('temporal') — 只对时序类问题触发`,
    trigger: "时序类问题（何时/最近/近年）"
  },
  "PG实体补漏": {
    what: "PG 实体 ILIKE 补漏",
    sql: `-- stage2 PG 臂
SELECT ent.id, ent.name
FROM entities ent
WHERE ent.source_id = $1
  AND ent.name ILIKE '%' || $2 || '%'
LIMIT 10`
  },
  "PG向量": {
    what: "PG 实体/切片向量检索",
    sql: `-- PG 向量臂
SELECT id, 1 - (embedding <=> $1::vector) AS score
FROM entities
WHERE source_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 10`
  },
  "CHUNKS词法": {
    what: "PG 切片词法检索",
    sql: `-- PG 词法臂
SELECT id, ts_rank_cd(search_text, websearch_to_tsquery('simple', $1)) AS score
FROM source_chunks
WHERE search_text @@ websearch_to_tsquery('simple', $1)
LIMIT 10`
  },
  "语义检索": {
    what: "Cognee 语义检索",
    code: `// cogneeSearch('semantic') — 纯向量`,
    formula: "cosine(q, chunk)"
  },
  "实体直查": {
    what: "实体名精确直查",
    sql: `SELECT id, name FROM entities
WHERE normalized_name = $1 AND source_id = $2`
  },
  "实体精炼": {
    what: "Graphiti 实体精炼检索",
    code: `// stage3_graphitiRefine → hybrid_search_entities
// MCP: hybrid_search_entities(entity_names)`,
    sql: `-- Graphiti（Neo4j 11001）
MATCH (e:Entity) WHERE e.name IN $names
RETURN e`
  },
  "概念搜索": {
    what: "Graphiti 概念检索",
    code: `// MCP: concept_search`,
    sql: `MATCH (c:Concept) WHERE c.name CONTAINS $term RETURN c`
  },
  "文献蒸馏": {
    what: "五层蒸馏（Graphiti 知识沉淀）",
    code: `// distill_robust.py 五层蒸馏
// 摘要→主题→事件→实体→关系`
  },
  "领域知识": {
    what: "领域知识检索",
    code: `// MCP: domain_search`
  },
  "实体邻居": {
    what: "实体邻居检索",
    sql: `MATCH (e:Entity)-[r]-(n) WHERE e.id = $1
RETURN n, r LIMIT 20`
  },
  "段落回溯": {
    what: "段落回溯（chunk → 原文段落）",
    sql: `SELECT sc.content FROM source_chunks sc
WHERE sc.id = $1`
  },
  "论文溯源": {
    what: "论文定位（paper_id → 标题）",
    code: `// getPaperTitleByPaperId
const title = paper_id_map[paperId]?.title`,
    trigger: "带 paperId 或论文定位命中"
  },
  "DeepWalk扩展": {
    what: "DeepWalk 图嵌入扩展",
    code: `// deepwalk_expand — 图嵌入近邻`,
    trigger: "图遍历结果稀疏时"
  },
  "关系查询": {
    what: "实体关系查询",
    sql: `MATCH (a:Entity)-[r]->(b:Entity)
WHERE a.name = $1 RETURN b.name, type(r)`,
    trigger: "关系型问题（谁投资/谁创办）"
  },
  "超边向量检索": {
    what: "超边向量检索（N元结构化事实）",
    code: `// search_hyperedges — V166+
// MCP: search_hyperedges(vector)`,
    sql: `MATCH (h:HyperEdge)
WHERE h.embedding <=> $vec < 0.85
RETURN h LIMIT 10`,
    trigger: "前端开启超边层"
  },
  "超边实体导向": {
    what: "超边按实体导向检索",
    sql: `MATCH (h:HyperEdge)-[:INVOLVED_IN]-(e:Entity)
WHERE e.name IN $names RETURN h`,
    trigger: "前端开启超边层"
  },
  "超边BM25": {
    what: "超边 BM25 检索",
    sql: `-- 超边文本检索（Neo4j fulltext index）
CALL db.index.fulltext.queryNodes('hyperedge_text', $term)`,
    trigger: "前端开启超边层"
  },
  "三路RRF融合": {
    what: "超边三路 RRF 融合",
    formula: "rrf = Σ 1/(k + rank_i)，k=60（超边向量/实体/BM25 三路）",
    trigger: "前端开启超边层"
  },
  "时间衰减": {
    what: "时间衰减加权",
    formula: "score *= 1/(1 + 0.05·Δmonths)",
    trigger: "时序类问题"
  },
  "Compiled Truth": {
    what: "知识页权威版本检索（×2.0 boost）",
    code: `// searchCompiledTruth → ×2.0 boost
const boost = source === 'compiled_truth' ? 2.0 : 1.0;`
  },
  "多查询变体": {
    what: "LLM 生成查询变体",
    code: `// generateQueryVariants（deepseek-v4-flash）
// 主搜索用 2 个变体补充（避免 9 路×N 爆炸）`
  },
  "HyDE扩展": {
    what: "HyDE 假设文档扩展",
    code: `// LLM 先写假设答案 → 用答案向量检索`,
    formula: "q → HyDE(q) → 向量检索",
    trigger: "查询词过短/语义模糊"
  },
  "意图调配额": {
    what: "按意图调 RRF k 配额",
    formula: "kwK = 60 / (intent==='entity' ? 1.2 : 1)，vecK = 60 × (intent==='temporal' ? 1.1 : 1)"
  },
  "三臂RRF": {
    what: "三路 RRF 融合（内容/标题/BM25）",
    formula: "rrf = Σ 1/(60 + rank_i)",
    code: `// gbrain-boosts rrfFusionWeighted`
  },
  "Cosine重打分": {
    what: "RRF 后余弦混合重排",
    formula: "score = 0.7·normRrf + 0.3·cosine",
    code: `// gbrain-boosts cosineReScore`
  },
  "Boost链": {
    what: "Boost 链（backlink/title/类型加权）",
    code: `// applyBacklinkBoost: 1 + 0.05·log(1+count)
// applyTitleBoost ×1.25，applyChronicleTypeBoost`,
    formula: "score *= boost_backlink · boost_title · boost_type"
  },
  "超边配额": {
    what: "超边结果配额（10% 上下文预算）",
    code: `// fusedContext 超边配额 10%
const hyperEdgeBudget = Math.floor(maxChars * 0.1)`,
    trigger: "超边层有命中"
  },
  "LLM重排": {
    what: "LLM 重排候选",
    code: `// llmRerankCandidates（deepseek）
// 带连续分重排 rerank_score`,
    formula: "rerank_score ∈ [0,1]"
  },
  "压缩段落": {
    what: "上下文压缩（裁到预算）",
    formula: "context ≤ maxChars（按分数保留）"
  },
  "COT推理": {
    what: "思维链推理",
    code: `// cotMode 推理（profile.cotMode）
// 多跳推理类问题启用`,
    trigger: "多跳推理类问题"
  },
  "Agentic搜索": {
    what: "Agentic 搜索（LLM 自主补检）",
    code: `// LLM 判断检索不足 → 自动补搜`,
    trigger: "首次检索不足时"
  },
  "生成假设": {
    what: "假设合成",
    code: `// generateHypothesis（LLM）
// 基于 outline + fusedContext 生成假设`,
    formula: "h = LLM(q, outline, context)"
  },
  "自评校验": {
    what: "假设自评（检索不足则重试）",
    code: `// V80 自愈闭环
// 置信度 < 0.4 → escalate 更强检索策略`
  },
  "置信评估": {
    what: "置信度评估",
    code: `// evaluateHypothesis → confidence ∈ [0,1]`
  },
  "溯源标注": {
    what: "引用标注（证据 → 假设）",
    code: `// citations: [{source, chunk}] 挂到假设`
  },
  "回写知识页": {
    what: "结论沉淀到知识页",
    code: `// associateSearch → 知识页时间线`,
    trigger: "结论通过评估"
  },
  "失败降级": {
    what: "推理失败降级（reasonFast 回退）",
    code: `// reasonFast — 全栈超时/失败的回退方案`,
    trigger: "推理失败/置信度过低"
  },
  "快速回退": {
    what: "全栈超时快速回退",
    code: `// Promise.race([reason, timeout 180s])
// 超时 → reasonFast 兜底`,
    trigger: "全栈超时（180s）"
  },
  "响应返回": {
    what: "返回推理结果",
    code: `// { taskId, trace: { outline, retrieveResults, hypothesis, evaluation } }`
  }
};

export const reasonStepDocs = { get: (name: string) => REASON_STEP_DOCS[name] };
