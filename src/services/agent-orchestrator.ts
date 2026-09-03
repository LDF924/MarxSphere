// agent-orchestrator.ts — V391(P2-1/2): 主管-工人层级编排 + Agent 消息协议
// 复杂任务: 主管(LLM)拆包为多个子目标 → 并行工人执行 → 主管汇总
// 消息协议: agent_messages 表记录 主管↔工人 的结构化消息（task/result/status）
import { pool } from "../db/pool.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";
import { randomUUID } from "node:crypto";

export interface WorkerTask {
  id: string;
  parentTaskId?: string;
  workerName: string;
  assignee: string;
  goal: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  detail?: string;
}

export interface AgentMessage {
  id: number;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  msgType: string;
  payload: Record<string, unknown>;
}

/** 最大并行工人数（默认 3） */
const MAX_WORKERS = parseInt(process.env.AGENT_MAX_WORKERS || "3", 10);

/** 主管拆包: LLM 把复杂目标分解为多个可并行的子目标 */
export async function decomposeGoal(goal: string): Promise<Array<{ goal: string; assignee: string }>> {
  try {
    const model = resolveModelAlias(getRoleModel("plan"));
    const r = await callLlm({
      model,
      messages: [{
        role: "user",
        content: `你是任务主管。把复杂研究目标拆包为 2-4 个可并行执行的子任务（各子任务相互独立）。
目标: ${goal}
工人角色: general(通用)/retriever(检索)/writer(写作)/reviewer(评审)
只返回 JSON 数组: [{"goal":"子目标(≤50字, 独立可执行)","assignee":"general|retriever|writer|reviewer"}]`,
      }],
      temperature: 0.2, maxTokens: 600,
    });
    const parsed = JSON.parse((r?.text ?? "").trim().replace(/```json|```/g, ""));
    const items = Array.isArray(parsed) ? parsed : parsed.tasks;
    return (items as any[]).slice(0, 4).map((t) => ({
      goal: String(t.goal || t.subgoal || t.task || goal),
      assignee: ["general", "retriever", "writer", "reviewer"].includes(t.assignee) ? t.assignee : "general",
    }));
  } catch {
    // 兜底: 单工人直接执行
    return [{ goal, assignee: "general" }];
  }
}

/** 下发工人任务（记录消息协议） */
export async function dispatchWorkers(input: {
  parentTaskId?: string;
  goal: string;
  workerRunner: (worker: WorkerTask) => Promise<string>;
}): Promise<WorkerTask[]> {
  const subtasks = await decomposeGoal(input.goal);
  const workers: WorkerTask[] = subtasks.slice(0, MAX_WORKERS).map((s, i) => ({
    id: randomUUID(),
    parentTaskId: input.parentTaskId,
    workerName: `worker-${i + 1}`,
    assignee: s.assignee,
    goal: s.goal,
    status: "pending",
  }));

  // 落库 + 主管发任务消息
  for (const w of workers) {
    await pool.query(
      `insert into worker_tasks (id, parent_task_id, worker_name, assignee, goal, status) values ($1,$2,$3,$4,$5,'pending')`,
      [w.id, w.parentTaskId ?? null, w.workerName, w.assignee, w.goal]
    );
    await sendAgentMessage({
      taskId: w.parentTaskId, fromAgent: "orchestrator", toAgent: w.workerName, msgType: "task",
      payload: { goal: w.goal, assignee: w.assignee },
    });
  }

  // 并行执行工人（Promise.allSettled: 单工人失败不影响其他）
  const results = await Promise.allSettled(workers.map(async (w) => {
    await pool.query("update worker_tasks set status='running', updated_at=now() where id=$1", [w.id]);
    await sendAgentMessage({ taskId: w.parentTaskId, fromAgent: w.workerName, toAgent: "orchestrator", msgType: "status", payload: { status: "running" } });
    try {
      const result = await input.workerRunner(w);
      await pool.query("update worker_tasks set status='done', result=$2, updated_at=now() where id=$1", [w.id, result.substring(0, 4000)]);
      await sendAgentMessage({ taskId: w.parentTaskId, fromAgent: w.workerName, toAgent: "orchestrator", msgType: "result", payload: { result: result.substring(0, 2000) } });
      return result;
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 300);
      await pool.query("update worker_tasks set status='failed', result=$2, updated_at=now() where id=$1", [w.id, err]);
      await sendAgentMessage({ taskId: w.parentTaskId, fromAgent: w.workerName, toAgent: "orchestrator", msgType: "status", payload: { status: "failed", error: err } });
      return err;
    }
  }));

  // 主管汇总
  const done = workers.map((w, i) => ({ ...w, result: results[i].status === "fulfilled" ? (results[i] as any).value : undefined }));
  const summary = await orchestrateSummary(input.goal, done);
  // 主管发汇总消息
  await sendAgentMessage({ taskId: input.parentTaskId, fromAgent: "orchestrator", toAgent: "user", msgType: "result", payload: { summary } });
  return done;
}

/** 主管汇总: LLM 整合各工人产出 */
async function orchestrateSummary(goal: string, workers: Array<WorkerTask & { result?: string }>): Promise<string> {
  const parts = workers.map((w) => `[${w.workerName}/${w.assignee}] ${w.goal}\n${(w.result || "").slice(0, 500)}`).join("\n\n");
  try {
    const model = resolveModelAlias(getRoleModel("plan"));
    const r = await callLlm({
      model,
      messages: [{
        role: "user",
        content: `你是任务主管。汇总以下工人产出为一份完整研究报告（覆盖目标各维度, 结构清晰）。
研究目标: ${goal}
工人产出:
${parts}
输出: 结构化中文汇总（500-800字）`,
      }],
      temperature: 0.3, maxTokens: 1500,
    });
    return r?.text?.trim() || "（汇总失败）";
  } catch {
    return parts;
  }
}

/** 结构化消息协议: 发送 Agent 消息 */
export async function sendAgentMessage(input: {
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  msgType: "task" | "result" | "status" | "approval" | "note";
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `insert into agent_messages (task_id, from_agent, to_agent, msg_type, payload) values ($1,$2,$3,$4,$5::jsonb)`,
      [input.taskId ?? null, input.fromAgent, input.toAgent, input.msgType, JSON.stringify(input.payload)]
    );
  } catch { /* 消息记录失败不阻塞 */ }
}

/** 读取消息流（前端可视化） */
export async function listAgentMessages(taskId?: string, limit = 50): Promise<AgentMessage[]> {
  const r = taskId
    ? await pool.query("select * from agent_messages where task_id = $1::uuid order by id desc limit $2", [taskId, limit])
    : await pool.query("select * from agent_messages order by id desc limit $2", [limit]);
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    taskId: row.task_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    msgType: row.msg_type,
    payload: row.payload || {},
  }));
}

export async function listWorkerTasks(parentTaskId?: string): Promise<WorkerTask[]> {
  const r = parentTaskId
    ? await pool.query("select * from worker_tasks where parent_task_id = $1::uuid order by created_at", [parentTaskId])
    : await pool.query("select * from worker_tasks order by created_at desc limit 50");
  return r.rows.map((row: any) => ({
    id: row.id,
    parentTaskId: row.parent_task_id,
    workerName: row.worker_name,
    assignee: row.assignee,
    goal: row.goal,
    status: row.status,
    result: row.result,
    detail: row.detail,
  }));
}

export const agentOrchestrator = {
  decomposeGoal,
  dispatchWorkers,
  sendAgentMessage,
  listAgentMessages,
  listWorkerTasks,
};
