// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// student-learning-service.ts — 学生端学习服务扩展（V389，复赛）
// 规格三缺口补齐：
//   ① 认知维度标签：将知识点拆解为多个认知维度标签（布鲁姆分类：记忆/理解/应用/分析/评价/创造）
//   ② 千人千策学习引导：根据专业背景 + 学习进度自动推荐学习内容
//   ③ 复习提醒：基于遗忘曲线（艾宾浩斯）+ 学习记录智能推送复习提醒
// 复用: 教育服务 llmJson/recallStudentMemory + knowledge_mastery/answer_history + kp_points
import { pool } from "../db/pool.js";
import { llmJson, recallStudentMemory } from "./education-service.js";
import { getStudentProfile } from "./adaptive-learning-service.js";

// ═══ ① 认知维度标签（布鲁姆分类）═══
const BLOOM_DIMS = ["记忆", "理解", "应用", "分析", "评价", "创造"];

export async function cognitiveDimensions(input: { subject: string; knowledgePoint: string }): Promise<Record<string, unknown>> {
  const chunks = await (await import("./education-service.js")).retrieveChunks(input.knowledgePoint, "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a", 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const judge = await llmJson(`你是认知维度分析专家。将知识点「${input.knowledgePoint}」（${input.subject}）拆解为多个认知维度标签${ctx}

按布鲁姆认知分类（${BLOOM_DIMS.join("/")}），输出各维度下该知识点的具体要求:
输出 JSON: {
  "knowledgePoint": "知识点",
  "dimensions": [{"dimension": "记忆", "requirement": "该维度下需要掌握什么（具体）", "example": "示例问题/任务", "level": 1}],
  "recommendedOrder": ["建议学习顺序（维度先后）"],
  "teachingHint": "教师教学提示（该知识点各维度的教法差异）"
}`);
  return { ok: true, knowledgePoint: input.knowledgePoint, dimensions: judge?.dimensions || [], recommendedOrder: judge?.recommendedOrder || BLOOM_DIMS };
}

// ═══ ② 千人千策学习引导 ═══
export async function personalizedRecommend(input: {
  studentId?: string;
  subject: string;
  professionalBackground?: string;   // 专业背景（如：经济学/法学/哲学）
  goal?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const memory = await recallStudentMemory(`${input.subject} 学习推荐 ${input.professionalBackground || ""}`);

  // 学生画像（掌握度/薄弱点）
  const profile = await getStudentProfile({ studentId, subject: input.subject });
  const mastery = (profile as any).mastery || [];
  const weak = mastery.filter((m: any) => Number(m.score || 0) < 0.6).map((m: any) => m.knowledge_point);

  const judge = await llmJson(`你是个性化学习引导专家。基于学生画像生成"千人千策"学习推荐：
科目: ${input.subject}${input.professionalBackground ? `，学生专业背景: ${input.professionalBackground}` : ""}${input.goal ? `，学习目标: ${input.goal}` : ""}
${memory}
学生画像: ${JSON.stringify(mastery).slice(0, 800)}
薄弱点: ${weak.length > 0 ? weak.join("、") : "（暂无，保持当前进度）"}

输出 JSON: {
  "strategy": "总体学习策略（结合专业背景的差异化建议）",
  "recommendations": [{"content": "推荐学习内容", "reason": "为什么推荐（结合画像）", "priority": "高|中|低", "type": "微课|例题|文献|练习|拓展"}],
  "nextFocus": "下一步聚焦点",
  "paceAdvice": "节奏建议（结合当前进度）"
}`);
  return { ok: true, studentId, weakPoints: weak, recommendation: judge };
}

// ═══ ③ 复习提醒（艾宾浩斯遗忘曲线）═══
// 遗忘曲线间隔：1天 / 2天 / 4天 / 7天 / 15天 / 30天
const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30];

export async function reviewReminder(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // 近期学过的知识点（有作答记录，按时间）
  const learned = await pool.query(
    `select distinct knowledge_point, subject, max(answered_at)::date as last_date
     from answer_history
     where student_id = $1 ${input.subject ? "and subject = $2" : ""}
     group by knowledge_point, subject
     order by last_date desc limit 20`,
    input.subject ? [studentId, input.subject] : [studentId]
  );

  // 掌握度（判断是否还需复习）
  const masteryMap = new Map<string, number>();
  const km = await pool.query(
    `select knowledge_point, score from knowledge_mastery
     where student_id = $1 ${input.subject ? "and subject = $2" : ""}`,
    input.subject ? [studentId, input.subject] : [studentId]
  );
  for (const r of km.rows) masteryMap.set(r.knowledge_point, Number(r.score));

  const today = new Date();
  const reminders: Array<{ knowledgePoint: string; due: string; interval: number; reason: string; score: number }> = [];
  for (const r of learned.rows as Array<{ knowledge_point: string; subject: string; last_date: string }>) {
    const score = masteryMap.get(r.knowledge_point) ?? 0;
    if (score >= 0.85) continue;   // 已牢固掌握，暂不需复习
    const last = new Date(r.last_date);
    const daysSince = Math.floor((today.getTime() - last.getTime()) / 86400000);
    // 找最近一个应复习的间隔点
    for (const interval of EBBINGHAUS_INTERVALS) {
      if (daysSince >= interval && daysSince < interval * 2) {
        reminders.push({
          knowledgePoint: r.knowledge_point,
          due: `距离上次学习 ${daysSince} 天`,
          interval,
          reason: `按遗忘曲线，第 ${interval} 天是${interval === 1 ? "第一次" : interval === 2 ? "第二次" : interval === 4 ? "第三次" : interval === 7 ? "第四次" : interval === 15 ? "第五次" : "第六次"}复习点`,
          score,
        });
        break;
      }
    }
  }
  reminders.sort((a, b) => a.interval - b.interval);

  return {
    ok: true,
    studentId,
    dueReminders: reminders.slice(0, 10),
    nextReview: reminders[0] || null,
    note: reminders.length > 0 ? `有 ${reminders.length} 个知识点到复习点，建议今天复习` : "暂无到期复习点，保持当前节奏",
    intervals: EBBINGHAUS_INTERVALS,
  };
}

export const studentLearningService = { cognitiveDimensions, personalizedRecommend, reviewReminder };
