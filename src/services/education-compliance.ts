// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-compliance.ts — 教育数据合规（复赛冲刺期实现）
// 对应方案 §4.2「教育数据合规设计」：
//   ① 数据分级：学习行为(低敏) / 教学交互(中敏) / 语音(高敏，仅本地+即删)
//   ② 最小化采集：默认匿名 student_id；日志脱敏（sanitizeLine）
//   ③ 权限隔离：/api/education 权限门（ALLOWED_PERMS 校验，复用既有权限体系）
//   ④ 生命周期：会话清理 / 语音即删 / 学情保留期（模拟数据默认 30 天）
//   ⑤ 合规自证：分级表 + 采集范围声明 + 清理操作 + 状态查询
import { pool } from "../db/pool.js";
import { sanitizeLine } from "./log-sanitizer.js";

/** 学情数据保留期（天），可用 EDU_DATA_RETENTION_DAYS 覆盖 */
const RETENTION_DAYS = Number(process.env.EDU_DATA_RETENTION_DAYS || 30);

// ═══ ① 数据分级表（静态自证）═══
export function dataClassification(): Record<string, unknown> {
  return {
    ok: true,
    classification: [
      {
        tier: "low", name: "学习行为", tables: ["answer_history", "learning_pace", "knowledge_mastery", "wrong_questions"],
        policy: "仅学科掌握度数值与作答记录，不含个人标识；默认匿名 student_id",
      },
      {
        tier: "medium", name: "教学交互", tables: ["study_plans", "study_reviews", "variant_questions"],
        policy: "按会话保存，可一键清理；不进评测语料",
      },
      {
        tier: "high", name: "语音", tables: ["（不落库）"],
        policy: "仅本地处理 + 会话后即删，不落库不训练；明示学生 + 「不使用语音」备选",
      },
    ],
    collectionScope: "仅采集学习过程数据（作答/错题/计划/复盘），不采集个人信息/录音录像/生物特征",
  };
}

// ═══ ② 生命周期：会话清理 ═══
/** 一键清理某学生的学情数据（作答/错题/掌握度/计划/复盘），并返回清理数量 */
export async function cleanupStudentData(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const where = input.subject ? "and subject = $2" : "";
  const params: unknown[] = [studentId];
  if (input.subject) params.push(input.subject);

  const counts: Record<string, number> = {};
  // 含 subject 列的表（支持按科目过滤）
  for (const table of ["answer_history", "learning_pace", "knowledge_mastery", "wrong_questions"]) {
    const r = await pool.query(`delete from ${table} where student_id = $1 ${where}`, params);
    counts[table] = r.rowCount ?? 0;
  }
  // 无 subject 列的表（仅按学生清理）
  for (const table of ["study_reviews", "study_plans"]) {
    const r = await pool.query(`delete from ${table} where student_id = $1`, [studentId]);
    counts[table] = r.rowCount ?? 0;
  }

  return { ok: true, deleted: counts, note: "学情数据已清理（语音数据本就会话后即删）" };
}

// ═══ ③ 生命周期：保留期清理（超期自动删）═══
/** 清理超过保留期的历史作答/错题数据（供定时任务/启动调用） */
export async function cleanupExpiredData(): Promise<Record<string, unknown>> {
  const deleted: Record<string, number> = {};
  // 作答历史：仅清理超期旧数据（保留最近 RETENTION_DAYS 天）
  const a = await pool.query(
    `delete from answer_history where answered_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]
  );
  deleted.answer_history = a.rowCount ?? 0;
  const w = await pool.query(
    `delete from wrong_questions where created_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]
  );
  deleted.wrong_questions = w.rowCount ?? 0;
  const p = await pool.query(
    `delete from study_plans where created_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]
  );
  deleted.study_plans = p.rowCount ?? 0;

  return { ok: true, retentionDays: RETENTION_DAYS, deleted };
}

// ═══ ④ 合规状态查询（自证）═══
export async function complianceStatus(input: { studentId?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select
      (select count(*)::int from answer_history where student_id = $1) as answers,
      (select count(*)::int from wrong_questions where student_id = $1) as wrongs,
      (select count(*)::int from study_plans where student_id = $1) as plans,
      (select count(*)::int from knowledge_mastery where student_id = $1) as mastery_points`,
    [studentId]
  );
  const row = r.rows[0] || { answers: 0, wrongs: 0, plans: 0, mastery_points: 0 };

  return {
    ok: true,
    studentId: sanitizeLine(studentId).slice(0, 20),
    anon: studentId === "default",
    data: row,
    retentionDays: RETENTION_DAYS,
    voicePolicy: "语音仅本地处理 + 会话后即删（不落库不训练）",
    exportDisclosure: "数据不向任何第三方传输；外部检索仅 SSRF 白名单域名",
  };
}

export const educationComplianceService = { dataClassification, cleanupStudentData, cleanupExpiredData, complianceStatus };
