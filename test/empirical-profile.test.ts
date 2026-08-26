import { describe, expect, it } from "vitest";
import { profileTableData } from "../src/services/empirical-questionnaire-service.js";

// V399-2 P2 补齐(ScienceX 对照 #3): 登记时自动数据画像 — 纯函数测试（不依赖 DB/Python）
// profileTableData: 列类型(numeric/categorical/empty) + 缺失率 + 唯一值率 + 数值 min/max/mean

describe("empirical data profile (V399-2 P2)", () => {
  const columns = ["age", "region", "note"];
  const rows: unknown[][] = [
    [35, "华北", "有备注"],
    ["", "华北", null],
    [42.5, "华南", "x"],
    [28, null, ""],
  ];

  it("numeric column: type + missing rate + min/max/mean", () => {
    const p = profileTableData(columns, rows).age as Record<string, unknown>;
    expect(p.type).toBe("numeric");
    expect(p.missing_rate).toBeCloseTo(0.25);       // 1/4 空
    expect(p.min).toBeCloseTo(28);
    expect(p.max).toBeCloseTo(42.5);
    expect(p.mean).toBeCloseTo(35.1667, 3);         // (35+42.5+28)/3
  });

  it("categorical column: type + unique rate", () => {
    const p = profileTableData(columns, rows).region as Record<string, unknown>;
    expect(p.type).toBe("categorical");
    expect(p.missing_rate).toBeCloseTo(0.25);
    expect(p.unique_rate).toBeCloseTo(2 / 3, 3);    // 华北重复, 华南唯一
  });

  it("empty column → type empty, 100% missing", () => {
    const p = profileTableData(columns, rows).note as Record<string, unknown>;
    // note 列: 2 有效("有备注","x")+2 空(null,"") → 缺失率 0.5
    expect(p.type).toBe("categorical");
    expect(p.missing_rate).toBeCloseTo(0.5);
  });

  it("all-empty column → type empty", () => {
    const p = profileTableData(["a"], [[""], [null], [""]]).a as Record<string, unknown>;
    expect(p.type).toBe("empty");
    expect(p.missing_rate).toBe(1);
  });

  it("does not throw on empty rows", () => {
    expect(() => profileTableData(["a", "b"], [])).not.toThrow();
  });
});
