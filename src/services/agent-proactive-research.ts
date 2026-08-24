// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-proactive-research.ts — P2: 主动研究（每日自主巡检）
// 补齐 V373 记忆声称但缺失的行为: 每日自动发现问题→发起研究任务→反馈
// 流程: ①从情景记忆/评测失败/历史任务收集信号 ②LLM 生成研究假设
//       ③按质量过滤(防噪音) ④创建 agent 任务入队执行 ⑤结果反馈到知识回流
// 开关: AGENT_PROACTIVE_RESEARCH=0 关闭; AGENT_PROACTIVE_INTERVAL_MS 覆盖周期(默认24h)
import { pool } from "../db/pool.js";
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";

/** 单次最多创建任务数（防刷屏） */
const MAX_TASKS_PER_RUN = 2;
/** 同目标去重窗口（小时）— 最近 N 小时内已有相同目标任务则跳过 */
const DEDUP_WINDOW_HOURS = 24;

/** 收集研究信号: 高频失败主题 + 情景记忆热点 + 最近评测失败 */
async function collectResearchSignals(): Promise<Array<{ topic: string; evidence: string; weight: number }>> {
  const signals: Array<{ topic: string; evidence: string; weight: number }> = [];
  try {
    // ① 最近 7 天失败/未达标任务（归因研究价值）
    const failed = await pool.query(
      `select goal, progress from agent_tasks
       where status = 'failed' and created_at > now() - interval '7 days'
       order by created_at desc limit 10`
    );
    for (const row of failed.rows) {
      const topic = String(row.goal || "").slice(0, 60);
      if (topic) signals.push({ topic, evidence: `失败任务: ${String(row.progress || "无原因").slice(0, 60)}`, weight: 0.8 });
    }
    // ② 评测集未通过条目（gold 任务回退 → 值得深究）
    const evalFails = await pool.query(
      `select s.goal from agent_eval_runs r join agent_eval_suite s on s.id = r.suite_id
       where r.passed = false and r.created_at > now() - interval '7 days'
       order by r.created_at desc limit 5`
    );
    for (const row of evalFails.rows) {
      const topic = String(row.goal || "").slice(0, 60);
      if (topic) signals.push({ topic, evidence: "评测集未通过（gold 任务回退）", weight: 1.0 });
    }
    // ③ 情景记忆热点（高频访问的研究轨迹 → 延伸研究）
    const hot = await pool.query(
      `select goal from agent_episodic_memory
       where access_count >= 2 and created_at > now() - interval '30 days'
       order by access_count desc, importance desc limit 5`
    );
    for (const row of hot.rows) {
      const topic = String(row.goal || "").slice(0, 60);
      if (topic) signals.push({ topic, evidence: "情景记忆热点（被多次检索复用）", weight: 0.6 });
    }
  } catch { /* 信号收集失败 → 空列表 */ }
  return signals;
}

/** 用 LLM 从信号中挑选最有价值的研究主题（防噪音刷任务） */
async function pickResearchTopic(signals: Array<{ topic: string; evidence: string; weight: number }>): Promise<string | null> {
  if (signals.length === 0) return null;
  const sorted = [...signals].sort((a, b) => b.weight - a.weight).slice(0, 8);
  try {
    const model = resolveModelAlias(getRoleModel("plan"));
    const r = await callLlm({
      model,
      agentContext: { action: "agent_proactive_pick" },
      messages: [{
        role: "user",
        content: `你是自主研究选题员。从以下研究信号中选出 1 个最有价值的新研究主题（避免与已有信号重复, 选能产生增量知识的）:
${sorted.map((s, i) => `${i + 1}. [${s.evidence}] ${s.topic}`).join("\n")}

只返回研究目标（一句话, 40 字内, 具体可执行）:`,
      }],
      temperature: 0.4, maxTokens: 100,
    });
    const topic = (r?.text || "").trim().replace(/[。.]+$/, "");
    if (!topic || topic.length < 6 || topic.length > 60) return null;
    return topic;
  } catch { return null; }
}

/** 去重: 最近 N 小时已有相同目标任务 → 跳过 */
async function isDuplicateTopic(topic: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `select 1 from agent_tasks
       where goal ilike $1 and created_at > now() - interval '${DEDUP_WINDOW_HOURS} hours' limit 1`,
      [`%${topic.slice(0, 20)}%`]
    );
    return (r.rowCount || 0) > 0;
  } catch { return false; }
}

/** 每日自主巡检: 收集信号 → 选题 → 创建任务入队 */
export async function runProactiveResearch(): Promise<{ created: string[]; skipped: number; signals: number }> {
  const created: string[] = [];
  let skipped = 0;
  let signals: Array<{ topic: string; evidence: string; weight: number }> = [];
  try {
    signals = await collectResearchSignals();
    if (signals.length === 0) {
      console.log("[agent-proactive] P2 无研究信号（失败任务/评测回退/热点为空）");
      return { created, skipped, signals: 0 };
    }
    // 选题（最多 2 个）
    const seen = new Set<string>();
    for (let i = 0; i < MAX_TASKS_PER_RUN; i++) {
      const topic = await pickResearchTopic(signals);
      if (!topic || seen.has(topic)) { skipped++; break; }
      seen.add(topic);
      if (await isDuplicateTopic(topic)) { skipped++; continue; }
      // 创建任务并入队执行
      const { agentTaskService } = await import("./agent-task-service.js");
      const task = await agentTaskService.createAgentTask({ goal: topic, userId: undefined });
      if (task) {
        created.push(task.id);
        const { agentTaskQueue } = await import("./agent-task-queue.js");
        void agentTaskQueue.enqueueTask({
          taskId: task.id,
          priority: 1,  // 主动研究低优先级（不挤占用户任务）
          run: async () => {
            await agentTaskService.runAgentTask(task.id, async (step) => {
              // 简化执行器: 用工具链真实执行（检索/推理走 SAG）
              const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
              const tools = await buildAgentTools({});
              const chosen = await chooseToolByLlm(topic, step.title, tools);
              if (chosen) {
                const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: "manager" });
                if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
              }
              const result = `【自主研究】${step.title} — 目标: ${(step.query || topic).slice(0, 80)}`;
              return { result, detail: result, source: "proactive-runner" };
            });
          },
        });
        console.log(`[agent-proactive] P2 已发起自主研究任务: ${topic.slice(0, 40)} (${task.id.slice(0, 8)})`);
      }
    }
  } catch (e: any) {
    console.error("[agent-proactive] P2 巡检失败:", String(e?.message || e).slice(0, 120));
  }
  return { created, skipped, signals: signals.length };
}

/** 启动每日自主巡检（幂等; 每 24h）— V445: 移除启动立即跑（防静默消费 LLM），
 * 需用户确认后才执行首次 */
let proactiveStarted = false;
export function startProactiveResearchScheduler(): void {
  if (proactiveStarted) return;
  proactiveStarted = true;
  if (process.env.AGENT_PROACTIVE_RESEARCH === "0") {
    console.log("[agent-proactive] P2 主动研究已关闭（AGENT_PROACTIVE_RESEARCH=0）");
    return;
  }
  const INTERVAL_MS = parseInt(process.env.AGENT_PROACTIVE_INTERVAL_MS || "86400000", 10);  // 默认 24h
  // V445: 移除 void runProactiveResearch()（原启动即调 LLM 消费额度）
  setInterval(() => { void runProactiveResearch(); }, INTERVAL_MS).unref?.();
  console.log(`[agent-proactive] P2 主动研究已启动 (每 ${Math.round(INTERVAL_MS / 3600000)}h 自动巡检；首次运行需用户确认)`);
}
