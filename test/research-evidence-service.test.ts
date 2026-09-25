// research-evidence-service.test.ts — 「研究 → 写作」这条线的不变量
//
// 由来(2026-09-25): 这一批补的是写作舱最根本的一条断线 —— 正文里没有任何研究证据。
// 其中三处**必须被单测钉住**, 因为它们的错误方式都是"静默"的:
//
//   ① `roundTierMatch` 的精度下界。写这个函数时我第一版从 d=0 起, 于是
//      round(0.312,0)=0 与 round(0.35,0)=0 相等 → 0.35 被判"对上了 0.312"。
//      这是把错的判成对的 —— 而整条数字核验的价值全在"抓错"上, 假阳性比漏报危险。
//   ② `extractFindings` 不能把截距当发现, 也不能在表头对不上时瞎抽。
//      它抽出来的数字会被写进论文, 抽错一个整篇可信度就没了。
//   ③ `autoHarvestForFile` 的归属: 一个数据文件可能被多个课题用, 但**没有数据文件的
//      分析不该凭空归到任何课题**; 同一个分析重复采集必须幂等。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: vi.fn(),
    // 事务路径(写依据/假设台账)走 pool.connect() —— 缺了这个 mock, 那些用例会以
    // "pool.connect is not a function" 失败, 而那看起来像业务错误、其实是测试没搭好
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({ getRoleModel: () => "m" }));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({}), fetchLlm: async () => ({ text: "{}" }), parseLlmJson: () => null,
}));

import { pool } from "../src/db/pool.js";
import {
  extractFindings, starsOf, buildFindingSkeleton, renderTableData,
  verifyChapterNumbers, listEvidence, replaceSectionEvidence, saveHypotheses,
} from "../src/services/research-evidence-service.js";

const OLS = {
  tables: [
    {
      title: "OLS 回归结果",
      columns: ["变量", "系数", "标准误", "t 值", "p 值", "95% CI"],
      rows: [
        ["const", 2.5, 0.3, 8.3, 0, "[1.9, 3.1]"],
        ["edu", 0.312, 0.101, 3.09, 0.0021, "[0.11, 0.51]"],
        ["age", -0.05, 0.02, -2.5, 0.013, "[-0.09, -0.01]"],
        ["gender", 0.08, 0.06, 1.33, 0.184, "[-0.04, 0.20]"],
      ],
    },
    { title: "模型拟合", columns: ["R²", "调整 R²", "F 值", "F p 值", "N"], rows: [[0.4271, 0.4188, 51.2, 0, 482]] },
  ],
};

describe("extractFindings", () => {
  it("抽系数表, 排除截距", () => {
    const { findings } = extractFindings("ols", OLS);
    expect(findings.map((f) => f.varName)).toEqual(["edu", "age", "gender"]);
    // const 是截距不是实质发现 —— 放进台账只会稀释它
    expect(findings.some((f) => f.varName === "const")).toBe(false);
  });

  it("系数/标准误/CI/N/R² 逐列取对, 星号按 p 分档", () => {
    const { findings } = extractFindings("ols", OLS);
    const edu = findings.find((f) => f.varName === "edu")!;
    expect(edu.coef).toBe(0.312);
    expect(edu.stdErr).toBe(0.101);
    expect(edu.tValue).toBe(3.09);
    expect(edu.pValue).toBe(0.0021);
    expect(edu.ciLow).toBe(0.11);
    expect(edu.ciHigh).toBe(0.51);
    expect(edu.stars).toBe("***");
    // 拟合表的 N / R² 要带到每一条上 —— 否则正文写样本量时无从引用
    expect(edu.nObs).toBe(482);
    expect(edu.rSquared).toBe(0.4271);
    expect(findings.find((f) => f.varName === "age")!.stars).toBe("**");     // p=0.013
    expect(findings.find((f) => f.varName === "gender")!.stars).toBe("");    // p=0.184
  });

  it("没有系数表的分析不瞎抽(相关矩阵/描述统计)", () => {
    const r = extractFindings("correlation", {
      tables: [{ title: "相关矩阵(pearson)", columns: ["变量", "a", "b"], rows: [["a", 1, 0.3]] }],
    });
    expect(r.findings).toHaveLength(0);
  });

  it("表头对不上时报出原因而不是静默跳过", () => {
    const r = extractFindings("ols", {
      tables: [{ title: "OLS 回归结果", columns: ["项", "值"], rows: [["edu", 1]] }],
    });
    expect(r.findings).toHaveLength(0);
    expect(r.skipped.join(" ")).toContain("系数");
  });

  it("多因素 ANOVA 的第一列叫「项」也该认", () => {
    const r = extractFindings("multivariate-anova", {
      tables: [{ title: "多因素 ANOVA", columns: ["项", "系数", "标准误", "t 值", "p 值"], rows: [["C(g)[T.2]", 0.4, 0.1, 4, 0.0001]] }],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].varName).toBe("C(g)[T.2]");
  });
});

