// learning-plan.test.ts — 学习计划链纯逻辑(V386, 借鉴 TraitTutor: 只重规划未开始尾部)
import { describe, it, expect } from "vitest";
import { computePreservedPrefix, type PlanComponent } from "../src/services/learning-plan-service.js";

const comp = (id: string, status: PlanComponent["status"]): PlanComponent => ({
  id, title: id, type: "concept", concept_refs: [], evidence_refs: [], status, reason: "",
});

describe("computePreservedPrefix(只重规划未开始尾部)", () => {
  it("全 pending → 不保留任何前缀(首次/从未开始)", () => {
    const prefix = computePreservedPrefix([comp("a", "pending"), comp("b", "pending"), comp("c", "pending")]);
    expect(prefix).toEqual([]);
  });
  it("completed+started 前缀保留, pending 尾部不保留", () => {
    const prefix = computePreservedPrefix([comp("a", "completed"), comp("b", "started"), comp("c", "pending"), comp("d", "pending")]);
    expect(prefix.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("中间有 skipped 也保留(非 pending 即已开始)", () => {
    const prefix = computePreservedPrefix([comp("a", "completed"), comp("b", "skipped"), comp("c", "pending")]);
    expect(prefix.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("全部完成 → 全部保留(计划不再重建尾部)", () => {
    const prefix = computePreservedPrefix([comp("a", "completed"), comp("b", "completed")]);
    expect(prefix.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("空数组安全", () => {
    expect(computePreservedPrefix([])).toEqual([]);
  });
});
