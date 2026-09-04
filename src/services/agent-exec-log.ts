// agent-exec-log.ts — V391(P2-4): 统一 Agent 执行日志
// 全链路记录: 工具调用/决策/成本 — 运维面板可查
import { pool } from "../db/pool.js";

export interface AgentExecLog {
  id: number;
  taskId?: string;
  stepId?: string;
  action: string;
  tool?: string;
  inputSummary?: string;
  outputSummary?: string;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  status: string;
  durationMs: number;
  createdAt: Date;
}

/** 记录一次 Agent 执行动作（工具调用/决策/LLM） */
export async function logAgentExec(input: {
  taskId?: string;
  stepId?: string;
  action: string;
  tool?: string;
  inputSummary?: string;
  outputSummary?: string;
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
  status?: string;
  durationMs?: number;
  spanType?: string; // 迁移067: 执行类型(LLM/TOOL/APPROVAL…), 默认 TOOL
  model?: string;    // V404-3: 实际使用的模型(迁移076 已有 model 列) — 路由反馈对齐查询用
}): Promise<void> {
  try {
    await pool.query(
      `insert into agent_exec_logs (task_id, step_id, action, tool, input_summary, output_summary, cost_cents, tokens_in, tokens_out, status, duration_ms, span_type, model)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.taskId ?? null, input.stepId ?? null, input.action, input.tool ?? null,
        (input.inputSummary || "").substring(0, 500), (input.outputSummary || "").substring(0, 500),
        input.costCents ?? 0, input.tokensIn ?? 0, input.tokensOut ?? 0,
        input.status ?? "ok", input.durationMs ?? 0,
        input.spanType ?? "TOOL",
        input.model ?? null,
      ]
    );
  } catch { /* 日志失败不阻塞 */ }
}

/** 按任务查执行日志 */
export async function listAgentExecLogs(taskId?: string, limit = 100): Promise<AgentExecLog[]> {
  const r = taskId
    ? await pool.query("select * from agent_exec_logs where task_id = $1::uuid order by id desc limit $2", [taskId, limit])
    : await pool.query("select * from agent_exec_logs order by id desc limit $2", [limit]);
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    taskId: row.task_id,
    stepId: row.step_id,
    action: row.action,
    tool: row.tool,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    costCents: Number(row.cost_cents),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    status: row.status,
    durationMs: Number(row.duration_ms),
    createdAt: row.created_at,
  }));
}

/** V391(P2-5): 成本聚合 — 按任务聚合（单任务成本/总成本/预算使用率） */
export async function agentCostSummary(taskId?: string): Promise<{
  totalCostCents: number;
  totalTokens: number;
  execCount: number;
  byTool: Array<{ tool: string; costCents: number; count: number }>;
}> {
  const where = taskId ? "where task_id = $1" : "";
  const params = taskId ? [taskId] : [];
  const agg = await pool.query(
    `select coalesce(sum(cost_cents),0) as cost, coalesce(sum(tokens_in+tokens_out),0) as tokens, count(*) as n
     from agent_exec_logs ${where}`, params
  );
  const byTool = await pool.query(
    `select coalesce(tool,'-') as tool, sum(cost_cents) as cost, count(*) as n
     from agent_exec_logs ${where} group by tool order by cost desc limit 10`, params
  );
  return {
    totalCostCents: Number(agg.rows[0]?.cost || 0),
    totalTokens: Number(agg.rows[0]?.tokens || 0),
    execCount: Number(agg.rows[0]?.n || 0),
    byTool: byTool.rows.map((r: any) => ({ tool: r.tool, costCents: Number(r.cost), count: Number(r.n) })),
  };
}

export async function buildExecSpanTree(taskId: string): Promise<Array<{
  id: number; parentId: number | null; spanType: string; action: string; tool: string | null;
  status: string; costCents: number; durationMs: number; inputSummary: string; outputSummary: string; createdAt: string;
}>> {
  const r = await pool.query(
    `select id, parent_id, span_type, action, tool, status, cost_cents, duration_ms, input_summary, output_summary, created_at
     from agent_exec_logs where task_id = $1::uuid order by id asc`,
    [taskId]
  );
  return r.rows.map((row: any) => ({
    id: Number(row.id),
    parentId: row.parent_id ? Number(row.parent_id) : null,
    spanType: row.span_type || "TOOL",
    action: row.action,
    tool: row.tool,
    status: row.status,
    costCents: Number(row.cost_cents),
    durationMs: Number(row.duration_ms),
    inputSummary: row.input_summary || "",
    outputSummary: row.output_summary || "",
    createdAt: row.created_at,
  }));
}

/** V393-6: Agent 审计溯源报表(近 N 天总任务/成本/token/按工具分布/最近 50 条) */
export async function agentAuditReport(days = 7): Promise<{
  totalTasks: number;
  totalCostCents: number;
  totalTokens: number;
  byTool: Array<{ tool: string; costCents: number; count: number }>;
  recentTasks: Array<{ taskId: string; stepId: string; action: string; tool: string; costCents: number; createdAt: string }>;
}> {
  const agg = await pool.query(
    `select coalesce(sum(cost_cents),0) as cost, coalesce(sum(tokens_in+tokens_out),0) as tokens, count(*) as n
     from agent_exec_logs where created_at > now() - ($1 || ' days')::interval`, [String(Math.min(days, 90))]
  );
  const byTool = await pool.query(
    `select coalesce(tool,'-') as tool, sum(cost_cents) as cost, count(*) as n
     from agent_exec_logs where created_at > now() - ($1 || ' days')::interval
     group by tool order by cost desc limit 10`, [String(Math.min(days, 90))]
  );
  const recent = await pool.query(
    `select task_id, step_id, action, tool, cost_cents, created_at
     from agent_exec_logs where created_at > now() - ($1 || ' days')::interval
     order by id desc limit 50`, [String(Math.min(days, 90))]
  );
  return {
    totalTasks: Number(agg.rows[0]?.n || 0),
    totalCostCents: Number(agg.rows[0]?.cost || 0),
    totalTokens: Number(agg.rows[0]?.tokens || 0),
    byTool: byTool.rows.map((r: any) => ({ tool: r.tool, costCents: Number(r.cost), count: Number(r.n) })),
    recentTasks: recent.rows.map((r: any) => ({
      taskId: r.task_id, stepId: r.step_id, action: r.action, tool: r.tool,
      costCents: Number(r.cost_cents), createdAt: r.created_at,
    })),
  };
}

export const agentExecLogService = {
  logAgentExec,
  listAgentExecLogs,
  buildExecSpanTree,  // V396-12: span 树(前端 trace 可视化)
  agentCostSummary,
  agentAuditReport,   // V393-6: 审计溯源报表
};
