// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// Based on Zleap-AI/SAG (MIT License) — https://github.com/Zleap-AI/SAG
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { rerankClient, type RerankClient } from "../ai/rerank-client.js";
import { MAX_SEARCH_TOP_K, aiSettingsService } from "./ai-settings-service.js";
import {
  assertSourcesAccessible,
  coarseRankEventsByContent,
  getEventIdsByEntityIds,
  getEventsWithEntityIds,
  getSectionsForEvents,
  graphTraversalTwoHops,
  relationalFanout,
  searchChunksByVector,
  searchCompiledTruth,
  searchEntitiesByName,
  searchEntitiesByText,
  searchEntitiesByVector,
  searchEventsByText,
  searchEventsByTitleVector
} from "../db/repositories.js";
import { applyTimeDecay, reciprocalRankFusion } from "./rrf.js";
import { aliasNormalize } from "./alias.js";
import { sanitizeInput } from "./sanitize.js";
import { getRoleModel } from "./llm-model-registry.js";
import { loadSourceConfig, type RetrievalHit } from "./retrieval-sources.js";
import { traceService } from "./trace-service.js";
import {
  applyBacklinkBoost,
  applyChronicleTypeBoost,
  applyTitleBoost,
  classifyQueryIntent,
  cosineReScore,
  dedupResults,
  effectiveRrfK,
  rrfFusionWeighted
} from "./gbrain-boosts.js";
import type {
  EntityRecord,
  EventRecord,
  MultiSubStrategy,
  SearchInput,
  SearchProgressEvent,
  SearchResult,
  SearchSection,
  SearchTrace,
  SearchTraceEvent
} from "../types.js";

interface MultiOptions {
  subStrategy: MultiSubStrategy;
  entityTopK: number;
  multiTopK: number;
  keySimilarityThreshold: number;
  similarityThreshold: number;
  maxHops: number;
  maxEvents: number;
  maxEventsA: number;
  maxEventsB: number;
  maxHopRetries: number;
  rerankTopK: number;
  maxSections: number;
}

type SearchProgressEmitter = (event: SearchProgressEvent) => void;
const MAX_SEARCH_RESULTS = MAX_SEARCH_TOP_K;