describe("starsOf", () => {
  it("1% / 5% / 10% / 不显著", () => {
    expect(starsOf(0.009)).toBe("***");
    expect(starsOf(0.049)).toBe("**");
    expect(starsOf(0.099)).toBe("*");
    expect(starsOf(0.1)).toBe("");
    expect(starsOf(undefined)).toBe("");
  });
});

describe("buildFindingSkeleton", () => {
  it("数字原样写进句子, 不四舍五入", () => {
    const s = buildFindingSkeleton([{ varName: "edu", coef: 0.312, stars: "***", pValue: 0.0021, nObs: 482, rSquared: 0.4271, tool: "ols" }]);
    expect(s).toContain("0.312");
    expect(s).toContain("1% 水平上显著");
    expect(s).toContain("N=482");
    expect(s).toContain("R²=0.4271");
  });

  it("系数为负写「负向」", () => {
    const s = buildFindingSkeleton([{ varName: "age", coef: -0.05, stars: "**", pValue: 0.013, tool: "ols" }]);
    expect(s).toContain("负向");
  });

  it("不显著时不给方向 —— 没有统计意义时方向不可解读", () => {
    const s = buildFindingSkeleton([{ varName: "gender", coef: 0.08, stars: "", pValue: 0.184, tool: "ols" }]);
    expect(s).not.toContain("正向关联");
    expect(s).toContain("未通过显著性检验");
  });
});

