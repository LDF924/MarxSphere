// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-session-graph.ts — 架构F: 持久化会话图 + 分叉
// F1: 会话→任务→工具→产出 图谱（前端可视化; 复盘研究过程）
// F2: 从 checkpoint 分叉新会话（DSH replay/fork 模式）
import { pool } from "../db/pool.js";

// ═══ F1: 会话图查询 ═══
export interface SessionGraphNode {
  id: string;
  type: "session" | "task" | "tool" | "message" | "credential";
  label: string;
  status?: string;
}

export interface SessionGraphEdge {
  from: string;
  to: string;
  relation: string;
}

/** 构建会话图: 会话 → 任务（goal/状态） → 工具调用（exec_logs） */
export async function buildSessionGraph(sessionId: string): Promise<{ nodes: SessionGraphNode[]; edges: SessionGraphEdge[] }> {
  const nodes: SessionGraphNode[] = [];
  const edges: SessionGraphEdge[] = [];
  try {
    // 会话节点
    const sessionUuid = await sessionToDbUuid(sessionId);
    nodes.push({ id: "session:" + sessionUuid, type: "session", label: `会话 ${sessionId.slice(0, 8)}` });
    // 该会话创建的任务（从 agent_messages task_id 关联, 或从会话前缀匹配目标）
    const tasks = await pool.query(
      `select distinct t.id, t.goal, t.status from agent_messages m
       join agent_tasks t on t.id = m.task_id
       where m.task_id is not null and m.created_at > now() - interval '30 days'
       order by t.created_at desc limit 20`
    );
    for (const t of tasks.rows) {
      nodes.push({ id: "task:" + t.id, type: "task", label: String(t.goal || "").slice(0, 40), status: t.status });
      edges.push({ from: "session:" + sessionUuid, to: "task:" + t.id, relation: "created" });
      // 任务 → 工具调用
      const logs = await pool.query(
        `select distinct tool, action from agent_exec_logs
         where task_id = $1 and tool is not null order by action limit 10`,
        [t.id]
      );
      for (const l of logs.rows) {
        const toolId = `tool:${t.id}:${l.tool}`;
        if (!nodes.some((n) => n.id === toolId)) {
          nodes.push({ id: toolId, type: "tool", label: String(l.tool || l.action) });
        }
        edges.push({ from: "task:" + t.id, to: toolId, relation: String(l.action || "used") });
      }
    }
    return { nodes, edges };
  } catch { return { nodes, edges }; }
}

/** 会话 UUID 转换（复用 agent-chat-memory 的确定性哈希） */
async function sessionToDbUuid(sessionId: string): Promise<string> {
  try {
    const { sessionToDbUuid } = await import("./agent-chat-memory.js");
    return sessionToDbUuid(sessionId);
  } catch { return sessionId; }
}

// ═══ F2: 从 checkpoint 分叉 ═══
/** 从任务 checkpoint 分叉新任务（复制计划+轮次, 新任务可独立演进） */
export async function forkTaskFromCheckpoint(taskId: string, newGoal?: string): Promise<{ taskId: string } | null> {
  try {
    const task = await pool.query(
      `select goal, plan, loop_count, checkpoint from agent_tasks where id = $1::uuid`,
      [taskId]
    );
    if (task.rows.length === 0) return null;
    const t = task.rows[0];
    const plan = t.plan || [];
    const goal = newGoal || String(t.goal || "分叉任务");
    // 新任务: 复制计划（重置步骤状态为 pending）, 记录分叉来源
    const resetPlan = (Array.isArray(plan) ? plan : []).map((s: any) => ({ ...s, status: "pending", result: undefined, detail: undefined, verification: undefined }));
    const r = await pool.query(
      `insert into agent_tasks (goal, status, plan, current_step, checkpoint, progress, updated_at)
       values ($1, 'planning', $2::jsonb, 0, $3::jsonb, $4, now()) returning id`,
      [goal, JSON.stringify(resetPlan), JSON.stringify({ ...(t.checkpoint || {}), forkedFrom: taskId, forkedAt: new Date().toISOString() }), `分叉自任务 ${taskId.slice(0, 8)}（计划已复制, 可独立演进）`]
    );
    return { taskId: r.rows[0].id };
  } catch { return null; }
}

export const agentSessionGraphService = { buildSessionGraph, forkTaskFromCheckpoint };