export class SearchService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient,
    private readonly reranker: RerankClient = rerankClient
  ) {}

  async search(input: SearchInput, tenantId = config.DEFAULT_TENANT_ID, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const strategy = input.strategy ?? "multi";
    if (strategy !== "vector" && strategy !== "multi") {
      throw new Error(`Unsupported search strategy: ${String(strategy)}`);
    }

    await assertSourcesAccessible(input.sourceIds, tenantId);
    if (strategy === "vector") {
      return this.vectorSearch(input, emit);
    }
    return this.multiSearch(input, emit);
  }

  async vectorSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const topK = resolveFinalSearchTopK(input.multi?.maxSections ?? input.topK ?? runtimeSettings.defaultSearchTopK);
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于向量召回。"
    });
    const sections = await timed(timings, "vectorSearchChunks", () => searchChunksByVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK
    }), emit, {
      title: "向量召回切片",
      detail: "按查询向量召回最相近的文档切片。"
    });
    return {
      traceId,
      sections: sections.slice(0, topK).map((section) => ({ ...section }))
    };
  }

  async multiSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const options = resolveMultiOptions(input, runtimeSettings.defaultSearchTopK);
    const searchMode = input.searchMode ?? runtimeSettings.defaultSearchMode;
    // 输入清洗（防 prompt-injection：剥离注入指令/控制字符/超长）
    const cleanedQuery = sanitizeInput(input.query);
    const traceId = randomUUID();
    // Trace Waterfall：全局 traceId（emitSearchStep 落 span 用）
    // noTrace：消融等并发场景禁用 trace 落库（并发共享 globalThis 会导致 span 串 trace）
    if (!input.noTrace) {
      (globalThis as { __sagTraceId?: string }).__sagTraceId = traceId;
    }
    // 根 span：Ask 检索（进缓冲区，multiSearch 结束统一落库；noTrace 时跳过）
    if (!input.noTrace) {
      const rootBuffer = (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer ?? [];
      (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer = rootBuffer;
      rootBuffer.push({ traceId, kind: "trace", name: `ask: ${cleanedQuery.slice(0, 50)}`, detail: `[${searchMode}] ${cleanedQuery}` });
    }
    const timings: Record<string, number> = {};
    const trace: SearchTrace = {
      traceId,
      query: cleanedQuery,
      searchMode,
      queryEntities: [],
      recalledEntities: [],
      entityEventIds: [],
      queryEventIds: [],
      expandedEventIds: [],
      coarseRankedEventIds: [],
      rerankedEventIds: [],
      timings
    };

    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(cleanedQuery), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于召回相关事件和切片。"
    });

    // V98: 别名消解（GBrain 第11步 alias）——查询词归一，提升实体召回（消融可关）
    const ablation = input.ablation ?? [];
    let effectiveQuery = cleanedQuery;
    let aliasReplacements: Array<{ from: string; to: string }> = [];
    if (!ablation.includes("alias")) {
      const normalized = aliasNormalize(cleanedQuery);
      effectiveQuery = normalized.replacements.length > 0 ? normalized.normalized : cleanedQuery;
      aliasReplacements = normalized.replacements;
    }
    if (aliasReplacements.length > 0) {
      emitSearchStep(emit, timings, "step0AliasNormalize", {
        title: "别名消解",
        detail: aliasReplacements.map((r) => `"${r.from}" → "${r.to}"`).join("，") || "查询词已归一",
        payload: aliasReplacements
      });
    }

    let queryEntities: string[] = [];
    let recalledEntities: EntityRecord[] = [];
    if (searchMode === "fast") {
      recalledEntities = await timed(timings, "step1Bm25Entities", () => searchEntitiesByText({
        sourceIds: input.sourceIds,
        query: effectiveQuery,
        limit: options.entityTopK
      }), emit, {
        title: "BM25 匹配查询实体",
        detail: "直接用用户问题在实体库做全文/BM25 匹配，不调用 LLM 抽取 key。"
      });
      queryEntities = recalledEntities.map((entity) => entity.name);
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1Bm25Entities", {
        title: "BM25 匹配查询实体",
        detail: recalledEntities.length === 0 ? "没有匹配到查询实体" : `匹配到 ${recalledEntities.length} 个查询实体`,
        payload: recalledEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score ?? 0
        }))
      });
    } else {
      queryEntities = await timed(timings, "step1ExtractEntities", () => this.llm.extractNamedEntities(cleanedQuery), emit, {
        title: "抽取查询实体",
        detail: "识别用户问题中的关键实体。"
      });
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1ExtractEntities", {
        title: "抽取查询实体",
        detail: queryEntities.length === 0 ? "没有识别到查询实体" : `识别到 ${queryEntities.length} 个查询实体`,
        payload: queryEntities,
        // V381: 实体抽取 LLM 真实 usage
        tokens: llmRealUsage(this.llm) ?? undefined
      });

      recalledEntities = await timed(timings, "step2RetrieveEntities", async () => {
        const exact = await searchEntitiesByName({
          sourceIds: input.sourceIds,
          names: queryEntities,
          limit: options.entityTopK
        });
        const byVector: EntityRecord[] = [];
        for (const entityName of queryEntities) {
          const vector = await this.embeddings.generate(entityName);
          byVector.push(...await searchEntitiesByVector({
            sourceIds: input.sourceIds,
            queryVector: vector,
            topK: options.entityTopK,
            threshold: options.keySimilarityThreshold
          }));
        }
        return dedupeEntities([...exact, ...byVector]);
      }, emit, {
        title: "召回相关实体",
        detail: "按实体名称和实体向量召回相关实体。"
      });
    }
    trace.recalledEntities = recalledEntities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      score: entity.score ?? 0
    }));
    if (searchMode !== "fast") {
      emitSearchStep(emit, timings, "step2RetrieveEntities", {
        title: "召回相关实体",
        detail: `召回 ${trace.recalledEntities.length} 个实体`,
        payload: trace.recalledEntities
      });
    }

    // 修复⑤：aliasHop 接线（GBrain 权威实体注入）— 查询命中别名时提升权威实体
    // 用 entity_norm_dict.json 的「别名→权威名」映射：查询含别名 → 权威实体加权
    try {
      const { loadNormDict } = await import("./alias.js");
      const normDict = loadNormDict();
      const aliasKeys = Object.keys(normDict).filter((k) => effectiveQuery.includes(k));
      if (aliasKeys.length > 0) {
        const canonicalNames = [...new Set(aliasKeys.map((k) => normDict[k]).filter((v) => v && v.length >= 2))];
        for (const canonical of canonicalNames) {
          const existing = recalledEntities.find((e) => e.name === canonical);
          if (existing) {
            existing.score = (existing.score ?? 0) * 1.5; // 命中权威名 ×1.5
          }
          // 不在候选里则不强注入（避免编造实体）——记录 trace 即可
        }
        trace.aliasHopApplied = canonicalNames;
        emitSearchStep(emit, timings, "step2AliasHop", {
          title: "别名权威注入",
          detail: `别名命中: ${aliasKeys.slice(0, 3).join(", ")} → 权威: ${canonicalNames.slice(0, 3).join(", ")}`
        });
      }
    } catch { /* alias hop 失败不阻断 */ }

    // Relational recall（GBrain typed-edge 适配）— 沿事件-实体边递归展开（消融可关）
    // 用 event_entities.description 作关系标签；链接型查询（"A与B关系"）触发
    const relationalEventIds = await timed(timings, "step2Relational", async () => {
      if (recalledEntities.length === 0) return [];
      if (ablation.includes("relational")) return [];
      const isRelational = /与|和|关系|关联|连接|联系|谁.*投资|谁.*创办|谁.*合作/.test(cleanedQuery);
      if (!isRelational) return [];
      const fanout = await relationalFanout({
        seedEntityIds: recalledEntities.map((e) => e.id).slice(0, 3),
        sourceIds: input.sourceIds,
        depth: 2,
        limit: 40
      });
      return [...new Set(fanout.map((f) => f.eventId))];
    }, emit, {
      title: "关系召回",
      detail: "沿事件-实体边递归展开关系网络（typed-edge）。"
    });
    if (relationalEventIds.length > 0) {
      trace.relationalEventIds = relationalEventIds;
      emitSearchStep(emit, timings, "step2Relational", {
        title: "关系召回",
        detail: `关系网络找到 ${relationalEventIds.length} 个关联事件`
      });
    }

    const entityEventIds = await timed(timings, "step3EntityEvents", () => getEventIdsByEntityIds({
      entityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds
    }), emit, {
      title: "实体关联事件",
      detail: "读取召回实体关联的候选事件。"
    });
    trace.entityEventIds = entityEventIds;
    emitSearchStep(emit, timings, "step3EntityEvents", {
      title: "实体关联事件",
      detail: `找到 ${entityEventIds.length} 个实体关联事件`
    });

    const queryEvents = await timed(timings, "step3QueryEvents", () => searchEventsByTitleVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK: options.multiTopK * 3,
      threshold: options.similarityThreshold
    }).then((events) => events.slice(0, options.multiTopK)), emit, {
      title: "标题向量召回事件",
      detail: "按查询向量召回标题相关事件。"
    });
    trace.queryEventIds = queryEvents.map((event) => event.id);
    trace.queryEvents = toTraceEvents(queryEvents);
    appendEventSnapshots(trace, trace.queryEvents);
    emitSearchStep(emit, timings, "step3QueryEvents", {
      title: "标题向量召回事件",
      detail: `召回 ${trace.queryEvents.length} 个标题相关事件`,
      payload: trace.queryEvents
    });

    // ① Multi-query 多查询变体（GBrain 步2）— LLM 生成查询变体，各跑标题向量召回合并
    // 解决单查询语义漂移：变体命中不同角度的事件（消融可关）
    const multiQueryEvents = await timed(timings, "step3MultiQuery", async () => {
      if (ablation.includes("multi_query")) return [];
      const variants = await this.generateQueryVariants(cleanedQuery, 3);
      if (variants.length === 0) return [];
      const variantEvents: EventRecord[] = [];
      const seenVariant = new Set<string>();
      for (const variant of variants) {
        if (variant === cleanedQuery || seenVariant.has(variant)) continue;
        seenVariant.add(variant);
        const vec = await this.embeddings.generate(variant);
        const found = await searchEventsByTitleVector({
          sourceIds: input.sourceIds,
          queryVector: vec,
          topK: options.multiTopK,
          threshold: 0.25
        });
        variantEvents.push(...found);
      }
      return variantEvents;
    }, emit, {
      title: "多查询变体召回",
      detail: "LLM 生成查询变体，各跑向量召回合并。"
    });
    if (multiQueryEvents.length > 0) {
      const seenMq = new Set(queryEvents.map((e) => e.id));
      const fresh = multiQueryEvents.filter((e) => !seenMq.has(e.id));
      if (fresh.length > 0) {
        trace.multiQueryEventIds = fresh.map((e) => e.id);
        emitSearchStep(emit, timings, "step3MultiQuery", {
          title: "多查询变体召回",
          detail: `变体召回 ${fresh.length} 个补充事件`,
          // 变体生成 LLM 调用 token 估算
          tokens: llmRealUsage(this.llm) ?? { input: cleanedQuery.length * 2, output: 100, cacheRead: 0 }
        });
      }
    }

    // ② Neo4j 检索臂（三库任意组合）— Graphiti/Cognee MCP 检索，结果转统一模型
    // 源配置：优先用请求携带的 sources（前端开关 → 请求参数），缺省用存储配置
    const sourceConfig = input.sources
      ? { sources: input.sources }
      : loadSourceConfig("ask");
    const graphitiHits: RetrievalHit[] = [];
    const cogneeHits: RetrievalHit[] = [];
    try {
      const { getGraphitiPool, getCogneePool } = await import("../api/reason-handler.js");
      const { hasSource } = await import("./retrieval-sources.js");
      const graphitiPool = getGraphitiPool();
      const cogneePool = getCogneePool();
      // Graphiti 臂：hybrid_search_entities（实体检索）
      if (hasSource(sourceConfig, "graphiti") && graphitiPool?.isReady?.()) {
        const gRes = await graphitiPool.callTool("hybrid_search_entities", {
          query: effectiveQuery, top_k: 10, enable_rewrite: true, enable_rerank: true
        }).catch(() => null);
        const gParsed = parseGraphitiResult(gRes);
        for (const e of gParsed.slice(0, 8)) {
          graphitiHits.push({ id: `graphiti-${e.name}`, title: e.name, content: e.description || e.name, score: e.score ?? 0.5, source: "graphiti", raw: e });
        }
        if (graphitiHits.length > 0) {
          trace.graphitiHits = graphitiHits;
          emitSearchStep(emit, timings, "step3Graphiti", {
            title: "Graphiti 实体臂",
            detail: `Neo4j 召回 ${graphitiHits.length} 个实体`
          });
        }
      }
      // Cognee 臂：cognee_search HYBRID_COMPLETION（论文切片）
      if (hasSource(sourceConfig, "cognee") && cogneePool?.isReady?.()) {
        const cRes = await cogneePool.callTool("cognee_search", {
          query: effectiveQuery, search_type: "HYBRID_COMPLETION", top_k: 8, datasets: "capital_v28"
        }).catch(() => null);
        const cParsed = parseCogneeHits(cRes);
        for (const c of cParsed.slice(0, 6)) {
          cogneeHits.push({ id: `cognee-${c.text?.substring(0, 40)}`, title: c.text?.substring(0, 60) || "Cognee", content: c.text || "", score: 0.5, source: "cognee", raw: c });
        }
        if (cogneeHits.length > 0) {
          trace.cogneeHits = cogneeHits;
          emitSearchStep(emit, timings, "step3Cognee", {
            title: "Cognee 切片臂",
            detail: `Neo4j 召回 ${cogneeHits.length} 个切片`
          });
        }
      }
    } catch { /* Neo4j 臂失败不阻断（预览模式无池是常态） */ }

    const seedEventIds = unique([...entityEventIds, ...queryEvents.map((event) => event.id), ...(trace.multiQueryEventIds ?? []), ...(trace.relationalEventIds ?? [])]);
    if (seedEventIds.length === 0) {
      trace.fallbackReason = "no seed events; used vector chunk search";
      emitSearchStep(emit, timings, "fallback", {
        title: "降级路径",
        detail: trace.fallbackReason
      });
      await flushTraceSpans();
      const fallback = await this.vectorSearch({ ...input, strategy: "vector", topK: options.maxSections }, emit);
      return { ...fallback, trace: input.returnTrace ? trace : undefined };
    }

    const seedEvents = await timed(timings, "step4FetchDetails", () => getEventsWithEntityIds(seedEventIds), emit, {
      title: "读取候选事件详情",
      detail: "读取候选事件及其关联实体。"
    });
    trace.entityEvents = idsToTraceEvents(entityEventIds, seedEvents);
    appendEventSnapshots(trace, trace.entityEvents);
    emitSearchStep(emit, timings, "step4FetchDetails", {
      title: "读取候选事件详情",
      detail: `读取 ${seedEvents.size} 个候选事件详情`,
      payload: toTraceEvents([...seedEvents.values()])
    });
    const expanded = await timed(timings, "step5Expand", () => ablation.includes("expansion")
      ? Promise.resolve({ eventsetIds: [], eventset1Ids: [], expandedEventIds: [], expandedEvents: [] })
      : this.expandEvents({
          seedEvents,
          initialEntityIds: recalledEntities.map((entity) => entity.id),
          sourceIds: input.sourceIds,
          query: cleanedQuery,
          queryVector,
          options
        }), emit, {
      title: "事件扩展",
      detail: "沿事件实体关系扩展候选事件集合。"
    });
    trace.expandedEventIds = expanded.expandedEventIds;
    emitSearchStep(emit, timings, "step5Expand", {
      title: "事件扩展",
      detail: `扩展 ${expanded.expandedEventIds.length} 个事件`
    });

    // ⑤ Graph traversal（GBrain 步8）— SQL 递归 CTE 2 层从种子实体展开（消融可关）
    // 补充候选事件集（与 step5 的 JS 扩展互补，SQL 侧直接取 2 层内闭环）
    const graphTraversal = await timed(timings, "step5GraphTraversal", () => ablation.includes("graph_traversal")
      ? Promise.resolve({ eventIds: [], entityIds: [] })
      : graphTraversalTwoHops({
          seedEntityIds: recalledEntities.map((entity) => entity.id),
          sourceIds: input.sourceIds,
          maxEvents: options.maxEventsA
        }), emit, {
      title: "图遍历展开",
      detail: "SQL 递归 2 层从种子实体沿关系网络展开事件。"
    });
    if (graphTraversal.eventIds.length > 0) {
      trace.graphTraversalEventIds = graphTraversal.eventIds;
      emitSearchStep(emit, timings, "step5GraphTraversal", {
        title: "图遍历展开",
        detail: `递归找到 ${graphTraversal.eventIds.length} 个关联事件`
      });
    }

    const coarseRanked = await timed(timings, "step6CoarseRank", async () => {
      // V98: RRF 三臂融合粗排（GBrain 第7步多路融合）
      // 臂1 内容向量 · 臂2 标题向量（标题独立臂①）· 臂3 BM25 文本（search_text）
      const candidateIds = unique([...seedEventIds, ...expanded.eventsetIds, ...(graphTraversal.eventIds ?? [])]);

      const contentRanked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: candidateIds,
        queryVector,
        maxEvents: options.maxEvents
      });

      const titleRanked = await searchEventsByTitleVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: options.maxEvents,
        threshold: 0.3
      });

      const bm25Ranked = await searchEventsByText({
        sourceIds: input.sourceIds,
        eventIds: candidateIds,
        query: effectiveQuery,
        limit: options.maxEvents
      });

      // 融合前过滤：只保留候选集合内的事件（标题臂可能召回集合外）
      const candidateSet = new Set(candidateIds);
      const titleFiltered = titleRanked.filter((event) => candidateSet.has(event.id));
      const bm25Filtered = bm25Ranked.filter((event) => candidateSet.has(event.id));

      // ① 加权 RRF 融合（GBrain rrfFusionWeighted，intent 调 k + Compiled Truth ×2.0）
      // 意图分类：entity/event → keyword k 降低（提升词法贡献）；temporal → 中调
      // Compiled Truth：命中知识页标题的事件 ×2.0 boost（GBrain shouldBoostCompiledTruth）
      const intentSuggestion = classifyQueryIntent(cleanedQuery);
      const kwK = effectiveRrfK(60, intentSuggestion.intent, "keyword");
      const vecK = effectiveRrfK(60, intentSuggestion.intent, "vector");
      // 预取知识页标题集合（compiledTruth 谓词用）
      const truthTitles = new Set<string>();
      try {
        const truthPages = await searchCompiledTruth({ query: cleanedQuery, limit: 5 });
        for (const tp of truthPages) truthTitles.add(tp.title);
      } catch { /* 知识页检索失败不阻断 */ }
      const isCompiledTruthEvent = (e: EventRecord): boolean => {
        const title = e.title || "";
        return title.length >= 2 && [...truthTitles].some((t) => title.includes(t) || t.includes(title));
      };
      const boostCompiledTruth = intentSuggestion.suggestedDetail === "low" || intentSuggestion.intent === "entity";
      // 消融实验：关掉 compiled_truth boost（对比检索效果）
      const ablationOffCompiledTruth = ablation.includes("compiled_truth");
      const fusedWeighted = rrfFusionWeighted<EventRecord>(
        [
          { list: contentRanked, k: vecK, keyOf: (e) => e.id, compiledTruth: boostCompiledTruth && !ablationOffCompiledTruth ? isCompiledTruthEvent : undefined },
          { list: titleFiltered, k: vecK, keyOf: (e) => e.id, compiledTruth: boostCompiledTruth && !ablationOffCompiledTruth ? isCompiledTruthEvent : undefined },
          { list: bm25Filtered, k: kwK, keyOf: (e) => e.id, compiledTruth: boostCompiledTruth && !ablationOffCompiledTruth ? isCompiledTruthEvent : undefined }
        ],
        true
      );

      // ② Cosine 重打分（GBrain cosineReScore）— RRF 后混合 0.7*normRrf + 0.3*cosine
      // 用 query 向量对候选事件标题向量重打分（事件无独立 embedding 列，用标题向量近似）（消融可关）
      let reScored = fusedWeighted;
      if (!ablation.includes("cosine")) {
        try {
          // 修复④：cosine 重打分改用存储的 title_embedding 列（替代 N 次实时 embed）
          const titleVecs = new Map<string, number[]>();
          const vecRows = await pool.query(
            `select id, title_embedding::text as emb from events where id = any($1::uuid[]) and title_embedding is not null`,
            [[...seedEvents.keys()]]
          );
          for (const row of vecRows.rows) {
            const nums = String(row.emb).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)?.map(Number).filter((n: number) => Number.isFinite(n)) ?? [];
            if (nums.length > 0) titleVecs.set(String(row.id), nums);
          }
          if (titleVecs.size > 0) {
            reScored = cosineReScore(fusedWeighted, titleVecs, queryVector, (e) => e.id);
          }
        } catch { /* 重打分失败不阻断 */ }
      }

      // ③ Boost 链（GBrain runPostFusionStages 五件套）
      const boosted = reScored.map((entry) => ({ item: entry.item, score: entry.score }));
      const floor = 0; // 无 floor gate（小语料不打折）

      // backlink：事件关联实体数
      const entityCountByEventId = new Map<string, number>();
      for (const [eventId, ev] of seedEvents.entries()) {
        entityCountByEventId.set(eventId, ev.entityIds?.length ?? 0);
      }
      // backlink：事件关联实体数（消融可关）
      if (!ablation.includes("backlink")) {
        applyBacklinkBoost(boosted, entityCountByEventId, (e) => e.id, floor);
      }

      // recency boost 已删除（V164）：对论文/政策文献不合适——
      // ① createdAt 是入库时间非发表时间，语义错误
      // ② 文献一视同仁：不按时间加权，老文献与新文献同等竞争，靠相关性排序
      // 时序类查询（"最近/最新"）靠 BM25 关键词臂命中即可

      // title：查询词命中事件标题（消融可关）
      if (!ablation.includes("title")) {
        applyTitleBoost(boosted, effectiveQuery, (e) => e.id, (e) => e.title, 1.25, floor);
      }

      // chronicle type：事件类型加权（学术类事件更高，消融可关）
      if (!ablation.includes("chronicle_type")) {
        applyChronicleTypeBoost(boosted, (e) => {
          const t = e.title || "";
          if (/论文|研究|报告|分析/.test(t)) return "academic";
          if (/政策|规定|条例|办法|通知/.test(t)) return "policy";
          return "general";
        }, { academic: 1.4, policy: 1.3, general: 1.0 }, floor);
      }

      // ⑤ Dedup（GBrain 4 路去重，消融可关）
      const deduped = ablation.includes("dedup")
        ? boosted.map((b) => ({ item: b.item, score: b.score })).sort((a, b) => b.score - a.score)
        : dedupResults(
            boosted.map((b) => ({ item: b.item, score: b.score })),
            (e) => e.id,
            (e) => e.title,
            (e) => e.content || ""
          ).sort((a, b) => b.score - a.score);

      const finalRanked = deduped.map((entry) => entry.item).slice(0, options.maxEvents);
      if (finalRanked.length > 0) {
        trace.rrfFusedEvents = toTraceEvents(finalRanked);
        return finalRanked;
      }

      // RRF 全空时降级回纯向量粗排
      if (options.subStrategy === "multi") {
        return contentRanked;
      }
      const eventsetRanked = contentRanked;
      const eventset1Ranked = expanded.eventset1Ids.length > 0 && options.maxEventsB > 0
        ? await coarseRankEventsByContent({
            sourceIds: input.sourceIds,
            eventIds: expanded.eventset1Ids,
            queryVector,
            maxEvents: options.maxEventsB
          })
        : [];
      return [...eventsetRanked, ...eventset1Ranked];
    }, emit, {
      title: "粗排事件",
      detail: "RRF 融合内容向量+标题向量+BM25 三臂粗排候选事件。"
    });
    trace.coarseRankedEventIds = coarseRanked.map((event) => event.id);
    trace.coarseRankedEvents = toTraceEvents(coarseRanked);
    trace.expandedEvents = trace.expandedEventIds.length > 0
      ? trace.coarseRankedEvents.filter((event) => trace.expandedEventIds.includes(event.id))
      : [];
    appendEventSnapshots(trace, trace.coarseRankedEvents);
    emitSearchStep(emit, timings, "step6CoarseRank", {
      title: "粗排事件",
      detail: `粗排得到 ${trace.coarseRankedEvents.length} 个候选事件`,
      payload: trace.coarseRankedEvents
    });

    // ② Compiled Truth（GBrain 步6）— 检索知识页沉淀结论，命中项 ×2.0 boost
    // 知识页是「已沉淀的研究结论」，命中时优先级高于普通切片
    const compiledTruth = await timed(timings, "step6CompiledTruth", () => searchCompiledTruth({
      query: cleanedQuery,
      limit: 3
    }), emit, {
      title: "Compiled Truth 检索",
      detail: "检索知识页已沉淀结论，命中项加权。"
    });
    if (compiledTruth.length > 0) {
      trace.compiledTruth = compiledTruth.map((ct) => ({ title: ct.title, contentPreview: previewText(ct.compiledTruth, 160) }));
      emitSearchStep(emit, timings, "step6CompiledTruth", {
        title: "Compiled Truth 检索",
        detail: `命中 ${compiledTruth.length} 个知识页（×2.0 boost）`,
        payload: compiledTruth.map((ct) => ({ title: ct.title, contentPreview: previewText(ct.compiledTruth, 160) }))
      });
    }

    // Always use LLM rerank (DashScope compatible-mode /v1/reranks returns 404)
    // GBrain applyReranker 模式：head(topNIn=30) 截断重排 + tail 保序 + fail-open
    const rerankStepKey = "step7LlmRerank";
    const RERANK_HEAD = 30; // 只送 top-30 给 reranker（GBrain topNIn 默认 30）
    const rerankHead = coarseRanked.slice(0, RERANK_HEAD);
    const rerankTail = coarseRanked.slice(RERANK_HEAD);
    // 带连续分重排（rerank_score — GBrain rerank_score 字段，支持阈值截断；消融可关）
    let rerankedHeadScored = await timed(timings, rerankStepKey, () => ablation.includes("rerank")
      ? Promise.resolve(rerankHead.slice(0, options.rerankTopK).map((event) => ({ id: event.id, score: 0 })))
      : this.reranker.rerankEventsWithScores({
          query: cleanedQuery,
          candidates: rerankHead,
          topK: options.rerankTopK
        }), emit, {
      title: "LLM 重排",
      detail: `让 LLM 从 top-${rerankHead.length} 候选中打分选择（rerank_score 连续分）。`
    });
    if (rerankedHeadScored.length === 0) {
      trace.fallbackReason = "llm rerank returned no ids; used coarse rank";
      rerankedHeadScored = rerankHead.slice(0, options.rerankTopK).map((event) => ({ id: event.id, score: 0 }));
    }
    const rerankedHeadIds = rerankedHeadScored.map((entry) => entry.id);
    trace.rerankScores = rerankedHeadScored;
    // 重排后的 head + 保序 tail（GBrain: un-reranked tail 保持原 RRF 位置）
    const rerankedHeadSet = new Set(rerankedHeadIds);
    const tailIds = rerankTail.map((event) => event.id).filter((id) => !rerankedHeadSet.has(id));
    const selectedIds = [...rerankedHeadIds, ...tailIds];
    trace.rerankedEventIds = selectedIds;
    const eventSnapshotById = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
    trace.rerankedEvents = selectedIds.map((id) => eventSnapshotById.get(id)).filter((event): event is SearchTraceEvent => Boolean(event));
    emitSearchStep(emit, timings, rerankStepKey, {
      title: "LLM 重排",
      detail: `选出 ${trace.rerankedEvents.length || selectedIds.length} 个最终候选事件`,
      payload: trace.rerankedEvents.length > 0 ? trace.rerankedEvents : undefined,
      // 重排 token：真实 usage（llm.lastUsage）优先，无则估算
      tokens: llmRealUsage(this.llm) ?? { input: rerankHead.length * 60, output: options.rerankTopK * 20, cacheRead: 0 }
    });

    const sections = await timed(timings, "step8FetchChunks", () => this.sectionsForSelectedEvents(selectedIds, coarseRanked, options.maxSections), emit, {
      title: "回取关联切片",
      detail: "读取最终事件关联的原文切片。"
    });
    // 主路径切片：标注来源为事件臂（RRF+重排选出的事件关联原文）
    for (const section of sections) {
      if (!section.sourceStep) section.sourceStep = "event-arm";
    }
    // BUG#2 修复：Neo4j 臂的命中（Graphiti 实体 / Cognee 切片）追加为补充证据片段
    // 它们不是 PG 事件，作为内容命中直接进 sections（三库融合的落点）
    const neo4jHits = [...(graphitiHits ?? []), ...(cogneeHits ?? [])];
    if (neo4jHits.length > 0 && sections.length < options.maxSections) {
      const seenContent = new Set(sections.map((s) => s.content?.substring(0, 80)));
      for (const hit of neo4jHits) {
        if (sections.length >= options.maxSections) break;
        const key = hit.content?.substring(0, 80) || hit.id;
        if (seenContent.has(key)) continue;
        seenContent.add(key);
        sections.push({
          chunkId: `neo4j-${hit.source}-${sections.length}`,
          sourceId: input.sourceIds[0] ?? "neo4j",
          heading: `[${hit.source}] ${hit.title?.substring(0, 60)}`,
          content: hit.content?.substring(0, 800) || hit.title || "",
          rank: 0,
          score: hit.score,
          sourceStep: hit.source === "graphiti" ? "graphiti-entity" : "cognee-chunk"
        });
      }
      if (neo4jHits.length > 0) {
        emitSearchStep(emit, timings, "step8Neo4jSections", {
          title: "Neo4j 证据补充",
          detail: `追加 ${neo4jHits.length} 条 ${graphitiHits?.length ? "Graphiti 实体" : ""}${graphitiHits?.length && cogneeHits?.length ? " + " : ""}${cogneeHits?.length ? "Cognee 切片" : ""} 证据`
        });
      }
    }
    if (sections.length < options.maxSections) {
      const supplemental = await searchChunksByVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: options.maxSections * 2
      });
      const seen = new Set(sections.map((section) => section.chunkId));
      for (const section of supplemental) {
        if (seen.has(section.chunkId)) {
          continue;
        }
        sections.push({ ...section, sourceStep: "vector" });
        seen.add(section.chunkId);
        if (sections.length >= options.maxSections) {
          break;
        }
      }
    }
    emitSearchStep(emit, timings, "step8FetchChunks", {
      title: "回取关联切片",
      detail: `读取 ${sections.slice(0, options.maxSections).length} 个最终上下文切片`,
      payload: sections.slice(0, options.maxSections).map((section) => ({
        heading: section.heading,
        contentPreview: previewText(section.content, 160),
        score: section.score,
        rank: section.rank
      }))
    });

    // Compiled Truth Guarantee（GBrain dedup 兜底）：知识页命中即使被切片/事件淹没，也硬保一席
    // 权威版本总有位置——不让排名把沉淀结论挤掉
    if (compiledTruth.length > 0 && sections.length < options.maxSections) {
      const inSections = new Set(sections.map((s) => s.heading?.substring(0, 40)));
      for (const ct of compiledTruth) {
        if (sections.length >= options.maxSections) break;
        const headingKey = ct.title?.substring(0, 40) || "";
        if (headingKey && inSections.has(headingKey)) continue;
        inSections.add(headingKey);
        sections.push({
          chunkId: `truth-guarantee-${ct.id ?? sections.length}`,
          sourceId: input.sourceIds[0] ?? "truth",
          heading: `[知识页] ${ct.title?.substring(0, 60) || "Compiled Truth"}`,
          content: ct.compiledTruth?.substring(0, 800) || "",
          rank: 0,
          score: 999, // 权威版本最高优先级
          sourceStep: "compiled-truth"
        });
      }
      if (compiledTruth.length > 0) {
        emitSearchStep(emit, timings, "step8TruthGuarantee", {
          title: "权威版本保底",
          detail: `知识页命中硬保一席（${sections.length} 个最终切片）`
        });
      }
    }

    // Trace Waterfall：批量落库本 trace 的全部步骤 span
    await flushTraceSpans();

    return {
      traceId,
      sections: sections.slice(0, options.maxSections),
      trace: input.returnTrace ? trace : undefined
    };
  }

  private async expandEvents(input: {
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>;
    initialEntityIds: string[];
    sourceIds: string[];
    query: string;
    queryVector: number[];
    options: MultiOptions;
  }): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    if (input.options.subStrategy === "multi") {
      return this.expandFixedHops(input.seedEvents, input.initialEntityIds, input.sourceIds, input.options.maxHops);
    }
    const stageA = await this.expandOneHop(input.seedEvents, input.initialEntityIds, input.sourceIds, new Set(input.seedEvents.keys()));
    const trackedEntityIdsForB = unique([...input.initialEntityIds, ...stageA.expandedEntityIds]);
    let seedForB = stageA.events;
    if (input.options.subStrategy === "hopllm") {
      const eventsetIds = unique([...input.seedEvents.keys(), ...stageA.eventIds]);
      const ranked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: eventsetIds,
        queryVector: input.queryVector,
        maxEvents: input.options.maxEventsA
      });
      seedForB = await getEventsWithEntityIds(ranked.map((event) => event.id));
    }
    const stageB = await this.expandDynamic(seedForB, trackedEntityIdsForB, input.sourceIds, new Set([...input.seedEvents.keys(), ...stageA.eventIds]), input.options.maxEventsB, input.options.maxHopRetries);
    return {
      eventsetIds: stageA.eventIds,
      eventset1Ids: stageB.eventIds,
      expandedEventIds: unique([...stageA.eventIds, ...stageB.eventIds])
    };
  }

  private async expandFixedHops(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    maxHops: number
  ): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    const trackedEvents = new Set(seedEvents.keys());
    const trackedEntities = new Set(initialEntityIds);
    let current = seedEvents;
    const expandedEventIds: string[] = [];
    for (let hop = 0; hop < maxHops; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...trackedEvents]
      });
      if (newEventIds.length === 0) {
        break;
      }
      newEventIds.forEach((id) => trackedEvents.add(id));
      expandedEventIds.push(...newEventIds);
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventsetIds: expandedEventIds, eventset1Ids: [], expandedEventIds };
  }

  private async expandOneHop(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>
  ): Promise<{ eventIds: string[]; events: Map<string, EventRecord & { entityIds: string[] }>; expandedEntityIds: string[] }> {
    const trackedEntities = new Set(initialEntityIds);
    const entityIds = collectNewEntityIds(seedEvents, trackedEntities);
    const eventIds = await getEventIdsByEntityIds({
      entityIds,
      sourceIds,
      excludeEventIds: [...excludeEvents]
    });
    return {
      eventIds,
      events: await getEventsWithEntityIds(eventIds),
      expandedEntityIds: entityIds
    };
  }

  private async expandDynamic(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>,
    targetEvents: number,
    maxHopRetries: number
  ): Promise<{ eventIds: string[] }> {
    if (targetEvents === 0 || seedEvents.size === 0) {
      return { eventIds: [] };
    }
    const trackedEntities = new Set(initialEntityIds);
    const collected: string[] = [];
    let current = seedEvents;
    for (let hop = 0; hop < maxHopRetries; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...excludeEvents, ...collected]
      });
      if (newEventIds.length === 0) {
        break;
      }
      collected.push(...newEventIds);
      if (collected.length >= targetEvents) {
        break;
      }
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventIds: collected };
  }

  /**
   * ① Multi-query（GBrain 步2）— LLM 生成查询变体
   * 用 DeepSeek 改写问题为 N 个变体（不同角度/措辞），返回变体数组
   */
  private async generateQueryVariants(query: string, count: number): Promise<string[]> {
    try {
      const dsKey = process.env.DEEPSEEK_API_KEY || '';
      const llmKey = dsKey || (process.env.LLM_API_KEY || '');
      const llmUrl = dsKey
        ? (process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions')
        : (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1') + '/chat/completions';
      // 2026-08-07 模型注册表：Ask 改写用 reason 角色（用户可选）
      const llmModel = getRoleModel("reason");
      const resp = await fetch(llmUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + llmKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llmModel,
          messages: [{ role: 'user', content: `请把以下问题改写成 ${count} 个同义检索查询（不同措辞/角度），用中文分号分隔，不要解释：${query}` }],
          temperature: 0.5, max_tokens: 150,
        }),
        signal: (AbortSignal as any).timeout(10_000),
      }).catch(() => null);
      if (!resp || !resp.ok) return [];
      const j = await resp.json();
      const text = j?.choices?.[0]?.message?.content || '';
      return text.split(/[；;]/).map((s: string) => s.trim()).filter((s: string) => s.length >= 2 && s.length <= 50).slice(0, count);
    } catch {
      return [];
    }
  }

  private async sectionsForSelectedEvents(
    eventIds: string[],
    rankedEvents: EventRecord[],
    maxSections: number
  ): Promise<SearchSection[]> {
    const scoreByEventId = new Map(rankedEvents.map((event) => [event.id, event.score ?? 0]));
    const rawSections = await getSectionsForEvents(eventIds);
    const seenChunks = new Set<string>();
    const sections: SearchSection[] = [];
    // ③ Source-aware boost（GBrain 步9）— 按 chunk 来源类型加权
    // 学术/概念类 ×1.4，通用 ×1.0，其余 ×0.8（对应 GBrain writing×1.4/concepts×1.3/daily×0.8）
    const sourceBoost = (sourceType?: string): number => {
      if (!sourceType) return 1.0;
      const t = sourceType.toLowerCase();
      if (/(paper|journal|article|academic|thesis|概念|理论|论文)/.test(t)) return 1.4;
      if (/(policy|regulation|法律|政策|制度)/.test(t)) return 1.3;
      if (/(note|memo|daily|日常|笔记|日志)/.test(t)) return 0.8;
      return 1.0;
    };
    for (const section of rawSections) {
      if (seenChunks.has(section.chunkId)) {
        continue;
      }
      seenChunks.add(section.chunkId);
      sections.push({
        chunkId: section.chunkId,
        sourceId: section.sourceId,
        documentId: section.documentId,
        heading: section.heading,
        content: section.content,
        rank: section.rank,
        score: (scoreByEventId.get(section.eventId) ?? 0) * sourceBoost(section.sourceType)
      });
      if (sections.length >= maxSections) {
        break;
      }
    }
    return sections;
  }
}

