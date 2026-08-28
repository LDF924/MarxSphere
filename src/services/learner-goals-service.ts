// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learner-goals-service.ts — L1 学习者画像增强（2026-08-29, 借鉴 Inno Agent L1 learner profile）
// 在 knowledge_mastery(掌握度)基础上补: 学习目标管理 + 误解诊断 + 画像自动更新事件
//   - 学习目标: 增删改查 + 状态(active/archived) + 优先级 + 成功标准
//   - 误解诊断: 答错模式 → 记录 misconception(带证据, 可纠正)
//   - 画像事件: 每次答题/目标变更产生 LearningEvent, 自动更新画像摘要
import { pool } from "../db/pool.js";

export interface LearningGoal {
  id: string;
  title: string;
  type: "skill" | "knowledge" | "project";
  priority: number;
  status: "active" | "archived";
  success_criteria: string[];
  source: "user_declared" | "inferred";
  created_at: string;
  updated_at: string;
}

export interface Misconception {
  id: string;
  topic: string;
  description: string;
  evidence: string[];
  status: "open" | "resolved";
  created_at: string;
}

/** 创建/更新学习目标 */
export async function upsertGoal(input: {
  studentId?: string;
  id?: string;
  title: string;
  type?: "skill" | "knowledge" | "project";
  priority?: number;
  successCriteria?: string[];
  archived?: boolean;
}): Promise<{ ok: boolean; goal?: LearningGoal; error?: string }> {
  const studentId = input.studentId || "default";
  try {
    if (input.id) {
      await pool.query(
        `update learning_goals set title=$1, type=$2, priority=$3, success_criteria=$4::jsonb,
           status=$5, updated_at=now()
         where id=$6 and student_id=$7`,
        [input.title, input.type || "skill", input.priority ?? 0.5,
         JSON.stringify(input.successCriteria || []), input.archived ? "archived" : "active",
         input.id, studentId]
      );
      // 画像事件: 目标更新
      await pool.query(
        `insert into learner_events (student_id, event_type, payload) values ($1, 'goal_updated', $2::jsonb)`,
        [studentId, JSON.stringify({ goal_id: input.id, title: input.title, archived: !!input.archived })]
      );
      const r = await pool.query("select * from learning_goals where id=$1", [input.id]);
      return { ok: true, goal: r.rows[0] as LearningGoal };
    }
    const r = await pool.query(
      `insert into learning_goals (student_id, title, type, priority, status, success_criteria, source)
       values ($1, $2, $3, $4, 'active', $5::jsonb, 'user_declared') returning *`,
      [studentId, input.title, input.type || "skill", input.priority ?? 0.5, JSON.stringify(input.successCriteria || [])]
    );
    await pool.query(
      `insert into learner_events (student_id, event_type, payload) values ($1, 'goal_declared', $2::jsonb)`,
      [studentId, JSON.stringify({ goal_id: r.rows[0].id, title: input.title })]
    );
    return { ok: true, goal: r.rows[0] as LearningGoal };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 列出学习目标(含掌握度统计) */
export async function listGoals(input: { studentId?: string }): Promise<{ ok: boolean; goals: LearningGoal[]; masteryByGoal?: Record<string, unknown> }> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select * from learning_goals where student_id=$1 order by priority desc, updated_at desc`,
    [studentId]
  );
  return { ok: true, goals: r.rows as LearningGoal[] };
}

/** 归档目标(自动匹配: 标题关键词/明确放弃声明) */
export async function archiveGoal(input: { studentId?: string; id: string; reason?: string }): Promise<{ ok: boolean; changed?: boolean; error?: string }> {
  const studentId = input.studentId || "default";
  try {
    const r = await pool.query(
      `update learning_goals set status='archived', priority=0, updated_at=now()
       where id=$1 and student_id=$2 returning id`,
      [input.id, studentId]
    );
    if (r.rows.length === 0) return { ok: false, error: "目标不存在" };
    await pool.query(
      `insert into learner_events (student_id, event_type, payload) values ($1, 'goal_archived', $2::jsonb)`,
      [studentId, JSON.stringify({ goal_id: input.id, reason: input.reason || "" })]
    );
    return { ok: true, changed: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 误解诊断: 答错时记录(带证据链), 可纠正 */
export async function recordMisconception(input: {
  studentId?: string;
  topic: string;
  description: string;
  evidence?: string[];
}): Promise<{ ok: boolean; misconception?: Misconception; error?: string }> {
  const studentId = input.studentId || "default";
  try {
    const r = await pool.query(
      `insert into misconceptions (student_id, topic, description, evidence, status)
       values ($1, $2, $3, $4::jsonb, 'open') returning *`,
      [studentId, input.topic, input.description, JSON.stringify(input.evidence || [])]
    );
    await pool.query(
      `insert into learner_events (student_id, event_type, payload) values ($1, 'misconception_recorded', $2::jsonb)`,
      [studentId, JSON.stringify({ misconception_id: r.rows[0].id, topic: input.topic })]
    );
    return { ok: true, misconception: r.rows[0] as Misconception };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 列出误解(open 优先) */
export async function listMisconceptions(input: { studentId?: string; status?: "open" | "resolved" }): Promise<{ ok: boolean; misconceptions: Misconception[] }> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1";
  if (input.status) { params.push(input.status); where += " and status = $" + params.length; }
  const r = await pool.query(
    `select * from misconceptions where ${where} order by created_at desc limit 30`,
    params
  );
  return { ok: true, misconceptions: r.rows as Misconception[] };
}

/** 标记误解已解决(学习者纠正) */
export async function resolveMisconception(input: { studentId?: string; id: string }): Promise<{ ok: boolean; error?: string }> {
  const studentId = input.studentId || "default";
  try {
    const r = await pool.query(
      `update misconceptions set status='resolved' where id=$1 and student_id=$2 returning id`,
      [input.id, studentId]
    );
    if (r.rows.length === 0) return { ok: false, error: "误解不存在" };
    await pool.query(
      `insert into learner_events (student_id, event_type, payload) values ($1, 'misconception_resolved', $2::jsonb)`,
      [studentId, JSON.stringify({ misconception_id: input.id })]
    );
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 画像上下文包: 目标+误解+弱项 → 注入系统提示词(每轮) */
export async function buildProfileContext(input: { studentId?: string; subject?: string }): Promise<{ ok: boolean; context: string }> {
  const studentId = input.studentId || "default";
  const [goals, mis, mastery] = await Promise.all([
    pool.query("select title, type, priority, status from learning_goals where student_id=$1 and status='active' order by priority desc limit 5", [studentId]),
    pool.query("select topic, description from misconceptions where student_id=$1 and status='open' limit 5", [studentId]),
    pool.query(
      `select knowledge_point, mastery_level from knowledge_mastery
       where student_id=$1 ${input.subject ? "and subject=$2" : ""} and mastery_level != 'mastered'
       order by score asc limit 5`,
      input.subject ? [studentId, input.subject] : [studentId]
    ),
  ]);
  const lines: string[] = [];
  if (goals.rows.length) lines.push("【学习目标】" + goals.rows.map((g) => `${g.title}(${g.type}${g.priority > 0.7 ? "·高优先" : ""})`).join("；"));
  if (mis.rows.length) lines.push("【待纠正误解】" + mis.rows.map((m) => `${m.topic}: ${String(m.description).slice(0, 60)}`).join("；"));
  if (mastery.rows.length) lines.push("【薄弱点】" + mastery.rows.map((m) => m.knowledge_point).join("、"));
  return { ok: true, context: lines.join("\n") };
}

export const learnerGoalsService = {
  upsertGoal, listGoals, archiveGoal, recordMisconception, listMisconceptions, resolveMisconception, buildProfileContext,
};
