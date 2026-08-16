import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettings = vi.hoisted(() => ({
  current: {
    embeddingBaseUrl: "https://api.302ai.cn/v1",
    embeddingModel: "text-embedding-3-large",
    embeddingDimensions: 1024,
    embeddingApiKey: "",
    hasRemoteEmbedding: false,
    llmBaseUrl: "https://api.302ai.cn/v1",
    llmModel: "qwen3.6-flash",
    llmApiKey: "",
    hasRemoteLlm: false,
    llmTimeoutMs: 60_000,
    llmMaxRetries: 2,
    defaultSearchMode: "fast" as const,
    defaultSearchTopK: 10,
    defaultChunkingMode: "heading_strict" as const,
    chunkTokenLimit: 512,
    chunkOverlapTokens: 100
  }
}));

vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: vi.fn(async () => runtimeSettings.current)
  }
}));

import { OpenAICompatibleLlmClient } from "../src/ai/llm-client.js";

describe("local LLM fallback", () => {
  beforeEach(() => {
    runtimeSettings.current = {
      embeddingBaseUrl: "https://api.302ai.cn/v1",
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      hasRemoteEmbedding: false,
      llmBaseUrl: "https://api.302ai.cn/v1",
      llmModel: "qwen3.6-flash",
      llmApiKey: "",
      hasRemoteLlm: false,
      llmTimeoutMs: 60_000,
      llmMaxRetries: 2,
      defaultSearchMode: "fast" as const,
      defaultSearchTopK: 10,
      defaultChunkingMode: "heading_strict" as const,
      chunkTokenLimit: 512,
      chunkOverlapTokens: 100
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts a single local event without remote API keys", async () => {
    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk({
      title: "Demo",
      heading: "SAG",
      content: "SAG uses PostgreSQL and MCP for retrieval.",
      references: ["00000000-0000-0000-0000-000000000001"]
    });

    expect(events).toHaveLength(1);
    expect(events[0].entities.length).toBeGreaterThan(0);
  });

  it("keeps Chinese fallback extraction in Chinese", async () => {
    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk({
      title: "中文文档",
      heading: "SAG系统升级",
      content: "SAG系统升级使用PostgreSQL数据库和MCP工具完成中文资料检索，并抽取事件和实体。",
      references: ["00000000-0000-0000-0000-000000000002"]
    });

    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("一般事项");
    expect(events[0].entities.length).toBeGreaterThan(0);
    expect(events[0].entities.every((entity) => !entity.description.includes("Mentioned in event"))).toBe(true);
  });

  it("normalizes remote extraction to one event when the model returns multiple items", async () => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "test-key",
      hasRemoteLlm: true
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              type: "response",
              data: {
                items: [
                  {
                    title: "SAG系统升级",
                    summary: "SAG系统升级用于资料检索。",
                    content: "SAG系统升级使用PostgreSQL数据库。",
                    category: "系统升级",
                    keywords: ["SAG系统", "PostgreSQL"],
                    references: [1],
                    entities: [{ type: "product", name: "SAG系统", description: "被升级的系统" }],
                    is_valid: true,
                    children: [
                      {
                        title: "MCP工具接入",
                        content: "SAG系统接入MCP工具。",
                        keywords: ["MCP工具"],
                        references: [1],
                        entities: [{ type: "product", name: "MCP工具", description: "用于测试的工具接入" }],
                        is_valid: true,
                        children: []
                      }
                    ]
                  },
                  {
                    title: "Embedding生成",
                    content: "SAG系统生成Embedding向量。",
                    keywords: ["Embedding"],
                    references: [1],
                    entities: [{ type: "subject", name: "Embedding", description: "用于向量检索" }],
                    is_valid: true,
                    children: []
                  }
                ],
                meta: { reason: "测试多事项违规输出" }
              }
            })
          }
        }]
      })
    } as Response)));

    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk({
      title: "中文文档",
      heading: "SAG系统升级",
      content: "SAG系统升级使用PostgreSQL数据库，接入MCP工具，并生成Embedding向量。",
      references: ["00000000-0000-0000-0000-000000000003"]
    });

    expect(events).toHaveLength(1);
    expect(events[0].content).toContain("SAG系统升级使用PostgreSQL数据库。");
    expect(events[0].content).toContain("SAG系统接入MCP工具。");
    expect(events[0].content).toContain("SAG系统生成Embedding向量。");
    expect(events[0].keywords).toEqual(["SAG系统", "PostgreSQL", "MCP工具", "Embedding"]);
    expect(events[0].entities.map((entity) => entity.name)).toEqual(["SAG系统", "MCP工具", "Embedding"]);
  });

  it("falls back when remote extraction changes Chinese content into English", async () => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "test-key",
      hasRemoteLlm: true
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              type: "response",
              data: {
                items: [{
                  title: "SAG system upgrade",
                  summary: "SAG system upgrades retrieval.",
                  content: "The system uses PostgreSQL and MCP tools for document retrieval.",
                  category: "system upgrade",
                  keywords: ["SAG", "PostgreSQL", "MCP"],
                  references: [1],
                  entities: [{
                    type: "product",
                    name: "MCP",
                    description: "Tool integration for retrieval"
                  }],
                  is_valid: true,
                  children: []
                }],
                meta: { reason: "language drift" }
              }
            })
          }
        }]
      })
    } as Response)));

    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk({
      title: "中文文档",
      heading: "SAG系统升级",
      content: "SAG系统升级使用PostgreSQL数据库和MCP工具完成中文资料检索。",
      references: ["00000000-0000-0000-0000-000000000004"]
    });

    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("一般事项");
    expect(events[0].content).toContain("SAG系统升级使用PostgreSQL数据库");
    expect(events[0].content).not.toContain("The system uses");
    expect(events[0].entities.every((entity) => !entity.description.includes("Tool integration"))).toBe(true);
  });

  it("retries transient remote LLM failures according to settings", async () => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "test-key",
      hasRemoteLlm: true,
      llmMaxRetries: 1
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "temporary upstream failure"
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "response",
                data: {
                  items: [{
                    title: "SAG重试",
                    summary: "SAG重试成功。",
                    content: "SAG在临时失败后完成远程抽取。",
                    category: "系统行为",
                    keywords: ["SAG", "重试"],
                    references: [1],
                    entities: [{ type: "subject", name: "SAG", description: "执行重试的系统" }],
                    is_valid: true,
                    children: []
                  }],
                  meta: { reason: "测试重试" }
                }
              })
            }
          }]
        })
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk({
      title: "远程抽取",
      heading: "SAG重试",
      content: "SAG在临时失败后完成远程抽取。",
      references: ["00000000-0000-0000-0000-000000000004"]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("SAG重试");
  });
});
