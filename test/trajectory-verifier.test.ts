// trajectory-verifier.test.ts — 三层轨迹验证单测（P1-6）
import { describe, it, expect } from "vitest";
import { verifyResult, verifyProcess, verifyTrace } from "../src/services/trajectory-verifier.js";

describe("verifyResult（结果层）", () => {
  it("论文命中 + 实体覆盖 → passed", () => {
    const q = { paper_title: "资本论研究_张三", gold_entities: ["资本论", "剩余价值"] };
    const trace = { fusedContext: "资本论研究 张三 论文内容 剩余价值 讨论" };
    const r = verifyResult(q, trace);
    expect(r.paperHit).toBe(true);
    expect(r.goldEntityCoverage).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("论文未命中 → failed", () => {
    const q = { paper_title: "资本论研究_张三", gold_entities: ["资本论"] };
    const trace = { fusedContext: "完全无关的另一篇论文内容" };
    const r = verifyResult(q, trace);
    expect(r.paperHit).toBe(false);
    expect(r.passed).toBe(false);
  });
});

describe("verifyProcess（过程层）", () => {
  it("降级未标注 → 过程违规", () => {
    const trace = { retrievalStrategy: "hyde", hypothesis: { content: "答案是X" } };
    const r = verifyProcess(trace);
    expect(r.degradedUnmarked).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("绕过检索直接答 → 过程违规", () => {
    const trace = {
      hypothesis: { content: "这是一个非常详细的完整回答内容，包含了超过五十个字符阈值的详细论述内容，直接作答完全没有经过任何检索过程，属于典型的绕过检索直接作答行为" },
      _debugCoarse: { chunks: [], pgChunks: [] },
    };
    const r = verifyProcess(trace);
    expect(r.skippedRetrieval).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("正常过程 → 合规", () => {
    const trace = {
      retrievalStrategy: "standard",
      hypothesis: { content: "基于检索的答案" },
      _debugCoarse: { chunks: [{ hasText: true }], pgChunks: [] },
    };
    const r = verifyProcess(trace);
    expect(r.passed).toBe(true);
  });
});

describe("verifyTrace（三层汇总）", () => {
  it("Q44 式内部自洽但张冠李戴 → 质量层可能满分, 过程/结果层抓出", () => {
    // 答案自洽但 fusedContext 无目标论文（张冠李戴场景）
    const q = { paper_title: "目标论文_李四", gold_entities: ["目标实体"] };
    const trace = {
      hypothesis: { content: "根据论文，答案是详细的完整回答" },
      fusedContext: "另一篇论文的内容",
      retrievalStrategy: "standard",
      _debugCoarse: { chunks: [{ hasText: true }], pgChunks: [] },
    };
    const v = verifyTrace(q, trace);
    expect(v.result.passed).toBe(false);  // 结果层抓出（论文未命中）
    expect(v.process.passed).toBe(true);  // 过程层合规（有检索有标注）
  });
});
