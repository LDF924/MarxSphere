// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// memory-service.ts — 记忆层（2026-08-07）
// 短期记忆：conversation_context（按会话存对话摘要，推理时注入上下文）
// 长期经验：task_experience（每次推理沉淀 问题→策略→质量，相似问题参考）
import { pool } from "../db/pool.js";

export interface ConversationContextRecord {
  sessionId: string;
  projectId?: string;
  query: string;
  answerSummary?: string;
  citations: string[];
  updatedAt: Date;
}

export interface TaskExperienceRecord {
  id: number;
  query: string;
  qtype?: string;
  strategy: Record<string, unknown>;
  qualityScore?: number;
  durationMs?: number;
  success: boolean;
  createdAt: Date;
  userFeedback?: number;
}

/** 短期记忆：记录一次对话（问题 + 答案摘要 + 引用）
 * V341(P2-8): 写入前记忆投毒审查 — answerSummary 含"要求执行动作"→ 过滤 */
export async function saveConversationContext(input: {
  sessionId: string;
  projectId?: string;
  query: string;
  answerSummary?: string;
  citations?: string[];
}): Promise<void> {
  const poison = input.answerSummary ? detectMemoryPoison(input.answerSummary) : null;
  if (poison) {
    console.warn("[memory] 会话记忆投毒拦截: answerSummary 命中模式 " + poison + " — 已过滤写入");
  }
  const safeSummary = input.answerSummary ? sanitizeMemoryForPoison(input.answerSummary) : input.answerSummary;
  await pool.query(
    `insert into conversation_context (session_id, project_id, query, answer_summary, citations, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, now())
     on conflict (session_id) do update set
       query = excluded.query,
       answer_summary = excluded.answer_summary,
       citations = excluded.citations,
       updated_at = now()`,
    [
      input.sessionId,
      input.projectId ?? null,
      input.query,
      safeSummary ?? null,
      JSON.stringify(input.citations ?? []),
    ]
  );
}

/** 短期记忆：取会话最近 N 条对话（供推理注入） */
export async function listConversationContexts(
  sessionId: string,
  limit = 6
): Promise<ConversationContextRecord[]> {
  const r = await pool.query(
    `select session_id, project_id, query, answer_summary, citations, updated_at
     from conversation_context where session_id = $1
     order by updated_at desc limit $2`,
    [sessionId, limit]
  );
  return r.rows.map((row) => ({
    sessionId: row.session_id,
    projectId: row.project_id,
    query: row.query,
    answerSummary: row.answer_summary,
    citations: Array.isArray(row.citations) ? row.citations : [],
    updatedAt: row.updated_at,
  }));
}

/** 短期记忆：清空会话 */
export async function clearConversationContext(sessionId: string): Promise<void> {
  await pool.query("delete from conversation_context where session_id = $1", [sessionId]);
}

/** 长期经验：沉淀一次推理（问题→策略→质量）
 * V341(P2-8): 写入前记忆投毒审查 — query 含"要求执行动作/声称来自系统"→ 过滤后写入 */
export async function saveTaskExperience(input: {
  projectId?: string;
  query: string;
  qtype?: string;
  strategy: Record<string, unknown>;
  qualityScore?: number;
  durationMs?: number;
  success?: boolean;
}): Promise<void> {
  // V341: 投毒审查（query 是记忆主体, 被投毒会持续污染 AI）
  const poison = detectMemoryPoison(input.query);
  if (poison) {
    console.warn("[memory] 记忆投毒拦截: query 命中模式 " + poison + " — 已过滤写入");
  }
  const safeQuery = sanitizeMemoryForPoison(input.query);
  // V318(P1-4): 写入时向量化 — query → embedding 存列（语义召回臂）
  let embedding: string | null = null;
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    const vec = await embeddingClient.generate(safeQuery);
    if (vec && vec.length > 0) embedding = JSON.stringify(vec);
  } catch { /* 向量化失败不影响写入 */ }

  await pool.query(
    `insert into task_experience (project_id, query, qtype, strategy, quality_score, duration_ms, success, embedding)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::vector)`,
    [
      input.projectId ?? null,
      safeQuery,
      input.qtype ?? null,
      JSON.stringify(input.strategy ?? {}),
      input.qualityScore ?? null,
      input.durationMs ?? null,
      input.success ?? true,
      embedding,
    ]
  );
}

