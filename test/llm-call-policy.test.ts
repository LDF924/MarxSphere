// llm-call-policy.test.ts — 恢复分级单测（P0-12）
import { describe, it, expect } from "vitest";
import { stripPrivateFields, callLlmWithPolicy } from "../src/services/llm-call-policy.js";

describe("stripPrivateFields", () => {
  it("保留 role/content，剥离私有格式", () => {
    const msgs = [{ role: "user", content: "hi", reasoning_content: "secret" } as any];
    const out = stripPrivateFields(msgs);
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect((out[0] as any).reasoning_content).toBeUndefined();
  });

  it("多消息逐条清理", () => {
    const msgs = [
      { role: "user", content: "a", reasoning_content: "x" } as any,
      { role: "assistant", content: "b", reasoning_content: "y", extra: 1 } as any,
    ];
    const out = stripPrivateFields(msgs);
    expect(out.length).toBe(2);
    expect(Object.keys(out[1])).toEqual(["role", "content"]);
  });
});

describe("callLlmWithPolicy 结构", () => {
  it("导出函数存在", () => {
    expect(typeof callLlmWithPolicy).toBe("function");
  });
});
