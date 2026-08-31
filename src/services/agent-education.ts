// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-education.ts — 教育专属 Agent 编排层（复赛冲刺期实现）
// 在通用编排之上提供教育场景特有的引导式闭环：
//   ① 苏格拉底式提问（socratic）：连续追问引导，追问轮次上限 3，超限给提示不揭底
//   ② 阶梯式启发（scaffolded）：hint→guided→full 逐级提示，记录跃级求助
//   ③ 错题-知识点联动（wrong-to-mastery）：错题→溯源→掌握度下调→变式验证→回升
//   ④ 学习进度追踪（progress）：study_plans.progress + 掌握度变化 + 变式正确率
//   ⑤ 角色化编排（role）：学生端「我的学习」/ 教师端「教师工作台」双工作流
// 边界: 辅助学习不替代教师/学校评价；不直接给答案（安全策略 agent-education.policy）
// 复用: 既有教育服务（homework-help / adaptive / diagnostic / study-companion）+ knowledge_mastery
import { pool } from "../db/pool.js";
import { llmJson, recallStudentMemory } from "./education-service.js";
import { solveQuestion, generateVariant } from "./homework-help-service.js";
import { recordAnswer, getStudentProfile, adaptivePush } from "./adaptive-learning-service.js";
import { locateGaps, predictRisk } from "./diagnostic-service.js";
import { updateProgress, currentPlans } from "./study-companion-service.js";

// ═══ ① 苏格拉底式提问 ═══
export interface SocraticState {
  round: number;          // 已追问轮数
  maxRounds: number;      // 上限 3
  question: string;       // 原始问题
  subject: string;
  answered: boolean;      // 学生是否已推出结论
  insights: string[];     // 学生已回答的点（记忆沉淀用）
}

