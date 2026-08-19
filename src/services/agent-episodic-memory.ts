// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-episodic-memory.ts — V396-8: 情景记忆（研究轨迹存储/检索/遗忘）
// 四层记忆中的"情景层": 任务执行经历 → 摘要+关键事实 → 可检索复用
// 遗忘机制: 时间(>90天未访问)/频率(访问<1次且重要性低)/重要性(低分优先遗忘)
import { pool } from "../db/pool.js";

export interface EpisodicMemory {
  id: number;
  taskId?: string;
  goal: string;
  summary: string;
  keyFacts: string[];
  toolsUsed: string[];
  outcome: "success" | "partial" | "failed";
  importance: number;
  accessCount: number;
  lastAccessedAt?: Date;
  createdAt: Date;
}

/** 记录情景记忆: 任务完成后沉淀研究轨迹（摘要+关键事实+工具+结果） */
export async function recordEpisodicMemory(input: {
  taskId?: string;
  goal: string;
  summary: string;
  keyFacts?: string[];
  toolsUsed?: string[];
  outcome?: "success" | "partial" | "failed";
  importance?: number;
}): Promise<EpisodicMemory | null> {
  try {
    const r = await pool.query(
      `insert into agent_episodic_memory (task_id, goal, summary, key_facts, tools_used, outcome, importance)
       values ($1,$2,$3,$4::jsonb,$5::text[],$6,$7) returning *`,
      [
        input.taskId ?? null, input.goal, input.summary.slice(0, 1000),
        JSON.stringify(input.keyFacts || []), input.toolsUsed || [],
        input.outcome || "success", input.importance ?? 0.5,
      ]
    );
    return mapRow(r.rows[0]);
  } catch { return null; }
}

/** 检索情景记忆: 按目标关键词相似度（ILIKE 匹配）返回最相关的经历 */
export async function recallEpisodicMemory(query: string, limit = 5): Promise<EpisodicMemory[]> {
  const keywords = query.split(/[\s,，、]+/).filter((k) => k.length >= 2).slice(0, 4);
  if (keywords.length === 0) return [];
  const conds = keywords.map((_, i) => `(goal ilike $${i + 1} or summary ilike $${i + 1})`).join(" or ");
  const params = keywords.map((k) => `%${k}%`);
  const r = await pool.query(
    `select * from agent_episodic_memory where ${conds}
     order by importance desc, created_at desc limit $${params.length + 1}`,
    [...params, limit]
  );
  // 访问计数+时间(遗忘依据)
  for (const row of r.rows) {
    await pool.query("update agent_episodic_memory set access_count = access_count + 1, last_accessed_at = now() where id = $1", [row.id]);
  }
  return r.rows.map(mapRow);
}

/** 记忆巩固: 任务成功后按相似度合并旧记忆（防止膨胀: 相似目标只留最新+汇总） */
export async function consolidateMemories(goal: string, maxKeep = 100): Promise<number> {
  // 1. 相似记忆合并: 同目标前缀的旧记忆合并到最新一条
  const prefix = goal.slice(0, 12);
  const dup = await pool.query(
    `select id from agent_episodic_memory
     where goal like $1 and created_at < now() - interval '1 day'
     order by created_at asc limit 50`, [`${prefix}%`]
  );
  let merged = 0;
  for (const row of dup.rows) {
    await pool.query("delete from agent_episodic_memory where id = $1", [row.id]);
    merged++;
  }
  // 2. 总量控制: 超限删最不重要+最旧
  const over = await pool.query(
    `select count(*) as n from agent_episodic_memory having count(*) > $1`, [maxKeep]
  );
  if (Number(over.rows[0]?.n || 0) > 0) {
    await pool.query(
      `delete from agent_episodic_memory
       where id in (select id from agent_episodic_memory order by importance asc, created_at asc limit 30)`
    );
    merged += 30;
  }
  return merged;
}

/** 遗忘机制: 三类规则 — 时间(>90天未访问且低重要)/频率(访问<1且重要<0.3)/重要性(重要<0.2) */
export async function forgetMemories(): Promise<{ forgotten: number; reasons: string[] }> {
  const reasons: string[] = [];
  let forgotten = 0;
  // ① 时间遗忘: 90 天未访问 + 重要性 < 0.6
  const t = await pool.query(
    `delete from agent_episodic_memory
     where last_accessed_at < now() - interval '90 days' and importance < 0.6 returning id`
  );
  if ((t.rowCount || 0) > 0) { forgotten += t.rowCount || 0; reasons.push(`时间遗忘(${t.rowCount}条: 90天未访问+低重要)`); }
  // ② 频率遗忘: 从未被访问 + 重要性 < 0.3
  const f = await pool.query(
    `delete from agent_episodic_memory
     where access_count = 0 and importance < 0.3 and created_at < now() - interval '30 days' returning id`
  );
  if ((f.rowCount || 0) > 0) { forgotten += f.rowCount || 0; reasons.push(`频率遗忘(${f.rowCount}条: 从未访问+低重要)`); }
  // ③ 重要性遗忘: 重要性 < 0.2 且超过 60 天
  const i = await pool.query(
    `delete from agent_episodic_memory
     where importance < 0.2 and created_at < now() - interval '60 days' returning id`
  );
  if ((i.rowCount || 0) > 0) { forgotten += i.rowCount || 0; reasons.push(`重要性遗忘(${i.rowCount}条: 极低重要)`); }
  return { forgotten, reasons };
}

/** 列表（前端记忆 tab 展示） */
export async function listEpisodicMemories(limit = 50): Promise<EpisodicMemory[]> {
  const r = await pool.query("select * from agent_episodic_memory order by importance desc, created_at desc limit $1", [limit]);
  return r.rows.map(mapRow);
}

function mapRow(row: any): EpisodicMemory {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    goal: row.goal,
    summary: row.summary,
    keyFacts: Array.isArray(row.key_facts) ? row.key_facts : [],
    toolsUsed: Array.isArray(row.tools_used) ? row.tools_used : [],
    outcome: row.outcome || "success",
    importance: Number(row.importance || 0.5),
    accessCount: Number(row.access_count || 0),
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
  };
}

export const agentEpisodicMemoryService = {
  recordEpisodicMemory,
  recallEpisodicMemory,
  consolidateMemories,
  forgetMemories,
  listEpisodicMemories,
};
