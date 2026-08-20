// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// language-learning-service.ts — 阅读与语言学习 Agent（V389，复赛）
// 手册 4.3.4「阅读与语言学习」方向：
//   ① 阅读理解辅导：外文/经典文献精读 → 段落释义 + 结构拆解 + 主旨提炼 + 重点词汇
//   ② 词汇与语法：生词释义（语境）、语法点反馈
//   ③ 写作修改：作文/论文润色 → 表达优化 + 语法修正 + 逻辑梳理 + 改写建议
//   ④ 学习记录：阅读/写作记录落库（answer_history 同构的 study_records 表）
// 边界: 辅助学习不替代教师评价；润色保留原意
import { pool } from "../db/pool.js";
import { llmJson } from "./education-service.js";

// ═══ ① 阅读理解辅导 ═══
export async function readingTutor(input: {
  text: string;                 // 待精读文本
  language?: string;            // zh/en
  focus?: string;               // 阅读目标（如：考研政治 / 论文精读）
  studentId?: string;
}): Promise<Record<string, unknown>> {
  const judge = await llmJson(`你是阅读辅导老师。精读以下文本（${input.language || "zh"}）${input.focus ? `，阅读目标: ${input.focus}` : ""}：
【文本】${input.text.slice(0, 2500)}

输出 JSON: {
  "summary": "段落/文本主旨（2-3句）",
  "structure": [{"part": "部分", "role": "作用", "keyPoints": ["要点"]}],
  "keyTerms": [{"term": "重点词汇/术语", "meaning": "语境释义", "example": "例句"}],
  "difficulties": [{"sentence": "难点句", "explanation": "拆解释义"}],
  "questions": [{"q": "引导思考的问题", "hint": "思考方向"}]
}`);
  return { ok: true, reading: judge };
}

// ═══ ② 词汇语法反馈 ═══
export async function vocabGrammar(input: {
  text: string;                 // 学生写的句子/段落
  language?: string;
}): Promise<Record<string, unknown>> {
  const judge = await llmJson(`你是语言老师。检查以下${input.language || "中文"}文本的词汇与语法：
【文本】${input.text.slice(0, 1500)}

输出 JSON: {
  "grammarIssues": [{"issue": "语法问题", "sentence": "原文", "correction": "修正", "reason": "原因"}],
  "vocabSuggestions": [{"word": "用词", "better": "更优表达", "context": "语境说明"}],
  "praise": "写得好的地方"
}`);
  return { ok: true, feedback: judge };
}

// ═══ ③ 写作修改（润色）═══
export async function writingPolish(input: {
  text: string;
  style?: string;               // 学术/正式/简洁/文采
  keepMeaning?: boolean;        // 保留原意（默认 true）
}): Promise<Record<string, unknown>> {
  const judge = await llmJson(`你是写作导师。${input.keepMeaning !== false ? "在保留原意的前提下" : ""}润色以下文本（风格: ${input.style || "学术"}）：
【原文】${input.text.slice(0, 2500)}

输出 JSON: {
  "polished": "润色后全文",
  "changes": [{"original": "原文片段", "revised": "修改后", "reason": "修改理由（语法/表达/逻辑）"}],
  "summary": "本次修改要点（2-3点）",
  "suggestions": ["进一步改进建议"]
}`);
  return { ok: true, polish: judge };
}

// ═══ ④ 学习记录（阅读/写作落库）═══
export async function recordStudy(input: {
  studentId?: string;
  activity: "reading" | "writing" | "vocab";
  subject: string;
  topic: string;
  detail?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `insert into study_records (student_id, activity, subject, topic, detail)
     values ($1, $2, $3, $4, $5) returning id, created_at`,
    [studentId, input.activity, input.subject, input.topic, input.detail || null]
  );
  return { ok: true, record: r.rows[0] };
}

export const languageLearningService = { readingTutor, vocabGrammar, writingPolish, recordStudy };
