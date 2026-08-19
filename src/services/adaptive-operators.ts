// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// adaptive-operators.ts — 自适应推理模式（V267）：算子注册表 + 类型定义
// 模式 B：LLM 根据问题动态选择算子执行（简单问题 5 步收敛、复杂问题自动加算子）
// 与 reason() 固定模板共存（模式 A），前端开关切换，缺省 template 保 0.870 基线
// 算子 run 通过 (svc as any) 调用 InferenceService 私有方法（同为类内协作）

import type { StepTokens } from "./inference-service.js";

/** 容错 JSON 解析（与 inference-service parseJsonSafe 同款：剥离噪声后解析，失败返回 {}） */
function parseJsonSafe(text: string): any {
  try { return JSON.parse(text.trim()); } catch {
    try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch {
      return {};
    }
  }
}

/** 算子执行上下文 — 自适应执行器内累积，算子间共享 */
export interface AdaptiveContext {
  taskId: string;                     // 当前推理任务 id（落库用）
  query: string;
  sourceId: string;
  profile: any;                       // QuestionProfile
  paperId?: string;
  candidatePapers: Array<{ paper_id: string; title: string; graphiti_folder: string }>;
  aliasQuery: string;
  expandedQuery: string;
  boostedQuery: string;
  coarse: Record<string, any>;        // stage2 结果（pgEntities/pgChunks/chunks 等）
  refined: Record<string, any>;       // stage3 结果
  pgFulltext: any[];
  entityNames: string[];
  hyperEdgeRes: { hyperedges: any[] };
  fusedContext: string;
  outline: Array<{ title: string; description: string; depth: number }>;
  outlineIds: string[];
  timings: Record<string, number>;
  executedOps: string[];              // 已执行算子 id
  tokens: Record<string, StepTokens | null>;
  flags: Record<string, boolean | string | number>;  // 条件门控/结果缓存
}

/** 算子元信息 */
export interface OperatorMeta {
  id: string;
  name: string;                       // 中文名（前端步骤显示）
  group: 'prep' | 'cognee' | 'graphiti' | 'fusion' | 'gen';
  costWeight: number;                 // 预算权重（低1/中3/高5）
  dependsOn: string[];                // 前置算子 id（缺失时执行器自动补）
  /** 条件触发（复用现有触发逻辑；返回 false 则跳过） */
  condition?: (ctx: AdaptiveContext) => boolean;
  timeoutMs: number;
  /** 执行函数（svc = InferenceService 实例，通过 as any 调私有方法） */
  run: (ctx: AdaptiveContext, svc: any) => Promise<void>;
}

