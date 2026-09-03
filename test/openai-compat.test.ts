// openai-compat.test.ts — OpenAI 兼容端点纯函数单测(不依赖 DB/网络)
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildEvidencePrompt,
  estimateTokens,
  extractLastUserMessage,
  formatChatChunk,
  mapSectionsToCitations,
  runOpenAiChatCompletion,
} from "../src/services/openai-compat.js";
import type { SearchSection } from "../src/types.js";

// ── 编排层测试: mock 掉 DB 与检索服务, 验证 0 结果短路分支 ──
vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) }, // 空 sources → ids=[]
}));
vi.mock("../src/services/search-service.js", () => ({
  searchService: { search: vi.fn() },
}));
vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: { getRuntimeSettings: vi.fn() },
}));

import { pool } from "../src/db/pool.js";
import { searchService } from "../src/services/search-service.js";

describe("runOpenAiChatCompletion 0 结果短路", () => {
  beforeEach(() => {
    vi.mocked(searchService.search).mockResolvedValue({
      sections: [],
      traceId: "trace-empty",
    } as any);
  });

  it("检索 0 结果时返回固定证据不足回答, 不调用 LLM", async () => {
    const result = await runOpenAiChatCompletion({
      messages: [{ role: "user", content: "不存在的概念" }],
      stream: false,
    });
    expect(result.choices[0].message.content).toContain("未在知识库中找到");
    expect(result.sag.citations).toEqual([]);
    expect(result.sag.traceId).toBe("trace-empty");
    expect(result.usage.total_tokens).toBeGreaterThan(0); // 估算 tokens
    expect(vi.mocked(searchService.search)).toHaveBeenCalledWith(
      expect.objectContaining({ query: "不存在的概念" }),
      expect.any(String),
    );
  });
});

describe("extractLastUserMessage", () => {
  it("取最后一条 user 消息", () => {
    const q = extractLastUserMessage([
      { role: "system", content: "你是助手" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "已回答" },
      { role: "user", content: "第二个问题" },
    ]);
    expect(q).toBe("第二个问题");
  });
  it("content 为数组时拼接 text 项(多模态形态)", () => {
    const q = extractLastUserMessage([
      { role: "user", content: [{ type: "text", text: "剩余价值率" }, { type: "text", text: "如何计算?" }] },
    ]);
    expect(q).toBe("剩余价值率如何计算?");
  });
  it("无 user 消息返回 null", () => {
    expect(extractLastUserMessage([{ role: "system", content: "hi" }])).toBeNull();
  });
  it("空字符串 content 返回 null", () => {
    expect(extractLastUserMessage([{ role: "user", content: "   " }])).toBeNull();
  });
});

describe("buildEvidencePrompt", () => {
  it("system 文案含证据编号约束(与 composeAnswer 同构)", () => {
    const { system } = buildEvidencePrompt("q", [{ title: "t", content: "c" }]);
    expect(system).toContain("马克思主义理论研究助手");
    expect(system).toContain("[n]");
    expect(system).toContain("只使用证据中的事实");
  });
  it("user 消息按 [n] 编号拼接证据", () => {
    const { user } = buildEvidencePrompt("问题", [
      { title: "甲", content: "内容甲" },
      { title: "乙", content: "内容乙" },
    ]);
    expect(user).toContain("问题：问题");
    expect(user).toContain("[1] 甲\n内容甲");
    expect(user).toContain("[2] 乙\n内容乙");
  });
  it("默认截断 8 条 × 800 字", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, content: "x".repeat(1000) }));
    const { user } = buildEvidencePrompt("q", many);
    expect(user).toContain("[8]");
    expect(user).not.toContain("[9]");
    expect(user).not.toContain("x".repeat(801));
  });
});

describe("mapSectionsToCitations", () => {
  const sections: SearchSection[] = [
    { chunkId: "c1", sourceId: "s1", heading: "第一章", content: "…", rank: 0, score: 0.9 },
    { chunkId: "c2", sourceId: "s2", content: "…", rank: 1, score: 0.8 },
  ];
  it("index 从 1 递增, 含 sourceId/chunkId/heading/score", () => {
    const citations = mapSectionsToCitations(sections, new Map([["s1", "《资本论》"]]));
    expect(citations[0]).toMatchObject({
      index: 1,
      title: "《资本论》",
      sourceId: "s1",
      chunkId: "c1",
      heading: "第一章",
      score: 0.9,
    });
    expect(citations[1].title).toBe("s2"); // 未命中映射兜底为 sourceId
    expect(citations[1].heading).toBeUndefined();
  });
});

describe("formatChatChunk", () => {
  it("输出合法 SSE data 行(首块带 role)", () => {
    const line = formatChatChunk({
      id: "chatcmpl-abc",
      created: 1000,
      model: "m",
      delta: { role: "assistant", content: "" },
    });
    expect(line.startsWith("data: ")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(line.slice(6).trim());
    expect(payload.object).toBe("chat.completion.chunk");
    expect(payload.choices[0].delta.role).toBe("assistant");
    expect(payload.choices[0].finish_reason).toBeNull();
  });
  it("末块 finish_reason + extra 字段", () => {
    const line = formatChatChunk({
      id: "chatcmpl-abc",
      created: 1000,
      model: "m",
      delta: {},
      finishReason: "stop",
      extra: { sag: { citations: [] }, usage: { total_tokens: 3 } },
    });
    const payload = JSON.parse(line.slice(6).trim());
    expect(payload.choices[0].finish_reason).toBe("stop");
    expect(payload.sag.citations).toEqual([]);
    expect(payload.usage.total_tokens).toBe(3);
  });
});

describe("estimateTokens", () => {
  it("chars/4 向上取整", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});
