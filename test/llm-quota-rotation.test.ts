// llm-quota-rotation.test.ts — Quota Rotation 网关(V389, 借鉴 TraitTutor gateway/quota_rotation.py)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 用模块级状态验证熔断(通过 callLlmWithRotation 的行为间接验证)
import { callLlmWithRotation, modelCircuitStats, classifyLlmError } from "../src/ai/llm-common.js";

describe("classifyLlmError(Quota Rotation 错误分类)", () => {
  it("429 → rate_limit 且可重试", () => {
    const c = classifyLlmError("HTTP 429", 429);
    expect(c.errorType).toBe("rate_limit");
    expect(c.retryable).toBe(true);
  });
  it("401/403 → auth 且不可重试(立即轮换)", () => {
    expect(classifyLlmError("HTTP 401", 401).errorType).toBe("auth");
    expect(classifyLlmError("HTTP 403", 403).errorType).toBe("auth");
    expect(classifyLlmError("HTTP 401", 401).retryable).toBe(false);
  });
  it("5xx → server_error 可重试", () => {
    const c = classifyLlmError("HTTP 502", 502);
    expect(c.errorType).toBe("server_error");
    expect(c.retryable).toBe(true);
  });
  it("400 → other 不可重试", () => {
    const c = classifyLlmError("HTTP 400", 400);
    expect(c.errorType).toBe("other");
    expect(c.retryable).toBe(false);
  });
  it("超时 → timeout 可重试", () => {
    const c = classifyLlmError("timeout of 180000ms exceeded");
    expect(c.errorType).toBe("timeout");
    expect(c.retryable).toBe(true);
  });
  it("网络错误 → network 可重试", () => {
    const c = classifyLlmError("ECONNREFUSED");
    expect(c.errorType).toBe("network");
    expect(c.retryable).toBe(true);
  });
});

describe("modelCircuitStats(路由熔断状态)", () => {
  it("初始无状态(未熔断)", () => {
    expect(Object.keys(modelCircuitStats()).length).toBe(0);
  });
});

describe("callLlmWithRotation(带熔断与 deadline 的调用)", () => {
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, env: { ...process.env, LLM_MODEL_CIRCUIT_FAILURES: "3", LLM_MODEL_CIRCUIT_COOLDOWN_MS: "60000" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("失败时返回含路由错误摘要的错误(不静默)", async () => {
    const r = await callLlmWithRotation({
      model: "nonexistent-model-xyz",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
      totalTimeoutMs: 15_000,
    });
    expect(r).not.toBeNull();
    expect(r!.error).toBeTruthy();
    expect(r!.errorType).toBeTruthy();
  });
});
