// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ask-demo.ts — Ask 沙箱 demo 数据（GBrain 模式：静态回放，不真打 API）
// 从真实检索 trace 生成的预设数据，进 Ask 页即可播放完整演示
// 结构对齐 SearchProgressEvent / Citation / AblationResult

export interface DemoStep {
  key: string;
  title: string;
  detail: string;
  status: "ok" | "error" | "running";
  durationMs: number;
  payload?: unknown;
  io?: { input: number; output: number };
  /** 条件触发标注：该步骤在什么条件下才执行 */
  trigger?: string;
  /** 该步消耗的 token（沙箱演示数据，对齐真实链路 OTEL usage） */
  tokens?: { input: number; output: number; cacheRead: number };
}

export interface DemoSections {
  chunkId: string;
  sourceId: string;
  heading: string;
  content: string;
  rank: number;
  score: number;
  sourceStep: string;
}

export const ASK_DEMO = {
  query: "资本下乡对农村集体经济的影响",
  // 20 步全展示，按代码真实执行顺序排列；条件触发的步骤标注 trigger
  steps: [
    { key: "queryEmbedding", title: "查询向量化", detail: "把用户问题转成向量，用于召回相关事件和切片。", status: "ok" as const, durationMs: 293, io: { input: 1, output: 1 } },
    { key: "step0AliasNormalize", title: "别名消解", detail: "查询词归一：工商资本 → 资本", status: "ok" as const, durationMs: 12, io: { input: 1, output: 1 }, trigger: "查询命中别名时触发" },
    { key: "step1ExtractEntities", title: "抽取查询实体", detail: "识别到 5 个查询实体（LLM）", status: "ok" as const, durationMs: 2699, io: { input: 5, output: 5 }, tokens: { input: 850, output: 260, cacheRead: 0 } },
    { key: "step2RetrieveEntities", title: "召回相关实体", detail: "召回 39 个实体（名称精确 + 向量）", status: "ok" as const, durationMs: 367, io: { input: 5, output: 39 } },
    { key: "step2AliasHop", title: "权威实体注入", detail: "别名命中 → 知识页权威实体注入召回集", status: "ok" as const, durationMs: 8, io: { input: 5, output: 8 }, trigger: "别名命中且知识页有权威实体时触发" },
    { key: "step2Relational", title: "关系臂召回", detail: "沿事件-实体边递归展开关系网络", status: "ok" as const, durationMs: 15, io: { input: 8, output: 20 }, trigger: "关系型查询（谁投资谁/谁创办谁）时触发" },
    { key: "step3EntityEvents", title: "实体关联事件", detail: "找到 506 个实体关联事件", status: "ok" as const, durationMs: 5, io: { input: 39, output: 506 } },
    { key: "step3QueryEvents", title: "标题向量召回事件", detail: "召回 20 个标题相关事件", status: "ok" as const, durationMs: 18, io: { input: 1, output: 20 } },
    { key: "step3MultiQuery", title: "多查询改写召回", detail: "LLM 改写 3 个变体 → 变体召回 42 个补充事件", status: "ok" as const, durationMs: 410, io: { input: 1, output: 42 }, tokens: { input: 520, output: 180, cacheRead: 0 } },
    { key: "step3Graphiti", title: "Graphiti 检索臂", detail: "三库融合：Graphiti 实体检索命中 18 条", status: "ok" as const, durationMs: 280, io: { input: 1, output: 18 }, trigger: "前端开启 Graphiti 库时触发" },
    { key: "step3Cognee", title: "Cognee 检索臂", detail: "三库融合：Cognee 语义检索命中 15 条", status: "ok" as const, durationMs: 320, io: { input: 1, output: 15 }, trigger: "前端开启 Cognee 库时触发" },
    { key: "step4FetchDetails", title: "事件详情回取", detail: "读取 525 个候选事件详情", status: "ok" as const, durationMs: 45, io: { input: 525, output: 525 } },
    { key: "step5Expand", title: "事件扩展", detail: "扩展 637 个事件（同文档/共现实体）", status: "ok" as const, durationMs: 96, io: { input: 525, output: 637 } },
    { key: "step5GraphTraversal", title: "图遍历展开", detail: "SQL 递归 2 层找到 100 个关联事件", status: "ok" as const, durationMs: 72, io: { input: 39, output: 100 } },
    { key: "step6CoarseRank", title: "粗排序（RRF 融合）", detail: "加权 RRF 多路融合 232 → 100", status: "ok" as const, durationMs: 24, io: { input: 232, output: 100 } },
    { key: "step6CompiledTruth", title: "Compiled Truth 检索", detail: "命中 1 个知识页（×2.0 boost）", status: "ok" as const, durationMs: 7, io: { input: 1, output: 1 } },
    { key: "step7LlmRerank", title: "LLM 重排", detail: "选出 75 个最终候选事件（rerank_score）", status: "ok" as const, durationMs: 380, io: { input: 75, output: 75 }, tokens: { input: 3200, output: 140, cacheRead: 0 } },
    { key: "step8FetchChunks", title: "回取关联切片", detail: "读取 5 个最终上下文切片", status: "ok" as const, durationMs: 14, io: { input: 5, output: 5 } },
    { key: "step8Neo4jSections", title: "Neo4j 证据补充", detail: "追加 5 条 Graphiti/Cognee 证据片段", status: "ok" as const, durationMs: 20, io: { input: 5, output: 10 }, trigger: "Graphiti/Cognee 臂有命中时触发" },
    { key: "step8TruthGuarantee", title: "权威版本保底", detail: "知识页命中硬保一席（score 999）", status: "ok" as const, durationMs: 3, io: { input: 10, output: 11 }, trigger: "知识页命中但未进结果时触发" }
  ],
  answer: "根据检索到的证据，资本下乡对农村集体经济的影响具有两面性：\n\n一方面，资本下乡能够激活农村闲置资源，促进集体经济增收——通过引入工商资本的经营管理经验、资金和技术，盘活村集体闲置的耕地、宅基地等资源，为农民提供就近就业机会，拓宽增收渠道。\n\n另一方面，资本下乡也存在潜在风险——挤占农户利益、加剧农村内部不平等，部分项目存在'非粮化'倾向，需要制度约束与政策引导来规范。",
  citations: [
    { chunkId: "demo-1", sourceId: "default", heading: "二、资本下乡与乡村振兴的内在机理", content: "资本下乡在激活农村闲置资源、促进集体经济增收的同时，也存在挤占农户利益、加剧内部不平等的风险。", rank: 1, score: 0.96, sourceStep: "event-arm" },
    { chunkId: "demo-2", sourceId: "default", heading: "1.2 资本下乡对农村社会的影响", content: "工商资本进入农业领域后，通过规模化经营提升了土地利用效率，但也改变了原有的农户-土地关系。", rank: 2, score: 0.92, sourceStep: "vector" },
    { chunkId: "demo-3", sourceId: "default", heading: "（一）村民非农化困境", content: "资本下乡推动农业产业化过程中，部分村民脱离农业生产，面临就业转型压力与收入不确定性。", rank: 3, score: 0.9, sourceStep: "graphiti-entity" },
    { chunkId: "demo-4", sourceId: "default", heading: "[知识页] 资本下乡综合研究结论", content: "权威版本：资本下乡是农业农村现代化的双刃剑——需要规范引导与制度约束并存。", rank: 4, score: 0.85, sourceStep: "compiled-truth" },
    { chunkId: "demo-5", sourceId: "default", heading: "2．资本下乡为提升农民的市场信心提供新通道", content: "资本下乡带来的市场信息与销售渠道，客观上增强了农户参与市场的信心与能力。", rank: 5, score: 0.78, sourceStep: "cognee-chunk" }
  ],
  ablation: {
    baselineCount: 10,
    operators: [
      { operator: "rerank", ablatedCount: 10, overlapWithBaseline: 2, hitChangePct: 80 },
      { operator: "expansion", ablatedCount: 10, overlapWithBaseline: 7, hitChangePct: 30 },
      { operator: "chronicle_type", ablatedCount: 10, overlapWithBaseline: 8, hitChangePct: 20 },
      { operator: "compiled_truth", ablatedCount: 10, overlapWithBaseline: 10, hitChangePct: 0 },
      { operator: "title", ablatedCount: 10, overlapWithBaseline: 10, hitChangePct: 0 },
      { operator: "backlink", ablatedCount: 10, overlapWithBaseline: 10, hitChangePct: 0 }
    ]
  },
  summary: { totalMs: 4973, steps: 20, passed: 20 }
};

export const askDemo = { get: () => ASK_DEMO };