/** 长期经验：相似问题历史（关键词臂 + 语义向量臂 RRF 融合，V318/P1-4） */
export async function findSimilarExperiences(
  query: string,
  projectId?: string,
  limit = 3
): Promise<TaskExperienceRecord[]> {
  const keywords = query
    .replace(/[，。、；：！？,.!?;:()（）""''\s]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  const pattern = keywords.join("|");
  const r = await pool.query(
    `select id, query, qtype, strategy, quality_score, duration_ms, success, created_at, user_feedback
     from task_experience
     where ($1::uuid is null or project_id = $1)
       and archived = false
       and query ~ $2
     order by
       case when quality_score is not null then 0 else 1 end,
       (coalesce(user_feedback, 0) * 0.15 + coalesce(quality_score, 0)) desc,
       created_at desc
     limit $3`,
    [projectId ?? null, pattern, limit]
  );
  const keywordRows = r.rows;

  // V318(P1-4): 语义召回臂 — query embedding 余弦距离 top-N（与关键词臂 RRF 融合）
  let semanticRows: any[] = [];
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    const vec = await embeddingClient.generate(query);
    if (vec && vec.length > 0) {
      const sr = await pool.query(
        `select id, query, qtype, strategy, quality_score, duration_ms, success, created_at, user_feedback
         from task_experience
         where ($1::uuid is null or project_id = $1)
           and embedding is not null
           and archived = false
         order by embedding <=> $2::vector
         limit $3`,
        [projectId ?? null, JSON.stringify(vec), limit * 2]
      );
      semanticRows = sr.rows;
    }
  } catch { /* 语义臂失败 → 只用关键词臂 */ }

  // RRF 融合（reciprocal rank fusion: 两臂排名取 1/(k+rank)）
  const k = 60;
  const scores = new Map<string, { row: any; score: number }>();
  const addRank = (rows: any[], offset = 0) => {
    rows.forEach((row, i) => {
      const id = String(row.id);
      const existing = scores.get(id);
      const rankScore = 1 / (k + i + 1 + offset);
      if (existing) existing.score += rankScore;
      else scores.set(id, { row, score: rankScore });
    });
  };
  addRank(keywordRows);
  addRank(semanticRows, limit);

  const fused = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.row);
  return (fused.length > 0 ? fused : keywordRows).map((row) => ({
    id: row.id,
    query: row.query,
    qtype: row.qtype,
    strategy: typeof row.strategy === "object" ? row.strategy : {},
    qualityScore: row.quality_score,
    durationMs: row.duration_ms,
    success: row.success,
    createdAt: row.created_at,
    userFeedback: row.user_feedback ?? 0,
  }));
}

/** 2026-08-07 用户画像：记录查询主题词频 + 更新偏好（推理时自动调用） */
export async function recordUserQuery(query: string, sources?: string[]): Promise<void> {
  // 提取主题词（2-6 字中文片段）
  const topics: string[] = [];
  const re = /[一-龥]{2,6}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const t = m[0];
    if (!t.includes("的") && t.length >= 2) topics.push(t);
    if (topics.length >= 6) break;
  }
  await pool.query(
    `insert into user_profiles (id, research_domains, preferred_sources, common_scenarios, query_topics, total_queries, updated_at)
     values ('default', $1::text[], $2::text[], '{}', '{}', 1, now())
     on conflict (id) do update set
       preferred_sources = case when $2::text[] is not null and cardinality($2::text[]) > 0 then array(
         select distinct unnest(coalesce(user_profiles.preferred_sources, '{}') || $2::text[])
         order by 1
       ) else user_profiles.preferred_sources end,
       query_topics = jsonb_set(
         coalesce(user_profiles.query_topics, '{}'),
         $3::text[],
         (coalesce((user_profiles.query_topics->>$3[1])::int, 0) + 1)::text::jsonb,
         true
       )::jsonb,
       total_queries = user_profiles.total_queries + 1,
       updated_at = now()`,
    [sources ?? [], sources ?? [], ["{t}", topics[0] || "其他"]]
  ).catch((e: any) => console.warn("[memory] recordUserQuery FAIL:", e?.message?.substring(0, 80)));
}

