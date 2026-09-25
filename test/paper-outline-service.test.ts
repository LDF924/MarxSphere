// paper-outline-service.test.ts — generateChapter 的**提示词契约**
//
// 由来(2026-09-25): 这一批「研究 → 写作」补的东西, 最终产物**就是那段 prompt**。
//   而在此之前它没有任何测试 —— 于是"某个参数压根没人在 prompt 里用"这类问题
//   (实测过: `thesis` 参数声明了很久, 全仓没有任何调用点传它)不会有人发现。
//   把"注入的每一块都真出现在 prompt 里"钉住, 比测"函数返回了个对象"有意义得多:
//   函数返回什么不是产品, **模型看到什么**才是。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/services/llm-model-registry.js", () => ({ getRoleModel: () => "test-model" }));
// ⚠ 显式标出参数类型。写成 `async () => ({...})` 时 vitest 推断出的入参是**空元组**,
//   于是 `mock.calls[n][0]` 过不了 tsc(TS2493)—— 单测能跑、类型检查却红。
const fetchLlm = vi.fn(async (_arg: { messages?: Array<{ content?: string }> }) => ({ text: JSON.stringify({ content: "正文" }) }));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: (arg: { messages?: Array<{ content?: string }> }) => fetchLlm(arg),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));
vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));

import { generateChapter } from "../src/services/paper-outline-service.js";

/** 取最近一次调用的 prompt 文本 */
function lastPrompt(): string {
  const calls = fetchLlm.mock.calls;
  return String(calls[calls.length - 1]?.[0]?.messages?.[0]?.content ?? "");
}

describe("generateChapter 提示词契约", () => {
  beforeEach(() => { fetchLlm.mockClear(); });

  it("基础参数都进 prompt(主题/标题/层级)", async () => {
    await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "数字化转型研究" });
    const p = lastPrompt();
    expect(p).toContain("数字化转型研究");
    expect(p).toContain("【本章标题】引言");
    /**
     * ⚠ 层级判据是 `isRoot = level === 0`, 而写作舱的一级章节 level 是 **1**
     *   (见 runChapterBatch 的 `level: sec.level ?? 1`)。所以实际生成时走的是
     *   "节/小节"这一支 —— 这里如实钉住, 免得以后有人照着注释以为走的是"章"。
     *   (那是既有口径, 与本次改动无关; 要改得单独开一条。)
     */
    expect(p).toContain("【本章层级】节/小节");

    fetchLlm.mockClear();
    await generateChapter({ nodeId: "s1", title: "第一章", level: 0, topic: "T" });
    expect(lastPrompt()).toContain("【本章层级】章(如");
  });

  it("核心论点: 传了才出现 —— 这是各章共享同一论点的唯一入口", async () => {
    await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "T" });
    expect(lastPrompt()).not.toContain("【核心论点】");

    await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "T", thesis: "本文主张X导致Y" });
    expect(lastPrompt()).toContain("【核心论点】本文主张X导致Y");
  });

  it("本章依据: 出现, 且带上「数字须原样引用」的硬约束", async () => {
    await generateChapter({
      nodeId: "s1", title: "实证结果", level: 1, topic: "T",
      evidenceBlock: "【本章依据】\n| 变量 | 系数 |\n| edu | 0.312 |",
    });
    const p = lastPrompt();
    expect(p).toContain("| edu | 0.312 |");
    expect(p).toContain("数字原样照抄");
  });

  it("没给依据时, 不出现那条「不得编造数值」的要求(避免空要求干扰)", async () => {
    await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "T" });
    expect(lastPrompt()).not.toContain("数字原样照抄");
  });

  it("研究主线逻辑: 传了才出现 —— 各章沿同一条论证路径", async () => {
    await generateChapter({ nodeId: "s1", title: "实证结果", level: 1, topic: "T" });
    expect(lastPrompt()).not.toContain("【研究主线");
    await generateChapter({ nodeId: "s1", title: "实证结果", level: 1, topic: "T", researchLogic: "先界定概念, 再检验机制, 最后落到政策含义" });
    const p = lastPrompt();
    expect(p).toContain("【研究主线");
    expect(p).toContain("先界定概念");
    // 它和 thesis 是两件事: 一个是主张, 一个是路径, 不能互相替代
    expect(p).toContain("不要自成一个话题");
  });

  it("研究设计约束: 出现 —— 它决定全文的因果措辞口径", async () => {
    await generateChapter({
      nodeId: "s1", title: "研究设计", level: 1, topic: "T",
      designBlock: "【研究设计约束】\n因果识别: **不做因果推断** —— 全文严禁因果措辞",
    });
    expect(lastPrompt()).toContain("严禁因果措辞");
  });

  it("文献综述章: 多出「落到本研究问题」的要求", async () => {
    await generateChapter({ nodeId: "s1", title: "文献综述", level: 1, topic: "T" });
    expect(lastPrompt()).toContain("不是文献罗列");
    expect(lastPrompt()).toContain("本研究填补的是哪一条");
  });

  it("非综述章不背那条额外要求(标题判据要真的分流)", async () => {
    await generateChapter({ nodeId: "s1", title: "结论", level: 1, topic: "T" });
    expect(lastPrompt()).not.toContain("不是文献罗列");
  });

  it("「相关研究」「既有研究」这类标题也认作综述", async () => {
    for (const title of ["相关研究", "既有研究述评", "文献回顾"]) {
      fetchLlm.mockClear();
      await generateChapter({ nodeId: "s1", title, level: 1, topic: "T" });
      expect(lastPrompt(), `${title} 应走综述分支`).toContain("不是文献罗列");
    }
  });

  it("字数配额进 prompt 的区间提示", async () => {
    await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "T", targetWordCount: 1000 });
    expect(lastPrompt()).toContain("800-1200字");
  });

  it("返回结构: content 与去空白字数", async () => {
    fetchLlm.mockResolvedValueOnce({ text: JSON.stringify({ content: "一二三 四五六" }) } as never);
    const r = await generateChapter({ nodeId: "s1", title: "引言", level: 1, topic: "T" });
    expect(r.content).toBe("一二三 四五六");
    expect(r.wordCount).toBe(6);
  });
});
