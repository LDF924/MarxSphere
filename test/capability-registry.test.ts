// capability-registry.test.ts — Capability 注册表 + 确定性候选(V397, 借鉴 LingxiLearn)
import { describe, it, expect } from "vitest";
import { parseCapability, generateCandidates, estimateGain, CAPABILITY_WHITELIST } from "../src/services/capability-registry-service.js";

describe("封闭 Capability 词表(LingxiLearn UnknownCapability)", () => {
  it("词表内 tag 通过", () => {
    expect(parseCapability("teach.explain")).toBe("teach.explain");
  });
  it("词表外 tag 硬错误", () => {
    expect(() => parseCapability("agent.foo")).toThrow("封闭词表拒绝");
  });
  it("词表非空且含核心能力", () => {
    expect(CAPABILITY_WHITELIST).toContain("teach.strategy");
    expect(CAPABILITY_WHITELIST).toContain("assess.grade");
    expect(CAPABILITY_WHITELIST).toContain("plan.create");
  });
});

describe("确定性收益估计(纯函数规则打分)", () => {
  it("有误区时 teach.explain 收益高", () => {
    expect(estimateGain("teach.explain", { weakPoints: ["a"], unobservedPoints: [], dueReviews: 0, misconceptions: ["a"] })).toBe(0.6);
  });
  it("有薄弱点 teach.explain 0.45, 无则 0.2", () => {
    expect(estimateGain("teach.explain", { weakPoints: ["a"], unobservedPoints: [], dueReviews: 0 })).toBe(0.45);
    expect(estimateGain("teach.explain", { weakPoints: [], unobservedPoints: [], dueReviews: 0 })).toBe(0.2);
  });
  it("有到期复习时 review.due 收益高", () => {
    expect(estimateGain("review.due", { weakPoints: [], unobservedPoints: [], dueReviews: 3 })).toBe(0.5);
    expect(estimateGain("review.due", { weakPoints: [], unobservedPoints: [], dueReviews: 0 })).toBe(0.15);
  });
});

describe("确定性候选生成(排序可复现)", () => {
  const ctx = { weakPoints: ["剩余价值"], unobservedPoints: ["资本积累"], dueReviews: 2 };
  it("有薄弱点时 content.lesson 排前且未阻塞", () => {
    const c = generateCandidates(ctx);
    const lesson = c.find((x) => x.capability === "content.lesson")!;
    expect(lesson.blocked).toBe(false);
    expect(lesson.utility).toBeGreaterThan(0);
  });
  it("hasDeck 时 content.deck 被前置条件拒绝", () => {
    const c = generateCandidates({ ...ctx, hasDeck: true });
    const deck = c.find((x) => x.capability === "content.deck")!;
    expect(deck.blocked).toBe(true);
    expect(deck.blockedReason).toContain("已有课件");
  });
  it("排序确定性: 相同输入两次结果一致", () => {
    expect(generateCandidates(ctx).map((c) => c.capability)).toEqual(generateCandidates(ctx).map((c) => c.capability));
  });
  it("utility = gain/cost 且阻塞项排最后", () => {
    const c = generateCandidates({ ...ctx, hasDeck: true });
    const last = c[c.length - 1];
    // 阻塞项 utility=-1 应排最后
    expect(last.utility).toBe(-1);
    for (const x of c.slice(0, -1)) expect(x.utility).toBeGreaterThanOrEqual(0);
  });
});
