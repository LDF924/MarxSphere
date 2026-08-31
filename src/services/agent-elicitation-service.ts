// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-elicitation-service.ts — V400: 澄清追问暂停协调 (openai/codex elicitation.rs 对齐)
// 借鉴 codex-rs/core/src/elicitation.rs:
//   - 计数注册: 多个并发 elicitation 期间 session 保持暂停, 直到全部结束 (outstanding=0)
//   - 工具结果等待追问: code_mode execute_handler 在把结果返回模型前 wait_until_clear()
//     → 避免工具结果与追问回答乱序
//   - 追问回答与请求 ID 关联, 作为用户输入回流
import { pool } from "../db/pool.js";
import { randomUUID } from "node:crypto";

interface ElicitationState {
  outstanding: number;
  paused: boolean;
  pending: Map<string, { question: string; createdAt: number }>;
}

const state: ElicitationState = { outstanding: 0, paused: false, pending: new Map() };

/** 注册一次追问(暂停开始) */
export function registerElicitation(taskId?: string, question?: string): string {
  state.outstanding += 1;
  state.paused = true;
  const id = randomUUID();
  if (question) {
    state.pending.set(id, { question, createdAt: Date.now() });
  }
  return id;
}

/** 释放一次追问(所有释放后暂停结束) */
export function releaseElicitation(id?: string): void {
  if (id) state.pending.delete(id);
  state.outstanding = Math.max(0, state.outstanding - 1);
  if (state.outstanding === 0) {
    state.paused = false;
  }
}

/** 是否处于暂停(有未完成追问) */
export function isPaused(): boolean {
  return state.paused;
}

/** V400 可视化: 当前待回答的追问列表(前端展示) */
export function listPendingElicitations(): Array<{ id: string; question: string; createdAt: number }> {
  return [...state.pending.entries()].map(([id, p]) => ({ id, question: p.question, createdAt: p.createdAt }));
}

/** 等待全部追问完成 (Promise 版 wait_until_clear; 轮询实现) */
export async function waitUntilClear(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (state.paused) {
    if (Date.now() - start > timeoutMs) {
      // 超时强制清除(避免死锁)
      state.outstanding = 0;
      state.paused = false;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 记录追问回答 (与请求 ID 关联, 回流为上下文) */
export async function recordElicitationAnswer(
  elicitationId: string,
  answer: string,
  taskId?: string
): Promise<{ ok: boolean; question?: string }> {
  const pending = state.pending.get(elicitationId);
  if (!pending) return { ok: false };
  state.pending.delete(elicitationId);
  releaseElicitation(elicitationId);
  // 回答落库(供下一轮 prompt 注入)
  try {
    await pool.query(
      `insert into agent_elicitation_answers (task_id, elicitation_id, question, answer)
       values ($1, $2, $3, $4)`,
      [taskId ?? null, elicitationId, pending.question, answer.slice(0, 2000)]
    );
  } catch { /* 落库失败不阻塞 */ }
  return { ok: true, question: pending.question };
}

/** 取任务待注入的追问回答 (供下一轮 prompt 拼接) */
export async function getPendingAnswers(taskId: string): Promise<string> {
  try {
    const r = await pool.query(
      `select question, answer from agent_elicitation_answers
       where task_id = $1::uuid and injected_at is null
       order by id limit 5`,
      [taskId]
    );
    if (r.rows.length === 0) return "";
    const parts = r.rows.map((row: any) => `【用户追问回答】问: ${row.question}\n答: ${row.answer}`);
    await pool.query(`update agent_elicitation_answers set injected_at = now() where task_id = $1::uuid and injected_at is null`, [taskId]);
    return parts.join("\n");
  } catch { return ""; }
}

/** 任务结束清理 */
export function clearElicitationState(): void {
  state.outstanding = 0;
  state.paused = false;
  state.pending.clear();
}

export const agentElicitationService = {
  registerElicitation, releaseElicitation, isPaused, waitUntilClear,
  recordElicitationAnswer, getPendingAnswers, clearElicitationState, listPendingElicitations,
};