function resolveMultiOptions(input: SearchInput, defaultSearchTopK: number): MultiOptions {
  const multi = input.multi ?? {};
  const topK = resolveFinalSearchTopK(input.topK ?? defaultSearchTopK);
  const rerankTopK = resolveFinalSearchTopK(multi.rerankTopK ?? topK);
  const maxSections = resolveFinalSearchTopK(multi.maxSections ?? topK);
  return {
    subStrategy: input.subStrategy ?? "multi",
    entityTopK: multi.entityTopK ?? 20,
    multiTopK: multi.multiTopK ?? 20,
    keySimilarityThreshold: multi.keySimilarityThreshold ?? 0.9,
    similarityThreshold: multi.similarityThreshold ?? 0.4,
    maxHops: multi.maxHops ?? 1,
    maxEvents: multi.maxEvents ?? 100,
    maxEventsA: multi.maxEventsA ?? 100,
    maxEventsB: multi.maxEventsB ?? 0,
    maxHopRetries: multi.maxHopRetries ?? 3,
    rerankTopK,
    maxSections
  };
}

function resolveFinalSearchTopK(value?: number): number {
  if (!Number.isFinite(value) || value == null) {
    return MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_SEARCH_RESULTS));
}

function collectNewEntityIds(
  events: Map<string, EventRecord & { entityIds: string[] }>,
  trackedEntities: Set<string>
): string[] {
  const ids = unique([...events.values()].flatMap((event) => event.entityIds));
  return ids.filter((id) => !trackedEntities.has(id));
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function dedupeEntities(entities: EntityRecord[]): EntityRecord[] {
  const seen = new Set<string>();
  const result: EntityRecord[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    result.push(entity);
  }
  return result;
}

async function timed<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
  emit?: SearchProgressEmitter,
  step?: { title: string; detail: string; payload?: unknown }
): Promise<T> {
  const start = performance.now();
  if (emit && step) {
    emitSearchStep(emit, timings, key, step, "running");
  }
  try {
    const result = await fn();
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, step, "done");
    }
    return result;
  } catch (error) {
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, {
        ...step,
        detail: `${step.detail} 失败：${error instanceof Error ? error.message : String(error)}`
      }, "failed");
    }
    // 真实事件 → 告警（检索步骤失败）
    try {
      const { recordAlert } = await import("./alert-service.js");
      void recordAlert({
        level: "warning",
        category: "failure",
        message: `检索步骤失败：${step?.title ?? key}（${error instanceof Error ? error.message.substring(0, 50) : String(error).substring(0, 50)}）`,
        taskType: "search",
        detail: { key, error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200) },
      }).catch(() => {});
    } catch { /* 告警失败不阻塞 */ }
    throw error;
  }
}

