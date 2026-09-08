// llm-common.test.ts — G1: callLlm 重试/错误分类/退避 单测
import { describe, it, expect } from "vitest";
import { classifyLlmError, retryBackoffMs, parseLlmJson } from "../src/ai/llm-common.js";

describe("classifyLlmError", () => {
  it("429 → rate_limit 可重试", () => {
    const r = classifyLlmError("too many", 429);
    expect(r.retryable).toBe(true);
    expect(r.errorType).toBe("rate_limit");
  });
  it("5xx → server_error 可重试", () => {
    const r = classifyLlmError("bad gateway", 502);
    expect(r.retryable).toBe(true);
    expect(r.errorType).toBe("server_error");
  });
  it("401/403 → 不可重试", () => {
    expect(classifyLlmError("unauthorized", 401).retryable).toBe(false);
    expect(classifyLlmError("forbidden", 403).retryable).toBe(false);
  });
  it("timeout → timeout 可重试", () => {
    const r = classifyLlmError(new Error("request timeout after 60000ms"));
    expect(r.retryable).toBe(true);
    expect(r.errorType).toBe("timeout");
  });
  it("网络错误 → network 可重试", () => {
    const r = classifyLlmError(new Error("fetch failed: ECONNRESET"));
    expect(r.retryable).toBe(true);
    expect(r.errorType).toBe("network");
  });
  it("其他错误 → other 不可重试", () => {
    const r = classifyLlmError(new Error("invalid json"));
    expect(r.retryable).toBe(false);
    expect(r.errorType).toBe("other");
  });
});

describe("retryBackoffMs", () => {
  it("指数退避", () => {
    expect(retryBackoffMs(1)).toBe(1000);
    expect(retryBackoffMs(2)).toBe(2000);
    expect(retryBackoffMs(3)).toBe(4000);
  });
  it("上限 30s", () => {
    expect(retryBackoffMs(8)).toBe(30_000);
  });
});

describe("parseLlmJson 五级容错(R16b 对齐闭源 jsonrepair)", () => {
  it("直解+围栏", () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLlmJson("```json\n{\"b\":2}\n```")).toEqual({ b: 2 });
  });
  it("括号截断补全", () => {
    expect(parseLlmJson('{"x": [1, 2, 3], "y": {"z": true}')).toEqual({ x: [1, 2, 3], y: { z: true } });
  });
  it("尾逗号/内嵌文本", () => {
    expect(parseLlmJson('{"d":[1,2,]}')).toEqual({ d: [1, 2] });
    expect(parseLlmJson('前面文本 {"e":{"f":5}} 后面')).toEqual({ e: { f: 5 } });
  });
  it("值中途截断回溯", () => {
    expect(parseLlmJson('{"arr": [{"k": "v"}, {"k')).toEqual({ arr: [{ k: "v" }] });
    expect(parseLlmJson('{"list": [1, 2, 3')).toEqual({ list: [1, 2, 3] });
  });
  it("完全损坏返 null", () => {
    expect(parseLlmJson('{"a": "未闭合字符串')).toBeNull();
    expect(parseLlmJson('')).toBeNull();
  });
});
