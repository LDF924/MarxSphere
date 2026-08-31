// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-reminder-service.ts — V400: 预算/时间提醒注入 (openai/codex 对齐)
// 借鉴 codex-rs:
//   - rollout_budget.rs:8  — Rollout 预算剩余 token 提醒(作为对话消息注入, 窗口去重)
//   - token_budget.rs:110  — TokenBudget 阈值提醒(每窗口一次, claim 去重)
//   - token_budget_context.rs:178 — TokenBudgetReminder 模板(阈值 6_144 tokens)
//   - current_time_reminder.rs:7  — 时间提醒(<current_time_reminder>It is {time}.</...>)
// 设计: 提醒作为消息注入下一轮 prompt(模型可见预算约束), 而非外部强打断;
//       窗口级去重(claim 机制), 避免每轮重复注入。
import { pool } from "../db/pool.js";

// ═══ Codex 对齐阈值 ═══
const REMINDER_THRESHOLD_TOKENS = 6144;          // TokenBudgetReminder 阈值
const FALLBACK_BUFFER_TOKENS = 16384;             // AutoCompactFallbackPrompt 缓冲
const ROLLOUT_REMINDER_EVERY = 50_000;            // 每消耗 50K token 提醒一次

interface ReminderState {
  lastReminderWindow: string;      // 窗口 id 去重键
  lastRolloutReminderTokens: number;
  fallbackClaimed: boolean;
  /** V400 可视化: 最近提醒日志(内容级展示) */
  log: Array<{ at: string; kind: string; message: string }>;
}

/** V400: 记录提醒日志(供前端展示) */
function logReminder(taskId: string, kind: string, message: string): void {
  const s = getState(taskId);
  s.log.unshift({ at: new Date().toLocaleTimeString("zh-CN", { hour12: false }), kind, message: message.slice(0, 150) });
  s.log = s.log.slice(0, 10);
}

/** V400: 取最近提醒日志(前端可视化) */
export function getReminderLog(taskId?: string): Array<{ at: string; kind: string; message: string }> {
  if (taskId) return (state.get(taskId)?.log || []);
  // 无 taskId → 聚合全部(最多 20 条)
  const all: Array<{ at: string; kind: string; message: string }> = [];
  for (const s of state.values()) all.push(...s.log);
  return all.slice(0, 20);
}

const state = new Map<string, ReminderState>();

function getState(taskId: string): ReminderState {
  let s = state.get(taskId);
  if (!s) {
    s = { lastReminderWindow: "", lastRolloutReminderTokens: 0, fallbackClaimed: false, log: [] };
    state.set(taskId, s);
  }
  return s;
}

/** 估算 token(近似: 中文≈1字/token, 英文≈4字符/token) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

/** 聚合任务已消耗 token (exec_logs) */
async function taskTokensUsed(taskId: string): Promise<number> {
  try {
    const r = await pool.query(
      `select coalesce(sum(tokens_in + tokens_out), 0)::int as used from agent_exec_logs where task_id = $1::uuid`,
      [taskId]
    );
    return Number(r.rows[0]?.used || 0);
  } catch { return 0; }
}

/** 聚合当前任务上下文量(plan 步骤结果总字符 → token) */
export async function taskContextTokens(taskId: string): Promise<number> {
  try {
    const r = await pool.query(
      `select coalesce(sum(length(coalesce(result,''))), 0)::int as chars from agent_task_steps where task_id = $1::uuid`,
      [taskId]
    );
    return estimateTokens(String(r.rows[0]?.chars || 0));
  } catch { return 0; }
}

/** 任务上下文窗口上限(默认 32K, 可配置) */
export function contextWindowLimit(): number {
  return parseInt(process.env.AGENT_CONTEXT_WINDOW_LIMIT || "32000", 10);
}

// ═══ 三种提醒 ═══

/**
 * ① Rollout 预算提醒 (codex rollout_budget.rs)
 * 任务级 token 消耗达每 50K 提醒一次, 注入"已用/剩余"约束消息
 */
