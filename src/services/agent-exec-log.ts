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
}): Promise<void> {
  try {
    await pool.query(
      `insert into agent_exec_logs (task_id, step_id, action, tool, input_summary, output_summary, cost_cents, tokens_in, tokens_out, status, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.taskId ?? null, input.stepId ?? null, input.action, input.tool ?? null,
        (input.inputSummary || "").substring(0, 500), (input.outputSummary || "").substring(0, 500),
        input.costCents ?? 0, input.tokensIn ?? 0, input.tokensOut ?? 0,
        input.status ?? "ok", input.durationMs ?? 0,
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

export const agentExecLogService = {
  logAgentExec,
  listAgentExecLogs,
  agentCostSummary,
};
