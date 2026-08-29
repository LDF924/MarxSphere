// learning-evidence.test.ts — BKT 公式 + 评分器 + 强证据闸门(V386, 借鉴 TraitTutor)
import { describe, it, expect } from "vitest";
import { bktUpdate, gradeAnswer, similarity, isStrongEvidence, MIN_OBSERVATIONS_FOR_PROBABILITY, SUPPORTED_THRESHOLD } from "../src/services/learning-evidence-service.js";

describe("BKT 更新公式(TraitTutor bkt_math 移植)", () => {
  it("答对提升后验", () => {
    const p = bktUpdate(0.2, true, 0.12, 0.2, 0.1);
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThanOrEqual(1);
  });
  it("答错降低后验", () => {
    const p = bktUpdate(0.5, false, 0.12, 0.2, 0.1);
    expect(p).toBeLessThan(0.5);
  });
  it("结果钳制在 [0,1]", () => {
    for (let i = 0; i < 50; i++) {
      const p = bktUpdate(0.5, i % 2 === 0, 0.12, 0.2, 0.1);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
  it("连续答对收敛向 1, 未校准先验 0.2 起点", () => {
    let p = 0.2;
    for (let i = 0; i < 10; i++) p = bktUpdate(p, true, 0.12, 0.2, 0.1);
    expect(p).toBeGreaterThan(0.95);
  });
  it("答错后验大幅低于先验(贝叶斯: 预测掌握却答错 → 掌握概率暴跌)", () => {
    const p = bktUpdate(0.2, false, 0.12, 0.2, 0.1);
    expect(p).toBeLessThan(0.2);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe("服务端评分器(TraitTutor grading.py)", () => {
  it("选择题精确匹配", () => {
    expect(gradeAnswer({ userAnswer: "B", expectedAnswer: "b", questionType: "choice" }).correct).toBe(true);
    expect(gradeAnswer({ userAnswer: "A", expectedAnswer: "B", questionType: "choice" }).correct).toBe(false);
  });
  it("判断题真值表", () => {
    expect(gradeAnswer({ userAnswer: "对", expectedAnswer: "对", questionType: "tf" }).correct).toBe(true);
    expect(gradeAnswer({ userAnswer: "错误", expectedAnswer: "对", questionType: "tf" }).correct).toBe(false);
  });
  it("短答案相似度 >= 0.85", () => {
    expect(gradeAnswer({ userAnswer: "剩余价值是工人创造的", expectedAnswer: "剩余价值是工人创造的", questionType: "short" }).correct).toBe(true);
    // 近义同序文本应判对
    const g = gradeAnswer({ userAnswer: "资本下乡是农业农村现代化的重要路径", expectedAnswer: "资本下乡是农业农村现代化的重要路径之一", questionType: "short" });
    expect(g.correct).toBe(true);
    // 明显不同判错
    expect(gradeAnswer({ userAnswer: "农民收入增加", expectedAnswer: "资本下乡促进农业现代化", questionType: "short" }).correct).toBe(false);
  });
  it("短答案超 30 字保守判错(fail-closed)", () => {
    const g = gradeAnswer({ userAnswer: "这句话非常长完全超出了三十个字符的限制所以直接判错处理更安全一些", expectedAnswer: "标准答案", questionType: "short" });
    expect(g.correct).toBe(false);
  });
  it("开放题关键词命中 >= 60%", () => {
    const g = gradeAnswer({ userAnswer: "资本下乡促进了农业农村现代化", expectedAnswer: "资本下乡 促进 农业 农村 现代化", questionType: "open" });
    expect(g.correct).toBe(true);
  });
  it("空预期答案必错(fail-closed)", () => {
    expect(gradeAnswer({ userAnswer: "任何内容", expectedAnswer: "", questionType: "short" }).correct).toBe(false);
  });
  it("空作答必错", () => {
    expect(gradeAnswer({ userAnswer: "", expectedAnswer: "标准答案", questionType: "short" }).correct).toBe(false);
  });
});

describe("强证据闸门(TraitTutor is_strong_evidence)", () => {
  it("服务端判分+可靠归属+答案非空 → true", () => {
    expect(isStrongEvidence({ evidence_strength: "strong", attribution_status: "reliable", is_correct: true })).toBe(true);
  });
  it("曝光/自我报告永不进 BKT", () => {
    expect(isStrongEvidence({ evidence_strength: "exposure", attribution_status: "reliable", is_correct: true })).toBe(false);
    expect(isStrongEvidence({ evidence_strength: "none", attribution_status: "reliable", is_correct: true })).toBe(false);
  });
  it("未评分(is_correct=null)永不进 BKT", () => {
    expect(isStrongEvidence({ evidence_strength: "strong", attribution_status: "reliable", is_correct: null })).toBe(false);
  });
  it("归属不可靠不进 BKT", () => {
    expect(isStrongEvidence({ evidence_strength: "strong", attribution_status: "pending", is_correct: true })).toBe(false);
  });
});

describe("相似度与常量", () => {
  it("相似度 1 当相同", () => expect(similarity("abc", "abc")).toBe(1));
  it("相似度 0 当完全不同", () => expect(similarity("abc", "xyz")).toBeLessThan(0.5));
  it("观察门槛 3 / 掌握阈值 0.75(TraitTutor 对齐)", () => {
    expect(MIN_OBSERVATIONS_FOR_PROBABILITY).toBe(3);
    expect(SUPPORTED_THRESHOLD).toBe(0.75);
  });
});
