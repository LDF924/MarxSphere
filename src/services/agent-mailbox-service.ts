// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-mailbox-service.ts — V400 B2: Mailbox 双通道 (openai/codex input_queue.rs 对齐)
// 借鉴 codex InputQueue.mailbox:
//   - enqueue_mailbox_communication: 多代理邮件入队 + activity 通知
//   - MailboxDeliveryPhase: CurrentTurn(可并入当前请求) / NextTurn(迟到留到下一回合)
//   - 子代理完成/结果经 mailbox 回流父代理
// 实现: worker 完成消息 → mailbox → 主管轮询/推送时取用(不阻塞主循环)
import { pool } from "../db/pool.js";

interface MailboxItem {
  id: string;
  fromAgent: string;
  toAgent: string;
  kind: "result" | "status" | "note";
  payload: Record<string, unknown>;
  createdAt: number;
  /** CurrentTurn: 可并入当前回合; NextTurn: 留到下一回合 */
  phase: "current" | "next";
  delivered: boolean;
}

const mailbox = new Map<string, MailboxItem[]>();  // taskId → items

/** 邮件入队(codex enqueue_mailbox_communication 对齐) */
export function enqueueMailbox(
  taskId: string,
  input: { fromAgent: string; toAgent: string; kind: "result" | "status" | "note"; payload: Record<string, unknown> }
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items = mailbox.get(taskId) || [];
  items.push({ id, ...input, createdAt: Date.now(), phase: "current", delivered: false });
  mailbox.set(taskId, items);
  return id;
}

/** 取未投递邮件(codex get_pending_input 对齐) */
export function drainMailbox(taskId: string): MailboxItem[] {
  const items = mailbox.get(taskId) || [];
  const pending = items.filter((m) => !m.delivered);
  for (const m of pending) m.delivered = true;
  return pending;
}

/** 是否有未投递邮件(供主循环判断是否续跑) */
export function hasPendingMail(taskId: string): boolean {
  return (mailbox.get(taskId) || []).some((m) => !m.delivered);
}

/** 回合结束: 未投递邮件延到下一回合(codex MailboxDeliveryPhase::NextTurn 对齐) */
export function deferToNextTurn(taskId: string): void {
  for (const m of mailbox.get(taskId) || []) {
    if (!m.delivered) m.phase = "next";
  }
}

/** 任务清理 */
export function clearMailbox(taskId: string): void {
  mailbox.delete(taskId);
}

export const agentMailboxService = { enqueueMailbox, drainMailbox, hasPendingMail, deferToNextTurn, clearMailbox };