describe("renderTableData", () => {
  it("{columns,rows} 形状渲染成 markdown 表", () => {
    const s = renderTableData({ columns: ["变量", "系数"], rows: [["edu", 0.312]] });
    expect(s).toContain("| 变量 | 系数 |");
    expect(s).toContain("| edu | 0.312 |");
  });
  it("二维数组形状也认", () => {
    expect(renderTableData([["变量", "系数"], ["edu", 0.312]])).toContain("| edu | 0.312 |");
  });
  it("空值不炸也不产出半截表", () => {
    expect(renderTableData(null)).toBe("");
    expect(renderTableData({})).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// 数字核验 —— 精度下界那一条是本文件最重要的断言
// ═══════════════════════════════════════════════════════════════
describe("verifyChapterNumbers", () => {
  const UID = "u1";
  const PID = "p1";
  const SID = "s1";

  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  /** 造一个"依据里只有一个系数 0.312(来自素材表格)"的环境 */
  function mockBasis() {
    vi.mocked(pool.query).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("from research_projects")) return { rows: [{ "?column?": 1 }] } as never;      // assertOwned
      if (s.includes("from research_chapter_evidence")) {
        return { rows: [{ id: "e1", section_id: SID, kind: "material", ref_id: "m1", note: "", sort_order: 0 }] } as never;
      }
      if (s.includes("from research_materials")) {
        return { rows: [{ id: "m1", title: "T", content_md: "", table_data: { columns: ["变量", "系数"], rows: [["edu", 0.312]] } }] } as never;
      }
      return { rows: [] } as never;
    });
  }

  it("0.31 / 0.3 / 0.312 都算对上 0.312(四舍五入是表述选择, 不是错误)", async () => {
    mockBasis();
    for (const written of ["0.31", "0.3", "0.312", "0.3120"]) {
      const r = await verifyChapterNumbers(UID, PID, SID, `系数为 ${written}。`);
      expect(r!.checks[0].status, `写 ${written} 应命中`).toBe("matched");
    }
  });

  it("⚠ 0.35 不得被判成「对上了 0.312」—— 整数精度会把两者都塌成 0", async () => {
    mockBasis();
    const r = await verifyChapterNumbers(UID, PID, SID, "系数为 0.35。");
    expect(r!.checks[0].status).toBe("unmatched");
  });

  it("依据里没有的数字判未命中, 近了给提示、远了不给", async () => {
    mockBasis();
    const near = await verifyChapterNumbers(UID, PID, SID, "系数为 0.34。");
    expect(near!.checks[0].status).toBe("unmatched");
    expect(near!.checks[0].suggestion).toBeTruthy();      // 与 0.312 差 9%, 值得提示

    const far = await verifyChapterNumbers(UID, PID, SID, "系数为 0.87。");
    expect(far!.checks[0].suggestion).toBeUndefined();    // 差 64%, 提示只会误导
  });

  it("年份不当统计量核验", async () => {
    mockBasis();
    const r = await verifyChapterNumbers(UID, PID, SID, "2023 年的样本显示系数为 0.31。");
    expect(r!.checks.some((c) => c.raw === "2023")).toBe(false);
    expect(r!.checks.some((c) => c.raw === "0.31")).toBe(true);
  });

  it("正文字里没有数字时不产出伪条目", async () => {
    mockBasis();
    const r = await verifyChapterNumbers(UID, PID, SID, "教育显著提高了收入水平。");
    expect(r!.checks).toHaveLength(0);
  });
});

/**
 * 标了出处的数字不该拿本课题的数据去核 —— 那是**假报错**。
 *
 * 这一组的关键不是"跳得多", 而是**跳得准**: 跳过 = 可能漏掉一个错。
 * 所以每一条"跳"的用例都配一条"不该跳"的反例。
 */
describe("数字核验: 跳过标了出处的数字", () => {
  const UID = "u1", PID = "p1", SID = "s1";
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  function mockBasis() {
    vi.mocked(pool.query).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("from research_projects")) return { rows: [{ x: 1 }] } as never;
      if (s.includes("from research_chapter_evidence")) {
        return { rows: [{ id: "e1", section_id: SID, kind: "material", ref_id: "m1", note: "", sort_order: 0 }] } as never;
      }
      if (s.includes("from research_materials")) {
        return { rows: [{ id: "m1", title: "T", content_md: "", table_data: { columns: ["a"], rows: [["x"]] } }] } as never;
      }
      return { rows: [] } as never;
    });
  }
  /** 取某段文本里被判"需要核验"的那些数 */
  async function checked(text: string) { mockBasis(); return (await verifyChapterNumbers(UID, PID, SID, text))!; }

  it("顺序编码制引用 [12] 里的数字被跳过", async () => {
    const r = await checked("已有研究表明该效应为 0.45[12]，本文的估计为 0.31。");
    expect(r.skipped.map((s) => s.raw)).toEqual(["12"]);
    expect(r.skippedByReason.citation).toBe(1);
    // 0.45 是别人研究里的数 —— 它仍然要**被核验**(它不是引用标注, 只是缺出处)
    expect(r.checks.map((c) => c.raw)).toContain("0.45");
  });

  it("本系统的 §REF_a_b§ 占位符里的数字被跳过", async () => {
    const r = await checked("李海波提出的测度框架§REF_23_1§支持这一判断。");
    // 占位符里有**两个**数字(池位置 23 / 条内序号 1), 两个都在标注内 → 都跳
    expect(r.skippedByReason.citation).toBe(2);
    expect(r.checks).toHaveLength(0);
  });

  it("作者年份制（张三，2020）里的年份被跳过", async () => {
    const r = await checked("这一结论已被反复验证（张三等，2020）。");
    expect(r.skippedByReason.citation).toBe(1);
  });

  it("⚠ 纯 (2020) 不跳 —— 它同样可能是数据", async () => {
    const r = await checked("样本区间为 2010 至 2020 年。");
    // 两个年份都该按 year 跳过(不是 citation), 但**都不是**被当成引用括注吞掉的
    expect(r.skippedByReason.citation).toBe(0);
    expect(r.skippedByReason.year).toBe(2);
  });

  it("图表/公式编号被跳过, 但旁边的真系数不被跳过", async () => {
    const r = await checked("表 3 报告了结果，系数为 0.31。");
    expect(r.skipped.some((s) => s.raw === "3" && s.reason === "reference")).toBe(true);
    expect(r.checks.some((c) => c.raw === "0.31")).toBe(true);
  });

  it("显著性阈值 p<0.01 被跳过(它是惯例写法, 不是算出来的)", async () => {
    const r = await checked("系数为 0.31，在 1% 水平上显著（p<0.01）。");
    expect(r.skipped.some((s) => s.raw === "0.01" && s.reason === "threshold")).toBe(true);
  });

  it("⚠ `β<0.1` 里的 0.1 不该被当阈值吞掉 —— 判据只认前面紧邻的 p", async () => {
    const r = await checked("估计得到 β<0.1。");
    expect(r.skippedByReason.threshold).toBe(0);
    expect(r.checks.some((c) => c.raw === "0.1")).toBe(true);
  });

  it("⚠ 方括号里有汉字的不算引用（[表1]、[注:…]）", async () => {
    const r = await checked("结果见 [表1]，其中 0.31 为关注系数。");
    // 方括号里是"表1" → 不是顺序编码引用; 里面的 1 会按 reference 跳过(因为前面是"表")
    expect(r.skippedByReason.citation).toBe(0);
    expect(r.checks.some((c) => c.raw === "0.31")).toBe(true);
  });

  it("多引用与区间写法 [12,13] / [12-14] 整段跳过", async () => {
    const r1 = await checked("见 [12,13]。");
    expect(r1.skipped.filter((s) => s.reason === "citation")).toHaveLength(2);
    const r2 = await checked("见 [12-14]。");
    expect(r2.skipped.filter((s) => s.reason === "citation")).toHaveLength(2);
  });

  it("跳过的一定归类, 且计数与列表一致", async () => {
    const r = await checked("表 2 给出结果（张三，2019），p<0.05，系数 0.31[7]。");
    const sum = Object.values(r.skippedByReason).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.skipped.length);
    expect(r.skipped.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 归属与鉴权 —— 这几条都是"静默出错"型
// ═══════════════════════════════════════════════════════════════
describe("归属校验", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("非本人项目一律拒绝(读与写)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    expect(await listEvidence("u2", "p1")).toBeNull();
    expect((await replaceSectionEvidence("u2", "p1", "s1", [])).ok).toBe(false);
    expect((await saveHypotheses("u2", "p1", [])).ok).toBe(false);
  });

  it("写依据时非法的 kind / 空 refId 被过滤掉", async () => {
    vi.mocked(pool.query).mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("from research_projects")) return { rows: [{ x: 1 }] } as never;
      return { rows: [] } as never;
    });
    const r = await replaceSectionEvidence("u1", "p1", "s1", [
      { kind: "material", refId: "ok" },
      { kind: "not-a-kind" as never, refId: "bad" },
      { kind: "material", refId: "   " },
    ]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
  });
});
