/**
 * paper-outline-service 的**要件档位**回归。
 *
 * 为什么值得单测：加一个档位要同时改 4 处（后端类型/COMPONENT_SPEC/zod enum/前端 label 表），
 *   而**旧的实现是嵌套三元**——
 *     `kind === "abstract" ? A : kind === "keywords" ? B : C`
 *   第四个档位会静默落进 `C`（结论的要求），产出完全不对但**不报错**。
 *   2026-09-26 加「讨论」时重构成查表，这组测试就是那次重构的护栏：
 *   往后每次加档位，只要漏配，这里就会红。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** 记录每次调用的 prompt，供断言用 */
const calls: Array<{ prompt: string; maxTokens?: number }> = [];

/**
 * ⚠ `llmJson` 是 paper-outline-service 的**文件内私有函数**，不是 import 来的 ——
 *   mock 一个模块打不中它。它内部调的是 `../ai/llm-common.js` 的 `fetchLlm`，
 *   所以 mock 那一层，并在返回值上给出 `parseLlmJson` 认得的 JSON 文本。
 *   （第一版 mock 错了层，8 条里 7 条因为真去连 LLM 而失败。）
 */
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: vi.fn(async (opts: { messages: Array<{ content: string }>; maxTokens?: number }) => {
    calls.push({ prompt: opts.messages?.[0]?.content ?? "", maxTokens: opts.maxTokens });
    return { text: JSON.stringify({ content: "生成的内容" }) };
  }),
  parseLlmJson: (s: string) => JSON.parse(s),
}));

const { generateComponent } = await import("../src/services/paper-outline-service.js");

const base = { topic: "数字经济的就业效应", sections: ["引言", "文献综述"], chapterContents: ["第一章正文…"] };

beforeEach(() => { calls.length = 0; });

describe("论文要件 · 档位", () => {
  it("四个档位都能生成，且标题正确", async () => {
    for (const [kind, cn] of [["abstract", "摘要"], ["keywords", "关键词"], ["conclusion", "结论"], ["discussion", "讨论"]] as const) {
      calls.length = 0;
      const r = await generateComponent({ ...base, kind });
      expect(r.title, `${kind} 的标题`).toBe(cn);
      expect(r.id).toBe(kind);
      expect(r.content).toBeTruthy();
    }
  });

  it("每档给的是**自己的**篇幅要求（旧嵌套三元会把第四档写成结论的）", async () => {
    calls.length = 0;
    await generateComponent({ ...base, kind: "discussion" });
    const p = calls[0].prompt;
    expect(p, "讨论的篇幅要求").toContain("讨论 500-1000 字");
    // 旧实现下这里会命中结论那句 —— 这条就是那个 bug 的护栏
    expect(p, "不应落进结论的要求").not.toContain("结论 300-600 字");
  });

  it("讨论的顺序要求写进了 prompt（结果→文献对话→启示→局限→展望）", async () => {
    calls.length = 0;
    await generateComponent({ ...base, kind: "discussion" });
    const p = calls[0].prompt;
    for (const k of ["主要发现及其含义", "与既有文献的对话", "局限", "后续研究"]) {
      expect(p, `讨论要求里应含「${k}」`).toContain(k);
    }
  });

  it("讨论拿到更长的正文切片（它要与正文对话，不是复述摘要）", async () => {
    calls.length = 0;
    const long = "甲".repeat(2000);
    await generateComponent({ ...base, chapterContents: [long], kind: "discussion" });
    const discLen = (calls[0].prompt.match(/甲+/)?.[0] ?? "").length;
    calls.length = 0;
    await generateComponent({ ...base, chapterContents: [long], kind: "abstract" });
    const absLen = (calls[0].prompt.match(/甲+/)?.[0] ?? "").length;
    expect(discLen).toBeGreaterThan(absLen);
    expect(absLen).toBe(500);
    expect(discLen).toBe(1200);
  });

  it("讨论吃研究证据，并带上「不得另编」的约束", async () => {
    calls.length = 0;
    await generateComponent({ ...base, kind: "discussion", evidenceSummary: "β=0.42, p<0.01" });
    const p = calls[0].prompt;
    expect(p).toContain("β=0.42, p<0.01");
    expect(p).toContain("不得另编");
  });

  it("关键词不套「不得编造数字」那条（它没有结果段）", async () => {
    calls.length = 0;
    await generateComponent({ ...base, kind: "keywords", evidenceSummary: "β=0.42" });
    expect(calls[0].prompt).not.toContain("不得编造数字");
  });

  it("未知档位**显式抛错**，不静默按结论生成", async () => {
    await expect(generateComponent({ ...base, kind: "nope" as never })).rejects.toThrow(/未知的论文要件类型/);
  });

  it("讨论给更大的 token 预算（3000 写不开 500-1000 字的解释）", async () => {
    calls.length = 0;
    await generateComponent({ ...base, kind: "discussion" });
    const disc = calls[0].maxTokens;
    calls.length = 0;
    await generateComponent({ ...base, kind: "abstract" });
    expect(disc).toBeGreaterThan(calls[0].maxTokens!);
  });
});
