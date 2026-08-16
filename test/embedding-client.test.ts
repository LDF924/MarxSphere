import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettings = vi.hoisted(() => ({
  current: {
    embeddingBaseUrl: "https://api.302ai.cn/v1",
    embeddingModel: "text-embedding-3-large",
    embeddingDimensions: 1024,
    embeddingApiKey: "secret-embedding-key",
    hasRemoteEmbedding: true,
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

import { OpenAICompatibleEmbeddingClient } from "../src/ai/embedding-client.js";
import { listModelCallLogs } from "../src/observability/model-call-log.js";

describe("OpenAICompatibleEmbeddingClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the configured OpenAI-compatible embeddings endpoint without logging the API key", async () => {
    const before = listModelCallLogs().latestSequence;
    const embedding = new Array(1024).fill(0);
    embedding[0] = 1;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("https://api.302ai.cn/v1/embeddings");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-embedding-key");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        model: "text-embedding-3-large",
        input: ["SAG"],
        dimensions: 1024
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ embedding }]
        })
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAICompatibleEmbeddingClient();
    await expect(client.generate("SAG")).resolves.toEqual(embedding);

    const { logs } = listModelCallLogs(before);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].request)).not.toContain("secret-embedding-key");
    expect(JSON.stringify(logs[0].request)).not.toContain("Authorization");
  });

  it("rejects embeddings with dimensions incompatible with the runtime setting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ embedding: [1, 0, 0] }]
      })
    } as Response)));

    const client = new OpenAICompatibleEmbeddingClient();
    await expect(client.generate("SAG")).rejects.toThrow("embedding dimension mismatch");
  });
});