export async function rolloutReminder(taskId: string, goal: string): Promise<string | null> {
  const s = getState(taskId);
  const used = await taskTokensUsed(taskId);
  const budget = parseInt(process.env.AGENT_TASK_TOKEN_BUDGET || "400000", 10);
  // 每 50K 提醒一次(窗口去重)
  const bucket = Math.floor(used / ROLLOUT_REMINDER_EVERY);
  if (bucket <= Math.floor(s.lastRolloutReminderTokens / ROLLOUT_REMINDER_EVERY)) return null;
  s.lastRolloutReminderTokens = used;
  const remaining = Math.max(0, budget - used);
  const msg = `【预算提醒】本任务已消耗约 ${Math.round(used / 1000)}K token（上限 ${Math.round(budget / 1000)}K），剩余约 ${Math.round(remaining / 1000)}K。请在剩余预算内收敛产出: 优先完成核心维度, 避免冗余检索与重复尝试。`;
  logReminder(taskId, "rollout", msg);
  return msg;
}

/**
 * ② TokenBudget 阈值提醒 (codex token_budget_context.rs, 阈值 6_144)
 * 上下文窗口剩余 ≤ 6_144 时注入一次(每窗口 claim 去重)
 */
export async function tokenBudgetReminder(taskId: string, windowId: string): Promise<string | null> {
  const s = getState(taskId);
  if (s.lastReminderWindow === windowId) return null;  // 窗口级去重
  const ctxTokens = await taskContextTokens(taskId);
  const remaining = contextWindowLimit() - ctxTokens;
  if (remaining > REMINDER_THRESHOLD_TOKENS) return null;
  s.lastReminderWindow = windowId;
  const msg = `【上下文预算提醒】当前上下文窗口剩余约 ${remaining.toLocaleString()} tokens（阈值 ${REMINDER_THRESHOLD_TOKENS.toLocaleString()}）。请立即收敛: 完成当前步骤后停止展开新分支, 在剩余预算内给出结论。`;
  logReminder(taskId, "token_budget", msg);
  return msg;
}

/**
 * ③ 压缩回退提示 (codex AutoCompactFallbackPrompt)
 * 上下文零剩余且未 claim 过 → 注入降级引导(引导模型改用压缩摘要继续)
 */
export async function compactFallbackPrompt(taskId: string, windowId: string): Promise<string | null> {
  const s = getState(taskId);
  if (s.fallbackClaimed) return null;
  const ctxTokens = await taskContextTokens(taskId);
  const remaining = contextWindowLimit() - ctxTokens;
  if (remaining > FALLBACK_BUFFER_TOKENS) return null;
  s.fallbackClaimed = true;
  const msg = `【上下文已压缩】历史上下文已超出窗口, 已由系统压缩为摘要。后续轮次: 基于摘要继续, 不再引用被压缩的细节; 优先推进剩余关键步骤并收敛产出。`;
  logReminder(taskId, "compact_fallback", msg);
  return msg;
}

/**
 * ④ 时间提醒 (codex current_time_reminder.rs)
 * 每次调用返回当前时间提醒(Agent 需感知时间)
 */
export function currentTimeReminder(): string {
  const now = new Date();
  const cn = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return `<current_time_reminder>It is ${now.toISOString()} (本地时间 ${cn}).</current_time_reminder>`;
}

/**
 * 汇总: 注入所有到期提醒(在 reflect/replan 前调用, 拼进 prompt)
 */
export async function buildReminders(taskId: string, goal: string, windowId: string): Promise<string> {
  const parts: string[] = [];
  const r1 = await rolloutReminder(taskId, goal);
  if (r1) parts.push(r1);
  const r2 = await tokenBudgetReminder(taskId, windowId);
  if (r2) parts.push(r2);
  const r3 = await compactFallbackPrompt(taskId, windowId);
  if (r3) parts.push(r3);
  if (parts.length === 0) return "";
  return `\n\n${parts.join("\n")}`;
}

/** 任务结束清理状态 */
export function clearReminderState(taskId: string): void {
  state.delete(taskId);
}

/**
 * A9: 滚动窗口推进 (codex turn.rs:461 对齐)
 * 压缩发生后调用: 记录窗口号, 使后续 tokenBudgetReminder 进入新窗口去重
 */
export function advanceContextWindow(taskId: string, windowId: string): void {
  const s = getState(taskId);
  s.lastReminderWindow = windowId;
}

export const agentReminderService = { estimateTokens, rolloutReminder, tokenBudgetReminder, compactFallbackPrompt, currentTimeReminder, buildReminders, clearReminderState, contextWindowLimit, advanceContextWindow, getReminderLog };
