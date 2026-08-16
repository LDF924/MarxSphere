// agent-advanced.test.ts — 收尾: 新增纯函数单测
// classifyRetry / assessGoalClarity / guardianReview / suggestSandboxEscalation / compactByBudget
import { describe, it, expect } from "vitest";
import { classifyRetry } from "../src/services/agent-task-service.js";
import { assessGoalClarity } from "../src/services/agent-task-service.js";
import { guardianReview } from "../src/services/agent-guardian-service.js";
import { suggestSandboxEscalation } from "../src/services/code-sandbox-service.js";
import { compactByBudget } from "../src/services/context-compressor.js";

describe("classifyRetry", () => {
  it("网络错误+幂等类型 → 可重试且幂等", () => {
    const r = classifyRetry("ECONNRESET", "retrieve");
    expect(r.retryable).toBe(true);
    expect(r.idempotent).toBe(true);
  });
  it("超时+非幂等类型 → 可重试但非幂等(副作用风险)", () => {
    const r = classifyRetry("timeout", "write");
    expect(r.retryable).toBe(true);
    expect(r.idempotent).toBe(false);
  });
  it("业务错误 → 不可重试", () => {
    const r = classifyRetry("参数错误", "write");
    expect(r.retryable).toBe(false);
  });
});

describe("assessGoalClarity", () => {
  it("过短目标 → ambiguous", async () => {
    const r = await assessGoalClarity("写论文");
    expect(r.clarifiability).toBe("ambiguous");
  });
  it("无研究动词 → ambiguous", async () => {
    const r = await assessGoalClarity("农村经济");
    expect(r.clarifiability).toBe("ambiguous");
  });
  it("完整目标 → clear", async () => {
    const r = await assessGoalClarity("分析资本下乡对农村集体经济的影响机制");
    expect(r.clarifiability).toBe("clear");
  });
});

describe("guardianReview", () => {
  it("只读工具 high 授权 → allow", () => {
    expect(guardianReview("sag_retrieve").verdict).toBe("allow");
  });
  it("run_code full-access → review(风险升级)", () => {
    const r = guardianReview("run_code", { profile: "full-access" });
    expect(r.verdict).toBe("review");
    expect(r.riskLevel).toBe("high");
  });
  it("路径越界 → deny", () => {
    expect(guardianReview("file_read", { path: "../../etc/passwd" }).verdict).toBe("deny");
  });
  it("低授权+中风险 → deny", () => {
    expect(guardianReview("run_code", {}, "low").verdict).toBe("deny");
  });
});

describe("suggestSandboxEscalation", () => {
  it("read-only + 文件操作 → 建议 workspace-write", () => {
    const r = suggestSandboxEscalation("require('fs').writeFileSync('a','b')", "read-only");
    expect(r.suggested).toBe("workspace-write");
  });
  it("read-only + 网络请求 → 建议 full-access", () => {
    const r = suggestSandboxEscalation("fetch('https://x.com')", "read-only");
    expect(r.suggested).toBe("full-access");
  });
  it("无敏感操作 → 无需升级", () => {
    const r = suggestSandboxEscalation("console.log(1+1)", "read-only");
    expect(r.suggested).toBe("read-only");
  });
});

describe("compactByBudget", () => {
  it("未超预算 → 原样返回", () => {
    const msgs = [{ role: "user", content: "abc" }];
    const r = compactByBudget(msgs, { budgetChars: 1000, roleWeights: { user: 1 } });
    expect(r.outputChars).toBe(3);
  });
  it("超预算 → 按角色预算截断", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: "x".repeat(2000) + i }));
    const r = compactByBudget(msgs, { budgetChars: 3000, roleWeights: { user: 1 } });
    expect(r.outputChars).toBeLessThan(10000);
    expect(r.outputChars).toBeGreaterThan(0);
  });
});
