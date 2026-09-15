import { describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getAiProviderSettings: vi.fn(async () => null),
  upsertAiProviderSettings: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => ({
  getAiProviderSettings: repositoryMocks.getAiProviderSettings,
  upsertAiProviderSettings: repositoryMocks.upsertAiProviderSettings
}));

import { AiSettingsService, toChatCompletionsUrl } from "../src/services/ai-settings-service.js";

describe("toChatCompletionsUrl", () => {
  // 2026-09-15: 这个字段是用户在设置页手填的, 而仓库里同时存在两种写法约定
  //   (.env.example 的 LLM_BASE_URL 是 base, DS_BASE_URL 是完整 URL)。
  //   原先 5 处调用点无条件追加后缀, 用户照第二种填就会拼成 .../chat/completions/chat/completions,
  //   实测该地址对 DeepSeek 返回 404(单个后缀是 200) —— 即静默失败。
  it("base 形式: 补上后缀", () => {
    expect(toChatCompletionsUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(toChatCompletionsUrl("https://api.302ai.cn/v1")).toBe("https://api.302ai.cn/v1/chat/completions");
  });

  it("完整 URL 形式: 不重复追加", () => {
    expect(toChatCompletionsUrl("https://api.deepseek.com/v1/chat/completions"))
      .toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("容忍尾斜杠与空白", () => {
    expect(toChatCompletionsUrl("  https://api.deepseek.com/v1/  ")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(toChatCompletionsUrl("https://api.deepseek.com/v1/chat/completions/")).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("只到域名也补全(不额外加 /v1 —— 由用户填的路径决定)", () => {
    expect(toChatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/chat/completions");
  });

  // 2026-09-15 补: 仓库里 DS_BASE_URL 与 LLM_BASE_URL 是**两套约定**
  //   (getProviderEndpoint 里 ANTHROPIC/DASHSCOPE 是 base 会追加, DS 不追加),
  //   inference/search/server/agent-tool-router/p2o/llm-common 六处的三元分支因此
  //   要么漏追加要么重复追加。实测: 用户按 LLM_BASE_URL 的约定填 base 给 DS_BASE_URL
  //   → 旧代码得到 ".../v1"(404); 按 DS 的约定填完整 URL 给 LLM_BASE_URL → 重复后缀(404)。
  //   归一化后两种填法都得到同一个正确地址。
  it("两套 env 约定(带后缀/不带后缀)归一到同一结果", () => {
    const full = "https://api.deepseek.com/v1/chat/completions";
    const base = "https://api.deepseek.com/v1";
    expect(toChatCompletionsUrl(base)).toBe(full);
    expect(toChatCompletionsUrl(full)).toBe(full);
  });
});

describe("AiSettingsService", () => {
  it("rejects embedding dimensions incompatible with pgvector schema", async () => {
    const service = new AiSettingsService();

    await expect(service.updateSettings({
      embeddingBaseUrl: "https://api.302ai.cn/v1",
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 1536,
      llmBaseUrl: "https://api.302ai.cn/v1",
      llmModel: "qwen3.6-flash",
      llmTimeoutMs: 60_000,
      llmMaxRetries: 2,
      defaultSearchMode: "fast",
      defaultSearchTopK: 10,
      defaultChunkingMode: "heading_strict",
      chunkTokenLimit: 512,
      chunkOverlapTokens: 100
    })).rejects.toThrow("embeddingDimensions must be 1024");
  });

  it("persists retrieval and chunking defaults in settings metadata", async () => {
    const service = new AiSettingsService();
    repositoryMocks.upsertAiProviderSettings.mockResolvedValueOnce({
      id: "global",
      embeddingBaseUrl: "https://api.302ai.cn/v1",
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 1024,
      embeddingApiKey: null,
      llmBaseUrl: "https://api.302ai.cn/v1",
      llmModel: "qwen3.6-flash",
      llmApiKey: null,
      llmTimeoutMs: 60_000,
      llmMaxRetries: 2,
      metadata: {
        defaultSearchMode: "standard",
        defaultSearchTopK: 10,
        defaultChunkingMode: "token",
        chunkTokenLimit: 768,
        chunkOverlapTokens: 128
      },
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z"
    });

    const settings = await service.updateSettings({
      embeddingBaseUrl: "https://api.302ai.cn/v1",
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 1024,
      llmBaseUrl: "https://api.302ai.cn/v1",
      llmModel: "qwen3.6-flash",
      llmTimeoutMs: 60_000,
      llmMaxRetries: 2,
      defaultSearchMode: "standard",
      defaultSearchTopK: 10,
      defaultChunkingMode: "token",
      chunkTokenLimit: 768,
      chunkOverlapTokens: 128
    });

    expect(repositoryMocks.upsertAiProviderSettings).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        defaultSearchMode: "standard",
        defaultSearchTopK: 10,
        defaultChunkingMode: "token",
        chunkTokenLimit: 768,
        chunkOverlapTokens: 128
      })
    }));
    expect(settings.defaultSearchMode).toBe("standard");
    expect(settings.defaultSearchTopK).toBe(10);
    expect(settings.defaultChunkingMode).toBe("token");
    expect(settings.chunkTokenLimit).toBe(768);
    expect(settings.chunkOverlapTokens).toBe(128);
  });
});
