/**
 * research-tools.test.ts — 写作舱(研途写作舱)的能力必须在**对话侧**可达。
 *
 * 由来(2026-09-29 用户: "AI 对话好久没更新其调用工具和能力, 因为我们不是新增几个页面吗"):
 *   我前一轮把这句话读成了"工具**名**显示成英文"(前端手抄清单烂了 37/77), 修的是显示。
 *   用户纠正后一查才发现真问题: 写作舱那几批新增的东西(投稿要件 / 评审返修 / 开题基金 /
 *   中期检查 / 复现包, 以及更早的素材库 / 证据账本 / 假设台账 / 章节正文)
 *   **在对话侧是零覆盖** —— 实测 agent 工具 0 个、编排能力 0 个、编排模板 0 个。
 *   用户在对话里说"看看我的假设检验结论", AI 根本够不着。
 *
 * 这个文件锁三件事(每一条都对应一个**不报错**的失效方式):
 *   ① **可达**: 那几项能力必须有对应的 agent 工具 —— 少一个, 用户在对话里就够不着它;
 *   ② **只能只读的必须只读**: 六个 view_* 工具不许出现在 WRITE_TOOLS 里(只读会话会拿到它们);
 *   ③ **会写/会烧钱的必须登记**: 两个生成工具必须在 WRITE_TOOLS **与** TOOL_MIN_ROLE 里。
 *      本仓记过的坑: 新工具只写 risk 不登记这两处, 只读会话照样能触发写操作。
 */
import { describe, it, expect } from "vitest";
import { buildAgentTools, WRITE_TOOLS, minRoleOf } from "../src/services/agent-tool-router.js";

/** 写作舱里"用户在对话里应该够得着"的能力 → 它为什么重要 */
const MUST_EXIST: Record<string, string> = {
  view_research_projects: "没有它, AI 不知道用户手上有哪些项目, 后面所有 projectId 都无从谈起",
  view_research_materials: "素材库是写作舱最常用的地方 —— 问「我的素材够不够」要能回答",
  view_research_evidence: "章节依据区写进去的东西, 不问它就只能去界面上一章章点",
  view_research_hypotheses: "假设检验台账是实证论文的结论来源",
  view_research_outline: "「第三章写了什么」是最常被问的一句",
  view_research_submission: "投稿记录/审稿意见/申报稿 —— 用户说「我那篇投出去了吗」要能回答",
  research_proposal_generate: "开题/基金/伦理/预注册是新增页面, 光能查不能生成等于没接",
  research_component_generate: "摘要/结论/讨论是投稿要件, 同上",
};

/** 只读的六个 —— 不许进 WRITE_TOOLS */
const READ_ONLY = Object.keys(MUST_EXIST).filter((n) => n.startsWith("view_"));

describe("写作舱能力在对话侧可达", () => {
  it("八个工具都真实注册进了 buildAgentTools", async () => {
    const names = new Set((await buildAgentTools({})).map((t) => t.name));
    const missing = Object.keys(MUST_EXIST).filter((n) => !names.has(n));
    expect(
      missing,
      "这些写作舱能力没有注册成 agent 工具 —— 用户在对话里够不着它们。\n" +
        "加回 agent-view-tools.ts 的 VIEW_TOOLS, 并同步 TOOL_MIN_ROLE / WRITE_TOOLS。",
    ).toEqual([]);
  });

  it("每个都写了「为什么需要」(防止条目被无声删掉)", () => {
    for (const [n, why] of Object.entries(MUST_EXIST)) {
      expect(why.length, `${n} 的理由太短, 日后没人知道该不该删`).toBeGreaterThan(10);
    }
  });

  it("**只读的六个不许出现在 WRITE_TOOLS**(只读会话会拿到它们)", () => {
    const wrong = READ_ONLY.filter((n) => WRITE_TOOLS.has(n));
    expect(wrong, `这六个是只读工具, 列进 WRITE_TOOLS 会让只读会话白白丢掉它们: ${wrong.join(", ")}`).toEqual([]);
  });

  it("**两个生成工具必须在 WRITE_TOOLS 与角色表里**(否则只读会话能触发写)", () => {
    const gen = Object.keys(MUST_EXIST).filter((n) => !n.startsWith("view_"));
    const missingWrite = gen.filter((n) => !WRITE_TOOLS.has(n));
    expect(
      missingWrite,
      "这两个会落库 + 烧 LLM。不在 WRITE_TOOLS 里, 只读(评审)会话就能触发它们 —— " +
        "本仓记过这个坑(orch_run 漏登记 ⇒ 评审会话能间接触发完整编排)。",
    ).toEqual([]);
    const missingRole = gen.filter((n) => minRoleOf(n) === "reader");
    expect(
      missingRole,
      "角色表里没登记 ⇒ 落回缺省 reader ⇒ 只读会话可达。要 analyst。",
    ).toEqual([]);
  });
});
