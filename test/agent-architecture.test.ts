// agent-architecture.test.ts — 批次1: 架构级新函数单测
// encryptToken/decryptToken / buildSessionGraph / forkTask / compactByBudget / llmConcurrencyStats
import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "../src/services/agent-oauth.js";
import { agentSessionGraphService } from "../src/services/agent-session-graph.js";
import { llmConcurrencyStats } from "../src/ai/llm-common.js";

describe("OAuth token 加密", () => {
  it("加密→解密往返", () => {
    const enc = encryptToken("gho_secret_token_xyz");
    expect(decryptToken(enc)).toBe("gho_secret_token_xyz");
  });
  it("密文不含明文", () => {
    const enc = encryptToken("gho_super_secret");
    expect(enc.includes("gho_super_secret")).toBe(false);
  });
  it("同值两次加密不同（随机 IV）", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(decryptToken(b));
  });
});

describe("会话图", () => {
  it("空会话 → 空图不崩", async () => {
    const g = await agentSessionGraphService.buildSessionGraph("nonexistent-session");
    expect(Array.isArray(g.nodes)).toBe(true);
    expect(Array.isArray(g.edges)).toBe(true);
  });
  it("图含会话根节点", async () => {
    const g = await agentSessionGraphService.buildSessionGraph("test-session");
    expect(g.nodes.some((n) => n.type === "session")).toBe(true);
  });
});

describe("并发统计", () => {
  it("含 adaptiveCap 字段", () => {
    const s = llmConcurrencyStats();
    expect(s.adaptiveCap).toBeGreaterThan(0);
    expect(s.adaptiveCap).toBeLessThanOrEqual(s.max);
  });
});