/** 发起苏格拉底会话（首轮提问） */
export async function socraticStart(input: {
  subject: string;
  question: string;
  studentId?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const memory = await recallStudentMemory(`${input.subject} 苏格拉底 ${input.question}`);

  const prompt = `你是苏格拉底式辅导老师。学生问题: ${input.question}（科目: ${input.subject}）。
${memory}
用苏格拉底式提问引导，规则:
1. 第 1 轮只给 1-2 个启发式追问（不是直接讲解，更不是答案）
2. 追问要贴合学生已知概念，逐级深入（如先问定义/区别，再问变换/应用）
3. 每轮追问让学生自己推出下一步
输出 JSON: {
  "acknowledge": "肯定学生主动提问（1句）",
  "questions": [{"q":"追问1（具体）","hint":"思考方向提示（不揭底）"}],
  "why": "这一问想引导学生想到什么（不展示给学生，仅供教师/审计）"
}`;
  const state: SocraticState = {
    round: 1, maxRounds: 3, question: input.question, subject: input.subject,
    answered: false, insights: [],
  };
  return { ok: true, state, socratic: await llmJson(prompt), role: "student" };
}

/** 苏格拉底继续追问（学生回答后） */
export async function socraticContinue(input: {
  studentId?: string;
  subject: string;
  question: string;
  state: SocraticState;
  studentAnswer: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const state = input.state;
  const round = (state.round || 0) + 1;

  // 学生答对了关键点 → 确认并引导收尾
  const prompt = `你是苏格拉底式辅导老师。科目: ${input.subject}，原始问题: ${input.question}。
第 ${round} 轮。学生上一轮回答: ${input.studentAnswer}（第 ${state.round} 轮的追问后）。

规则:
1. 判断学生回答是否已推出正确方向:
   - 已接近正确 → 确认 + 给出收尾引导（让学生自己完成最后一步）
   - 方向偏差 → 温和纠正 + 再给 1 个更具体追问（不直接给答案）
   - 完全卡住 → 给提示性追问（仍不揭底）
2. 追问轮次已到上限(${state.maxRounds})时，若学生仍未答出 → 给分步提示但不给最终答案
3. 判断学生是否已得出最终结论（answered）
输出 JSON: {
  "verdict": "on_track | off_track | stuck | concluded",
  "feedback": "对学生回答的反馈（肯定进步/纠正偏差）",
  "questions": [{"q":"下一轮追问（或空数组表示收尾）","hint":"思考方向"}],
  "stepHints": ["若到上限：分步提示（不直接给答案）"],
  "answered": true|false,
  "conclusionCheck": "如果是 concluded，引导学生核对结论的问题"
}`;
  const res = await llmJson(prompt);

  return {
    ok: true,
    round,
    socratic: res,
    state: {
      ...state,
      round,
      answered: !!res?.answered,
      insights: [...(state.insights || []), input.studentAnswer],
    },
    role: "student",
  };
}

// ═══ ② 阶梯式启发 ═══
/** 阶梯式辅导：按卡住程度逐级给提示（复用 solveQuestion 的 hint/guided/full） */
export async function scaffoldedTutoring(input: {
  subject: string;
  question: string;
  stuckLevel?: 0 | 1 | 2;       // 0=方向提示 1=操作步骤 2=完整解析
  studentId?: string;
  mode?: "text" | "photo" | "formula" | "diagram";
}): Promise<Record<string, unknown>> {
  const stuckLevel = input.stuckLevel ?? 0;
  // 阶梯映射：0→hint(方向) 1→guided(分步) 2→full(完整解析，供核对)
  const hintLevel = (["hint", "guided", "full"] as const)[stuckLevel];
  const solution = await solveQuestion({
    subject: input.subject, question: input.question,
    mode: input.mode || "text", hintLevel, studentId: input.studentId,
  });
  return {
    ok: true,
    stuckLevel,
    hintLevel,
    solution,
    nextHint: stuckLevel < 2 ? `若仍卡住，可请求第 ${stuckLevel + 2} 级提示（更具体）` : "已是完整解析，请核对后尝试同类题",
    role: "student",
  };
}

// ═══ ③ 错题-知识点联动 ═══
/** 错题-知识点联动：错题归集 → 溯源 → 掌握度下调 → 建议变式 */
export async function wrongToMastery(input: {
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

  // ① 自动归集错题（recordWrongQuestion 内部联动 recordAnswer 下调掌握度）
  const { recordWrongQuestion } = await import("./homework-help-service.js");
  const wrong = await recordWrongQuestion({ ...input, studentId });
  const wrongId = wrong.wrongId;

  // ② 读取当前掌握度
  const mastery = await pool.query(
    `select mastery_level, score, attempts from knowledge_mastery
     where student_id = $1 and subject = $2 and knowledge_point = $3`,
    [studentId, input.subject, input.knowledgePoint]
  );
  const cur = mastery.rows[0] || { mastery_level: "unlearned", score: 0, attempts: 0 };

  // ③ 连续错题检测（错 3 次 → 建议插入微课）
  const wrongCount = await pool.query(
    `select count(*)::int as n from wrong_questions
     where student_id = $1 and subject = $2 and knowledge_point = $3 and mastered = false`,
    [studentId, input.subject, input.knowledgePoint]
  );
  const consecWrong = wrongCount.rows[0]?.n || 0;

  // ④ 自动生成变式题（巩固）
  const variants = await generateVariant({
    studentId, subject: input.subject, knowledgePoint: input.knowledgePoint,
    wrongQuestionId: wrongId as number, originalQuestion: input.question, count: 2,
  });

  return {
    ok: true,
    wrongId,
    masteryAfter: cur,
    consecWrong,
    insertMicroLesson: consecWrong >= 3,   // 联动：连续错 3 次 → 下次计划自动插微课
    variants: variants.variants || [],
    role: "student",
  };
}

// ═══ ④ 学习进度追踪 ═══
/** 学习进度报告：计划完成率 + 掌握度变化 + 变式正确率 */
export async function learningProgress(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const subject = input.subject;

  // ① 计划完成率（study_plans）
  const plans = await currentPlans({ studentId });
  const activePlan = (plans.plans as Array<Record<string, unknown>> | undefined)?.[0] || null;

  // ② 掌握度变化（knowledge_mastery，按科目过滤）
  const mastery = await pool.query(
    `select knowledge_point, mastery_level, score, attempts, last_answer_at
     from knowledge_mastery where student_id = $1 ${subject ? "and subject = $2" : ""}
     order by last_answer_at desc limit 15`,
    subject ? [studentId, subject] : [studentId]
  );

  // ③ 变式正确率（variant_questions 关联 answer_history 近似：变式题作答正确率）
  const variantStats = await pool.query(
    `select count(*)::int as total,
            sum(case when is_correct then 1 else 0 end)::int as correct
     from answer_history
     where student_id = $1 ${subject ? "and subject = $2" : ""} and question like '%变式%'`,
    subject ? [studentId, subject] : [studentId]
  );

  // ④ 错题清零情况
  const wrongStats = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where mastered = true)::int as mastered
     from wrong_questions where student_id = $1 ${subject ? "and subject = $2" : ""}`,
    subject ? [studentId, subject] : [studentId]
  );

  const v = variantStats.rows[0] || { total: 0, correct: 0 };
  const w = wrongStats.rows[0] || { total: 0, mastered: 0 };

  return {
    ok: true,
    plan: activePlan,
    mastery: mastery.rows,
    variantAccuracy: v.total > 0 ? Math.round((v.correct / v.total) * 100) : 0,
    wrongCleared: w.total > 0 ? Math.round((w.mastered / w.total) * 100) : 0,
    role: "student",
  };
}

// ═══ ⑤ 角色化编排：学生端 / 教师端工作流分派 ═══
export async function routeByRole(input: {
  role: "student" | "teacher";
  action: string;             // 学生: socratic|scaffold|wrong|progress | 教师: lesson|exam|grade|class-summary
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { role, action, payload } = input;

  if (role === "teacher") {
    // 教师工作台：备课/命题/批改/班级学情（动态 import 教学服务）
    const { generateLesson, generateExam, gradeSubmission, classSummary } = await import("./teaching-assistant-service.js");
    switch (action) {
      case "lesson": return { ok: true, role, lesson: await generateLesson(payload as any) };
      case "exam": return { ok: true, role, exam: await generateExam(payload as any) };
      case "grade": return { ok: true, role, grading: await gradeSubmission(payload as any) };
      case "class-summary": return { ok: true, role, summary: await classSummary(payload as any) };
      default: return { ok: false, error: `教师端未知动作: ${action}` };
    }
  }

  // 学生端「我的学习」
  switch (action) {
    case "socratic": return socraticStart(payload as any);
    case "socratic-continue": return socraticContinue(payload as any);
    case "scaffold": return scaffoldedTutoring(payload as any);
    case "wrong": return wrongToMastery(payload as any);
    case "progress": return learningProgress(payload as any);
    default: return { ok: false, error: `学生端未知动作: ${action}` };
  }
}

// ═══ ⑥ 安全边界（agent-education.policy 内嵌规则）═══
/** 策略校验：拒绝越界工具调用（不直接给答案 / 不替代教师评价） */
export function checkEducationPolicy(content: string): { allowed: boolean; reason?: string } {
  // 明令禁止：直接要求输出最终答案（辅导场景需走阶梯/苏格拉底）
  if (/请(直接|马上|立刻).{0,10}(给|写|输出).{0,8}(答案|解题过程)/.test(content)) {
    return { allowed: false, reason: "教育策略：默认分步引导，不直接给答案（可走 scaffold/socratic）" };
  }
  if (/代替.{0,6}(老师|教师|学校).{0,8}(评价|判断|打分)/.test(content)) {
    return { allowed: false, reason: "教育策略：不替代教师/学校/专业机构的最终教育评价" };
  }
  return { allowed: true };
}

// ═══ ⑦ 五步追问打磨（Hazel 式：发散 → 聚焦 → 压力测试 → 子问题拆解）═══
const POLISH_STEPS = ["记录问题", "发散拓展", "聚焦收敛", "压力测试"] as const;
type PolishStep = (typeof POLISH_STEPS)[number];

/** 学习问题打磨：按步骤迭代（发散/聚焦/压力测试），每步可独立执行 */
export async function polishStep(input: {
  subject: string;
  question: string;
  step: "diverge" | "verify" | "focus" | "stress";
  context?: string;             // 前置步骤输出（跳步会降级）
}): Promise<Record<string, unknown>> {
  const { subject, question, step, context } = input;
  const ctx = context ? `\n【前置上下文】${context.slice(0, 1200)}` : "\n（无前置上下文——跳步执行，输出质量降级）";

  // ③ 初步验证：检索知识库判断研究密度与空白
  if (step === "verify") {
    const { retrieveChunks } = await import("./education-service.js");
    const { DEFAULT_SOURCE } = await import("./education-service.js");
    const hits = await retrieveChunks(question, DEFAULT_SOURCE, 8);
    const density = hits.length;

    const judge = await llmJson(`你是选题验证专家。基于知识库检索结果判断该问题（${subject}）的研究密度与空白：${ctx}
【问题】${question}
【知识库命中】${hits.length} 条：
${hits.slice(0, 5).map((h: any) => `- [${h.title}] ${h.content.substring(0, 100)}`).join("\n")}

输出 JSON: {
  "density": "高|中|低",
  "densityReason": "密度判断依据（命中数量/内容分布）",
  "gapAnalysis": "研究空白判断（哪些角度未被覆盖）",
  "verdict": "值得做|需调整|换方向",
  "adjustment": "调整建议（如何让问题更可研究）",
  "relatedSources": ["知识库相关来源标题"]
}`);
    return { ok: true, step, question, result: { ...judge, _kbHits: density }, stepLabel: "初步验证" };
  }

  const prompts: Record<string, string> = {
    diverge: `你是学习问题发散专家。围绕问题「${question}」（${subject}）发散拓展：${ctx}

输出 JSON: {
  "directions": [{"direction": "拓展方向", "rationale": "为什么值得探索", "questions": ["可延伸的问题"]}],
  "keywords": ["关键词/检索词"],
  "branches": ["相关分支主题"],
  "suggestion": "下一步聚焦建议"
}`,
    focus: `你是学习问题收敛专家。基于以下信息将问题聚焦为清晰的 Problem Statement：${ctx}
【问题】${question}（${subject}）

输出 JSON: {
  "problemStatement": "规范的问题陈述（一句话）",
  "scope": "研究/学习边界",
  "assumptions": ["隐含假设"],
  "keyConcepts": ["核心概念界定"],
  "nextSteps": ["下一步行动"]
}`,
    stress: `你是严格的审稿人（借鉴 good-question 技能的 Reviewer 模式：先给最强拒稿风险，再给修复路径）。对以下问题陈述进行压力测试，找出缺陷：${ctx}
【问题】${question}（${subject}）

输出 JSON: {
  "weaknesses": [{"issue": "缺陷/漏洞", "severity": "高|中|低", "reason": "为什么是问题"}],
  "challenges": [{"challenge": "可能的质疑", "response": "如何回应"}],
  "boundaryIssues": ["边界/概念界定问题"],
  "killRules": ["命中哪条淘汰规则(无受益者/只说没人做过/说不出证伪路径/资源远超约束/方法先于问题/复杂度无收益)"],
  "falsifier": "什么可观察结果会推翻这个假设",
  "improved": "改进后的问题表述"
}`,
  };

  const stepLabels: Record<string, string> = { diverge: "发散拓展", focus: "聚焦收敛", stress: "压力测试" };
  return { ok: true, step, question, result: await llmJson(prompts[step]), stepLabel: stepLabels[step] };
}

/** 子问题拆解：从问题陈述自动拆出 2-4 个子问题 */
export async function decomposeQuestions(input: { subject: string; problemStatement: string; count?: number }): Promise<Record<string, unknown>> {
  const count = input.count || 3;
  const judge = await llmJson(`你是研究拆解专家。从以下问题陈述拆解出 ${count} 个子问题（可独立研究/检索）：
【问题】${input.problemStatement}（${input.subject}）

输出 JSON: {
  "subQuestions": [{"question": "子问题", "rationale": "为什么重要", "searchHints": ["检索关键词"]}]
}`);
  return { ok: true, subQuestions: judge?.subQuestions || [], count };
}

/** 步骤结果追问：对某一步的输出苏格拉底式追问（Hazel「结果与追问」区） */
export async function followUpPolish(input: {
  subject: string;
  stepLabel: string;
  stepOutput: string;        // 该步输出（截断）
  question: string;          // 用户追问
}): Promise<Record<string, unknown>> {
  const judge = await llmJson(`你是苏格拉底式追问导师。用户针对「${input.stepLabel}」步骤的输出进行追问，请引导深入：
【步骤输出】${input.stepOutput.slice(0, 1500)}
【用户追问】${input.question}（${input.subject}）

追问原则：不直接给答案，用递进问题引导思考；先肯定提问价值；每次 1-2 个追问。
输出 JSON: {
  "acknowledge": "肯定用户的追问",
  "diagnosis": "追问背后的深层问题判断",
  "followUps": [{"q": "引导追问", "hint": "思考方向"}],
  "insight": "一句话点拨（不是答案）"
}`);
  return { ok: true, followUp: judge };
}

// ═══ ⑧ 想法卡管理（Hazel 式多想法并行）═══
export async function listIdeaCards(input: { studentId?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select id, title, raw_idea, subject, progress, created_at, updated_at
     from idea_cards where student_id = $1 order by updated_at desc limit 20`,
    [studentId]
  );
  return { ok: true, cards: r.rows };
}

export async function createIdeaCard(input: { studentId?: string; title: string; rawIdea: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const title = (input.title || input.rawIdea.slice(0, 20) || "新想法").slice(0, 60);
  const r = await pool.query(
    `insert into idea_cards (student_id, title, raw_idea, subject) values ($1, $2, $3, $4) returning id, title, raw_idea, subject, progress`,
    [studentId, title, input.rawIdea, input.subject || "政治经济学"]
  );
  return { ok: true, card: r.rows[0] };
}

export async function updateIdeaCard(input: { studentId?: string; id: number; title?: string; rawIdea?: string; subject?: string; progress?: number }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const sets: string[] = [];
  const params: unknown[] = [studentId, input.id];
  if (input.title !== undefined) { params.push(input.title.slice(0, 60)); sets.push(`title = $${params.length}`); }
  if (input.rawIdea !== undefined) { params.push(input.rawIdea); sets.push(`raw_idea = $${params.length}`); }
  if (input.subject !== undefined) { params.push(input.subject); sets.push(`subject = $${params.length}`); }
  if (input.progress !== undefined) { params.push(input.progress); sets.push(`progress = $${params.length}`); }
  if (sets.length === 0) return { ok: false, error: "无更新字段" };
  sets.push("updated_at = now()");
  const r = await pool.query(
    `update idea_cards set ${sets.join(", ")} where student_id = $1 and id = $2 returning id, title, raw_idea, subject, progress`,
    params
  );
  return r.rows.length > 0 ? { ok: true, card: r.rows[0] } : { ok: false, error: "想法卡不存在" };
}

export async function deleteIdeaCard(input: { studentId?: string; id: number }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(`delete from idea_cards where student_id = $1 and id = $2 returning id`, [studentId, input.id]);
  return { ok: true, deleted: (r.rowCount ?? 0) > 0 };
}

export const agentEducationService = {
  socraticStart, socraticContinue, scaffoldedTutoring, wrongToMastery, learningProgress,
  routeByRole, checkEducationPolicy, polishStep, decomposeQuestions, followUpPolish,
  listIdeaCards, createIdeaCard, updateIdeaCard, deleteIdeaCard,
};
