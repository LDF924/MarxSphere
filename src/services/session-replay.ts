// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// session-replay.ts — 会话回放导出（2026-08-29, 借鉴 Inno Agent case-exporter.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 行为对齐, 存储适配 MarxSphere mcp_sessions 表
// 导出任意真实会话为可回放 JSON:
//   - 消息流(user/assistant/tool 角色, 按时间序)
//   - 工具调用记录(名称/参数/结果)
//   - 清洗: 路径重写 + 密钥形状脱敏(回放可发布)
import { pool } from "../db/pool.js";

export interface ReplayMessage {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: Array<{ name: string; args: string; result: string }>;
}

export interface SessionReplay {
  id: string;
  title: string;
  recordedAt: string;
  messageCount: number;
  messages: ReplayMessage[];
  toolSummary: Array<{ name: string; count: number }>;
}

/** 密钥/路径脱敏(借鉴 Inno sanitize: 路径重写 + 常见密钥形状) */
export function sanitizeReplay(text: string): string {
  return text
    // 密钥形状: sk-xxx / sag_xxx / 长 base64
    .replace(/\b(sk|sag|Bearer|eyJ)[-_a-zA-Z0-9]{8,}\b/g, "[REDACTED]")
    // 本机路径
    .replace(/([A-Za-z]:)?[\\/][\w一-鿿]+(?:[\\/][\w一-鿿 .\-()（）]+)+/g, (m) => {
      if (/node_modules|\.claude|SAG-main/.test(m)) return "[PATH]";
      return m;
    });
}

/** 导出会话回放(与 Inno exportShowcaseCase 对齐: 消息+工具调用+清洗) */
export async function exportSessionReplay(sessionId: string): Promise<{ ok: boolean; replay?: SessionReplay; error?: string }> {
  try {
    const s = await pool.query("select id, title, kind, created_at, updated_at from mcp_sessions where id = $1", [sessionId]).catch(() => ({ rows: [] }));
    if (s.rows.length === 0) return { ok: false, error: "会话不存在" };
    const session = s.rows[0];

    const msgs = await pool.query(
      "select role, content, created_at from mcp_messages where session_id = $1 order by created_at, id",
      [sessionId]
    ).catch(() => ({ rows: [] }));
    const calls = await pool.query(
      "select tool_name, arguments, result, created_at from mcp_tool_calls where session_id = $1 order by created_at, id",
      [sessionId]
    ).catch(() => ({ rows: [] }));

    // 工具调用按时间归入对应消息(借鉴 Inno toolMessageIndex)
    const callIdx = new Map<string, number>();
    (calls.rows as any[]).forEach((c, i) => callIdx.set(String(c.created_at), i));

    const messages: ReplayMessage[] = (msgs.rows as any[]).map((m) => ({
      role: m.role,
      content: sanitizeReplay(String(m.content || "")).slice(0, 5000),
      timestamp: new Date(m.created_at).toISOString(),
      toolCalls: (calls.rows as any[])
        .filter((c) => Math.abs(new Date(c.created_at).getTime() - new Date(m.created_at).getTime()) < 30_000)
        .slice(0, 5)
        .map((c) => ({
          name: String(c.tool_name || ""),
          args: sanitizeReplay(String(c.arguments || "")).slice(0, 500),
          result: sanitizeReplay(String(c.result || "")).slice(0, 500),
        })),
    })).filter((m) => m.content || (m.toolCalls ?? []).length > 0);

    const toolCount = new Map<string, number>();
    for (const c of calls.rows as any[]) toolCount.set(String(c.tool_name), (toolCount.get(String(c.tool_name)) ?? 0) + 1);

    return {
      ok: true,
      replay: {
        id: String(session.id),
        title: String(session.title || "未命名会话"),
        recordedAt: new Date(session.created_at).toISOString(),
        messageCount: messages.length,
        messages,
        toolSummary: [...toolCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      },
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 列出可回放会话 */
export async function listReplayableSessions(limit = 30): Promise<Array<{ id: string; name: string; kind: string; updatedAt: string }>> {
  const r = await pool.query(
    "select id, title, kind, updated_at from mcp_sessions order by updated_at desc limit $1",
    [limit]
  ).catch(() => ({ rows: [] }));
  return (r.rows as any[]).map((x) => ({ id: String(x.id), name: String(x.title || "未命名"), kind: x.kind, updatedAt: new Date(x.updated_at).toISOString() }));
}

export const sessionReplayService = { exportSessionReplay, listReplayableSessions, sanitizeReplay };
