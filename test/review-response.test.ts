/**
 * review-response-service 的纯函数回归。
 *
 * 为什么这几条值得单测:
 *   · **拆条是启发式**(不走 LLM —— 拆条是格式问题不是理解问题, 而 LLM 会**改写原文**,
 *     可原文要原样引用给编辑部)。启发式必然有边界, 而切错的条目在界面上看着完全正常:
 *     把一条意见拦腰切成两条, 用户只会觉得"这意见怎么怪怪的"。
 *   · **buildRevisionInput 必须排除"未采纳"** —— 这是全模块最容易做错的一处:
 *     把用户明确不想改的意见塞进修订 prompt, 模型会照着改, 而用户不会立刻发现
 *     (改出来的稿子看着更"听话"了)。判据写死在函数里而不是调用方, 这条测试锁住它。
 */
import { describe, it, expect } from "vitest";
import { splitReviewComments, buildResponseLetter, buildRevisionInput } from "../src/services/review-response-service.js";

describe("splitReviewComments — 拆条", () => {
  it("数字编号(1. 2. 3.)", () => {
    const r = splitReviewComments("1. 引言部分缺少问题意识。\n2. 方法部分未说明样本来源。\n3. 结论过于笼统。");
    expect(r).toHaveLength(3);
    expect(r[0].comment).toBe("引言部分缺少问题意识。");
    expect(r[2].comment).toBe("结论过于笼统。");
  });

  it("中文编号(一、二、)", () => {
    const r = splitReviewComments("一、选题价值不高。\n二、文献综述流于罗列。");
    expect(r).toHaveLength(2);
    expect(r[1].comment).toBe("文献综述流于罗列。");
  });

  it("圈号(①②③)", () => {
    const r = splitReviewComments("① 概念界定不清。\n② 变量测量存疑。");
    expect(r).toHaveLength(2);
    expect(r[0].comment).toBe("概念界定不清。");
  });

  it("Comment N / 意见 N", () => {
    const r = splitReviewComments("Comment 1: The literature review is thin.\nComment 2: Methods need detail.");
    expect(r).toHaveLength(2);
    expect(r[1].comment).toBe("Methods need detail.");
  });

  it("括号编号 (1) （2）", () => {
    const r = splitReviewComments("(1) 数据来源不明。\n（2）稳健性检验缺失。");
    expect(r).toHaveLength(2);
    expect(r[1].comment).toBe("稳健性检验缺失。");
  });

  it("审稿人分节标题被识别为标签, 不混进意见正文", () => {
    const r = splitReviewComments("审稿人1\n1. 选题有意义。\n2. 但论证不足。\n审稿人2\n1. 方法尚可。");
    expect(r.map((x) => x.reviewerLabel)).toEqual(["审稿人1", "审稿人1", "审稿人2"]);
    expect(r[0].comment).toBe("选题有意义。");
    expect(r[2].comment).toBe("方法尚可。");
  });

  it("⚠ 续行以小数开头(3.5)不得被误切成新条目", () => {
    // 这是实现时真踩到的边界: 初版用 `^\d+\.` 匹配编号, 于是 "3.5 的系数…"
    // 会被当成第三条, 把第 2 条拦腰截断 —— 而界面上两条看着都正常。
    const r = splitReviewComments("1. 请核对回归结果。\n2. 表 2 中 x 的系数与正文不一致。\n3.5 的系数在正文写作 0.42, 表里是 0.35。");
    expect(r).toHaveLength(2);
    expect(r[1].comment).toContain("3.5 的系数");
  });

  it("点后无空格但接中文(1.引言) 仍算编号", () => {
    const r = splitReviewComments("1.引言部分需要重写。\n2.方法部分尚可。");
    expect(r).toHaveLength(2);
    expect(r[0].comment).toBe("引言部分需要重写。");
  });

  it("多行条目: 编号行的后续普通行归入同一条", () => {
    const r = splitReviewComments("1. 第一段。\n第二行仍属第一条。\n2. 第二条。");
    expect(r).toHaveLength(2);
    expect(r[0].comment).toBe("第一段。\n第二行仍属第一条。");
  });

  it("完全没有编号 → 整段当作一条(不拦腰截断)", () => {
    const r = splitReviewComments("感谢审稿人的细致意见, 本文在文献综述与研究设计两方面均存在不足, 需要大改。");
    expect(r).toHaveLength(1);
    expect(r[0].comment).toContain("需要大改");
  });

  it("空输入 → 空数组(不是一条空意见)", () => {
    expect(splitReviewComments("")).toEqual([]);
    expect(splitReviewComments("   \n  \n")).toEqual([]);
  });

  it("编号加粗(**1.**) 与全角句点都认 —— ⚠ 断言**内容**不只是条数", () => {
    /**
     * 这条一开始只写了 `expect(...).toHaveLength(2)` —— 而当时实现**根本没拆开**第一行,
     *   只是第二行拆了、总数凑够 2, 于是测试**假通过**(`**1.**` 整行留在了意见正文里)。
     *   "判据看不到被测对象"的老毛病: 数量对不对, 不代表拆得对。
     */
    const r = splitReviewComments("**1.** 标题过长。\n2．摘要需重写。");
    expect(r).toHaveLength(2);
    expect(r[0].comment).toBe("标题过长。");
    expect(r[1].comment).toBe("摘要需重写。");
  });

  it("条数上限 300 —— 超长粘贴不会写爆库", () => {
    const raw = Array.from({ length: 400 }, (_, i) => `${i + 1}. 意见${i + 1}`).join("\n");
    expect(splitReviewComments(raw).length).toBeLessThanOrEqual(300);
  });
});

