// reason-steps.test.ts — 52 步权威映射的回归测试
//
// 由来: 前端曾拿静态数组的下标去对 retrieve_steps 的第 N 条, 而后端落库顺序完全不同,
//   界面把"1. 问题分类"显示成了 stage2_pgChunks。修法是把步号定义收敛到 reason-steps.ts,
//   后端落库带 step_no、前端按步号对齐。这里钉住映射本身, 防两边再次漂移。
import { describe, expect, it } from "vitest";
import { REASON_STEPS, STEP_NO_BY_SEARCH_TYPE, STEP_BY_NO, stepNoForSearchType } from "../src/services/reason-steps.js";

describe("52 步定义本身", () => {
  it("正好 52 步, 且步号 1..52 连续无重复", () => {
    expect(REASON_STEPS.length).toBe(52);
    const nos = REASON_STEPS.map((s) => s.no);
    expect(nos).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
  });

  it("步骤名不重复(重名会让前端对齐产生歧义)", () => {
    const names = REASON_STEPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每个落库步的 writeAs 唯一(两个步共用一个 search_type 会串号)", () => {
    const written = REASON_STEPS.filter((s) => s.writeAs).map((s) => s.writeAs!);
    expect(new Set(written).size).toBe(written.length);
  });
});

describe("search_type → step_no 映射", () => {
  it("数据库里出现过的正常链路 search_type 全都能映射", () => {
    // 取自生产库的实际值(2026-09-13 全库 distinct 查询); adaptive_* 与 budget_pruned 属动态模式, 不对齐
    const fromDb = ["outline", "stage2_chunks", "stage2_cognee_coarse", "stage2_cogneeEntities",
      "stage2_contextExtension", "stage2_graphCompletion", "stage2_hybridCompletion",
      "stage2_pgChunks", "stage2_pgEntities", "stage2_pgEntityVectors", "stage2_ragCompletion",
      "stage2_summaries", "stage2_temporal", "stage2_tripletCompletion", "stage35_hyperedge",
      "stage3_distills", "stage3_domain", "stage3_entities", "stage3_graphiti_refine",
      "stage3_hybridEntities", "stage3_papers", "stage3_passages",
      "stage4_evaluate", "stage4_hypothesis", "stage4_rerank"];
    const unmapped = fromDb.filter((t) => stepNoForSearchType(t) === null);
    expect(unmapped).toEqual([]);
  });

  it("派生写法归到主步(不另起一步)", () => {
    expect(stepNoForSearchType("stage2_graphCompletionDecomp")).toBe(8);
    expect(stepNoForSearchType("stage2_graphSummaryCompletion")).toBe(10);
    expect(stepNoForSearchType("stage3_paperInfo")).toBe(25);
  });

  it("adaptive 模式算子也映射到 52 步(同一批执行单元, 两套序列共用一张表)", () => {
    expect(stepNoForSearchType("adaptive_outline")).toBe(4);
    expect(stepNoForSearchType("adaptive_pg_arm")).toBe(17);
    expect(stepNoForSearchType("adaptive_fuse")).toBe(37);
    expect(stepNoForSearchType("adaptive_hypothesis")).toBe(45);
  });

  it("adaptive 算子名与 52 步的 search_type 不冲突(两套序列各归各的)", () => {
    // adaptive_* 一律走 ADAPTIVE_OP_TO_STEP, 不会被当成 stage2_/stage3_ 动态标签
    for (const t of ["adaptive_outline", "adaptive_fuse", "adaptive_evaluate"]) {
      const no = stepNoForSearchType(t);
      expect(no, t).not.toBeNull();
      expect(STEP_BY_NO[no!], t).toBeTruthy();
    }
  });

  it("生产库里出现过的 adaptive_* 全都有映射(漏一个前端就显示灰态)", () => {
    // 取自生产库 distinct 查询(2026-09-13)
    const fromDb = ["adaptive_cognee_lexical", "adaptive_evaluate", "adaptive_fuse",
      "adaptive_hypothesis", "adaptive_outline", "adaptive_pg_arm"];
    expect(fromDb.filter((t) => stepNoForSearchType(t) === null)).toEqual([]);
  });

  it("预算裁剪埋点不对齐到 52 步(它是账本记录, 不是链路上的一步)", () => {
    expect(stepNoForSearchType("budget_pruned")).toBeNull();
  });

  it("落库步映射到自己的步号", () => {
    expect(stepNoForSearchType("outline")).toBe(4);
    expect(stepNoForSearchType("stage2_cognee_coarse")).toBe(6);
    expect(stepNoForSearchType("stage4_hypothesis")).toBe(45);
  });

  it("未登记的 search_type 不硬塞步号(返回 null 让前端显示灰态)", () => {
    expect(stepNoForSearchType("something_unknown")).toBeNull();
  });
});

describe("反向查找(前端按步号取名)", () => {
  it("每个落库步都能按步号取回定义", () => {
    for (const s of REASON_STEPS) {
      expect(STEP_BY_NO[s.no]?.name, `no=${s.no}`).toBe(s.name);
    }
  });

  it("条件步带 trigger 文案(前端据此显示'未触发'原因)", () => {
    expect(STEP_BY_NO[13].trigger).toContain("时序");
    expect(STEP_BY_NO[28].trigger).toContain("超边");
    expect(STEP_BY_NO[51].trigger).toContain("超时");
  });

  it("内部计算步没有 writeAs(它们真跑但不落库)", () => {
    for (const no of [1, 2, 3, 37, 38, 52]) {
      expect(STEP_BY_NO[no].writeAs, `no=${no}`).toBeUndefined();
    }
  });

  it("SEARCH_TYPE→步号 索引与定义一致", () => {
    for (const [type, no] of Object.entries(STEP_NO_BY_SEARCH_TYPE)) {
      expect(STEP_BY_NO[no].writeAs, type).toBe(type);
    }
  });
});
