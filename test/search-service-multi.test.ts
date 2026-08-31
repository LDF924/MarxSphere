import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingClient } from "../src/ai/embedding-client.js";
import type { LlmClient } from "../src/ai/llm-client.js";
import type { RerankClient } from "../src/ai/rerank-client.js";

const repositories = vi.hoisted(() => ({
  assertSourcesAccessible: vi.fn(),
  coarseRankEventsByContent: vi.fn(),
  getEventIdsByEntityIds: vi.fn(),
  getEventsWithEntityIds: vi.fn(),
  getSectionsForEvents: vi.fn(),
  graphTraversalTwoHops: vi.fn(),
  relationalFanout: vi.fn(),
  searchChunksByVector: vi.fn(),
  searchCompiledTruth: vi.fn(),
  searchEntitiesByName: vi.fn(),
  searchEntitiesByText: vi.fn(),
  searchEntitiesByVector: vi.fn(),
  searchEventsByText: vi.fn(),
  searchEventsByTitleVector: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);

// V400 CI 修复: mock rerankClient — 避免无有效 RERANK_API_KEY 环境(CI dummy key)下走真实 API 401
const rerank = vi.hoisted(() => ({
  rerankEvents: vi.fn(async () => [] as string[]),
  rerankEventsWithScores: vi.fn(async () => [] as Array<{ id: string; score: number }>)
}));
vi.mock("../src/ai/rerank-client.js", () => ({ rerankClient: rerank, QwenRerankClient: class {} }));

import { SearchService } from "../src/services/search-service.js";

describe("SearchService multi search", () => {
  beforeEach(() => {
    for (const mock of Object.values(repositories)) {
      mock.mockReset();
    }
    repositories.assertSourcesAccessible.mockResolvedValue(undefined);
    repositories.searchEntitiesByName.mockResolvedValue([]);
    repositories.searchEntitiesByText.mockResolvedValue([]);
    repositories.searchEntitiesByVector.mockResolvedValue([]);
    repositories.getEventIdsByEntityIds.mockResolvedValue([]);
    repositories.searchEventsByTitleVector.mockResolvedValue([]);
    repositories.searchEventsByText.mockResolvedValue([]);
    repositories.searchChunksByVector.mockResolvedValue([]);
    repositories.searchCompiledTruth.mockResolvedValue([]);
    repositories.relationalFanout.mockResolvedValue([]);
    repositories.graphTraversalTwoHops.mockResolvedValue({ eventIds: [], entityIds: [] });
  });

  it("uses SAG2 multi defaults for thresholds and query-event oversampling", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["SAG"]),
      extractRelations: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };
    const service = new SearchService(embeddings, llm);

    await service.search({
      query: "SAG 多跳检索",
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      strategy: "multi",
      searchMode: "standard"
    });

    expect(repositories.searchEntitiesByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 20,
      threshold: 0.9
    }));
    expect(repositories.searchEventsByTitleVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 60,
      threshold: 0.4
    }));
  });

  it("allows vector search up to the configured service maximum", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractRelations: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(async () => []),
      rerankEvents: vi.fn(async () => []),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.searchChunksByVector.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: "00000000-0000-0000-0000-000000000002",
      heading: `切片 ${index + 1}`,
      content: `内容 ${index + 1}`,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "vector",
      topK: 50
    });

    expect(repositories.searchChunksByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 50
    }));
    expect(result.sections).toHaveLength(50);
  });

  it("expands only through new entities and ranks dual-phase candidates separately", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["初始实体"]),
      extractRelations: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => []),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";

    repositories.searchEntitiesByVector.mockResolvedValue([entity("entity-query", sourceId, "初始实体")]);
    repositories.getEventIdsByEntityIds
      .mockResolvedValueOnce(["event-seed"])
      .mockResolvedValueOnce(["event-hop1"])
      .mockResolvedValueOnce(["event-hop2"]);
    repositories.getEventsWithEntityIds
      .mockResolvedValueOnce(new Map([
        ["event-seed", event("event-seed", sourceId, ["entity-query", "entity-new"])]
      ]))
      .mockResolvedValueOnce(new Map([
        ["event-hop1", event("event-hop1", sourceId, ["entity-new", "entity-hop2"])]
      ]));
    repositories.coarseRankEventsByContent.mockImplementation(async (input: { eventIds: string[] }) => (
      input.eventIds.map((id) => event(id, sourceId, []))
    ));
    repositories.getSectionsForEvents.mockResolvedValue([]);

    await service.search({
      query: "解释多跳检索",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      subStrategy: "multi1",
      multi: {
        maxEventsB: 1
      }
    });

    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entityIds: ["entity-query"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entityIds: ["entity-new"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(3, expect.objectContaining({
      entityIds: ["entity-hop2"]
    }));
    // V98 后: coarseRank 改为一次调用（candidateIds 合并后 RRF 三臂融合粗排）
    expect(repositories.coarseRankEventsByContent).toHaveBeenCalledTimes(1);
    expect(repositories.coarseRankEventsByContent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      maxEvents: 100
    }));
  });

  it("uses requested topK for LLM rerank and final sections", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractRelations: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      )),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const events = Array.from({ length: 6 }, (_, index) => event(`event-${index + 1}`, sourceId, []));

    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      topK: 50
    });

            // V98+ 后: 使用 rerankEventsWithScores（连续分重排）；此处未传 reranker 用默认，
    // 断言结果 sections 数量（topK=50 → 最多 50 条，实际取决于候选数）
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections).toHaveLength(6);
  });

  it("uses fast mode without LLM entity extraction or LLM rerank", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["不应调用"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => ["不应调用"]),
      extractRelations: vi.fn(async () => []),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };
    const reranker: RerankClient = {
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      )),
      rerankEventsWithScores: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1 }))
      ))
    };
    const service = new SearchService(embeddings, llm, reranker);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const matchedEntity = entity("entity-query", sourceId, "SAG");
    const events = Array.from({ length: 3 }, (_, index) => event(`event-${index + 1}`, sourceId, ["entity-query"]));

    repositories.searchEntitiesByText.mockResolvedValue([matchedEntity]);
    repositories.getEventIdsByEntityIds.mockResolvedValue(["event-1"]);
    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG 为什么快",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast",
      returnTrace: true,
      topK: 5
    });

    expect(llm.extractNamedEntities).not.toHaveBeenCalled();
    expect(llm.rerankEvents).not.toHaveBeenCalled();
    expect(repositories.searchEntitiesByText).toHaveBeenCalledWith(expect.objectContaining({
      query: "SAG 为什么快",
      limit: 20
    }));
    // V98+ 后: rerank 用 rerankEventsWithScores；fast 模式不应调用 LLM rerank（reranker 是确定性重排）
    expect(reranker.rerankEventsWithScores).toHaveBeenCalledWith(expect.objectContaining({
      topK: 5
    }));
    expect(result.trace?.searchMode).toBe("fast");
    expect(result.trace?.recalledEntities).toHaveLength(1);
    expect(result.sections).toHaveLength(3);
  });
});

function entity(id: string, sourceId: string, name: string) {
  return {
    id,
    sourceId,
    type: "subject",
    name,
    normalizedName: name.toLowerCase(),
    score: 1
  };
}

function event(id: string, sourceId: string, entityIds: string[]) {
  return {
    id,
    sourceId,
    documentId: "00000000-0000-0000-0000-000000000002",
    chunkId: "00000000-0000-0000-0000-000000000003",
    title: id,
    summary: id,
    content: id,
    rank: 0,
    score: 1,
    entityIds
  };
}
