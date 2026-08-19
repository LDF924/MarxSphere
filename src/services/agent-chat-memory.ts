// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-chat-memory.ts — V395-3: Agent 对话记忆（多轮上下文）
// /api/agent/chat 会话上下文: "帮我研究X"→"重点看Y" 连续对话
// 存储: 内存 Map（本进程多轮, 每会话最近 20 条）+ conversation_context 表（摘要持久化, 重启恢复）
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";

export interface AgentChatTurn {
  role: "user" | "assistant";
  content: string;
  ts: number;
  /** 关联的任务（assistant 消息: 创建的任务 id） */
  taskId?: string;
}

const MAX_TURNS = 20;
/** 内存会话历史: sessionId → 消息轮次（最新在前, 超限裁剪） */
const sessions = new Map<string, AgentChatTurn[]>();
/** G10: 会话 TTL — 闲置 24 小时未访问的会话自动清除（防内存泄漏; 持久化摘要仍在 DB 可恢复） */
const SESSION_TTL_MS = parseInt(process.env.AGENT_CHAT_SESSION_TTL_MS || "86400000", 10);  // 默认 24h
const lastTouch = new Map<string, number>();

/** G10: 触摸会话（更新 TTL 时间戳） */
function touchSession(sessionId: string): void {
  lastTouch.set(sessionId, Date.now());
}

/** G10: 清理过期会话（惰性巡检 — 会话数超阈值才扫, 防高频调用开销） */
function pruneExpiredSessions(now = Date.now()): void {
  if (lastTouch.size < 1000 && sessions.size < 500) return;
  for (const [sid, ts] of lastTouch) {
    if (now - ts > SESSION_TTL_MS) {
      sessions.delete(sid);
      lastTouch.delete(sid);
    }
  }
}

/**
 * conversation_context 表 session_id 是 uuid 类型 — 任意 sessionId（如前端自定义串）
 * 确定性哈希为合法 UUID（md5 16 字节 → 按 RFC4122 版本 3 格式），进程重启后同一 sessionId
 * 仍映射同一 UUID, DB 恢复可用。内存 Map 仍用原始 sessionId 作 key。
 */
