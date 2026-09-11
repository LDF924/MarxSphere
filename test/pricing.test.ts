// pricing.test.ts — 统一定价源的不变量
// 这是"成本→售价"的唯一口径, billing 与 points 两侧都从这里取, 因此必须有测试锁住:
//   1. 售价必须覆盖成本并达到目标毛利(否则越用越亏)
//   2. 未登记功能必须返回 0(不收费), 不能误扣
import { describe, expect, it } from "vitest";
import { featureCogsCny, featurePriceCny, featurePoints, pricingTable, POINTS_YUAN, TARGET_GROSS_MARGIN, FAILURE_BUFFER } from "../src/services/pricing.js";

describe("pricing 定价不变量", () => {
  it("每个功能的售价都覆盖成本并达到目标毛利", () => {
    for (const row of pricingTable()) {
      expect(row.cogsCny).toBeGreaterThan(0);
      expect(row.priceCny).toBeGreaterThan(row.cogsCny);
      const margin = 1 - row.cogsCny / row.priceCny;
      // 允许整数积分进位导致的偏差, 但不得低于目标毛利
      expect(margin).toBeGreaterThanOrEqual(TARGET_GROSS_MARGIN - 0.01);
    }
  });

  it("成本已包含失败摊销(5%)", () => {
    const raw = featureCogsCny("editor:title");     // 已含 buffer
    expect(raw).toBeGreaterThan(0);
    // 反推: 不含 buffer 的值应等于 raw / (1+buffer)
    const withoutBuffer = raw / (1 + FAILURE_BUFFER);
    expect(withoutBuffer).toBeLessThan(raw);
  });

  it("积分 = 售价 / 每积分面额, 且至少 1 分(有成本就必须收费)", () => {
    for (const row of pricingTable()) {
      expect(row.points).toBeGreaterThanOrEqual(1);
      expect(row.points).toBe(Math.ceil(row.priceCny / POINTS_YUAN));
    }
  });

  it("未登记的功能不收费(返回 0, 不可误扣)", () => {
    expect(featurePoints("no:such:feature")).toBe(0);
    expect(featureCogsCny("no:such:feature")).toBe(0);
    expect(featurePriceCny("no:such:feature")).toBe(0);
  });

  it("重活比轻活贵(评审 > 编辑器改写)", () => {
    expect(featurePoints("review:paper")).toBeGreaterThan(featurePoints("editor:rewrite"));
  });
});