function emitSearchStep(
  emit: SearchProgressEmitter | undefined,
  timings: Record<string, number>,
  key: string,
  step: { title: string; detail: string; payload?: unknown; tokens?: { input: number; output: number; cacheRead: number } },
  status: SearchProgressEvent["status"] = "done",
  traceIdOverride?: string
) {
  // token 估算兜底：LLM 相关步骤按输入长度估算（无显式 tokens 时），保证 Trace 页有明细
  const tokens = step.tokens ?? estimateStepTokens(key, step);
  // 入/出流量收敛：入 = payload 数组长度（候选数），出 = 同上（该步输出）；非数组 payload 不标注
  const payloadLen = Array.isArray(step.payload) ? step.payload.length : undefined;
  emit?.({
    type: "step",
    status,
    key,
    title: step.title,
    detail: step.detail,
    payload: step.payload,
    durationMs: timings[key],
    tokens,
    io: payloadLen !== undefined ? { input: payloadLen, output: payloadLen } : undefined
  });
  // Trace Waterfall：步骤 span 收集到 per-trace 缓冲区（multiSearch 结束时批量落库）
  // 用显式传入的 traceId（并发检索时全局变量会被覆盖，导致 span 串 trace）
  const traceId = traceIdOverride ?? (globalThis as { __sagTraceId?: string }).__sagTraceId;
  const stepDurationMs = timings[key];
  if (traceId && stepDurationMs !== undefined) {
    try {
      const buffer = (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer ?? [];
      (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer = buffer;
      buffer.push({
        traceId,
        kind: "step",
        name: key,
        status: status === "failed" ? "error" : "ok",
        durationMs: stepDurationMs,
        tokens,
        detail: step.detail,
        io: payloadLen !== undefined ? { input: payloadLen, output: payloadLen } : undefined
      });
    } catch { /* 忽略 */ }
  }
}

/** 按步骤类型估算 token 消耗（中文按 ~1.5 字/token，估算值仅用于 Trace 展示） */
/** V381: 从 LlmClient 读最近一次真实 usage（搜索链 token 采集——替代硬编码估算）
 * llm 可能未实现 lastUsage（mock/旧实现）→ 返回 null 走估算兜底 */
function llmRealUsage(llm: LlmClient): { input: number; output: number; cacheRead: number } | null {
  const u = llm.lastUsage;
  if (!u || typeof u.in !== "number") return null;
  return { input: u.in, output: u.out, cacheRead: u.cacheHit ?? 0 };
}

function estimateStepTokens(
  key: string,
  step: { title?: string; detail?: string; payload?: unknown }
): { input: number; output: number; cacheRead: number } {
  const detailLen = (step.detail ?? "").length;
  const payloadLen = JSON.stringify(step.payload ?? "").length;
  const textLen = detailLen + payloadLen;
  const LLM_STEPS: Record<string, { in: number; out: number }> = {
    step1ExtractEntities: { in: 200, out: 60 },
    step3MultiQuery: { in: 250, out: 100 },
    step5Expand: { in: 400, out: 150 },
    step6CompiledTruth: { in: 300, out: 200 },
    rerankEvents: { in: 500, out: 50 },
    rerankEventsWithScores: { in: 500, out: 50 },
    step7Rerank: { in: 500, out: 50 },
    composeAnswer: { in: 800, out: 400 }
  };
  const spec = LLM_STEPS[key];
  if (spec) {
    // 有 payload 时按实际内容量估算输入
    return { input: Math.max(spec.in, Math.round(textLen * 0.7)), output: spec.out, cacheRead: 0 };
  }
  // 非 LLM 步骤（数据库/向量检索）：token 为 0，不显示明细
  return { input: 0, output: 0, cacheRead: 0 };
}

function toTraceEvents(events: Array<EventRecord & { entityIds?: string[] }>): SearchTraceEvent[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    summary: event.summary,
    contentPreview: previewText(event.content || event.summary || event.title, 160),
    score: event.score
  }));
}

