// education-service.ts — AI+教育 六大能力（V382, 2026-08-09）
// 个性化学习规划 / 专业课课程辅导 / 学情诊断 / 预习与复习 / 教师备课 / 学习陪伴
// V383: 深度联动整个 Agent —— 走 52 步推理链路（三库检索→图谱→生成→评估→反思）+ 引用溯源 + 记忆
// 复用: 推理链路（HTTP 调 /api/reason/query）+ 检索（PG chunks）+ 记忆（OpenViking）
// 边界: 辅助学习不替代教师/学校评价（比赛合规要求）
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { callLlm, getLlmEndpoint } from "../ai/llm-common.js";

const SAG_URL = process.env.SAG_INTERNAL_URL || "http://127.0.0.1:4173";
export const DEFAULT_SOURCE = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

export async function llmJson(prompt: string, modelOverride?: string): Promise<any | null> {
  const ep = getLlmEndpoint(modelOverride ? { model: modelOverride } : undefined);
  const r = await callLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 2000, jsonMode: true,
  });
  return r?.json ?? null;
}

/**
 * V383: 深度推理联动 —— 走 52 步完整链路（三库检索→图谱→生成→评估→反思）
 * 返回结构化结果 + 推理轨迹（供前端展示全链路）
 */
async function deepReason(query: string, sourceId?: string): Promise<{
  content: string; confidence: number; citations: unknown[]; trace: Record<string, unknown>;
}> {
  try {
    const res = await fetch(`${SAG_URL}/api/reason/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: sourceId || DEFAULT_SOURCE, query, topK: 10 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { content: "", confidence: 0, citations: [], trace: {} };
    const d = await res.json();
    const hyp = d?.trace?.hypothesis || {};
    return {
      content: hyp.content || "",
      confidence: hyp.confidence ?? 0,
      citations: hyp.citations || [],
      trace: d?.trace || {},
    };
  } catch {
    return { content: "", confidence: 0, citations: [], trace: {} };
  }
}

/** 记忆联动：从 OpenViking 召回学生历史画像/诊断记录 */
export async function recallStudentMemory(query: string): Promise<string> {
  try {
    const { recallMemory } = await import("./openviking-memory.js");
    const mems = await recallMemory(query, 3, 0.15);
    return mems.length > 0
      ? `\n\n【该学生的历史记忆（来自 OpenViking 长期记忆）】\n${mems.map(m => m.content.substring(0, 150)).join("\n")}`
      : "";
  } catch { return ""; }
}

/** 从知识库检索相关内容（source_chunks 表，V383 修正表名） */
export async function retrieveChunks(query: string, sourceId: string, topK = 15): Promise<Array<{ title: string; heading: string; content: string }>> {
  try {
    const r = await pool.query(
      `select c.heading as title, c.heading, c.content
       from source_chunks c
       where c.source_id = $1 and (c.heading ILIKE '%' || $2 || '%' or c.content ILIKE '%' || $2 || '%')
       order by c.rank nulls last
       limit $3`,
      [sourceId, query.slice(0, 30), topK]
    );
    return r.rows;
  } catch { return []; }
}

// ═══ 1. 个性化学习规划（V383 深度联动：记忆画像 + 知识库支撑 + 推理）═══
export async function learningPlan(input: {
  subject: string;          // 课程/科目
  goal: string;             // 学习目标
  currentLevel?: string;    // 当前水平
  hoursPerWeek?: number;    // 每周可投入时间
  deadline?: string;        // 目标日期
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  // ① 记忆联动：召回该学生历史画像
  const memory = await recallStudentMemory(`${input.subject} 学习 ${input.currentLevel || ""}`);
  // ② 知识库支撑：检索该科目相关文献
  const chunks = await retrieveChunks(input.subject, input.sourceId || DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${input.subject} 相关文献）】\n${chunks.slice(0, 5).map(c => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是个性化学习规划专家。请为以下学习者制定分阶段学习计划，并给出与系统知识库的关联学习路径：
科目: ${input.subject}
目标: ${input.goal}
当前水平: ${input.currentLevel || "未说明"}
每周可投入: ${input.hoursPerWeek || 4} 小时
目标期限: ${input.deadline || "灵活"}
${memory}${ctx}

要求:
1. 按阶段划分（基础→强化→冲刺），每阶段明确学习内容与练习量
2. 每个阶段关联 1-2 篇系统知识库中的文献（作为该阶段必读材料）
3. 根据目标动态调整路径（不是固定模板）
4. 输出 JSON: {"stages":[{"phase":"阶段名","duration":"周期","objectives":["目标"],"tasks":[{"activity":"任务","hours":N,"assessment":"验收方式"}],"readings":["关联文献"]}],"totalWeeks":N,"adaptation":"如何根据进度动态调整","knowledgeGap":"该科目当前知识库覆盖情况"}`;
  return { ok: true, plan: await llmJson(prompt), subject: input.subject, goal: input.goal, linked: chunks.length > 0, memoryLinked: memory.length > 0 };
}

// ═══ 2. 专业课课程辅导（V383 深度联动：52步推理 + 引用溯源）═══
export async function courseTutoring(input: {
  subject: string;      // 专业
  topic: string;        // 问题/知识点
  difficulty?: string;  // 基础/进阶/挑战
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  // ① 深度推理：走 52 步链路检索三库 + 生成
  const reason = await deepReason(`请讲解「${input.topic}」(${input.subject} 专业课知识点，难度: ${input.difficulty || "基础"})，给出分步推导和关键概念`, input.sourceId);
  // ② 知识库补充（同主题文献）
  const chunks = await retrieveChunks(input.topic, input.sourceId || DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${input.topic} 相关）】\n${chunks.slice(0, 4).map(c => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是专业课辅导老师。学生问「${input.topic}」（${input.subject}，难度: ${input.difficulty || "基础"}）。
按"分步引导"方式辅导（不直接给完整答案）:
1. 先给出问题拆解（这个知识点分哪几部分）
2. 第一步提示 + 引导学生自己思考
3. 学生卡住时的提示线索
4. 完整的解题示范（放在最后，供核对）
5. 标注哪些内容来自系统知识库（引用来源）
输出 JSON: {"breakdown":["知识点拆解"],"stepHints":["分步提示"],"fallbackTips":["卡住时的线索"],"fullExplanation":"完整示范（含关键公式/概念）","commonMistakes":["常见错误"],"citations":[{"source":"引用来源","note":"依据"}]}
${ctx}
（参考推理结果: ${reason.content.substring(0, 800)}）`;
  return {
    ok: true, tutoring: await llmJson(prompt), topic: input.topic,
    deepReason: reason.content ? { content: reason.content.substring(0, 500), confidence: reason.confidence } : null,
    linked: chunks.length > 0,
  };
}

// ═══ 3. 学情诊断（V383 深度联动：记忆画像 + 知识库对照）═══
export async function learningDiagnosis(input: {
  subject: string;
  answers: string;          // 练习/测试作答记录
  knowledgePoints?: string; // 涉及知识点（可选）
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  // 防 undefined 崩溃：answers 为空时给默认提示
  const answers = (input.answers || "").trim();
  if (!answers) {
    return { ok: false, error: "请先填写学生的作答记录再运行诊断" };
  }
  // ① 记忆联动：召回该学生历史诊断记录（追踪进步/退步）
  const memory = await recallStudentMemory(`${input.subject} 学情 薄弱 ${input.knowledgePoints || ""}`);
  // ② 知识库对照：检索涉及知识点的标准表述
  const chunks = await retrieveChunks(input.knowledgePoints || input.subject, input.sourceId || DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库标准表述（对照用）】\n${chunks.slice(0, 4).map(c => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是学情诊断专家。根据学生的作答记录识别薄弱点并给出改进方案。
科目: ${input.subject || "未说明"}
作答记录: ${answers.substring(0, 2000)}
${input.knowledgePoints ? `涉及知识点: ${input.knowledgePoints}` : ""}
${memory}${ctx}

输出 JSON: {
  "mastered": ["已掌握的知识点"],
  "weak": [{"point":"薄弱知识点","evidence":"作答证据","severity":"高/中/低"}],
  "rootCauses": ["薄弱点根因分析（概念不清/方法不熟/粗心）"],
  "actionPlan": [{"recommendation":"针对性练习建议","resources":"推荐学习内容（优先系统知识库文献）"}],
  "summary": "总体学情一句话结论",
  "progress": "与历史记忆对比的进步/退步分析（如有历史记录）"
}`;
  return { ok: true, diagnosis: await llmJson(prompt), subject: input.subject, linked: chunks.length > 0, memoryLinked: memory.length > 0 };
}

// ═══ 4. 预习与复习（V383 深度联动：知识库文献驱动）═══
export async function previewReview(input: {
  subject: string;
  topic: string;
  mode: "preview" | "review";   // 预习 / 复习
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.topic, input.sourceId || DEFAULT_SOURCE, 10);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库资料（${input.topic} 相关文献）】\n${chunks.slice(0, 5).map(c => `[${c.title}] ${c.content.substring(0, 250)}`).join("\n")}`
    : "";

  const prompt = input.mode === "preview"
    ? `你是预习指导老师。学生即将学习「${input.topic}」（${input.subject}），请生成预习材料（优先基于系统知识库文献）:
1. 预习目标（3-5 个，明确"学完后能做什么"）
2. 重点概念预习清单（每个概念给一句话通俗解释 + 课前思考问题）
3. 关联旧知识（哪些已学内容与新知识相关）
4. 系统知识库推荐阅读（列出相关文献标题）
5. 预习自测（3-5 道快速自测题，附答案在最后）
输出 JSON: {"objectives":["预习目标"],"concepts":[{"name":"概念","plainExplanation":"通俗解释","thinkAbout":"课前思考"}],"prerequisites":["关联旧知识"],"recommendedReadings":["知识库文献"],"selfCheck":[{"question":"自测题","answer":"答案"}]}`
    : `你是复习指导老师。学生已学完「${input.topic}」（${input.subject}），请生成复习材料（优先基于系统知识库文献）:
1. 知识框架（用层级结构整理本课知识）
2. 核心要点速记（每个要点 1-2 句话）
3. 易错点提醒
4. 系统知识库重点回顾（列出相关文献关键结论）
5. 自测题（5-8 道，覆盖主要考点，附答案）
输出 JSON: {"framework":"知识框架(层级)","keyPoints":[{"point":"要点","note":"速记"}],"pitfalls":["易错点"],"literatureReview":["知识库重点"],"selfCheck":[{"question":"自测题","answer":"答案"}]}`;
  return { ok: true, material: await llmJson(prompt), topic: input.topic, mode: input.mode, linked: chunks.length > 0 };
}

// ═══ 5. 教师备课（V383 深度联动：知识库文献支撑教案）═══
export async function lessonPlanning(input: {
  subject: string;
  chapter: string;          // 章节/课题
  classMinutes?: number;    // 课时长
  studentLevel?: string;    // 学生水平
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.chapter, input.sourceId || DEFAULT_SOURCE, 10);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库资料（${input.chapter} 相关文献）】\n${chunks.slice(0, 5).map(c => `[${c.title}] ${c.content.substring(0, 250)}`).join("\n")}`
    : "";

  const prompt = `你是专业课程教学设计专家。请为以下课程生成完整备课方案（优先引用系统知识库文献作为教学素材）：
科目: ${input.subject}
章节: ${input.chapter}
课时: ${input.classMinutes || 90} 分钟
学生水平: ${input.studentLevel || "普通本科"}
${ctx}

输出 JSON: {
  "lessonTitle": "课题名称",
  "objectives": ["教学目标(知识/能力/素养)"],
  "classFlow": [{"segment":"教学环节","duration":N,"activity":"活动设计","teacherAction":"教师活动","studentAction":"学生活动"}],
  "keyPoints": ["本课重点难点"],
  "caseMaterials": ["案例/素材建议（优先系统知识库文献）"],
  "activities": ["课堂互动设计"],
  "assessment": {"formative":["过程性评价"],"summative":"终结性评价设计"},
  "homework": "课后作业设计",
  "literatureSupport": ["知识库支撑文献"]
}`;
  return { ok: true, plan: await llmJson(prompt), chapter: input.chapter, linked: chunks.length > 0 };
}

// ═══ 6. 学习陪伴（V383 深度联动：记忆画像 + 知识库支撑）═══
export async function studyCompanion(input: {
  subject: string;
  studentProfile?: string;   // 学生画像
  message: string;           // 学生的话
  history?: Array<{ role: string; content: string }>;  // 最近对话
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  // ① 记忆联动：召回学生历史（学习偏好/情绪记录）
  const memory = await recallStudentMemory(`${input.subject} 学习陪伴 ${input.studentProfile || ""}`);
  // ② 知识库支撑：给具体建议时关联文献
  const chunks = await retrieveChunks(input.subject, input.sourceId || DEFAULT_SOURCE, 5);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（可推荐的学习材料）】\n${chunks.slice(0, 3).map(c => `[${c.title}] ${c.content.substring(0, 150)}`).join("\n")}`
    : "";

  const prompt = `你是${input.subject}学习陪伴助手，像一位耐心、鼓励性的学长/学姐。
学生画像: ${input.studentProfile || "普通学习者"}
学生说: "${input.message}"
${memory}${ctx}

陪伴原则:
1. 先共情回应（认可学生的努力/情绪）
2. 再给具体学习建议（不是泛泛而谈，可推荐系统知识库中的学习材料）
3. 适当提问引导学生思考
4. 学生表现出放弃/焦虑情绪时给予鼓励和具体行动建议
5. 不替代教师评判，但给予学习信心

输出 JSON: {"empathy":"共情回应(1-2句)","advice":"具体学习建议","followUp":"引导学生思考的追问","encouragement":"鼓励语(可选)","resources":["可推荐的学习材料"]}`;
  return { ok: true, companion: await llmJson(prompt), subject: input.subject, linked: chunks.length > 0 };
}

export const educationService = {
  learningPlan, courseTutoring, learningDiagnosis, previewReview, lessonPlanning, studyCompanion,
};