export function sessionToDbUuid(sessionId: string): string {
  const hash = createHash("md5").update("agent-chat:" + sessionId).digest("hex");
  // v3 UUID: 8-4-4-4-12, 版本 3 + 变体 8
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-3${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** 追加一轮对话（内存 + 异步持久化摘要到 conversation_context） */
export function appendAgentChat(sessionId: string, role: "user" | "assistant", content: string, taskId?: string): void {
  if (!sessionId) return;
  pruneExpiredSessions();
  touchSession(sessionId);
  const turns = sessions.get(sessionId) || [];
  turns.unshift({ role, content: content.slice(0, 2000), ts: Date.now(), taskId });
  sessions.set(sessionId, turns.slice(0, MAX_TURNS));
  // 持久化摘要（防进程重启丢记忆; 表结构一会话一行, 存最新摘要）
  if (role === "assistant") {
    void pool.query(
      `insert into conversation_context (session_id, query, answer_summary, session_prefix, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (session_id) do update set
         query = excluded.query, answer_summary = excluded.answer_summary, session_prefix = coalesce(excluded.session_prefix, conversation_context.session_prefix), updated_at = now()`,
      [sessionToDbUuid(sessionId), content.slice(0, 2000), content.slice(0, 800), null]
    ).catch(() => { /* 持久化失败不影响对话 */ });
  }
}

/** 差距G③(Codex session_prefix): 设置会话前缀 — 会话级研究目标锚点（续作/规划注入用） */
export async function setAgentChatPrefix(sessionId: string, prefix: string): Promise<void> {
  if (!sessionId || !prefix?.trim()) return;
  await pool.query(
    `insert into conversation_context (session_id, query, answer_summary, session_prefix, updated_at)
     values ($1, '（会话前缀）', '', $2, now())
     on conflict (session_id) do update set session_prefix = excluded.session_prefix, updated_at = now()`,
    [sessionToDbUuid(sessionId), prefix.trim().slice(0, 500)]
  ).catch(() => {});
}

/** 取会话前缀（续作任务注入） */
export async function getAgentChatPrefix(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const r = await pool.query(
      `select session_prefix from conversation_context where session_id = $1 and session_prefix is not null`,
      [sessionToDbUuid(sessionId)]
    );
    return r.rows[0]?.session_prefix || null;
  } catch { return null; }
}

/** 取会话最近 N 轮（用户视角: 旧→新; 空会话返回 []） */
export async function getAgentChatHistory(sessionId: string, limit = 10): Promise<AgentChatTurn[]> {
  if (!sessionId) return [];
  pruneExpiredSessions();
  touchSession(sessionId);
  let turns = sessions.get(sessionId);
  // 内存无记录 → 尝试从 DB 恢复（进程重启后找回最近摘要）
  if (!turns || turns.length === 0) {
    try {
      const r = await pool.query(
        `select query, answer_summary, session_prefix from conversation_context where session_id = $1`,
        [sessionToDbUuid(sessionId)]
      );
      if (r.rows.length > 0) {
        turns = [];
        if (r.rows[0].session_prefix) turns.push({ role: "assistant", content: `【会话主题】${r.rows[0].session_prefix}`, ts: 0 });
        if (r.rows[0].answer_summary) turns.push({ role: "assistant", content: String(r.rows[0].answer_summary), ts: 0 });
        turns.push({ role: "user", content: String(r.rows[0].query), ts: 0 });
        sessions.set(sessionId, turns);
      }
    } catch { /* DB 恢复失败 → 空历史 */ }
  }
  return (turns || []).slice(0, limit).reverse();
}

/** 差距K③(DSH session): 最近活跃会话列表（跨会话记忆召回 — 续作/规划注入用） */
export async function listRecentAgentSessions(limit = 5): Promise<Array<{ sessionId: string; prefix: string; updatedAt: Date }>> {
  try {
    const r = await pool.query(
      `select session_id, session_prefix, updated_at from conversation_context
       where session_prefix is not null
       order by updated_at desc limit $1`,
      [limit]
    );
    return r.rows.map((row: any) => ({
      sessionId: row.session_id,
      prefix: String(row.session_prefix || "").slice(0, 80),
      updatedAt: row.updated_at,
    }));
  } catch { return []; }
}

/** 差距Q①(DSH session-query): 会话全文检索 — 跨会话搜索 query/摘要/前缀（找回历史研究） */
export async function searchAgentSessions(query: string, limit = 10): Promise<Array<{ sessionId: string; snippet: string; updatedAt: Date }>> {
  if (!query?.trim()) return [];
  try {
    const r = await pool.query(
      `select session_id, query, answer_summary, session_prefix, updated_at from conversation_context
       where query ilike $1 or answer_summary ilike $1 or session_prefix ilike $1
       order by updated_at desc limit $2`,
      [`%${query.trim()}%`, limit]
    );
    return r.rows.map((row: any) => {
      const snippet = [
        row.session_prefix ? `【主题】${row.session_prefix}` : "",
        row.query ? `问: ${String(row.query).slice(0, 60)}` : "",
        row.answer_summary ? `答: ${String(row.answer_summary).slice(0, 60)}` : "",
      ].filter(Boolean).join(" ");
      return { sessionId: row.session_id, snippet: snippet.slice(0, 160), updatedAt: row.updated_at };
    });
  } catch { return []; }
}

/** 清空会话记忆（内存 + DB） */
export async function clearAgentChat(sessionId: string): Promise<void> {
  sessions.delete(sessionId);
  await pool.query("delete from conversation_context where session_id = $1", [sessionToDbUuid(sessionId)]).catch(() => {});
}

/** 会话最新研究目标（最后一条用户消息, 供"继续/续作"意图使用）
 * 内存为空时从 conversation_context 表恢复（进程重启后仍可续作） */
export async function getAgentChatLastGoal(sessionId: string): Promise<string | null> {
  pruneExpiredSessions();
  touchSession(sessionId);
  const turns = sessions.get(sessionId);
  const lastUser = turns?.find((t) => t.role === "user");
  if (lastUser?.content) return lastUser.content;
  // 内存无记录 → DB 恢复（表存最近一次用户 query）
  try {
    const r = await pool.query(
      `select query from conversation_context where session_id = $1`,
      [sessionToDbUuid(sessionId)]
    );
    if (r.rows.length > 0 && r.rows[0].query) {
      return String(r.rows[0].query);
    }
  } catch { /* DB 恢复失败 */ }
  return null;
}

/** 会话活跃度（运维/测试） */
export function agentChatSessionCount(): number {
  return sessions.size;
}

export const agentChatMemory = {
  appendAgentChat,
  getAgentChatHistory,
  clearAgentChat,
  getAgentChatLastGoal,
  agentChatSessionCount,
  // 差距G③: 会话前缀（目标锚点）
  setAgentChatPrefix,
  getAgentChatPrefix,
  // 差距K③: 最近会话列表（跨会话记忆召回）
  listRecentAgentSessions,
  // 差距Q①: 会话全文检索
  searchAgentSessions,
};