function idsToTraceEvents(
  ids: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>
): SearchTraceEvent[] {
  return ids
    .map((id) => events.get(id))
    .filter((event): event is EventRecord & { entityIds: string[] } => Boolean(event))
    .map((event) => toTraceEvents([event])[0]);
}

function appendEventSnapshots(trace: SearchTrace, events: SearchTraceEvent[]) {
  const byId = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
  for (const event of events) {
    byId.set(event.id, event);
  }
  trace.eventSnapshots = [...byId.values()];
}

function previewText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

/** Trace Waterfall：批量落库当前 trace 的步骤 span（flush 缓冲区） */
async function flushTraceSpans(): Promise<void> {
  try {
    const buffer = (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer ?? [];
    (globalThis as { __sagTraceBuffer?: unknown[] }).__sagTraceBuffer = [];
    console.log(`[trace] flush: buffer ${buffer.length} spans`);
    if (buffer.length > 0) {
      const { recordSpansBatch } = await import("./trace-service.js");
      await recordSpansBatch(buffer as Parameters<typeof recordSpansBatch>[0]);
      console.log(`[trace] flushed ${buffer.length} spans`);
    }
  } catch (error) { console.error("[trace] flush 失败:", error instanceof Error ? error.message : String(error)); }
}

// ─── Neo4j 臂解析辅助（Graphiti/Cognee MCP 结果 → 统一结构）───

/** Graphiti hybrid_search_entities 结果解析 */
function parseGraphitiResult(raw: unknown): Array<{ name: string; description?: string; score?: number }> {
  try {
    const r = raw as { result?: Array<{ text?: string }> };
    const text = r?.result?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    const entities = Array.isArray(parsed?.entities) ? parsed.entities : Array.isArray(parsed) ? parsed : [];
    return entities.map((e: Record<string, unknown>) => ({
      name: String(e.name ?? e.title ?? ""),
      description: e.description == null ? undefined : String(e.description),
      score: typeof e.score === "number" ? e.score : undefined
    })).filter((e: { name: string; description?: string; score?: number }) => e.name);
  } catch {
    return [];
  }
}

/** Cognee cognee_search 结果解析 */
function parseCogneeHits(raw: unknown): Array<{ text?: string }> {
  try {
    const r = raw as { result?: unknown };
    const arr = Array.isArray(r?.result) ? r.result : [];
    return arr.map((item: unknown) => {
      if (typeof item === "string") return { text: item };
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return { text: String(o.text ?? o.content ?? "") };
      }
      return { text: "" };
    }).filter((c) => c.text && c.text.length > 20);
  } catch {
    return [];
  }
}

export const searchService = new SearchService();
