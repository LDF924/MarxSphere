// sidecar-guard.test.ts — Sidecar 工具门控单测（P0-13）
import { describe, it, expect } from "vitest";
import { guardToolCall, resetGuardBreaker, type SidecarCall } from "../src/services/sidecar-guard.js";

describe("规则层（确定性，零成本）", () => {
  it("$(echo rm) 子shell → deny", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_execute_code", args: { code: "$(echo rm) -rf /" } });
    expect(r.verdict).toBe("deny");
    expect(r.layer).toBe("rule");
  });

  it("cat ~/.ssh/id_rsa → deny", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_execute_code", args: { code: "cat ~/.ssh/id_rsa" } });
    expect(r.verdict).toBe("deny");
  });

  it("路径遍历 → deny", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_execute_code", args: { code: "open('../etc/passwd')" } });
    expect(r.verdict).toBe("deny");
  });

  it("低风险工具直接 allow（不走 LLM）", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_search", args: { query: "x" } });
    expect(r.verdict).toBe("allow");
    expect(r.layer).toBe("rule");
  });

  it("rm -rf → deny", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_execute_code", args: { code: "rm -rf /tmp/x" } });
    expect(r.verdict).toBe("deny");
  });

  it("环境变量读取含密钥 → deny", async () => {
    resetGuardBreaker();
    const r = await guardToolCall({ tool: "sag_execute_code", args: { code: "printenv DEEPSEEK_API_KEY" } });
    expect(r.verdict).toBe("deny");
  });
});

describe("熔断升级", () => {
  it("连续 3 次 deny → review（升级人工）", async () => {
    resetGuardBreaker();
    const call: SidecarCall = { tool: "sag_execute_code", args: { code: "$(echo rm) -rf /" } };
    await guardToolCall(call);
    await guardToolCall(call);
    const third = await guardToolCall(call);
    expect(third.verdict).toBe("review");
    expect(third.layer).toBe("breaker");
  });
});
