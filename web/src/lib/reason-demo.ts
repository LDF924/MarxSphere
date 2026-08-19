// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reason-demo.ts — 推理沙箱 demo 数据（GBrain 模式：静态回放，不真打 API）
// 推理页进来自动播放，展示四个区域：答案与证据 / 引用证据 / 检索步骤 / 消融实验
import type { ReasonDetail } from "../components/ReasonPanel";

export const REASON_DEMO: ReasonDetail = {
  task: {
    id: "demo-reason-task",
    query: "资本下乡对农村集体经济的影响及制度约束",
    status: "completed",
    created_at: new Date().toISOString(),
  },
  outlines: [
    { id: "o1", title: "资本下乡的正面效应", description: "激活闲置资源、促进集体经济增收的机制", status: "completed" },
    { id: "o2", title: "资本下乡的负面风险", description: "挤占农户利益、加剧不平等的路径", status: "completed" },
    { id: "o3", title: "制度约束与政策引导", description: "法律框架与监管工具", status: "completed" },
  ],
  retrieveSteps: [
    { id: "r1", engine: "sag", search_type: "classify", query: "资本下乡 农村集体经济 影响", duration_ms: 12, status: "completed" as const, result_count: 5, error: undefined },
    { id: "r2", engine: "sag", search_type: "intent_detect", query: "资本下乡 农村集体经济 影响", duration_ms: 8, status: "completed" as const, result_count: 8, error: undefined },
    { id: "r3", engine: "sag", search_type: "term_variant", query: "资本下乡 农村集体经济 影响", duration_ms: 15, status: "completed" as const, result_count: 11, error: undefined },
    { id: "r4", engine: "sag", search_type: "outline", query: "资本下乡 农村集体经济 影响", duration_ms: 45, status: "completed" as const, result_count: 14, error: undefined },
    { id: "r5", engine: "cognee", search_type: "entity_extract", query: "资本下乡 农村集体经济 影响", duration_ms: 210, status: "completed" as const, result_count: 17, error: undefined },
    { id: "r6", engine: "cognee", search_type: "cognee_search_hybrid", query: "资本下乡 农村集体经济 影响", duration_ms: 385, status: "completed" as const, result_count: 20, error: undefined },
    { id: "r7", engine: "cognee", search_type: "cognee_search_rag", query: "资本下乡 农村集体经济 影响", duration_ms: 320, status: "completed" as const, result_count: 23, error: undefined },
    { id: "r8", engine: "cognee", search_type: "cognee_search_graph", query: "资本下乡 农村集体经济 影响", duration_ms: 280, status: "completed" as const, result_count: 6, error: undefined },
    { id: "r9", engine: "cognee", search_type: "cognee_search_triplet", query: "资本下乡 农村集体经济 影响", duration_ms: 290, status: "completed" as const, result_count: 9, error: undefined },
    { id: "r10", engine: "cognee", search_type: "cognee_search_summary", query: "资本下乡 农村集体经济 影响", duration_ms: 260, status: "completed" as const, result_count: 12, error: undefined },
    { id: "r11", engine: "cognee", search_type: "cognee_search_subq", query: "资本下乡 农村集体经济 影响", duration_ms: 310, status: "completed" as const, result_count: 15, error: undefined },
    { id: "r12", engine: "cognee", search_type: "cognee_search_ctx", query: "资本下乡 农村集体经济 影响", duration_ms: 240, status: "completed" as const, result_count: 18, error: undefined },
    { id: "r13", engine: "cognee", search_type: "cognee_search_temporal", query: "资本下乡 农村集体经济 影响", duration_ms: 265, status: "completed" as const, result_count: 21, error: undefined },
    { id: "r14", engine: "pg", search_type: "pg_entities", query: "资本下乡 农村集体经济 影响", duration_ms: 85, status: "completed" as const, result_count: 24, error: undefined },
    { id: "r15", engine: "pg", search_type: "pg_vector", query: "资本下乡 农村集体经济 影响", duration_ms: 92, status: "completed" as const, result_count: 7, error: undefined },
    { id: "r16", engine: "pg", search_type: "pg_chunks_lexical", query: "资本下乡 农村集体经济 影响", duration_ms: 78, status: "completed" as const, result_count: 10, error: undefined },
    { id: "r17", engine: "cognee", search_type: "cognee_search_semantic", query: "资本下乡 农村集体经济 影响", duration_ms: 275, status: "completed" as const, result_count: 13, error: undefined },
    { id: "r18", engine: "cognee", search_type: "cognee_search_entities", query: "资本下乡 农村集体经济 影响", duration_ms: 195, status: "completed" as const, result_count: 16, error: undefined },
    { id: "r19", engine: "graphiti", search_type: "hybrid_search_entities", query: "资本下乡 农村集体经济 影响", duration_ms: 412, status: "completed" as const, result_count: 19, error: undefined },
    { id: "r20", engine: "graphiti", search_type: "concept_search", query: "资本下乡 农村集体经济 影响", duration_ms: 380, status: "completed" as const, result_count: 22, error: undefined },
    { id: "r21", engine: "graphiti", search_type: "distill", query: "资本下乡 农村集体经济 影响", duration_ms: 420, status: "completed" as const, result_count: 5, error: undefined },
    { id: "r22", engine: "graphiti", search_type: "domain_search", query: "资本下乡 农村集体经济 影响", duration_ms: 350, status: "completed" as const, result_count: 8, error: undefined },
    { id: "r23", engine: "graphiti", search_type: "entity_neighbors", query: "资本下乡 农村集体经济 影响", duration_ms: 300, status: "completed" as const, result_count: 11, error: undefined },
    { id: "r24", engine: "graphiti", search_type: "passage_backtrack", query: "资本下乡 农村集体经济 影响", duration_ms: 330, status: "completed" as const, result_count: 14, error: undefined },
    { id: "r25", engine: "graphiti", search_type: "paper_trace", query: "资本下乡 农村集体经济 影响", duration_ms: 360, status: "completed" as const, result_count: 17, error: undefined },
    { id: "r26", engine: "graphiti", search_type: "deepwalk_expand", query: "资本下乡 农村集体经济 影响", duration_ms: 290, status: "completed" as const, result_count: 20, error: undefined },
    { id: "r27", engine: "graphiti", search_type: "relation_query", query: "资本下乡 农村集体经济 影响", duration_ms: 315, status: "completed" as const, result_count: 23, error: undefined },
    { id: "r28", engine: "graphiti", search_type: "search_hyperedges_vector", query: "资本下乡 农村集体经济 影响", duration_ms: 240, status: "completed" as const, result_count: 6, error: undefined },
    { id: "r29", engine: "graphiti", search_type: "search_hyperedges_entity", query: "资本下乡 农村集体经济 影响", duration_ms: 220, status: "completed" as const, result_count: 9, error: undefined },
    { id: "r30", engine: "graphiti", search_type: "search_hyperedges_bm25", query: "资本下乡 农村集体经济 影响", duration_ms: 180, status: "completed" as const, result_count: 12, error: undefined },
    { id: "r31", engine: "sag", search_type: "hyperedge_rrf", query: "资本下乡 农村集体经济 影响", duration_ms: 35, status: "completed" as const, result_count: 15, error: undefined },
    { id: "r32", engine: "sag", search_type: "time_decay", query: "资本下乡 农村集体经济 影响", duration_ms: 18, status: "completed" as const, result_count: 18, error: undefined },
    { id: "r33", engine: "pg", search_type: "compiled_truth", query: "资本下乡 农村集体经济 影响", duration_ms: 25, status: "completed" as const, result_count: 21, error: undefined },
    { id: "r34", engine: "llm", search_type: "multi_query", query: "资本下乡 农村集体经济 影响", duration_ms: 410, status: "completed" as const, result_count: 24, error: undefined, tokens: { in: 820, out: 180 } },
    { id: "r35", engine: "llm", search_type: "hyde", query: "资本下乡 农村集体经济 影响", duration_ms: 395, status: "completed" as const, result_count: 7, error: undefined, tokens: { in: 480, out: 160 } },
    { id: "r36", engine: "sag", search_type: "intent_quota", query: "资本下乡 农村集体经济 影响", duration_ms: 12, status: "completed" as const, result_count: 10, error: undefined },
    { id: "r37", engine: "sag", search_type: "rrf_fusion", query: "资本下乡 农村集体经济 影响", duration_ms: 24, status: "completed" as const, result_count: 13, error: undefined },
    { id: "r38", engine: "sag", search_type: "cosine_rescore", query: "资本下乡 农村集体经济 影响", duration_ms: 30, status: "completed" as const, result_count: 16, error: undefined },
    { id: "r39", engine: "sag", search_type: "boost_chain", query: "资本下乡 农村集体经济 影响", duration_ms: 19, status: "completed" as const, result_count: 19, error: undefined },
    { id: "r40", engine: "sag", search_type: "hyperedge_quota", query: "资本下乡 农村集体经济 影响", duration_ms: 10, status: "completed" as const, result_count: 22, error: undefined },
    { id: "r41", engine: "llm", search_type: "rerank", query: "资本下乡 农村集体经济 影响", duration_ms: 380, status: "completed" as const, result_count: 5, error: undefined, tokens: { in: 4200, out: 150 } },
    { id: "r42", engine: "sag", search_type: "compress", query: "资本下乡 农村集体经济 影响", duration_ms: 45, status: "completed" as const, result_count: 8, error: undefined },
    { id: "r43", engine: "llm", search_type: "cot_reasoning", query: "资本下乡 农村集体经济 影响", duration_ms: 520, status: "completed" as const, result_count: 11, error: undefined, tokens: { in: 3500, out: 900 } },
    { id: "r44", engine: "llm", search_type: "agentic_search", query: "资本下乡 农村集体经济 影响", duration_ms: 480, status: "completed" as const, result_count: 14, error: undefined, tokens: { in: 4200, out: 1100 } },
    { id: "r45", engine: "llm", search_type: "generate_hypothesis", query: "资本下乡 农村集体经济 影响", duration_ms: 610, status: "completed" as const, result_count: 17, error: undefined, tokens: { in: 8500, out: 2100 } },
    { id: "r46", engine: "llm", search_type: "self_check", query: "资本下乡 农村集体经济 影响", duration_ms: 350, status: "completed" as const, result_count: 20, error: undefined, tokens: { in: 2400, out: 450 } },
    { id: "r47", engine: "llm", search_type: "confidence", query: "资本下乡 农村集体经济 影响", duration_ms: 180, status: "completed" as const, result_count: 23, error: undefined, tokens: { in: 900, out: 120 } },
    { id: "r48", engine: "sag", search_type: "citation", query: "资本下乡 农村集体经济 影响", duration_ms: 30, status: "completed" as const, result_count: 6, error: undefined },
    { id: "r49", engine: "sag", search_type: "write_truth", query: "资本下乡 农村集体经济 影响", duration_ms: 60, status: "completed" as const, result_count: 9, error: undefined },
    { id: "r50", engine: "sag", search_type: "fallback", query: "资本下乡 农村集体经济 影响", duration_ms: 25, status: "completed" as const, result_count: 12, error: undefined },
    { id: "r51", engine: "sag", search_type: "fast_retry", query: "资本下乡 农村集体经济 影响", duration_ms: 15, status: "completed" as const, result_count: 15, error: undefined },
    { id: "r52", engine: "sag", search_type: "respond", query: "资本下乡 农村集体经济 影响", duration_ms: 8, status: "completed" as const, result_count: 18, error: undefined },
  ],
  hyperEdges: [
    {
      id: "h1", text: "资本下乡 → 激活农村闲置资源 → 促进集体经济增收", type: "因果", summary: "资本下乡通过盘活闲置耕地和宅基地，为村集体带来租金与分红收入。",
      entities: ["资本下乡", "闲置资源", "集体经济"], source_title: "资本下乡与农村集体经济", pub_year: 2022, confidence: 0.92, score: 0.95,
    },
    {
      id: "h2", text: "资本下乡 → 挤占农户利益 → 加剧内部不平等", type: "风险", summary: "工商资本进入后，部分农户失去土地经营权，利益分配失衡。",
      entities: ["资本下乡", "农户", "不平等"], source_title: "资本下乡的双重效应", pub_year: 2023, confidence: 0.88, score: 0.9,
    },
    {
      id: "h3", text: "制度约束 → 规范资本下乡 → 保障集体利益", type: "对策", summary: "土地承包法第45条与集体经济组织法构成制度框架，引导资本规范运行。",
      entities: ["制度约束", "资本下乡", "集体利益"], source_title: "工商资本规范引导研究", pub_year: 2024, confidence: 0.85, score: 0.87,
    },
  ],
  hypotheses: [
    {
      id: "h1",
      content: "资本下乡对农村集体经济具有双重效应：既能通过盘活闲置资源、引入经营能力促进集体增收，也存在挤占农户利益、加剧内部不平等的风险。制度约束（土地承包法、集体经济组织法）是规范资本下乡、保障集体利益的关键杠杆——需要在'激活'与'约束'之间寻求平衡。",
      confidence: 0.92,
      reasoning: "综合 6 路检索（Graphiti 2 路 + Cognee 2 路 + PG 2 路）的 81 条候选，其中 3 条超边知识（因果/风险/对策）支持正面效应与负面风险并存；权威版本（Compiled Truth）×2.0 加权后，'制度约束是平衡关键'的结论置信度最高。",
    },
  ],
  evaluations: [
    {
      id: "e1",
      overall_score: 0.92,
      passed: true,
      /** 演示标记：沙箱回放用预设值，真实推理时由后端 LLM Judge 返回真实分 */
      isDemo: true,
      notes: "假设与超边证据一致（3/3 支持），引用了制度框架（土地承包法45条），证据充分。",
    },
  ],
};

export const reasonDemo = { get: () => REASON_DEMO };
