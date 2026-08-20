// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// auto-learning-loop.ts — 端到端自动闭环（复赛冲刺期实现）
// 从「人工喂数据」升级为「系统自动采集 → 自动诊断 → 自动迭代方案」：
//   ① 自动采集：教育服务入口事件钩子（作答/错题/计划自动落库）
//   ② 自动诊断：会话后/每日触发 locateGaps + behaviorAnalysis + predictRisk
//   ③ 自动迭代：诊断结果自动回流（计划重排/内容重推/陪伴干预）
//   ④ 自动验证：掌握度/错题清零/计划完成率 → 自动闭环周报
// 边界: 仅采集学习过程数据（不采集个人信息/录音录像）；计划变更推送学生确认
import { pool } from "../db/pool.js";
import { recordAnswer } from "./adaptive-learning-service.js";
import { locateGaps, behaviorAnalysis, predictRisk, diagnosticReport } from "./diagnostic-service.js";
import { learningPlan } from "./education-service.js";
import { adaptivePush } from "./adaptive-learning-service.js";
import { updateProgress } from "./study-companion-service.js";

// ═══ ① 自动采集：事件钩子 ═══
/** 作答自动采集钩子：辅导/变式训练后调用，自动写入 answer_history 并更新掌握度 */
export async function hookRecordAnswer(input: {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  isCorrect: boolean;
  difficulty?: string;
  source?: string;            // "solve" | "variant" | "socratic" | "quiz"
}): Promise<Record<string, unknown>> {
  const r = await recordAnswer(input);
  // 学习节奏：记录会话时长（learning_pace 汇总用）
  await pool.query(
    `insert into learning_pace (student_id, subject, session_minutes, session_date)
     values ($1, $2, $3, now()::date)
     on conflict (student_id, subject, session_date) do update
       set session_minutes = learning_pace.session_minutes + $3`,
    [input.studentId || "default", input.subject, 5]  // 每次作答近似 5 分钟
  );
  return { ok: true, mastery: (r as any).mastery, source: input.source || "auto" };
}

/** 学习计划执行钩子：任务完成自动更新 progress */
export async function hookPlanProgress(input: {
  studentId?: string;
  planId: number;
  itemIndex: number;
  done: boolean;
}): Promise<Record<string, unknown>> {
  return updateProgress(input);
}

// ═══ ② 自动诊断 ═══
/** 会话后自动诊断：聚合薄弱点/行为/风险，输出诊断结果 */
export async function autoDiagnose(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const [gaps, behavior, risk] = await Promise.all([
    locateGaps({ studentId, subject: input.subject }),
    behaviorAnalysis({ studentId, subject: input.subject }),
    predictRisk({ studentId, subject: input.subject }),
  ]);
  return {
    ok: true,
    gaps: (gaps as any).gaps,
    behavior: (behavior as any).behavior,
    risk: (risk as any).riskLevel,
    signals: (risk as any).signals,
    at: new Date().toISOString(),
  };
}

// ═══ ③ 自动迭代：诊断结果回流 ═══
/** 自动迭代方案：按诊断结果重排计划 / 重推内容 / 触发干预 */
export async function autoIterate(input: {
  studentId?: string;
  subject: string;
  goal?: string;
  hoursPerWeek?: number;
  autoPush?: boolean;          // 是否同时重推内容（默认 true）
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // ① 自动诊断（不依赖人工输入）
  const diag = await autoDiagnose({ studentId, subject: input.subject });
  const weak = ((diag.gaps as any)?.lowAccuracyPoints || []) as Array<{ knowledge_point: string; accuracy: number }>;
  const risk = diag.risk as string;

  // ② 自动重排计划（weak[] 注入 learning-plan 重排）
  const plan = await learningPlan({
    subject: input.subject,
    goal: input.goal || `巩固 ${input.subject} 薄弱知识点`,
    currentLevel: weak.length > 0 ? `存在薄弱点: ${weak.slice(0, 3).map((w) => w.knowledge_point).join("、")}` : undefined,
    hoursPerWeek: input.hoursPerWeek,
    deadline: undefined,
  });

  // ③ 自动重推内容（薄弱点 → 微课/例题）
  let push = null;
  if (input.autoPush !== false && weak.length > 0) {
    push = await adaptivePush({ studentId, subject: input.subject });
  }

  // ④ 干预标记（高风险 → 建议陪伴干预）
  const needIntervention = risk === "high" || risk === "medium";

  return {
    ok: true,
    diagnosis: diag,
    weakPoints: weak.map((w) => w.knowledge_point),
    plan: (plan as any).plan,
    pushed: push ? (push as any).items?.length ?? 0 : 0,
    needIntervention,
    note: needIntervention ? "检测到学习风险，建议触发陪伴干预（motivate）" : "学情健康，保持当前节奏",
  };
}

// ═══ ④ 自动验证：闭环周报 ═══
/** 自动闭环周报：掌握度变化 / 错题清零 / 计划完成率 */
export async function autoLoopReport(input: { studentId?: string; subject?: string; days?: number }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const days = input.days || 7;
  const subject = input.subject;

  // 掌握度变化（近 N 天有作答的知识点）
  const masteryTrend = await pool.query(
    `select knowledge_point, mastery_level, score, attempts, correct_count, last_answer_at
     from knowledge_mastery
     where student_id = $1 and last_answer_at > now() - ($2 || ' days')::interval
     ${subject ? "and subject = $3" : ""}
     order by last_answer_at desc`,
    subject ? [studentId, String(days), subject] : [studentId, String(days)]
  );

  // 作答统计
  const answerStats = await pool.query(
    `select count(*)::int as answers,
            sum(case when is_correct then 1 else 0 end)::int as correct
     from answer_history
     where student_id = $1 and answered_at > now() - ($2 || ' days')::interval
     ${subject ? "and subject = $3" : ""}`,
    subject ? [studentId, String(days), subject] : [studentId, String(days)]
  );

  // 错题清零
  const wrongStats = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where mastered = true)::int as mastered
     from wrong_questions
     where student_id = $1 and created_at > now() - ($2 || ' days')::interval
     ${subject ? "and subject = $3" : ""}`,
    subject ? [studentId, String(days), subject] : [studentId, String(days)]
  );

  // 计划完成率
  const planStats = await pool.query(
    `select count(*)::int as plans,
            round(avg(progress)::numeric, 3)::float as avg_progress
     from study_plans
     where student_id = $1 and created_at > now() - ($2 || ' days')::interval`,
    [studentId, String(days)]
  );

  const a = answerStats.rows[0] || { answers: 0, correct: 0 };
  const w = wrongStats.rows[0] || { total: 0, mastered: 0 };
  const p = planStats.rows[0] || { plans: 0, avg_progress: 0 };

  return {
    ok: true,
    days,
    report: {
      period: `${days} 天`,
      answers: a.answers,
      accuracy: a.answers > 0 ? Math.round((a.correct / a.answers) * 100) : 0,
      mastery: masteryTrend.rows,
      masteryChange: masteryTrend.rows.map((m) => `${m.knowledge_point}: ${m.mastery_level}(${m.score})`),
      wrongClearedRate: w.total > 0 ? Math.round((w.mastered / w.total) * 100) : 0,
      planCompletion: p.plans > 0 ? Math.round((p.avg_progress || 0) * 100) : 0,
      risk: (await predictRisk({ studentId, subject: input.subject })).riskLevel,
    },
  };
}

export const autoLearningLoopService = {
  hookRecordAnswer, hookPlanProgress, autoDiagnose, autoIterate, autoLoopReport,
};
