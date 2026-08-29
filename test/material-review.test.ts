// material-review.test.ts — 材料分析启发式 + 审查状态机(V387, 借鉴 TraitTutor needs_review)
import { describe, it, expect } from "vitest";
import { heuristicMaterialAnalysis } from "../src/services/material-review-service.js";

describe("确定性材料分析启发式(TraitTutor infer_material_affordances)", () => {
  it("中文材料识别为 zh + 马理论学科", () => {
    const a = heuristicMaterialAnalysis("马克思在《资本论》中分析了剩余价值的产生过程。辩证法揭示了矛盾运动的规律。", "剩余价值理论");
    expect(a.language).toBe("zh");
    expect(a.subject).toBe("马克思主义理论");
  });
  it("难度: 术语密度高 → advanced", () => {
    const a = heuristicMaterialAnalysis("该定理的证明需要推导公式, 模型假设包含悖论, 推论涉及多个原理。", "高等数学");
    expect(a.difficulty).toBe("advanced");
  });
  it("难度: 无术语 → basic", () => {
    const a = heuristicMaterialAnalysis("这是一段简单的介绍性文字, 讲述了基本概念。", "入门介绍");
    expect(a.difficulty).toBe("basic");
  });
  it("模态适配: 含图/例/练习信号", () => {
    const a = heuristicMaterialAnalysis("请看图1的示意图, 结合示例讲解, 最后完成练习。", "图表教程");
    expect(a.affordances.visual.suitable).toBe(true);
    expect(a.affordances.worked_example.suitable).toBe(true);
    expect(a.affordances.practice.suitable).toBe(true);
  });
  it("概念候选: bigram 词频提取", () => {
    const a = heuristicMaterialAnalysis("商品的价值由社会必要劳动时间决定。商品是使用价值与价值的统一体。商品交换以价值为基础。", "商品理论");
    expect(a.conceptCandidates.length).toBeGreaterThanOrEqual(1);
    // 价值出现4次 > 商品3次, bigram 频次正确排序
    expect(a.conceptCandidates[0]).toBe("价值");
    expect(a.conceptCandidates).toContain("商品");
  });
  it("英文材料识别为 en", () => {
    const a = heuristicMaterialAnalysis("The supply and demand curve determines market equilibrium price. Economics studies allocation.", "Microeconomics");
    expect(a.language).toBe("en");
    expect(a.subject).toBe("经济学");
  });
});

// 审查状态机逻辑(纯函数部分: 硬性 fail 判定)
describe("审查状态机(needs_review 三态)", () => {
  it("任一维度 < 0.6 → 需人工审查", () => {
    const issues = [{ dimension: "准确性", score: 0.55, note: "概念表述有误" }];
    expect(issues.some((i) => i.score < 0.6)).toBe(true);
  });
  it("全部 >= 0.6 → 直接确认", () => {
    const issues = [{ dimension: "准确性", score: 0.9, note: "" }, { dimension: "完整性", score: 0.7, note: "" }];
    expect(issues.some((i) => i.score < 0.6)).toBe(false);
  });
});
