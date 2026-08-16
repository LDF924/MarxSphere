// error-recovery-map.test.ts — 故障分类学单测（P0-10）
import { describe, it, expect } from "vitest";
import { classifyError, toolCallFingerprint } from "../src/services/error-recovery-map.js";

describe("classifyError", () => {
  it("429 → api_rate_limit, retryable, retry_backoff", () => {
    const c = classifyError(new Error("429 Too Many Requests"));
    expect(c.category).toBe("api_rate_limit");
    expect(c.retryable).toBe(true);
    expect(c.strategy.kind).toBe("retry_backoff");
  });

  it("rate limit 文本 → api_rate_limit", () => {
    const c = classifyError(new Error("Rate limit exceeded, retry later"));
    expect(c.category).toBe("api_rate_limit");
  });

  it("timeout → api_timeout, retryable", () => {
    const c = classifyError(new Error("ETIMEDOUT after 90000ms"));
    expect(c.category).toBe("api_timeout");
    expect(c.retryable).toBe(true);
  });

  it("Connection reset → api_overload", () => {
    const c = classifyError(new Error("Connection reset by peer"));
    expect(c.category).toBe("api_overload");
  });

  it("JSON parse failed → tool_malformed_args, 不可重试", () => {
    const c = classifyError(new Error("JSON parse failed"));
    expect(c.category).toBe("tool_malformed_args");
    expect(c.retryable).toBe(false);
    expect(c.strategy.kind).toBe("change_input");
  });

  it("MCP Connection closed → tool_missing → fallback", () => {
    const c = classifyError(new Error("MCP Connection closed"));
    expect(c.category).toBe("tool_missing");
    expect(c.strategy.kind).toBe("fallback_strategy");
  });

  it("未知错误 → unknown, surface_to_user", () => {
    const c = classifyError(new Error("weird random thing"));
    expect(c.category).toBe("unknown");
    expect(c.strategy.kind).toBe("surface_to_user");
  });

  it("401 → 认证错误 surface_to_user", () => {
    const c = classifyError(new Error("401 Unauthorized"));
    expect(c.strategy.kind).toBe("surface_to_user");
  });
});

describe("toolCallFingerprint", () => {
  it("相同 tool+params 指纹一致", () => {
    expect(toolCallFingerprint("sag_search", { q: "x", k: 5 }))
      .toBe(toolCallFingerprint("sag_search", { q: "x", k: 5 }));
  });

  it("不同 params 指纹不同", () => {
    expect(toolCallFingerprint("sag_search", { q: "x" }))
      .not.toBe(toolCallFingerprint("sag_search", { q: "y" }));
  });

  it("JSON 序列化失败时退化为 tool 名", () => {
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(toolCallFingerprint("t", cyclic)).toBe("t");
  });
});