/** 24 算子注册表（52 步按执行单元合并） */
export const ADAPTIVE_OPERATORS: OperatorMeta[] = [
  // ─── prep 组（问题准备）───
  {
    id: "outline", name: "大纲拆解", group: "prep", costWeight: 3, dependsOn: [], timeoutMs: 30_000,
    run: async (ctx, svc) => {
      const gen = await svc.generateOutline(ctx.query);
      ctx.outline = gen.items;
      ctx.tokens['outline'] = gen.tokens;
      if (ctx.outline.length > 0) {
        // 通过 svc 暴露的 pool（InferenceService 构造时注入）
        const db = svc.pool ?? (await import('../db/pool.js')).pool;
        const rows = await Promise.all(ctx.outline.map((item: any, i: number) =>
          db.query(`INSERT INTO outlines (task_id, title, description, order_index, depth, status) VALUES ($1, $2, $3, $4::int, COALESCE($5::int, 0), 'completed') RETURNING id`,
            [ctx.taskId, item.title, item.description, i, Number(item.depth) || 0])
        ));
        ctx.outlineIds = rows.map((r: any) => r.rows[0].id);
      }
    },
  },
  // ─── cognee 组（粗检索）───
  {
    id: "pg_arm", name: "PG 本地检索", group: "cognee", costWeight: 3, dependsOn: [], timeoutMs: 60_000,
    run: async (ctx, svc) => {
      // 只跑 PG 路（sourceCogneeOn=false 避免触发 Cognee MCP——pg_arm 是纯本地补漏）
      const res = await svc.stage2_cogneeCoarse(ctx.boostedQuery, ctx.sourceId, ctx.profile.cogneeChunksTopK, ctx.candidatePapers, [], false, true);
      // 只保留 PG 相关路
      ctx.coarse.pgEntities = res.pgEntities || [];
      ctx.coarse.pgChunks = res.pgChunks || [];
      ctx.coarse.pgEntityVectors = res.pgEntityVectors || [];
      ctx.flags['has_pg'] = (ctx.coarse.pgEntities?.length || 0) + (ctx.coarse.pgChunks?.length || 0) > 0;
    },
  },
  {
    id: "cognee_hybrid", name: "Cognee HYBRID", group: "cognee", costWeight: 5, dependsOn: [], timeoutMs: 120_000,
    run: async (ctx, svc) => {
      const hybridTopK = Math.max(ctx.profile.cogneeChunksTopK, 20);
      const res = await svc.cogneeSearch(ctx.boostedQuery, 'HYBRID_COMPLETION', hybridTopK, ctx.sourceId, ctx.candidatePapers);
      ctx.coarse.chunks = res;
      ctx.flags['has_hybrid'] = res.length > 0;
    },
  },
  {
    id: "cognee_derived", name: "Cognee 衍生路", group: "cognee", costWeight: 5, dependsOn: ["cognee_hybrid"], timeoutMs: 180_000,
    run: async (ctx, svc) => {
      const routes = [
        { st: 'RAG_COMPLETION', key: 'ragCompletion', topK: 15 },
        { st: 'SUMMARIES', key: 'summaries', topK: 5 },
        { st: 'GRAPH_COMPLETION', key: 'graphCompletion', topK: 10 },
        { st: 'GRAPH_COMPLETION_DECOMPOSITION', key: 'graphCompletionDecomp', topK: 10 },
        { st: 'TRIPLET_COMPLETION', key: 'tripletCompletion', topK: 10 },
        { st: 'GRAPH_SUMMARY_COMPLETION', key: 'graphSummaryCompletion', topK: 10 },
        { st: 'GRAPH_COMPLETION_CONTEXT_EXTENSION', key: 'contextExtension', topK: 10 },
        { st: 'TEMPORAL', key: 'temporal', topK: 10 },
      ];
      const results = await Promise.allSettled(
        routes.map((r) => svc.cogneeSearch(ctx.boostedQuery, r.st, r.topK, ctx.sourceId, ctx.candidatePapers))
      );
      for (let i = 0; i < routes.length; i++) {
        if (results[i].status === 'fulfilled' && Array.isArray((results[i] as PromiseFulfilledResult<any>).value)) {
          ctx.coarse[routes[i].key] = (results[i] as PromiseFulfilledResult<any>).value.slice(0, 3);
        }
      }
    },
  },
  {
    id: "cognee_lexical", name: "CHUNKS 词法", group: "cognee", costWeight: 1, dependsOn: [], timeoutMs: 60_000,
    condition: (ctx) => ctx.profile.cogneeChunksTopK >= 20 || /(?:几个|哪几|指哪|哪些|什么|几个|具体|几个|列出|列举|写出)/.test(ctx.query),
    run: async (ctx, svc) => {
      const lexTopK = ctx.profile.cogneeChunksTopK >= 20 ? 15 : 10;
      const res = await svc.cogneeSearch(ctx.query, 'CHUNKS_LEXICAL', lexTopK, ctx.sourceId, ctx.candidatePapers);
      ctx.coarse.chunks = [...(ctx.coarse.chunks || []), ...res];
    },
  },
  {
    id: "cognee_cot", name: "COT 多跳推理", group: "cognee", costWeight: 5, dependsOn: ["cognee_hybrid"], timeoutMs: 90_000,
    condition: (ctx) => ctx.profile.cotMode === 'forced',
    run: async (ctx, svc) => {
      const res = await svc.cogneeSearch(ctx.query, 'GRAPH_COMPLETION_COT', 5, ctx.sourceId, ctx.candidatePapers);
      ctx.coarse.cotResults = res;
      ctx.flags['has_cot'] = res.length > 0;
    },
  },
  {
    id: "cognee_entities", name: "实体直查", group: "cognee", costWeight: 1, dependsOn: ["pg_arm"], timeoutMs: 30_000,
    run: async (ctx, svc) => {
      const ngNames = (ctx.coarse.pgEntities || []).slice(0, 5).map((e: any) => e.name).filter(Boolean);
      if (ngNames.length > 0) {
        const { neo4jQuery } = await import('../db/neo4j-query.js');
        const rows = await neo4jQuery(11003, 'MATCH (e:Entity)-[r]-(other:Entity) WHERE e.name CONTAINS $q RETURN DISTINCT e.name, e.type LIMIT 20', { q: ngNames[0] }, 15000);
        if (Array.isArray(rows) && rows.length > 0) ctx.coarse.cogneeEntities = rows;
      }
    },
  },
  // ─── graphiti 组（精炼检索）───
  {
    id: "extract_entities", name: "实体抽取", group: "graphiti", costWeight: 3, dependsOn: ["pg_arm"], timeoutMs: 60_000,
    run: async (ctx, svc) => {
      ctx.entityNames = await svc.extractEntityNames(ctx.coarse, ctx.query, ctx.profile, ctx.sourceId);
      ctx.flags['entity_count'] = ctx.entityNames.length;
    },
  },
  {
    id: "g_chunk", name: "实体精炼", group: "graphiti", costWeight: 3, dependsOn: ["extract_entities"], timeoutMs: 90_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const topEntity = ctx.entityNames[0] || ctx.query;
      const r = await svc.graphitiMCP.callTool('chunk_search_entities', { query: topEntity, limit: 20 });
      const t = parseJsonSafe(r?.result?.[0]?.text || '{}');
      if (t?.entities) ctx.refined.entities = t.entities;
    },
  },
  {
    id: "g_literature", name: "论文溯源", group: "graphiti", costWeight: 3, dependsOn: ["extract_entities"], timeoutMs: 90_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const topEntity = ctx.entityNames[0] || ctx.query;
      const r = await svc.graphitiMCP.callTool('search_literature', { query: topEntity, limit: 10 });
      const t = parseJsonSafe(r?.result?.[0]?.text || '{}');
      if (t?.results) ctx.refined.papers = t.results;
    },
  },
  {
    id: "g_entity_info", name: "实体邻居", group: "graphiti", costWeight: 3, dependsOn: ["extract_entities"], timeoutMs: 90_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const topEntity = ctx.entityNames[0] || ctx.query;
      const [info, concept] = await Promise.allSettled([
        svc.graphitiMCP.callTool('get_entity_info', { entity_name: topEntity, limit: 5 }),
        svc.graphitiMCP.callTool('search_by_concept', { query: topEntity, limit: 10 }),
      ]);
      if (info.status === 'fulfilled') {
        const t = parseJsonSafe(info.value?.result?.[0]?.text || '');
        if (t?.neighbors) ctx.refined.entityNeighbors = t.neighbors;
      }
      if (concept.status === 'fulfilled') {
        const t = parseJsonSafe(concept.value?.result?.[0]?.text || '');
        if (t?.results) ctx.refined.conceptResults = t.results;
      }
    },
  },
  {
    id: "g_heavy", name: "深度精炼", group: "graphiti", costWeight: 5, dependsOn: ["extract_entities"], timeoutMs: 180_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const topEntity = ctx.entityNames[0] || ctx.query;
      const refinedQuery = ctx.entityNames.slice(0, 5).join(' ') || ctx.query;
      const [hybrid, distill, domain] = await Promise.allSettled([
        svc.graphitiMCP.callTool('hybrid_search_entities', { query: refinedQuery, top_k: 10, enable_rewrite: true, enable_rerank: true }),
        svc.graphitiMCP.callTool('get_distill_content', { entity_name: topEntity, limit: 3 }),
        svc.graphitiMCP.callTool('get_domain_knowledge', { query: refinedQuery, limit: 3 }),
      ]);
      if (hybrid.status === 'fulfilled') {
        const t = parseJsonSafe(hybrid.value?.result?.[0]?.text || '{}');
        if (t?.entities) ctx.refined.hybridEntities = t.entities;
      }
      if (distill.status === 'fulfilled') {
        const t = parseJsonSafe(distill.value?.result?.[0]?.text || '{}');
        if (t?.distills) ctx.refined.distills = t.distills;
      }
      if (domain.status === 'fulfilled') {
        const t = parseJsonSafe(domain.value?.result?.[0]?.text || '{}');
        if (t) ctx.refined.domain = t;
      }
    },
  },
  {
    id: "g_deepwalk", name: "DeepWalk 扩展", group: "graphiti", costWeight: 5, dependsOn: ["g_heavy"], timeoutMs: 90_000,
    condition: (ctx) => ctx.profile.type === 'multi_hop_reasoning',
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP || (ctx.refined.hybridEntities || []).length === 0) return;
      const neighbors = (ctx.refined.hybridEntities as any[])
        .flatMap((e: any) => (e.neighbors || []).map((n: any) => n.name || n.target || ''))
        .filter((n: string) => n && n.length >= 2 && n.length <= 30)
        .slice(0, 15);
      if (neighbors.length === 0) return;
      const r = await svc.graphitiMCP.callTool('hybrid_search_entities', { query: neighbors.join(' '), top_k: 15, enable_rewrite: true, enable_rerank: true });
      const t = parseJsonSafe(r?.result?.[0]?.text || '{}');
      if (t?.entities) {
        const seen = new Set((ctx.refined.hybridEntities || []).map((e: any) => e.name));
        for (const e of t.entities) {
          if (e.name && !seen.has(e.name)) { seen.add(e.name); ctx.refined.hybridEntities.push(e); }
        }
      }
    },
  },
  {
    id: "hyperedge", name: "超边检索", group: "graphiti", costWeight: 3, dependsOn: ["extract_entities"], timeoutMs: 30_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const heR = await svc.graphitiMCP.callTool('search_hyperedges', {
        query: ctx.query,
        top_k: ctx.profile?.hyperedgeTopK ?? 8,
        entity_names: (ctx.entityNames || []).slice(0, 8),
      });
      const heText = heR?.result?.[0]?.text || '';
      if (heText) {
        const parsed = parseJsonSafe(heText);
        ctx.hyperEdgeRes = { hyperedges: parsed?.results || parsed || [] };
      }
    },
  },
  // ─── fusion 组（融合）───
  {
    id: "fuse", name: "融合上下文", group: "fusion", costWeight: 1, dependsOn: ["pg_arm", "outline"], timeoutMs: 10_000,
    run: async (ctx, svc) => {
      ctx.fusedContext = svc.stage4_fuseResults(ctx.coarse, ctx.refined, ctx.pgFulltext, {}, ctx.query, ctx.profile, ctx.entityNames, ctx.hyperEdgeRes);
    },
  },
  {
    id: "truth", name: "Compiled Truth", group: "fusion", costWeight: 1, dependsOn: ["fuse"], timeoutMs: 10_000,
    run: async (ctx, svc) => {
      try {
        const { searchCompiledTruth } = await import('../db/repositories.js');
        const truthPages = await searchCompiledTruth({ query: ctx.query, limit: 2 });
        if (truthPages.length > 0) {
          const truthBlock = truthPages
            .map((p: any) => `## 知识页沉淀 [Compiled Truth·高] ${p.title}\n${p.compiledTruth.substring(0, 800)}`)
            .join('\n\n');
          ctx.fusedContext = ctx.fusedContext + '\n\n' + truthBlock;
        }
      } catch { /* 知识页检索失败不阻断 */ }
    },
  },
  {
    id: "rerank", name: "LLM 重排", group: "fusion", costWeight: 3, dependsOn: ["fuse"], timeoutMs: 30_000,
    run: async (ctx, svc) => {
      if (ctx.fusedContext.length < 500) return;
      const rr = await svc.llmRerankCandidates(ctx.query, ctx.fusedContext, ctx.profile);
      ctx.fusedContext = rr.context;
      ctx.tokens['rerank'] = rr.tokens;
    },
  },
  {
    id: "compress", name: "压缩段落", group: "fusion", costWeight: 1, dependsOn: ["pg_arm"], timeoutMs: 15_000,
    run: async (ctx, svc) => {
      if (!svc.graphitiMCP) return;
      const longChunks = (ctx.coarse.pgChunks || []).filter((c: any) => (c.text || c.content || '').length > 2000).slice(0, 5);
      if (longChunks.length === 0) return;
      const compressPromises = longChunks.map((c: any) => {
        const raw = (c.text || c.content || '').substring(0, 4000);
        return svc.graphitiMCP.callTool('compress_passages', { passages: raw, max_tokens: 800, context: ctx.query })
          .then((compR: any) => {
            const compText = compR?.result?.[0]?.text || '';
            if (compText.length > 20 && compText.length < raw.length) c.text = compText;
          }).catch(() => {});
      });
      await Promise.all(compressPromises);
    },
  },
  // ─── gen 组（生成）───
  {
    id: "hypothesis", name: "生成假设", group: "gen", costWeight: 5, dependsOn: ["fuse"], timeoutMs: 120_000,
    run: async (ctx, svc) => {
      const hyp = await svc.generateHypothesis(ctx.query, ctx.outline, ctx.fusedContext, ctx.profile);
      ctx.tokens['hypothesis'] = hyp.tokens;
      ctx.flags['hypothesis_content'] = hyp.content;
      ctx.flags['hypothesis_confidence'] = hyp.confidence;
    },
  },
  {
    id: "cite_check", name: "政策引用验证", group: "gen", costWeight: 3, dependsOn: ["hypothesis"], timeoutMs: 60_000,
    condition: (ctx) => ctx.profile.type === 'policy_evaluation',
    run: async (ctx, svc) => {
      const content = String(ctx.flags['hypothesis_content'] || '');
      const hasCitations = /[一-龥]{2,4}年/.test(content) || /[第〔\[\(]\s*[一二三四五六七八九十\d]+\s*[条章节]\)\)〕]/.test(content) || /\[.*?\]/.test(content);
      if (!hasCitations) {
        const regenerated = await svc.generateHypothesis(
          ctx.query, ctx.outline,
          ctx.fusedContext + '\n\n【重要】你的回复中缺少具体来源引用。请重新生成，每个事实性陈述必须标注 [来源:xxx] 标记。', ctx.profile
        );
        ctx.flags['hypothesis_content'] = regenerated.content;
        ctx.flags['hypothesis_confidence'] = Math.min(1, Math.max(0, regenerated.confidence + 0.1));
        ctx.tokens['cite_check'] = regenerated.tokens;
      }
    },
  },
  {
    id: "evaluate", name: "自评校验", group: "gen", costWeight: 3, dependsOn: ["hypothesis"], timeoutMs: 60_000,
    run: async (ctx, svc) => {
      const content = String(ctx.flags['hypothesis_content'] || '');
      const allResults = [
        { source: 'cognee_coarse', data: ctx.coarse, durationMs: 0 },
        { source: 'graphiti_refine', data: ctx.refined, durationMs: 0 },
      ];
      const evalRes = await svc.evaluateHypothesis(ctx.query, content, allResults);
      ctx.tokens['evaluate'] = evalRes.tokens;
      ctx.flags['adaptive_score'] = evalRes.overallScore;
      ctx.flags['adaptive_passed'] = evalRes.passed;
      // V268: 与模板模式一致，评估结果写入 eval_records 表（可追溯/评测用）
      try {
        const db = svc.pool ?? (await import('../db/pool.js')).pool;
        await db.query(
          `INSERT INTO eval_records (task_id, evaluator, dimensions, overall_score, passed, notes) VALUES ($1, 'llm', $2, $3, $4, $5)`,
          [ctx.taskId, JSON.stringify(evalRes.dimensions), evalRes.overallScore, evalRes.passed, evalRes.notes]
        );
      } catch { /* 落库失败不阻断 */ }
    },
  },
];

