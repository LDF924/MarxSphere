// cost-service.ts — 成本监控 + 每任务成本上限（BOOK-GAP-ROADMAP P2-3）
// 聚合 retrieve_steps.parameters.tokens（真实 token 采集）→ 按任务/模型估算成本
// 单任务 token 上限（默认 100 万）超限 → 返回 shouldStop 供推理链路终止
// 单价配置: 环境变量 COST_PER_M_TOKEN（默认 $0.5/百万 token, DeepSeek 约价）

import { pool } from "../db/pool.js";

/** 模型单价（$/百万 token, 默认 DeepSeek 近似价） */
const COST_PER_M_IN = parseFloat(process.env.COST_PER_M_TOKEN_IN || "0.3");
const COST_PER_M_OUT = parseFloat(process.env.COST_PER_M_TOKEN_OUT || "1.2");

/** 单任务 token 上限（默认 100 万） */
export const TASK_TOKEN_BUDGET = parseInt(process.env.TASK_TOKEN_BUDGET || "1000000", 10);

/** 从 retrieve_steps.parameters 提取 token（兼容 tokens.in/out 或 tokens 对象） */
function extractTokens(params: any): { in: number; out: number } | null {
  if (!params || typeof params !== "object") return null;
  const t = params.tokens;
  if (!t || typeof t !== "object") return null;
  const tin = typeof t.in === "number" ? t.in : (typeof t.input === "number" ? t.input : 0);
  const tout = typeof t.out === "number" ? t.out : (typeof t.output === "number" ? t.output : 0);
  return { in: tin, out: tout };
}

export interface CostSummary {
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCost: number;   // 美元
  taskCount: number;
  byModel: Record<string, { tokensIn: number; tokensOut: number; cost: number }>;
}

/** 聚合全部成本（最近 N 天） */
export async function getCostSummary(days = 7): Promise<CostSummary> {
  const r = await pool.query(
    `select task_id, parameters from retrieve_steps
     where created_at > now() - make_interval(days => $1)
       and parameters is not null`,
    [days]
  );
  const summary: CostSummary = { totalTokensIn: 0, totalTokensOut: 0, estimatedCost: 0, taskCount: 0, byModel: {} };
  const tasks = new Set<string>();
  for (const row of r.rows) {
    let params: any = {};
    try { params = typeof row.parameters === "string" ? JSON.parse(row.parameters) : (row.parameters || {}); } catch {}
    const t = extractTokens(params);
    if (!t) continue;
    tasks.add(String(row.task_id));
    summary.totalTokensIn += t.in;
    summary.totalTokensOut += t.out;
    // 模型（parameters.model 或默认）
    const model = typeof params.model === "string" ? params.model : "unknown";
    const m = summary.byModel[model] || (summary.byModel[model] = { tokensIn: 0, tokensOut: 0, cost: 0 });
    m.tokensIn += t.in;
    m.tokensOut += t.out;
    const cost = (t.in / 1e6) * COST_PER_M_IN + (t.out / 1e6) * COST_PER_M_OUT;
    m.cost += cost;
    summary.estimatedCost += cost;
  }
  summary.taskCount = tasks.size;
  return summary;
}

/** 单任务 token 用量（供上限检查） */
export async function getTaskTokenUsage(taskId: string): Promise<{ tokensIn: number; tokensOut: number; overBudget: boolean }> {
  const r = await pool.query(
    `select parameters from retrieve_steps where task_id = $1 and parameters is not null`,
    [taskId]
  );
  let tokensIn = 0, tokensOut = 0;
  for (const row of r.rows) {
    let params: any = {};
    try { params = typeof row.parameters === "string" ? JSON.parse(row.parameters) : (row.parameters || {}); } catch {}
    const t = extractTokens(params);
    if (t) { tokensIn += t.in; tokensOut += t.out; }
  }
  return { tokensIn, tokensOut, overBudget: tokensIn + tokensOut > TASK_TOKEN_BUDGET };
}

/** 今日成本（按天, 前端面板用） */
export async function getTodayCost(): Promise<{ date: string; cost: number; tokensIn: number; tokensOut: number }> {
  const r = await pool.query(
    `select parameters from retrieve_steps
     where created_at > date_trunc('day', now()) and parameters is not null`
  );
  let tokensIn = 0, tokensOut = 0;
  for (const row of r.rows) {
    let params: any = {};
    try { params = typeof row.parameters === "string" ? JSON.parse(row.parameters) : (row.parameters || {}); } catch {}
    const t = extractTokens(params);
    if (t) { tokensIn += t.in; tokensOut += t.out; }
  }
  const cost = (tokensIn / 1e6) * COST_PER_M_IN + (tokensOut / 1e6) * COST_PER_M_OUT;
  return { date: new Date().toISOString().substring(0, 10), cost, tokensIn, tokensOut };
}
