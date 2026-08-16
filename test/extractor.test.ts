import { describe, expect, it, vi } from "vitest";
import { extractEventsFromChunk } from "../src/ingestion/extract/extractor.js";
import type { LlmClient } from "../src/ai/llm-client.js";

describe("extractEventsFromChunk", () => {
  it("keeps one event per chunk even if the LLM client returns multiple events", async () => {
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractRelations: vi.fn(async () => []),
      rerankEvents: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(async () => [
        {
          title: "第一个事项",
          summary: "第一个事项摘要",
          content: "第一个事项内容",
          category: "一般事项",
          keywords: ["第一个事项"],
          references: [],
          entities: []
        },
        {
          title: "第二个事项",
          summary: "第二个事项摘要",
          content: "第二个事项内容",
          category: "一般事项",
          keywords: ["第二个事项"],
          references: [],
          entities: []
        }
      ]),
      composeAnswer: vi.fn(async () => ({ answer: "test", citations: [] }))
    };

    const events = await extractEventsFromChunk({
      llm,
      documentTitle: "测试文档",
      heading: "测试章节",
      content: "测试章节包含多个事实，但当前系统每个切片只保留一个事项。",
      references: ["00000000-0000-0000-0000-000000000001"]
    });

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("第一个事项");
    expect(events[0].references).toEqual(["00000000-0000-0000-0000-000000000001"]);
  });
});
