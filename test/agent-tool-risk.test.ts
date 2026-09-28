// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/agent-tool-risk.test.ts — 危险 agent 工具**不得**标成 risk:"safe"
//
// 为什么需要(2026-09-28, 一路查下来才发现的):
//   现象是"编排的第 2 步就挂, 整个旗舰模板跑不完":
//     analyze  failed  工具 llm_write 需要审批（当前自主级别: 建议模式 — 每步工具调用都需审批）
//   根因是自主级别默认档是 `suggest`(每步审批), 而**在编排里"需要审批"就是"失败"** ——
//   后台任务没有"停下等人点同意"这一态。于是安全档把功能关掉了, 而不是把危险挡住。
//
//   想把它改回 `auto-edit` 时, 必须回答"那风险工具怎么办"。查下来发现:
//     · 2026-09-14 那次安全审计把 runtime_exec / run_command / file_write / sag_ingest /
//       apply_patch 都改成了 review —— **但漏了 `run_code`**(任意代码执行, 还带
//       workspace-write / full-access 档, 却标着 safe);
//     · `auto-edit` 的规则正是"`risk === "safe"` 自动执行, review 才审批" ——
//       所以只要有一个"会写/会跑"的工具漏标成 safe, 切到 auto-edit 就等于**无审批**。
//
//   也就是说: "默认档能否安全地调到 auto-edit"**完全依赖这张标注表的正确性**,
//   而那张表是靠人肉维护的、并且**已经漏过一次**。
//   所以这里把它变成机器拦: 会写/会执行/能提权的工具, 一律不许出现在 safe 里。
import { describe, it, expect } from "vitest";
import { buildAgentTools } from "../src/services/agent-tool-router.js";

/**
 * 这些名字的工具**必须**是 review(或更严)。
 *
 * 判据不是"名字里有敏感词"(那太脆), 而是逐条说明**它为什么危险** ——
 * 加新条目时请照着写清楚, 否则日后没人知道该不该把它删掉。
 */
const MUST_BE_REVIEW: Record<string, string> = {
  run_code: "任意代码执行(Python/JS), 且带 workspace-write / full-access 档",
  runtime_exec: "持久 Python 运行时, 代码跨调用保持",
  run_command: "执行终端命令",
  file_write: "写文件",
  apply_patch: "打补丁(等价于写文件)",
  sag_ingest: "写知识库(入库)",
  doc_edit: "改知识库文档",
  orch_run: "触发编排 —— 编排的节点可绑任意工具, 是**提权旁路**",
};

describe("agent 工具风险标注", () => {
  it("会写/会跑/能提权的工具都不能标 risk:safe", async () => {
    const tools = await buildAgentTools({});
    const byName = new Map(tools.map((t) => [t.name, t]));
    const offenders: string[] = [];
    for (const [name, why] of Object.entries(MUST_BE_REVIEW)) {
      const t = byName.get(name);
      // 工具被删掉了不算错(那时这条清单也该跟着删), 但不许**存在却标 safe**
      if (t && t.risk === "safe") offenders.push(`${name}(risk=safe) — ${why}`);
    }
    expect(
      offenders,
      "以下工具会改系统状态却标着 risk:\"safe\"。\n" +
      "后果不是「标注不准」: `auto-edit` 自主级别的规则是「**safe 自动执行、无需审批**」,\n" +
      "所以漏标一个就等于开了一条无审批的写/执行通道(2026-09-14 那次审计漏掉过 run_code)。\n" +
      "修法: 在 agent-tool-router.ts 里把它的 risk 改成 \"review\", 或(若确实无害)把它从本清单删掉并说明理由。\n" +
      offenders.join("\n"),
    ).toEqual([]);
  });

  it("反向: 纯检索类工具应当仍是 safe(防「一刀切全改成 review」)", async () => {
    const tools = await buildAgentTools({});
    const byName = new Map(tools.map((t) => [t.name, t]));
    // 只读检索 —— 它们每次调用都弹审批没有意义, 而且会把编排再次堵死
    for (const name of ["sag_search", "policy_search", "llm_write"]) {
      const t = byName.get(name);
      if (!t) continue;                       // 工具不存在就跳过(名字可能变)
      expect(t.risk, `${name} 是只读检索/生成, 不该要审批 —— 会让编排又跑不动`).toBe("safe");
    }
  });
});