/** 预算启发式：保证简单问题少算子 */
export function computeBudget(query: string, qtype: string, len: number): number {
  if (qtype === 'policy_evaluation' || qtype === 'multi_hop_reasoning' || len > 80) return 26;
  if (qtype === 'concept_definition') return 18;
  return 14; // factual / 短问题 → 约 5-6 个中低算子
}

/** 依赖闭包：自动补前置算子 */
export function opDepsClosure(ids: string[], all: OperatorMeta[]): string[] {
  const result = new Set<string>(ids);
  const byId = new Map(all.map((op) => [op.id, op]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...result]) {
      const op = byId.get(id);
      if (op) {
        for (const dep of op.dependsOn) {
          if (!result.has(dep)) { result.add(dep); changed = true; }
        }
      }
    }
  }
  return [...result];
}

/** 预算权重总和 */
export function planBudgetWeight(ids: string[], all: OperatorMeta[]): number {
  const byId = new Map(all.map((op) => [op.id, op]));
  return ids.reduce((sum, id) => sum + (byId.get(id)?.costWeight ?? 0), 0);
}

/** 最小集兜底（规划失败时用）：outline + pg_arm + fuse + hypothesis + evaluate */
export const MINIMAL_PLAN = ["outline", "pg_arm", "fuse", "hypothesis", "evaluate"];
