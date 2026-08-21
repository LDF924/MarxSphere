// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-feedback-service.ts — 教育反馈闭环（2026-08-21）
// 学生/教师对教育功能（辅导/规划/诊断/批改/备课）的使用反馈：
//   提交反馈（赞/踩+备注+场景）→ 落库 edu_feedback（脱敏，不落日志）
//   统计聚合（各场景赞踩率、负评热点）→ 教学效果指标 ⑫ 用户满意度的数据来源
//   负评热点 → 改进建议（按场景聚合，供功能迭代驱动）
import { pool } from "../db/pool.js";
import { sanitizeLine } from "./log-sanitizer.js";

const VALID_SCENES = ["tutoring", "plan", "diagnosis", "grading", "lesson", "general"] as const;

export interface EduFeedbackInput {
  role?: "student" | "teacher";
  scene?: string;
  feedback: 1 | -1 | 0;
  note?: string;
  source?: string;
}

/** 提交教育功能反馈（脱敏后落库） */
export async function submitEduFeedback(input: EduFeedbackInput): Promise<Record<string, unknown>> {
  if (![1, -1, 0].includes(input.feedback)) {
    return { ok: false, error: "feedback 必须是 1(赞)/-1(踩)/0(中性)" };
  }
  const scene = VALID_SCENES.includes(input.scene as (typeof VALID_SCENES)[number])
    ? input.scene!
    : "general";
  const role = input.role === "teacher" ? "teacher" : "student";
  // 脱敏：备注与来源只取长度上限，且经 sanitizeLine 清洗（不落日志、防注入个人标识）
  const note = input.note ? sanitizeLine(String(input.note)).slice(0, 500) : null;
  const source = input.source ? sanitizeLine(String(input.source)).slice(0, 200) : null;

  await pool.query(
    `insert into edu_feedback (role, scene, feedback, note, source) values ($1, $2, $3, $4, $5)`,
    [role, scene, input.feedback, note, source]
  );
  return { ok: true, note: "反馈已记录（脱敏存储，不落日志）" };
}

/** 反馈统计（教学效果指标 ⑫：用户满意度数据源） */
export async function eduFeedbackStats(): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `select
       count(*) filter (where feedback = 1) as likes,
       count(*) filter (where feedback = -1) as dislikes,
       count(*) filter (where feedback = 0) as neutral,
       count(*) as total,
       round(100.0 * count(*) filter (where feedback = 1) / nullif(count(*), 0), 1) as like_rate,
       scene,
       role
     from edu_feedback
     group by scene, role
     order by scene, role`
  );
  // 负评热点（教学效果反馈 → 改进驱动）
  const neg = await pool.query(
    `select scene, count(*) as n, array_agg(left(coalesce(note, ''), 80)) as notes
     from edu_feedback where feedback = -1
     group by scene order by n desc limit 5`
  );
  return {
    ok: true,
    summary: {
      total: r.rows.reduce((s: number, x) => s + Number(x.total), 0),
      likes: r.rows.reduce((s: number, x) => s + Number(x.likes), 0),
      dislikes: r.rows.reduce((s: number, x) => s + Number(x.dislikes), 0),
      likeRate: r.rows.length
        ? Math.round(1000 * r.rows.reduce((s: number, x) => s + Number(x.likes), 0) / Math.max(1, r.rows.reduce((s: number, x) => s + Number(x.total), 0))) / 10
        : 0,
    },
    byScene: r.rows,
    negativeHotspots: neg.rows,
  };
}

export const educationFeedbackService = { submitEduFeedback, eduFeedbackStats };
