// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// teaching-assistant-service.ts — 教师备课辅助系统（V387）
// 释放教师重复性劳动，把精力回归教学设计与师生互动
// 四层能力：
//   ① 教案课件生成：依据课标/学情生成教案、PPT大纲、课堂活动设计
//   ② 命题组卷：分层试卷/随堂练习，难度调节 + 知识点筛选
//   ③ 作业批改：客观题自动判分；主观题辅助评阅（评分参考+修改意见）
//   ④ 班级学情汇总：聚合全班错题与薄弱点，定位班级共性教学盲区
// 复用: 教育服务 llmJson/retrieveChunks + knowledge_mastery/answer_history/wrong_questions
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks, DEFAULT_SOURCE } from "./education-service.js";

// ═══ ① 教案课件生成：教案 + PPT 大纲 + 课堂活动 ═══
export async function generateLesson(input: {
  subject: string;
  chapter: string;          // 章节/课题
  curriculum?: string;      // 课标要求（可选）
  classMinutes?: number;
  studentLevel?: string;
  includePpt?: boolean;     // 是否生成 PPT 大纲
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.chapter, DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${input.chapter} 相关文献）】\n${chunks.slice(0, 4).map((c) => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是教学设计专家。为以下课程生成完整教案${input.includePpt ? " + PPT 大纲" : ""}：
科目: ${input.subject}
章节: ${input.chapter}
课标要求: ${input.curriculum || "未指定（按通用标准）"}
课时: ${input.classMinutes || 90} 分钟
学生水平: ${input.studentLevel || "普通"}
${ctx}

输出 JSON: {
  "lessonTitle": "课题名称",
  "objectives": ["教学目标(知识/能力/素养，对齐课标)"],
  "keyPoints": ["重点难点"],
  "classFlow": [{"segment":"环节","duration":N,"teacherAction":"教师活动","studentAction":"学生活动","designIntent":"设计意图"}],
  "activities": [{"name":"课堂活动","type":"讨论|案例|角色扮演|小组任务","detail":"活动设计"}],
  "materials": ["教学素材（优先知识库文献）"],
  "assessment": {"formative":["过程性评价"],"summative":"终结性评价"},
  "homework": "分层作业设计",
  ${input.includePpt ? '"pptOutline": [{"slide":N,"title":"PPT页标题","content":"该页要点"}]' : '"reflection": "教学反思要点"'}
}`;
  return { ok: true, lesson: await llmJson(prompt), chapter: input.chapter, includePpt: !!input.includePpt, linked: chunks.length > 0 };
}

// ═══ ② 命题组卷：分层试卷/随堂练习 ═══
export async function generateExam(input: {
  subject: string;
  topic?: string;           // 知识点范围（可选）
  difficulty?: "easy" | "medium" | "hard";  // 难度调节
  questionCount?: number;
  includeAnswers?: boolean;
  knowledgePoints?: string; // 知识点筛选（逗号分隔）
}): Promise<Record<string, unknown>> {
  const difficulty = input.difficulty || "medium";
  const count = input.questionCount || 10;
  const kps = input.knowledgePoints || input.topic || "";

  const chunks = kps ? await retrieveChunks(kps, DEFAULT_SOURCE, 5) : [];
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${kps} 相关，可作命题素材）】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是命题专家。生成${input.subject}试卷${kps ? `（知识点: ${kps}）` : ""}，难度: ${difficulty}，共 ${count} 题。${ctx}

题目配比建议: 选择/填空/简答/论述混合，难度按 ${difficulty} 分布（easy=基础题多，hard=拔高题多）。
输出 JSON: {
  "examTitle": "试卷标题",
  "difficulty": "${difficulty}",
  "sections": [{"type":"选择题|填空题|简答题|论述题","count":N,"questions":[{"num":1,"question":"题目","difficulty":"easy|medium|hard","knowledgePoint":"考点"}]}],
  ${input.includeAnswers ? '"answers": [{"num":1,"answer":"答案/解析"}]' : '"gradingRubric": "评分标准简述"'}
}`;
  return { ok: true, exam: await llmJson(prompt), difficulty, count };
}

// ═══ ③ 作业批改：客观题自动判分 + 主观题辅助评阅 ═══
export async function gradeSubmission(input: {
  subject: string;
  questions: Array<{ question: string; studentAnswer: string; correctAnswer?: string; type?: "objective" | "subjective"; fullScore?: number }>;
}): Promise<Record<string, unknown>> {
  // 客观题：规则自动判分（字符串匹配/数字容差）
  const results: Array<Record<string, unknown>> = input.questions.map((q, i) => {
    const isObjective = q.type === "objective" || (q.correctAnswer && q.correctAnswer.trim().length < 50);
    if (isObjective && q.correctAnswer) {
      const sa = (q.studentAnswer || "").trim();
      const ca = q.correctAnswer.trim();
      // 简单判分：去除空白后比较（容错：数字比较）
      const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
      const isCorrect = norm(sa) === norm(ca) || (parseFloat(sa) === parseFloat(ca) && !isNaN(parseFloat(sa)));
      return {
        num: i + 1, type: "objective", question: q.question.slice(0, 60),
        correct: isCorrect, score: isCorrect ? (q.fullScore ?? 1) : 0, fullScore: q.fullScore ?? 1,
        note: isCorrect ? "客观题自动判分：正确" : "客观题自动判分：错误",
      };
    }
    // 主观题 → 交给 LLM 辅助评阅（批量）
    return { num: i + 1, type: "subjective", question: q.question.slice(0, 60), pending: true, fullScore: q.fullScore ?? 10 };
  });

  // 主观题聚合给 LLM 评阅
  const subjectiveIndexes = input.questions.map((_, i) => i).filter((i) => results[i].pending);
  const subjective = subjectiveIndexes.map((i) => input.questions[i]);
  if (subjective.length > 0) {
    const prompt = `你是阅卷老师。请对以下主观题答案给出评分参考与修改意见（满分10分制，可带小分）：
科目: ${input.subject}
${subjective.map((q, i) => `【题${i + 1}】题目: ${q.question.substring(0, 150)}\n学生答案: ${(q.studentAnswer || "").substring(0, 500)}\n${q.correctAnswer ? `参考答案: ${q.correctAnswer.substring(0, 300)}` : ""}`).join("\n\n")}

输出 JSON: {"grades":[{"num":N,"score":0~10,"comment":"评语","suggestions":"修改建议","keyPoints":"得分点分析"}]}`;
    const grade = await llmJson(prompt);
    if (grade?.grades) {
      for (const g of grade.grades) {
        const subIdx = Number(g.num) - 1;
        if (subIdx >= 0 && subIdx < subjectiveIndexes.length) {
          const idx = subjectiveIndexes[subIdx];
          results[idx] = { ...results[idx], score: g.score, comment: g.comment, suggestions: g.suggestions, keyPoints: g.keyPoints };
        }
      }
    }
  }

  const scored = results.filter((r) => typeof r.score === "number");
  const total = scored.reduce((s, r) => s + Number(r.score || 0), 0);
  const maxTotal = scored.reduce((s, r) => s + Number(r.fullScore || 0), 0);

  return { ok: true, results, summary: { total, maxTotal, percent: maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0 } };
}

// ═══ ④ 班级学情汇总：共性盲区 + 授课重点调整 ═══
export async function classSummary(input: { classId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const subject = input.subject || "政治经济学";
  // 班级 = 该科目所有学生数据的聚合（student_id 即学生）
  const r = await pool.query(
    `select knowledge_point, count(*)::int as wrong_count,
            array_agg(distinct mistake_type) as mistake_types
     from wrong_questions where subject = $1 and mastered = false
     group by knowledge_point order by wrong_count desc limit 10`,
    [subject]
  );
  const commonGaps = r.rows;

  // 班级整体正确率（跨学生）
  const acc = await pool.query(
    `select count(*)::int as n, sum(case when is_correct then 1 else 0 end)::int as c,
            count(distinct student_id)::int as students
     from answer_history where subject = $1`,
    [subject]
  );

  const prompt = `你是教研组长。基于班级数据定位共性教学盲区，给出授课重点调整建议：
科目: ${subject}
班级共性错题分布: ${JSON.stringify(commonGaps).substring(0, 1200)}
班级整体: ${JSON.stringify(acc.rows[0])}

输出 JSON: {
  "classProfile": "班级整体情况(3句)",
  "commonBlindSpots": [{"point":"共性薄弱知识点","evidence":"错题数据","likelyCause":"可能的教学原因"}],
  "teachingFocus": [{"adjustment":"授课重点调整建议","reason":"依据","method":"课堂处理方式"}],
  "groupPlan": {"needsSupport":["需重点辅导学生特征"],"extension":["可拔高方向"]}
}`;

  return { ok: true, summary: await llmJson(prompt), commonGaps, classStats: acc.rows[0] };
}

export const teachingAssistantService = { generateLesson, generateExam, gradeSubmission, classSummary };