describe("buildRevisionInput — 送进修订的意见", () => {
  const mk = (over: Record<string, unknown>) => ({
    seq: 0, kind: "revise", comment: "C", response: "", responseType: "", ...over,
  }) as never;

  it("⚠ '未采纳'的意见**不得**进入修订输入", () => {
    // 塞进去模型会照着改, 而用户恰恰是不想改才标了未采纳 —— 改出来的稿子看着更"听话",
    //   用户不会立刻发现。这是本模块最容易做错的一处。
    const out = buildRevisionInput([
      mk({ seq: 0, comment: "请补做稳健性检验", responseType: "revised" }),
      mk({ seq: 1, comment: "建议删除第三章", responseType: "disagreed", response: "该章是本文核心论证" }),
    ]);
    expect(out).toContain("请补做稳健性检验");
    expect(out).not.toContain("建议删除第三章");
    expect(out).not.toContain("该章是本文核心论证");
  });

  it("'已修改'与'已回应'都进; 未处理的('')不进", () => {
    const out = buildRevisionInput([
      mk({ seq: 0, comment: "A改", responseType: "revised" }),
      mk({ seq: 1, comment: "B回应", responseType: "responded", response: "已说明" }),
      mk({ seq: 2, comment: "C没动", responseType: "" }),
    ]);
    expect(out).toContain("A改");
    expect(out).toContain("B回应");
    expect(out).not.toContain("C没动");
  });

  it("全未处理 → 空串(调用方据此决定加不加这一段)", () => {
    expect(buildRevisionInput([mk({ comment: "X", responseType: "" })])).toBe("");
  });

  it("作者表态会一并带上, 让模型知道用户的处置意图", () => {
    const out = buildRevisionInput([mk({ comment: "请补检验", responseType: "responded", response: "已在 4.3 节补充" })]);
    expect(out).toContain("已在 4.3 节补充");
  });
});

describe("buildResponseLetter — 回应信", () => {
  const mk = (over: Record<string, unknown>) => ({
    round: 1, seq: 0, kind: "revise", comment: "C", quote: "", response: "",
    responseType: "", revisionRefs: [], reviewerLabel: "", ...over,
  }) as never;

  it("统计已处理条数", () => {
    const s = buildResponseLetter([
      mk({ seq: 0, comment: "一", responseType: "revised" }),
      mk({ seq: 1, comment: "二", responseType: "" }),
    ], "p", "标题");
    expect(s).toContain("共收到 2 条意见，已处理 1 条");
  });

  it("未处理的**也列出来并标注** —— 瞒着不写编辑一审就发现少一条", () => {
    const s = buildResponseLetter([mk({ comment: "被忽略的意见" })], "p");
    expect(s).toContain("被忽略的意见");
    expect(s).toContain("尚未处理");
  });

  it("三类呼应方式措辞可区分", () => {
    const s = buildResponseLetter([
      mk({ seq: 0, comment: "a", responseType: "revised" }),
      mk({ seq: 1, comment: "b", responseType: "responded" }),
      mk({ seq: 2, comment: "c", responseType: "disagreed" }),
    ], "p");
    expect(s).toContain("已修改");
    expect(s).toContain("已回应");
    expect(s).toContain("未采纳");
  });

  it("按轮次分节; 引用原文用 blockquote 与回复正文分开", () => {
    const s = buildResponseLetter([
      mk({ round: 1, seq: 0, comment: "第一轮", quote: "原文引用" }),
      mk({ round: 2, seq: 0, comment: "第二轮" }),
    ], "p");
    expect(s).toContain("## 第 1 轮");
    expect(s).toContain("## 第 2 轮");
    expect(s).toContain("> 原文引用");
  });

  it("修订版本号被写上(编辑部要据此核对改了哪一稿)", () => {
    const s = buildResponseLetter([mk({ seq: 0, comment: "a", responseType: "revised", revisionRefs: [3, 4] })], "p");
    expect(s).toContain("v3 / v4");
  });
});
