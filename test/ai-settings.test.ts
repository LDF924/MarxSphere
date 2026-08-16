import { describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  getAiProviderSettings: vi.fn(async () => null),
  upsertAiProviderSettings: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => ({
  getAiProviderSettings: repositoryMocks.getAiProviderSettings,
  upsertAiProviderSettings: repositoryMocks.upsertAiProviderSettings
}));

import { AiSettingsService } from "../src/services/ai-settings-service.js";

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
