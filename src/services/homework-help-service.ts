// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// homework-help-service.ts — 作业辅导系统（V385）
// 四层能力：
//   ① 题目解析：分步拆解提供思路，不直接灌输答案（启发式）
//   ② 错题处理：自动归集错题→溯源知识点→生成同类变式题巩固
//   ③ 多模态支持：文本/拍照描述/公式/图表类题目解析
//   ④ 作业答疑：针对卡点追问式引导，提示思考方向
// 复用: 教育服务 llmJson/retrieveChunks + knowledge_mastery(掌握度联动)
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks, recallStudentMemory, DEFAULT_SOURCE } from "./education-service.js";

// ═══ ① 题目解析：分步拆解 + 思路引导（不直接给答案）═══
export async function solveQuestion(input: {
  subject: string;
  question: string;          // 题目内容（文本/拍照描述的OCR文本/公式文本/图表描述）
  mode?: "text" | "photo" | "formula" | "diagram";  // 多模态类型
  hintLevel?: "hint" | "guided" | "full";           // 提示程度（默认 hint 启发式）
  studentId?: string;
}): Promise<Record<string, unknown>> {
  const mode = input.mode || "text";
  const hintLevel = input.hintLevel || "hint";
  const studentId = input.studentId || "default";

  // 知识库检索（相关文献支撑）
  const chunks = await retrieveChunks(input.question.slice(0, 20), DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库参考】\n${chunks.slice(0, 3).map((c) => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const modeHint = {
    text: "文本题目",
    photo: "拍照题目（已OCR为文本）",
    formula: "公式类题目（含数学/经济公式）",
    diagram: "图表类题目（已描述图表内容）",
  }[mode];

  const levelRule = {
    hint: "只给解题思路提示，不直接给答案（保护独立思考）",
    guided: "分步引导，每步给提示让学生自己推导，最后才核对",
    full: "完整解析（供学生核对）",
  }[hintLevel];

  const prompt = `你是作业辅导老师。题目类型：${modeHint}。${levelRule}。
科目: ${input.subject}
题目: ${input.question}
${ctx}

输出 JSON: {
  "analysis": "题目拆解（考点/已知条件/要求什么）",
  "steps": [{"hint":"第一步提示","thinking":"引导学生思考的问题"}],
  "keyFormula": "关键公式/概念（如有）",
  "pitfalls": ["易错点提醒"],
  "finalAnswer": "最终答案（hint模式可留空让学生自己完成）",
  "similarPractice": "一道同类练习建议"
}`;
  return { ok: true, solution: await llmJson(prompt), mode, hintLevel };
}

// ═══ ② 错题处理：归集 + 溯源 + 变式题 ═══
export async function recordWrongQuestion(input: {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  correctAnswer?: string;
  mistakeType?: string;
  difficulty?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // 存错题
  const r = await pool.query(
    `insert into wrong_questions (student_id, subject, knowledge_point, question, user_answer, correct_answer, mistake_type, difficulty)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [studentId, input.subject, input.knowledgePoint, input.question, input.userAnswer ?? null, input.correctAnswer ?? null, input.mistakeType || "unknown", input.difficulty || "medium"]
  );
  const wrongId = r.rows[0].id;

  // 溯源：更新掌握度（错题 → 该知识点扣分）
  const { recordAnswer } = await import("./adaptive-learning-service.js");
  await recordAnswer({
    studentId, subject: input.subject, knowledgePoint: input.knowledgePoint,
    question: input.question, userAnswer: input.userAnswer, isCorrect: false, difficulty: input.difficulty,
  });

  return { ok: true, wrongId, note: "已归集错题并溯源知识点，掌握度已下调" };
}

/** 生成同类变式题（巩固） */
export async function generateVariant(input: {
  studentId?: string;
  subject: string;
  wrongQuestionId?: number;
  knowledgePoint: string;
  originalQuestion: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const count = input.count || 3;

  const prompt = `你是出题老师。请基于原题生成 ${count} 道同类变式题（同知识点、不同角度/数据，用于巩固掌握）：
科目: ${input.subject}
知识点: ${input.knowledgePoint}
原题: ${input.originalQuestion}

要求: 变式题与原题同难度或略高，避免原题简单改写，要有思维增量。
输出 JSON: {"variants":[{"question":"变式题","answer":"答案/解析","thinkingPoint":"考察的思维点"}]}`;

  const res = await llmJson(prompt);
  const variants = res?.variants || [];

  // 记录变式题
  for (const v of variants) {
    await pool.query(
      `insert into variant_questions (wrong_question_id, student_id, subject, knowledge_point, variant_question, variant_answer)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.wrongQuestionId ?? null, studentId, input.subject, input.knowledgePoint, v.question, v.answer]
    );
  }

  // 更新错题变式计数
  if (input.wrongQuestionId) {
    await pool.query(`update wrong_questions set variant_count = variant_count + $2 where id = $1`, [input.wrongQuestionId, variants.length]);
  }

  return { ok: true, variants, knowledgePoint: input.knowledgePoint };
}

/** 错题本列表（按科目/未掌握） */
export async function listWrongQuestions(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1 and mastered = false";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }

  const r = await pool.query(
    `select id, subject, knowledge_point, question, mistake_type, difficulty, variant_count, created_at
     from wrong_questions where ${where} order by created_at desc limit 50`,
    params
  );
  return { ok: true, wrongQuestions: r.rows, total: r.rows.length };
}

/** 标记错题已掌握（变式题答对后） */
export async function markWrongMastered(input: { wrongQuestionId: number; studentId?: string }): Promise<Record<string, unknown>> {
  await pool.query(`update wrong_questions set mastered = true, updated_at = now() where id = $1`, [input.wrongQuestionId]);
  return { ok: true, mastered: true };
}

// ═══ ④ 作业答疑：追问式引导（不是直接回答）═══
export async function homeworkQnA(input: {
  subject: string;
  question: string;          // 作业题目
  stuckAt: string;           // 卡在哪里（具体描述）
  attempts?: string;         // 已尝试的方法
  studentId?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const memory = await recallStudentMemory(`${input.subject} 作业 卡点 ${input.stuckAt}`);

  const prompt = `你是作业答疑老师。学生作业卡住，用【追问式引导】帮助他（绝不直接给答案）：
科目: ${input.subject}
题目: ${input.question}
学生卡在: ${input.stuckAt}
已尝试: ${input.attempts || "未说明"}
${memory}

引导原则:
1. 先确认学生已经理解的部分（肯定他的尝试）
2. 用 2-3 个递进式追问缩小卡点（不是一次给完）
3. 每个追问给思考方向提示（不是答案）
4. 如果学生方向完全错误，温和纠正并引导回到正确思路
输出 JSON: {
  "acknowledge": "肯定已尝试的部分",
  "diagnosis": "卡点诊断（可能是概念不清/方法不对/漏条件）",
  "followUpQuestions": [{"question":"追问1","directionHint":"思考方向提示"}],
  "redirect": "如果方向错了的纠正引导（可选）",
  "nextStep": "建议学生下一步做什么"
}`;
  return { ok: true, guidance: await llmJson(prompt) };
}

export const homeworkHelpService = { solveQuestion, recordWrongQuestion, generateVariant, listWrongQuestions, markWrongMastered, homeworkQnA };
