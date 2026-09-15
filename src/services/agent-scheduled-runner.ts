// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-scheduled-runner.ts — V417: 定时任务被触发后的执行体
//
// 由来: `agent-scheduler` 触发定时任务时只创建 planning 状态的 agent 任务, 注释写明
//   "不自动 run — 由用户从任务面板启动, 避免后台消耗"。作为默认行为是合理的(防后台烧钱),
//   但这样一来"每天自动跑一次研究"这类诉求就落空了 —— 表里也一直没有登记任何任务。
//
// 做法: 把执行体抽到这里, 由 AGENT_SCHEDULE_AUTO_RUN 开关(默认关)决定是否调用。
//   步骤执行器与对话链一致: 先让 LLM 选工具(带角色/白名单/沙箱/Guardian 全套策略闸),
//   选不出工具就回落一次 /api/reason/query。**不绕过任何既有安全策略** —— 定时任务不是特权路径。
//
// 角色: 定时任务是用户主动登记的, 按 analyst 给(与普通用户对话同档), 不给 manager。
import { selfBaseUrl } from "./base-urls.js";

/**
 * 执行一个已创建的定时任务(异步跑完全部步骤)。
 * @param taskId agent_tasks.id
 * @param goal   任务目标(用于检索与日志)
 */
export async function runScheduledTask(taskId: string, goal: string): Promise<void> {
  const agentTaskService = await import("./agent-task-service.js");
  const SELF_BASE = selfBaseUrl();
  await agentTaskService.runAgentTask(taskId, async (step) => {
    const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
    const task = await agentTaskService.getAgentTask(taskId);
    const tools = await buildAgentTools({ sourceId: task?.projectId || undefined });
    const chosen = await chooseToolByLlm(goal, step.title, tools);
    if (chosen) {
      const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: "analyst", taskId });
      if (exec.ok) {
        return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
      }
    }
    const res = await fetch(SELF_BASE + "/api/reason/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: task?.projectId || undefined, query: step.query || goal, mode: "adaptive" }),
    });
    const data = (await res.json()) as { trace?: { hypothesis?: { content?: string } }; error?: string };
    const content = data?.trace?.hypothesis?.content || data?.error || "（无结果）";
    return { result: content.substring(0, 120), detail: content, source: "SAG 推理" };
  });
  console.log(`[agent-scheduler] 定时任务自动执行完成: ${taskId.slice(0, 8)}`);
}