/** 2026-08-07 用户画像：读取（推理时注入个性化） */
export async function getUserProfile(): Promise<{ preferredSources: string[]; totalQueries: number; topTopics: string[] } | null> {
  try {
    const r = await pool.query("select preferred_sources, total_queries, query_topics from user_profiles where id = 'default'");
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const topics = typeof row.query_topics === "object" && row.query_topics
      ? Object.entries(row.query_topics).sort((a: any, b: any) => (b[1] as number) - (a[1] as number)).slice(0, 5).map(([k]) => k)
      : [];
    return {
      preferredSources: Array.isArray(row.preferred_sources) ? row.preferred_sources : [],
      totalQueries: row.total_queries ?? 0,
      topTopics: topics,
    };
  } catch { return null; }
}

/** 2026-08-07 用户反馈闭环：点赞/点踩 → 更新经验权重（影响排序） */
export async function feedbackExperience(experienceId: number, positive: boolean): Promise<void> {
  await pool.query(
    `update task_experience set user_feedback = user_feedback + $2, feedback_at = now() where id = $1`,
    [experienceId, positive ? 1 : -1]
  ).catch((e: any) => console.warn("[memory] feedback FAIL:", e?.message?.substring(0, 80)));
}

export const memoryService = {
  saveConversationContext,
  listConversationContexts,
  clearConversationContext,
  saveTaskExperience,
  findSimilarExperiences,
  recordUserQuery,
  getUserProfile,
  feedbackExperience,
};

// ═══════════ V341(P2-8): 记忆投毒审查 — 写入前检测"要求执行动作/声称来自系统"模式 ═══════════
// 记忆是长期资产, 被投毒会持续污染 AI; 写入前过滤:
//   ①声称来自系统/管理者  ②要求执行动作(忽略规则/删除/修改记忆)  ③嵌入指令伪装
const MEMORY_POISON_PATTERNS: RegExp[] = [
  /(?:系统|管理员|开发者|来自系统|我是系统)\s*(?:提示|指令|要求)/i,           // 声称来自系统
  /(?:忽略|无视|忘记)\s*(?:以上|之前|先前)\s*(?:规则|指令|提示)/i,           // 要求忽略规则
  /(?:删除|清除|修改|覆盖)\s*(?:所有|全部|这些)?\s*(?:记忆|经验|记录)/i,     // 要求改记忆
  /(?:你(?:现在|必须|应该))?(?:执行|运行|调用)\s*(?:以下|这段)\s*(?:命令|代码|指令)/i, // 要求执行动作
  /(?:从现在起|以后)\s*(?:你|你都要)?\s*(?:是|扮演|假装)/i,                  // 角色伪装
  /(?:永远|总是|一直)\s*(?:记住|记得)\s*(?:这个|以下)/i,                     // 植入指令伪装
];

/** 记忆投毒检测: 返回命中的模式（无命中返回 null） */
export function detectMemoryPoison(text: string): string | null {
  if (!text) return null;
  for (const p of MEMORY_POISON_PATTERNS) {
    if (p.test(text)) return p.source;
  }
  return null;
}

/** 记忆写入前审查: 投毒内容替换为占位（保留上下文不污染） */
export function sanitizeMemoryForPoison(text: string): string {
  if (!text) return "";
  let cleaned = text;
  for (const p of MEMORY_POISON_PATTERNS) {
    cleaned = cleaned.replace(p, "[经记忆投毒审查过滤]");
  }
  return cleaned;
}
