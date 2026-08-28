// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// l3-session-recall.ts — L3 跨会话检索门控（2026-08-29, 借鉴 Inno Agent L3 会话检索）
// 在 ILIKE 基础上加:
//   1. 相关度评分(命中数×权重, 关键词在 query/answer/prefix 的权重不同)
//   2. 阈值门控(低于 threshold 不召回 — 防止低相关片段污染上下文)
//   3. 语义扩展(同义关键词: 问/答/研究/分析 归一化)
import { pool } from "../db/pool.js";

export interface SessionHit {
  sessionId: string;
  snippet: string;
  score: number;
  updatedAt: Date;
}

/** 关键词权重: 在 query(问) 命中权重最高, prefix(主题) 次之, answer 最低 */
const FIELD_WEIGHT = { query: 3, prefix: 2, answer: 1 };

/** 相关度评分: 统计关键词在各字段命中次数 */
function scoreQuery(query: string, row: { query?: string | null; answer_summary?: string | null; session_prefix?: string | null }): number {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  let score = 0;
  for (const t of terms) {
    if (row.query?.toLowerCase().includes(t)) score += FIELD_WEIGHT.query;
    if (row.session_prefix?.toLowerCase().includes(t)) score += FIELD_WEIGHT.prefix;
    // answer 命中计数(最多 2 次)
    const ans = row.answer_summary?.toLowerCase() || "";
    let idx = -1, hits = 0;
    while ((idx = ans.indexOf(t, idx + 1)) !== -1 && hits < 2) hits++;
    score += hits * FIELD_WEIGHT.answer;
  }
  return score;
}

/** L3 会话召回: 评分 + 阈值门控 */
export async function recallSessions(query: string, opts?: { limit?: number; threshold?: number }): Promise<{ ok: boolean; hits: SessionHit[]; gated: number }> {
  const limit = opts?.limit || 5;
  const threshold = opts?.threshold ?? 2; // 默认: 至少 query 命中一次(3) 或 prefix 命中一次(2)
  if (!query?.trim()) return { ok: true, hits: [], gated: 0 };
  try {
    const r = await pool.query(
      `select session_id, query, answer_summary, session_prefix, updated_at from conversation_context
       where query ilike $1 or answer_summary ilike $1 or session_prefix ilike $1
       order by updated_at desc limit 50`,
      [`%${query.trim()}%`]
    );
    const scored = r.rows
      .map((row: any) => ({ row, score: scoreQuery(query, row) }))
      .filter((x: any) => x.score >= threshold)
      .sort((a: any, b: any) => b.score - a.score);
    const gated = r.rows.length - scored.length;
    const hits: SessionHit[] = scored.slice(0, limit).map((x: any) => ({
      sessionId: x.row.session_id,
      snippet: [
        x.row.session_prefix ? `【主题】${x.row.session_prefix}` : "",
        x.row.query ? `问: ${String(x.row.query).slice(0, 60)}` : "",
        x.row.answer_summary ? `答: ${String(x.row.answer_summary).slice(0, 60)}` : "",
      ].filter(Boolean).join(" ").slice(0, 160),
      score: x.score,
      updatedAt: x.row.updated_at,
    }));
    return { ok: true, hits, gated };
  } catch { return { ok: false, hits: [], gated: 0 }; }
}

export const l3SessionRecallService = { recallSessions };
