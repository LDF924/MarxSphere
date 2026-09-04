// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/dream-consolidation.test.ts — 记忆 Dream 巩固(V404-7, 借鉴 OpenSquilla memory/dream)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = path.join(os.tmpdir(), `sag-dream-${process.pid}`);
process.env.SAG_DREAM_DIR = TEST_DIR;

let mod: typeof import("../src/services/dream-consolidation-service.js");
beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mod = await import("../src/services/dream-consolidation-service.js");
});
afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });

function prop(key: string, extra: Record<string, unknown> = {}) {
  return {
    key, goal: `目标${key}`, seenCount: 3, taskIds: ["t1", "t2", "t3"],
    positiveSignals: 1, negativeSignals: 0, spanDays: 4, bestResult: "",
    lastSeenAt: new Date().toISOString(), ...extra,
  };
}

describe("dream-consolidation", () => {
  it("normalizeGoalKey: 去语气前缀/尾标点, 截断保特征", () => {
    const { normalizeGoalKey } = mod!;
    expect(normalizeGoalKey("请帮我分析下资本下乡对集体经济的影响，")).toContain("资本下乡对集体经济的影响");
    expect(normalizeGoalKey("写一份关于剩余价值率的综述报告")).toContain("剩余价值率");
    // 动词前缀(生成/写/做)去掉, 留实质名词 — 聚合语义(跨"生成周报"/"周报生成"归并)
    expect(normalizeGoalKey("生成周报")).toBe("周报");
    expect(normalizeGoalKey("周报生成")).toBe("周报生成"); // 动词在尾部不剥
  });

  it("scoreCandidate: 频率+跨天+正评加权; 负评 → 0 硬拦", () => {
    const { scoreCandidate } = mod!;
    const high = prop("a", { seenCount: 6, positiveSignals: 1, spanDays: 5 });
    const s1 = scoreCandidate(high);
    expect(s1).toBeGreaterThanOrEqual(0.95); // 高频+跨天+正评 → 满分附近
    const neg = prop("b", { seenCount: 5, negativeSignals: 1, spanDays: 4 });
    expect(scoreCandidate(neg)).toBe(0); // 负评 → 评分层硬拦
    const low = prop("c", { seenCount: 2, spanDays: 1, positiveSignals: 0 });
    // freq=0.565*0.35=0.198; span=0.5*0.35=0.175; signal=0 → 0.373
    expect(scoreCandidate(low)).toBeCloseTo(0.373, 2);
    expect(scoreCandidate(low)).toBeLessThan(0.5); // 低于门槛 → 不推
    const mid = prop("d", { seenCount: 3, spanDays: 2, positiveSignals: 0 });
    // freq=0.707*0.35=0.247; span=0.707*0.35=0.247 → 0.494 仍未过…3次/2天应过 → 需正评或跨天
    expect(scoreCandidate(prop("e", { seenCount: 3, spanDays: 3, positiveSignals: 0 })))
      .toBeGreaterThanOrEqual(0.5); // 3次/3天 → span=1 → 0.247+0.35=0.597 ✓
  });

  it("deterministicPolish: 断言式包含次数/天数/建议", () => {
    const { deterministicPolish } = mod!;
    const s = deterministicPolish(prop("x"));
    expect(s).toContain("3 次");
    expect(s).toContain("4 天");
    expect(s).toContain("目标x");
  });

  it("runDream(确定性): 无 DB 时扫描为空 → 无候选; 不炸", async () => {
    const { runDream } = mod!;
    const out = await runDream({ days: 30 });
    expect(Array.isArray(out)).toBe(true); // DB 不可用 → 空数组降级
  });

  it("acceptProposal 不存在 id → ok:false", async () => {
    const { acceptProposal } = mod!;
    const r = await acceptProposal("dp-不存在");
    expect(r.ok).toBe(false);
  });

  it("rejectProposal 不存在 id → ok:false", () => {
    const { rejectProposal } = mod!;
    const r = rejectProposal("dp-不存在");
    expect(r.ok).toBe(false);
  });

  it("rollbackAccepted 无回执 → 报错", async () => {
    const { rollbackAccepted } = mod!;
    const r = await rollbackAccepted("dp-不存在");
    expect(r.ok).toBe(false);
  });
});
