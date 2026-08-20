// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// coding-education-service.ts — 职业教育/编程教育 Agent（V389，复赛）
// 手册 4.3.4「职业教育/编程教育」方向：
//   ① 任务拆解：项目/作业任务 → 可执行步骤 + 子任务 + 验收标准
//   ② 代码练习辅导：不直接给答案 → 分步提示 + 报错解读 + 思路引导
//   ③ 面试准备：技术面试题 + 答题框架 + 模拟追问
//   ④ 学习路线：岗位技能 → 分阶段学习路线 + 里程碑
// 边界: 辅助学习不替代教师评价；代码辅导默认引导式（hint 优先）
import { llmJson } from "./education-service.js";
import { solveQuestion } from "./homework-help-service.js";

// ═══ ① 任务拆解 ═══
export async function taskDecomposition(input: {
  task: string;                 // 项目/作业任务描述
  role?: string;                // 岗位方向（如：数据分析师/前端）
  skillLevel?: string;          // 基础/进阶
}): Promise<Record<string, unknown>> {
  const judge = await llmJson(`你是项目导师。将任务拆解为可执行步骤：
【任务】${input.task.slice(0, 1500)}${input.role ? `，岗位方向: ${input.role}` : ""}${input.skillLevel ? `，技能水平: ${input.skillLevel}` : ""}

输出 JSON: {
  "objective": "任务目标（一句话）",
  "steps": [{"step": 1, "title": "子任务", "detail": "具体做法", "output": "本步产出/验收标准", "timeEstimate": "预计耗时"}],
  "dependencies": [{"from": "前置步骤", "to": "后续步骤", "why": "依赖原因"}],
  "pitfalls": ["常见坑/注意事项"]
}`);
  return { ok: true, decomposition: judge };
}

// ═══ ② 代码练习辅导（引导式，不直接给答案）═══
export async function codeTutoring(input: {
  subject: string;
  question: string;             // 代码题描述/报错
  code?: string;                // 学生代码
  error?: string;               // 报错信息
  hintLevel?: "hint" | "guided" | "full";
}): Promise<Record<string, unknown>> {
  // ① 代码报错优先解读
  let errorAnalysis = null;
  if (input.error) {
    errorAnalysis = await llmJson(`解读以下代码报错（${input.subject}）：
【代码】${(input.code || "").slice(0, 1000)}
【报错】${input.error.slice(0, 800)}

输出 JSON: {
  "cause": "报错根因（通俗解释）",
  "location": "出错位置定位",
  "fixHint": "修复提示（不直接给完整修复）",
  "concept": "涉及的核心概念"
}`);
  }

  // ② 引导式解题（复用 solveQuestion 的阶梯 hint）
  const solution = await solveQuestion({
    subject: input.subject,
    question: `${input.question}${input.code ? `\n学生代码:\n${input.code.slice(0, 1000)}` : ""}`,
    mode: "text",
    hintLevel: input.hintLevel || "hint",
  });

  return {
    ok: true,
    errorAnalysis,
    solution: (solution as any).solution,
    hintLevel: input.hintLevel || "hint",
    note: "代码辅导默认引导式，先给思路再逐步深入，不直接给完整代码",
  };
}

// ═══ ③ 面试准备 ═══
export async function interviewPrep(input: {
  role: string;                 // 岗位（如：后端开发/算法工程师）
  topic?: string;               // 重点方向
  count?: number;
}): Promise<Record<string, unknown>> {
  const count = input.count || 5;
  const judge = await llmJson(`你是技术面试官导师。为「${input.role}」岗位${input.topic ? `（重点: ${input.topic}）` : ""}准备 ${count} 道面试题：

输出 JSON: {
  "questions": [{"num": 1, "question": "面试题", "type": "概念|场景|手写|项目", "difficulty": "基础|进阶|高难",
                 "answerFramework": "答题框架（要点结构，不代写完整答案）",
                 "followUp": "模拟追问（面试官会追什么）"}],
  "prepAdvice": "整体准备建议"
}`);
  return { ok: true, interview: judge };
}

// ═══ ④ 学习路线（岗位技能 → 分阶段）═══
export async function careerPath(input: {
  role: string;                 // 目标岗位
  currentLevel?: string;        // 当前水平
  weeks?: number;
}): Promise<Record<string, unknown>> {
  const weeks = input.weeks || 12;
  const judge = await llmJson(`你是职业规划导师。为「${input.role}」岗位${input.currentLevel ? `（当前: ${input.currentLevel}）` : ""}生成 ${weeks} 周学习路线：

输出 JSON: {
  "role": "岗位",
  "skillMap": [{"skill": "核心技能", "importance": "高|中|低", "why": "为什么重要"}],
  "phases": [{"phase": 1, "weeks": "第1-3周", "focus": "阶段重点", "skills": ["技能"], "projects": ["实践项目"], "milestone": "阶段验收标准"}],
  "resources": ["推荐学习资源"],
  "careerTips": "求职建议"
}`);
  return { ok: true, path: judge, weeks };
}

export const codingEducationService = { taskDecomposition, codeTutoring, interviewPrep, careerPath };
