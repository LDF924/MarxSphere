import { describe, expect, it } from "vitest";
// 模型中立（ScienceX 理念 2026-08-27）: Anthropic 原生格式 vs OpenAI 兼容格式识别
// 逻辑在 src/ai/llm-common.ts fetchLlm 内, 这里测 URL 识别规则

function isAnthropicEndpoint(url: string): boolean {
  return url.includes("/messages") && !url.includes("/chat/completions");
}

describe("model neutrality (Anthropic-compatible)", () => {
  it("anthropic native endpoint /v1/messages → anthropic format", () => {
    expect(isAnthropicEndpoint("https://api.anthropic.com/v1/messages")).toBe(true);
  });

  it("openai-compatible /chat/completions → not anthropic", () => {
    expect(isAnthropicEndpoint("https://api.deepseek.com/v1/chat/completions")).toBe(false);
    expect(isAnthropicEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")).toBe(false);
  });

  it("custom base url ending with /messages (claude-code style) → anthropic", () => {
    expect(isAnthropicEndpoint("https://my-proxy.example.com/v1/messages")).toBe(true);
  });

  it("302ai aggregate (OpenAI-compatible) → not anthropic", () => {
    expect(isAnthropicEndpoint("https://api.302ai.cn/v1/chat/completions")).toBe(false);
  });
});
