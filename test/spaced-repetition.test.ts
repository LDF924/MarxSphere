// spaced-repetition.test.ts — 间隔重复调度(V391, 借鉴 TraitTutor learning/scheduler.py)
import { describe, it, expect } from "vitest";
import { advanceReviewState, INTERVAL_SEQUENCES } from "../src/services/spaced-repetition-service.js";

describe("间隔序列(TraitTutor scheduler.INTERVAL_SEQUENCES)", () => {
  it("MEMORY 序列 [0,1,3,7,14,30,60]", () => {
    expect(INTERVAL_SEQUENCES.memory).toEqual([0, 1, 3, 7, 14, 30, 60]);
  });
  it("CONCEPT 序列 [3,7,14,30]", () => {
    expect(INTERVAL_SEQUENCES.concept).toEqual([3, 7, 14, 30]);
  });
  it("DESIGN 序列 [7,14,30,60]", () => {
    expect(INTERVAL_SEQUENCES.design).toEqual([7, 14, 30, 60]);
  });
});

describe("advanceReviewState(档位推进)", () => {
  it("首次答对 → 0 档(间隔 3 天, concept)", () => {
    const r = advanceReviewState({ correct: true, intervalIdx: 0, consecutiveCorrect: 0, consecutiveWrong: 0, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(0);
    expect(r.dueInDays).toBe(3);
    expect(r.consecutiveCorrect).toBe(1);
  });
  it("连中 2 次跳 2 档", () => {
    const r = advanceReviewState({ correct: true, intervalIdx: 0, consecutiveCorrect: 1, consecutiveWrong: 0, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(2);
    expect(r.dueInDays).toBe(14);  // CONCEPT[3,7,14,30][2] = 14
    expect(r.consecutiveCorrect).toBe(0);  // 跳档后重置计数
  });
  it("答错退 1 档", () => {
    const r = advanceReviewState({ correct: false, intervalIdx: 2, consecutiveCorrect: 0, consecutiveWrong: 0, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(1);
    expect(r.dueInDays).toBe(7);
    expect(r.needsRepair).toBe(true);
  });
  it("连错 2 次重置到起点", () => {
    const r = advanceReviewState({ correct: false, intervalIdx: 3, consecutiveCorrect: 0, consecutiveWrong: 1, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(0);
    expect(r.dueInDays).toBe(3);
    expect(r.consecutiveWrong).toBe(0);
  });
  it("0 档答错不越界(不降到负)", () => {
    const r = advanceReviewState({ correct: false, intervalIdx: 0, consecutiveCorrect: 0, consecutiveWrong: 0, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(0);
  });
  it("memory 类型使用 MEMORY 序列", () => {
    const r = advanceReviewState({ correct: true, intervalIdx: 1, consecutiveCorrect: 1, consecutiveWrong: 0, knowledgeType: "memory" });
    expect(r.intervalIdx).toBe(3);  // [0,1,3,7,...][1+2]=7? 不对: 跳2档=3 → 7天
    expect(r.dueInDays).toBe(7);
  });
  it("档位越界钳制到序列末尾", () => {
    const r = advanceReviewState({ correct: true, intervalIdx: 5, consecutiveCorrect: 1, consecutiveWrong: 0, knowledgeType: "concept" });
    expect(r.intervalIdx).toBe(3);  // CONCEPT 末尾
    expect(r.dueInDays).toBe(30);
  });
});
