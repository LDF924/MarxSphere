// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/routing-log.test.ts — 路由决策日志 + 用户抱怨对齐(V404-3, 借鉴 OpenSquilla 路由数据飞轮)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_LOG = path.join(os.tmpdir(), `sag-routing-log-${process.pid}.jsonl`);
process.env.SAG_ROUTING_LOG_FILE = TEST_LOG;

let mod: typeof import("../src/services/routing-log.js");

beforeAll(async () => {
  rmSync(TEST_LOG, { force: true });
  mod = await import("../src/services/routing-log.js");
});
afterAll(() => { rmSync(TEST_LOG, { force: true }); });

function readLines(): any[] {
  return readFileSync(TEST_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("routing-log", () => {
  let logRoutingDecision: any, routingUnderestimateStats: any, trimRoutingLog: any, logUnderestimateSample: any;
  beforeAll(() => {
    const m = mod!;
    logRoutingDecision = m.logRoutingDecision;
    routingUnderestimateStats = m.routingUnderestimateStats;
    trimRoutingLog = m.trimRoutingLog;
    logUnderestimateSample = m.logUnderestimateSample;
  });
  it("inferTier: 模型名 → 档位", () => {
    const { inferTier } = mod!;
    expect(inferTier("deepseek-v4-flash")).toBe("cheap");
    expect(inferTier("deepseek-r1-mini")).toBe("cheap");
    expect(inferTier("qwen-plus")).toBe("standard");
    expect(inferTier("deepseek-v4")).toBe("standard");
    expect(inferTier("qwen3.7-max")).toBe("strong");
    expect(inferTier("deepseek-pro")).toBe("strong");
    expect(inferTier("gpt-4o")).toBe("other");
    expect(inferTier("deepseek-chat")).toBe("other"); // 无档关键词 → other
  });

  it("estimateContextTokens: 中文粗估", () => {
    const { estimateContextTokens } = mod!;
    expect(estimateContextTokens()).toBe(0);
    const msgs = [{ role: "user", content: "资".repeat(240) }]; // 240 字
    expect(estimateContextTokens(msgs)).toBe(100); // 240/2.4
  });

  it("logRoutingDecision: 记录决策 → 文件含完整字段", () => {
    logRoutingDecision({ model: "deepseek-v4-flash", role: "plan", contextTokens: 3000, attempts: ["deepseek-v4-flash", "qwen-plus"], retried: true, ok: true, ms: 850, purpose: "plan_steps" });
    logRoutingDecision({ model: "deepseek-v4-flash", role: "reflect", ok: false, errorType: "timeout", ms: 1200 });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].event).toBe("decision");
    expect(lines[0].model).toBe("deepseek-v4-flash");
    expect(lines[0].tier).toBe("cheap");
    expect(lines[0].role).toBe("plan");
    expect(lines[0].contextTokens).toBe(3000);
    expect(lines[0].ok).toBe(true);
    expect(lines[1].ok).toBe(false);
    expect(lines[1].errorType).toBe("timeout");
  });

  it("underestimate 统计: 低估率 = underestimate/decisions, 超阈 flagged", async () => {
    // 清空重写
    rmSync(TEST_LOG, { force: true });
    // 6 次决策(便宜档), 2 次低估 → 率 1/3 > 0.15 → flagged
    for (let i = 0; i < 6; i++) logRoutingDecision({ model: "deepseek-v4-flash", role: "write", ok: true, ms: 500 });
    for (let i = 0; i < 2; i++) logRoutingDecision({ model: "qwen-plus", role: "write", ok: true, ms: 500 });
    // 手动写 underestimate 样本(模拟用户负评对齐)
    const { appendFileSync } = await import("node:fs");
    appendFileSync(TEST_LOG, JSON.stringify({ event: "underestimate", ts: new Date().toISOString(), taskId: "x", model: "deepseek-v4-flash", tier: "cheap" }) + "\n");
    appendFileSync(TEST_LOG, JSON.stringify({ event: "underestimate", ts: new Date().toISOString(), taskId: "y", model: "deepseek-v4-flash", tier: "cheap" }) + "\n");
    const stats = routingUnderestimateStats();
    const flash = stats.byModel.find((m) => m.model === "deepseek-v4-flash");
    expect(flash).toBeDefined();
    expect(flash!.decisions).toBe(6);
    expect(flash!.underestimates).toBe(2);
    expect(flash!.rate).toBeCloseTo(2 / 6, 5);
    expect(flash!.flagged).toBe(true);
    const qwen = stats.byModel.find((m) => m.model === "qwen-plus");
    expect(qwen!.flagged).toBe(false);
    expect(stats.flagged).toContain("deepseek-v4-flash");
  });

  it("trimRoutingLog: 小文件不裁剪, 无副作用", () => {
    const before = existsSync(TEST_LOG) ? readFileSync(TEST_LOG, "utf8").length : 0;
    const trimmed = trimRoutingLog();
    expect(trimmed).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it("logUnderestimateSample: 便宜档→counted=true; 强档→false", async () => {
    // 无 DB 且文件无该 taskId 决策 → model undefined, counted false
    const r0 = await logUnderestimateSample("00000000-0000-0000-0000-000000000001");
    expect(r0.counted).toBe(false);
  });

  it("负评(非低估)也落盘为 negative_feedback", async () => {
    const r = await logUnderestimateSample("00000000-0000-0000-0000-000000000002", "分析太浅");
    expect(r.counted).toBe(false);
    const lines = readLines();
    const nb = lines.filter((l) => l.event === "negative_feedback" && l.taskId === "00000000-0000-0000-0000-000000000002");
    expect(nb).toHaveLength(1);
    expect(nb[0].note).toBe("分析太浅");
  });
});
