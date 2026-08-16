// agent-exec-log.ts — V391(P2-4): 统一 Agent 执行日志
// 全链路记录: 工具调用/决策/成本 — 运维面板可查
// V395-2/7: 日志写入后经 SSE 实时推送（订阅该任务的 EventSource 连接）
import { pool } from "../db/pool.js";
import { publishAgentProgress } from "./agent-progress.js";

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
  // V396-3: span 树可观测性
  parentId?: number;
  spanType: "CHAIN" | "LLM" | "TOOL" | "AGENT" | "RETRIEVER";
  conversationId?: string;
}

/** 记录一次 Agent 执行动作（工具调用/决策/LLM）— V396-3 支持 span 树(parent_id/span_type/conversation_id) */
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
  parentId?: number;
  spanType?: "CHAIN" | "LLM" | "TOOL" | "AGENT" | "RETRIEVER";
  conversationId?: string;
  /** 差距S③(Codex turn_metadata): 轮次元数据 — 调用的模型/扩展信息 */
  model?: string;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  try {
    const r = await pool.query(
      `insert into agent_exec_logs (task_id, step_id, action, tool, input_summary, output_summary, cost_cents, tokens_in, tokens_out, status, duration_ms, parent_id, span_type, conversation_id, model, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       returning id`,
      [
        input.taskId ?? null, input.stepId ?? null, input.action, input.tool ?? null,
        (input.inputSummary || "").substring(0, 500), (input.outputSummary || "").substring(0, 500),
        input.costCents ?? 0, input.tokensIn ?? 0, input.tokensOut ?? 0,
        input.status ?? "ok", input.durationMs ?? 0,
        input.parentId ?? null, input.spanType ?? "TOOL", input.conversationId ?? null,
        input.model ?? null, input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );
    const logId = Number(r.rows[0]?.id || 0);
    // V395-2/7: 实时推送执行日志（SSE; 前端实时日志面板）
    if (input.taskId) {
      publishAgentProgress({
        type: "exec_log", taskId: input.taskId,
        data: {
          action: input.action, tool: input.tool ?? null, stepId: input.stepId ?? null,
          inputSummary: input.inputSummary ?? "", outputSummary: input.outputSummary ?? "",
          status: input.status ?? "ok", costCents: input.costCents ?? 0, durationMs: input.durationMs ?? 0,
          spanType: input.spanType ?? "TOOL", parentId: input.parentId ?? null,
          createdAt: new Date().toISOString(),
        },
      });
    }
    return logId;
  } catch { return null; }
}

/** V396-3: 按任务构建 span 树（执行 DAG 可视化数据: 节点+父子关系） */
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

/** 按任务查执行日志 */
export async function listAgentExecLogs(taskId?: string, limit = 100): Promise<AgentExecLog[]> {
  const r = taskId
    ? await pool.query("select * from agent_exec_logs where task_id = $1::uuid order by id desc limit $2", [taskId, limit])
    : await pool.query("select * from agent_exec_logs order by id desc limit $1", [limit]);
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
    parentId: row.parent_id ? Number(row.parent_id) : undefined,
    spanType: (row.span_type || "TOOL") as AgentExecLog["spanType"],
    conversationId: row.conversation_id || undefined,
  }));
}

/** V391(P2-5): 成本聚合 — 按任务聚合（单任务成本/总成本/预算使用率） */
export async function agentCostSummary(taskId?: string): Promise<{
  totalCostCents: number;
  totalTokens: number;
  execCount: number;
  byTool: Array<{ tool: string; costCents: number; count: number }>;
}> {
  const where = taskId ? "where task_id = $1::uuid" : "";
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
  buildExecSpanTree,  // V396-3: span 树（执行 DAG）
  /** V393-6: 用户×任务×成本×工具 聚合报表 */
  async agentAuditReport(days = 7): Promise<{
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
  },
};
