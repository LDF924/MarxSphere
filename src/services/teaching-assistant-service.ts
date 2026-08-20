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

// ═══ ⑤ 课程大纲生成（V389，复赛）═══
export async function generateSyllabus(input: {
  subject: string;
  courseName: string;          // 课程名称
  weeks?: number;              // 课时/周数
  studentLevel?: string;
  curriculum?: string;         // 课标要求
}): Promise<Record<string, unknown>> {
  const weeks = input.weeks || 16;
  const chunks = await retrieveChunks(input.courseName, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是课程设计专家。为以下课程生成大纲：
课程: ${input.courseName}（${input.subject}）${input.studentLevel ? `，学生水平: ${input.studentLevel}` : ""}
${input.curriculum ? `课标要求: ${input.curriculum}` : ""}
课时: ${weeks} 周${ctx}

输出 JSON: {
  "courseTitle": "课程名称",
  "objectives": ["教学目标(知识/能力/素养)"],
  "outline": [{"week": 1, "topic": "周主题", "keyPoints": ["知识点"], "homework": "作业建议"}],
  "assessment": "考核方式",
  "textbook": "建议教材/参考书"
}`;
  return { ok: true, syllabus: await llmJson(prompt), weeks };
}

// ═══ ⑥ 课件生成（V389，复赛）═══
export async function generateCourseware(input: {
  subject: string;
  courseName: string;          // 课程名/课件标题
  knowledgePoint: string;      // 核心知识点
  slides?: number;             // 页数（默认 10）
}): Promise<Record<string, unknown>> {
  const slides = input.slides || 10;
  const chunks = await retrieveChunks(`${input.courseName} ${input.knowledgePoint}`, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是课件制作专家。生成课件「${input.courseName} — ${input.knowledgePoint}」（${input.subject}，约 ${slides} 页）：
${ctx}

输出 JSON: {
  "title": "课件标题",
  "slides": [{"page": 1, "title": "页标题", "type": "cover|text|concept|example|image|chart|summary|quiz|qa",
              "content": "页面内容（文字）", "visualHint": "配图/图表建议（含图片描述）"}],
  "notes": "讲解要点（教师备注）"
}`;
  return { ok: true, courseware: await llmJson(prompt), slideCount: slides };
}

// ═══ ⑦ 分层教学设计（V389，复赛）═══
export async function layeredDesign(input: {
  subject: string;
  chapter: string;
  levels?: string[];           // 分层（默认 基础/进阶/挑战）
}): Promise<Record<string, unknown>> {
  const levels = input.levels || ["基础", "进阶", "挑战"];
  const chunks = await retrieveChunks(input.chapter, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是分层教学专家。为「${input.chapter}」（${input.subject}）设计分层教学方案，层次: ${levels.join("/")}${ctx}

输出 JSON: {
  "chapter": "章节",
  "layers": [{"level": "基础", "targetStudents": "面向学生特征", "objectives": ["教学目标"], "activities": ["课堂活动"], "assignments": ["作业"]}],
  "progression": "层间递进逻辑（如何从基础到挑战）"
}`;
  return { ok: true, design: await llmJson(prompt), levels };
}

// ═══ ⑧ 智能出题（分层：基础/提升/拓展）（V389，复赛）═══
export async function generateQuestions(input: {
  subject: string;
  knowledgePoint: string;
  tier?: "基础" | "提升" | "拓展";
  count?: number;
}): Promise<Record<string, unknown>> {
  const tier = input.tier || "基础";
  const count = input.count || 5;
  const chunks = await retrieveChunks(input.knowledgePoint, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const tierRule = {
    "基础": "考察基本概念与直接应用，学生应能直接作答",
    "提升": "综合运用与变式，需两步以上推理",
    "拓展": "跨知识点综合、开放性设问、批判性思考",
  }[tier];

  const prompt = `你是命题专家。为知识点「${input.knowledgePoint}」（${input.subject}）生成 ${count} 道${tier}题。
${tierRule}${ctx}

输出 JSON: {
  "questions": [{"num": 1, "question": "题目", "type": "选择|填空|简答|论述", "difficulty": "基础|提升|拓展", "knowledgePoint": "考点", "answer": "参考答案/解析", "thinkingPoint": "考查的思维点"}]
}`;
  return { ok: true, tier, questions: await llmJson(prompt) };
}

// ═══ ⑨ 错题分析报告（班级/个人）（V389，复赛）═══
export async function wrongAnalysisReport(input: {
  studentId?: string;           // 个人（缺省=班级聚合）
  subject: string;
  days?: number;               // 统计窗口（默认 30 天）
}): Promise<Record<string, unknown>> {
  const days = input.days || 30;
  const subject = input.subject;
  const isClass = !input.studentId;

  const rows = await pool.query(
    `select knowledge_point,
            count(*)::int as wrong_count,
            array_agg(distinct mistake_type) as mistake_types,
            array_agg(distinct question) as sample_questions
     from wrong_questions
     where subject = $1 and mastered = false and created_at > now() - ($2 || ' days')::interval
     ${isClass ? "" : "and student_id = $3"}
     group by knowledge_point order by wrong_count desc limit 12`,
    isClass ? [subject, String(days)] : [subject, String(days), input.studentId]
  );

  const report = await llmJson(`你是教学分析专家。基于错题数据生成${isClass ? "班级" : "个人"}错题分析报告：
科目: ${subject}，窗口: ${days} 天${isClass ? "" : `，学生: ${input.studentId}`}
错题分布: ${JSON.stringify(rows.rows).slice(0, 2000)}

输出 JSON: {
  "summary": "错题总体情况（数量/集中度）",
  "topWeakPoints": [{"point": "知识点", "wrongCount": N, "mistakeTypes": ["错误类型"], "suggestion": "针对性建议"}],
  "patterns": ["发现的共性错误模式"],
  "actionPlan": [{"priority": "高|中|低", "action": "建议措施", "target": "针对对象"}]
}`);
  return { ok: true, scope: isClass ? "class" : "student", subject, report, raw: rows.rows };
}

// ═══ ⑩ 课堂讨论题生成（V389，复赛）═══
export async function generateDiscussion(input: {
  subject: string;
  topic: string;               // 课程内容/知识点
  count?: number;
}): Promise<Record<string, unknown>> {
  const count = input.count || 3;
  const chunks = await retrieveChunks(input.topic, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是课堂讨论设计专家。基于「${input.topic}」（${input.subject}）生成 ${count} 个课堂讨论题${ctx}

输出 JSON: {
  "discussions": [{"topic": "讨论题", "type": "观点辨析|案例分析|开放探讨|辩论", "guideQuestions": ["引导问题1", "引导问题2"], "expectedPoints": ["预期达成的认识/结论"], "minutes": "建议时长"}]
}`;
  return { ok: true, discussions: await llmJson(prompt) };
}

// ═══ ⑪ 随堂测验（V389，复赛）═══
export async function quickQuiz(input: {
  subject: string;
  topic: string;
  count?: number;
  autoAnswers?: boolean;       // 含答案（供批改对照）
}): Promise<Record<string, unknown>> {
  const count = input.count || 5;
  const chunks = await retrieveChunks(input.topic, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是随堂测验设计专家。基于「${input.topic}」（${input.subject}）生成 ${count} 道随堂测验题（客观题为主，快速作答）${ctx}

输出 JSON: {
  "quizTitle": "随堂测验标题",
  "questions": [{"num": 1, "question": "题目", "type": "选择|判断|填空", "options": ["A. ...", "B. ..."], ${input.autoAnswers ? '"answer": "正确答案",' : ""} "knowledgePoint": "考点"}],
  "estimateMinutes": "预计作答分钟"
}`;
  return { ok: true, quiz: await llmJson(prompt) };
}

// ═══ ⑫ 课堂总结（V389，复赛）═══
export async function lectureSummary(input: {
  subject: string;
  topic: string;               // 本节课内容
  notes?: string;              // 课堂记录（可选）
  minutes?: number;            // 课时
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.topic, DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是课堂总结助手。基于课程内容生成课堂总结：
科目: ${input.subject}，内容: ${input.topic}${input.minutes ? `，课时 ${input.minutes} 分钟` : ""}${input.notes ? `\n课堂记录: ${input.notes.slice(0, 500)}` : ""}${ctx}

输出 JSON: {
  "topic": "本课主题",
  "keyPoints": ["知识要点（结构化）"],
  "conclusions": ["核心结论"],
  "homework": "课后作业建议",
  "nextLesson": "下节课衔接建议",
  "misconceptions": ["学生可能的常见误区（提前预警）"]
}`;
  return { ok: true, summary: await llmJson(prompt) };
}

export const teachingAssistantService = {
  generateLesson, generateExam, gradeSubmission, classSummary,
  generateSyllabus, generateCourseware, layeredDesign, generateQuestions,
  wrongAnalysisReport, generateDiscussion, quickQuiz, lectureSummary,
};
