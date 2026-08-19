// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// study-companion-service.ts — 学习陪伴 Agent（V388）
// 情感+任务双驱动，全天候学习伙伴
// 四层能力：
//   ① 学习规划：日/周计划生成 + 定时提醒 + 进度跟踪
//   ② 答疑对话：随时问答、知识点复述、概念辨析
//   ③ 激励引导：学习鼓励、心态疏导（缓解厌学焦虑）
//   ④ 复盘总结：每日/每周复盘，梳理收获与待改进点
// 复用: 教育服务 llmJson/recallStudentMemory + adaptive(掌握度) + OpenViking 记忆
import { pool } from "../db/pool.js";
import { llmJson, recallStudentMemory } from "./education-service.js";

// ═══ ① 学习规划：日/周计划 + 进度 ═══
export async function createPlan(input: {
  studentId?: string;
  planType: "daily" | "weekly";
  subject: string;
  goal: string;
  availableHours: number;
  reminderTime?: string;   // 提醒时间（如 08:00）
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const memory = await recallStudentMemory(`${input.subject} 学习计划 ${input.goal}`);

  const prompt = `你是学习规划师。为学生制定${input.planType === "daily" ? "日" : "周"}学习计划：
科目: ${input.subject}
目标: ${input.goal}
可投入: ${input.availableHours} 小时${input.planType === "daily" ? "/天" : "/周"}
${memory}

输出 JSON: {
  "title": "计划标题",
  "items": [{"task":"学习任务","time":"时间段/天","duration":N,"type":"复习|练习|新课|整理","focus":"重点"}],
  "arrangement": "安排逻辑（为什么这样排）"
}`;
  const plan = await llmJson(prompt);
  const items = plan?.items || [];

  // 周期计算
  const today = new Date();
  const periodEnd = new Date(today);
  periodEnd.setDate(periodEnd.getDate() + (input.planType === "daily" ? 0 : 6));

  const r = await pool.query(
    `insert into study_plans (student_id, plan_type, period_start, period_end, title, items, reminder_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      studentId, input.planType, today.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10),
      plan?.title || `${input.subject}${input.planType === "daily" ? "日" : "周"}计划`, JSON.stringify(items),
      input.reminderTime ? new Date(`${today.toISOString().slice(0, 10)}T${input.reminderTime}:00+08:00`) : null,
    ]
  );

  return { ok: true, planId: r.rows[0].id, plan: plan?.title, items: items.length, arrangement: plan?.arrangement ?? "" };
}

/** 进度更新：标记任务完成 → 自动算进度 */
export async function updateProgress(input: { studentId?: string; planId: number; itemIndex: number; done: boolean }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(`select items from study_plans where id = $1 and student_id = $2`, [input.planId, studentId]);
  if (r.rows.length === 0) return { ok: false, error: "计划不存在" };

  const items = r.rows[0].items as Array<{ task: string; status?: string }>;
  if (input.itemIndex >= 0 && input.itemIndex < items.length) {
    items[input.itemIndex].status = input.done ? "done" : "pending";
  }
  const doneCount = items.filter((i) => i.status === "done").length;
  const progress = items.length > 0 ? doneCount / items.length : 0;

  await pool.query(
    `update study_plans set items = $2::jsonb, progress = $3::numeric, status = case when $3::numeric >= 1 then 'done' else 'active' end, updated_at = now()
     where id = $1`,
    [input.planId, JSON.stringify(items), progress]
  );
  return { ok: true, progress, doneCount, total: items.length };
}

/** 当前计划 + 进度（供提醒/跟踪） */
export async function currentPlans(input: { studentId?: string; status?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select id, plan_type, title, items, progress, status, period_start, period_end, reminder_at
     from study_plans where student_id = $1 ${input.status ? "and status = $2" : "and status = 'active'"} order by created_at desc limit 5`,
    input.status ? [studentId, input.status] : [studentId]
  );
  return { ok: true, plans: r.rows };
}

// ═══ ② 答疑对话：随时问答/概念辨析 ═══
export async function companionQnA(input: {
  subject: string;
  question: string;
  mode?: "qa" | "explain" | "compare";  // 问答/知识点复述/概念辨析
  studentId?: string;
}): Promise<Record<string, unknown>> {
  const mode = input.mode || "qa";
  const memory = await recallStudentMemory(`${input.subject} ${input.question}`);

  const modeRule = {
    qa: "直接回答，简洁清晰",
    explain: "复述讲解该知识点（用自己的话，帮助学生巩固记忆）",
    compare: "概念辨析：对比异同、关联、易混淆点",
  }[mode];

  const prompt = `你是学习伙伴。${modeRule}。
科目: ${input.subject}
问题: ${input.question}
${memory}

输出 JSON: {"answer":"回答内容","keyPoint":"一句话核心","followUp":"可追问的问题（促进学生思考）"}`;
  return { ok: true, qa: await llmJson(prompt), mode };
}

// ═══ ③ 激励引导：鼓励/心态疏导 ═══
export async function motivate(input: {
  studentId?: string;
  subject: string;
  situation: string;       // 当前情绪/处境（如：学不进去/考试焦虑/坚持不下去）
  recentProgress?: string; // 近期进步（如有）
}): Promise<Record<string, unknown>> {
  const memory = await recallStudentMemory(`${input.subject} 情绪 ${input.situation}`);

  const prompt = `你是学习陪伴者的激励师。学生处于: ${input.situation}${input.recentProgress ? `，近期进步: ${input.recentProgress}` : ""}。${memory}

激励原则（情感+任务双驱动）:
1. 先共情（不敷衍的认可）
2. 给具体的小行动建议（不是空喊加油）
3. 帮学生看到已有进步（用成长视角）
4. 如焦虑/厌学：疏导情绪 + 降低门槛（先做5分钟）
输出 JSON: {
  "empathy": "共情话语",
  "reframe": "重新框定（换个视角看问题）",
  "smallAction": "立即能做的微小行动",
  "encouragement": "激励话语",
  "ifStuck": "如果还是不行，可以怎么做"
}`;
  return { ok: true, motivation: await llmJson(prompt) };
}

// ═══ ④ 复盘总结：每日/每周 ═══
export async function dailyReview(input: {
  studentId?: string;
  subject: string;
  todayWhat: string;       // 今天做了什么
  todayFeeling: string;    // 今天感受
  reviewType?: "daily" | "weekly";
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const reviewType = input.reviewType || "daily";

  // 结合掌握度/答题数据（真实学习痕迹）
  const stats = await pool.query(
    `select count(*)::int as answers, sum(case when is_correct then 1 else 0 end)::int as correct
     from answer_history where student_id = $1 and subject = $2
     and answered_at > now() - interval '1 day'`,
    [studentId, input.subject]
  );

  const prompt = `你是复盘教练。帮学生做${reviewType === "daily" ? "日" : "周"}度复盘：
科目: ${input.subject}
今天/本周做了什么: ${input.todayWhat}
感受: ${input.todayFeeling}
今日答题数据: ${JSON.stringify(stats.rows[0])}

输出 JSON: {
  "summary": "复盘总结（客观+鼓励）",
  "achievements": ["收获/做得好的"],
  "improvements": ["待改进点（具体可执行）"],
  "pattern": "发现的学习模式/规律",
  "tomorrowFocus": "明天/下周的聚焦点"
}`;
  const review = await llmJson(prompt);

  // 存复盘
  await pool.query(
    `insert into study_reviews (student_id, review_type, review_date, summary, achievements, improvements, mood)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (student_id, review_type, review_date) do update set summary = $4, achievements = $5, improvements = $6, mood = $7`,
    [
      studentId, reviewType, new Date().toISOString().slice(0, 10),
      review?.summary ?? "", review?.achievements ?? [], review?.improvements ?? [], input.todayFeeling,
    ]
  );

  return { ok: true, review, saved: true };
}

/** 复盘历史 */
export async function reviewHistory(input: { studentId?: string; reviewType?: "daily" | "weekly" }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select review_type, review_date, summary, achievements, improvements, mood from study_reviews
     where student_id = $1 ${input.reviewType ? "and review_type = $2" : ""} order by review_date desc limit 30`,
    input.reviewType ? [studentId, input.reviewType] : [studentId]
  );
  return { ok: true, reviews: r.rows };
}

export const studyCompanionService = { createPlan, updateProgress, currentPlans, companionQnA, motivate, dailyReview, reviewHistory };
