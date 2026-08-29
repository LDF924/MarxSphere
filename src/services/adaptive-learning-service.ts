// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// adaptive-learning-service.ts — 自适应学习系统（V384）
// 四层能力：
//   ① 学情建模：答题历史→知识点掌握度（已掌握/模糊/未掌握），平滑更新
//   ② 自适应内容推送：薄弱点→微课/例题/拓展；学有余力→拔高
//   ③ 节奏适配：按掌握度调整习题难度/时长（避免简单重复/难度过载）
//   ④ 分层教学：同一知识点按水平输出不同版本讲解（基础/进阶/挑战）
// 复用: 教育服务 + 知识库(source_chunks) + OpenViking 记忆
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks, recallStudentMemory, DEFAULT_SOURCE } from "./education-service.js";
import { recordLearnerEvent, rebuildMastery, getActiveBktParams, MIN_OBSERVATIONS_FOR_PROBABILITY, SUPPORTED_THRESHOLD } from "./learning-evidence-service.js";

// ═══ 兼容投影: BKT 重建结果写回 legacy knowledge_mastery 表(旧服务继续可读) ═══
// 说明: 事实源是 learner_event_ledger 账本; knowledge_mastery 只是兼容投影,
//       由写路径维护(ADR-0002 精神: 读视图/投影不回写事实源, 反之亦然)
async function syncKnowledgeMasteryLegacy(studentId: string): Promise<void> {
  const cells = await rebuildMastery(studentId);
  for (const cell of cells) {
    const level = cell.evidence_state === "supported" ? "mastered"
      : cell.evidence_state === "insufficient_evidence" ? "unlearned" : "fuzzy";
    await pool.query(
      `insert into knowledge_mastery (student_id, subject, knowledge_point, mastery_level, score, attempts, correct_count, last_answer_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (student_id, subject, knowledge_point) do update
         set mastery_level = $4, score = $5, attempts = $6, correct_count = $7, last_answer_at = $8, updated_at = now()`,
      [cell.student_id, cell.subject, cell.knowledge_point, level,
       cell.mastery_probability ?? 0, cell.attempts, cell.correct_count, cell.last_answer_at ?? new Date()]
    ).catch(() => {});
  }
}

// ═══ ① 学情建模：记录答题 → BKT 概念掌握(V386, 借鉴 TraitTutor) ═══
// 走事件账本: 提供 expectedAnswer 则服务端判分(强证据, 进 BKT); 否则仅记录参与(永不进 BKT)
export async function recordAnswer(input: {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  expectedAnswer?: string;
  isCorrect?: boolean | null;
  questionType?: "choice" | "tf" | "short" | "open";
  difficulty?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const ev = await recordLearnerEvent({
    studentId,
    subject: input.subject,
    knowledgePoint: input.knowledgePoint,
    question: input.question,
    userAnswer: input.userAnswer,
    expectedAnswer: input.expectedAnswer,
    isCorrect: input.isCorrect,
    questionType: input.questionType,
    difficulty: input.difficulty,
    surfaceType: "practice",
  });
  // 写回兼容视图(掌握度以账本重放为准)
  await pool.query(
    `insert into answer_history (student_id, subject, knowledge_point, question, user_answer, is_correct, difficulty)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [studentId, input.subject, input.knowledgePoint, input.question, input.userAnswer ?? null, ev.isCorrect ?? null, input.difficulty || "medium"]
  ).catch(() => {});
  await syncKnowledgeMasteryLegacy(studentId);
  const cell = (await rebuildMastery(studentId)).find((m) => m.subject === input.subject && m.knowledge_point === input.knowledgePoint) ?? null;
  return { ok: true, ...ev, mastery: cell };
}

// ═══ 学情画像：BKT 定性状态 + 诚实读(未校准/观察不足不显示数字) ═══
export async function getStudentProfile(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const cells = await rebuildMastery(studentId);
  const points = input.subject ? cells.filter((c) => c.subject === input.subject) : cells;
  const mastered = points.filter((p) => p.evidence_state === "supported").length;
  const fuzzy = points.filter((p) => p.evidence_state === "developing" || p.evidence_state === "needs_support").length;
  const unlearned = points.filter((p) => p.evidence_state === "insufficient_evidence").length;

  const hist = await pool.query(
    `select knowledge_point, is_correct, difficulty, answered_at from answer_history
     where student_id = $1 order by answered_at desc limit 20`,
    [studentId]
  );

  return {
    ok: true,
    studentId,
    summary: { total: points.length, mastered, fuzzy, unlearned },
    weakPoints: points.filter((p) => p.evidence_state !== "supported").slice(0, 8),
    masteredPoints: points.filter((p) => p.evidence_state === "supported").slice(0, 8),
    recentAnswers: hist.rows,
    params: await getActiveBktParams(),
    // 诚实读: 未达到观察门槛的知识点不暴露数字, 只给定性状态
    note: "掌握度为 BKT 定性状态: 未校准参数或观察不足(少于 3 次服务端判分)时不显示概率, 只给定性状态",
  };
}

// ═══ ② 自适应内容推送：按画像推学习内容 ═══
export async function adaptivePush(input: {
  studentId?: string;
  subject: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const limit = input.limit || 5;

  // 薄弱点（BKT 定性: needs_support/developing/insufficient_evidence）
  const cells = (await rebuildMastery(studentId)).filter((c) => c.subject === input.subject);
  const weak = cells.filter((c) => c.evidence_state !== "supported").sort((a, b) => (a.mastery_probability ?? 0) - (b.mastery_probability ?? 0)).slice(0, limit);
  const strong = cells.filter((c) => c.evidence_state === "supported").slice(0, 3);

  const weakPoints = weak.map((c) => ({ knowledge_point: c.knowledge_point, evidence_state: c.evidence_state, score: c.mastery_probability }));
  const strongPoints = strong.map((c) => ({ knowledge_point: c.knowledge_point, score: c.mastery_probability }));

  // 记忆联动：学生历史画像
  const memory = await recallStudentMemory(`${input.subject} 学习 ${weakPoints.map((w) => w.knowledge_point).join("、") || ""}`);

  const prompt = `你是自适应学习推导师。学生画像：${input.subject}，薄弱点：${weakPoints.map((w) => `${w.knowledge_point}(${w.evidence_state})`).join("、") || "暂无"}，已掌握：${strongPoints.map((s) => s.knowledge_point).join("、") || "暂无"}。${memory}

请为每个薄弱点推荐针对性学习内容（微课/例题/拓展材料），为已掌握点推荐拔高内容：
输出 JSON: {
  "weakContent": [{"point":"薄弱知识点","materialType":"微课|例题|拓展","material":"具体学习内容建议","practiceQuestion":"配套练习题","estimatedMinutes":N}],
  "advancedContent": [{"point":"已掌握知识点","advancedTopic":"拔高方向","material":"拓展材料建议"}],
  "strategy": "整体学习策略（先攻哪个点、为什么）"
}`;

  return { ok: true, weakContent: (await llmJson(prompt))?.weakContent ?? [], advancedContent: (await llmJson(prompt))?.advancedContent ?? [], strategy: (await llmJson(prompt))?.strategy ?? "", points: { weak: weakPoints, strong: strongPoints } };
}

// ═══ ③ 节奏适配：按掌握度调整难度/时长 ═══
export async function paceAdapt(input: {
  studentId?: string;
  subject: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  const cells = (await rebuildMastery(studentId)).filter((c) => c.subject === input.subject);
  const counts: Record<string, number> = {};
  for (const cell of cells) counts[cell.evidence_state] = (counts[cell.evidence_state] || 0) + 1;

  const mastered = counts.supported || 0;
  const fuzzy = (counts.developing || 0) + (counts.needs_support || 0);
  const unlearned = counts.insufficient_evidence || 0;
  const total = mastered + fuzzy + unlearned;

  // 节奏规则（基于掌握度分布）
  let recommendedDifficulty = "medium";
  let sessionMinutes = 45;
  let note = "";
  if (total === 0) {
    recommendedDifficulty = "easy";
    sessionMinutes = 30;
    note = "新学生：从基础开始，短时高频";
  } else {
    const masteryRatio = mastered / total;
    if (masteryRatio >= 0.6) { recommendedDifficulty = "hard"; sessionMinutes = 60; note = "掌握度好：加大难度、延长深度练习"; }
    else if (masteryRatio >= 0.3) { recommendedDifficulty = "medium"; sessionMinutes = 45; note = "中等进度：均衡推进，重点巩固模糊点"; }
    else { recommendedDifficulty = "easy"; sessionMinutes = 30; note = "基础薄弱：降低难度，先补未掌握点"; }
  }

  return { ok: true, profile: { mastered, fuzzy, unlearned, total }, recommendation: { difficulty: recommendedDifficulty, sessionMinutes, note } };
}

// ═══ ④ 分层教学：同一知识点多版本讲解 ═══
export async function layeredTeaching(input: {
  subject: string;
  knowledgePoint: string;
  levels?: Array<"basic" | "advanced" | "challenge">;
}): Promise<Record<string, unknown>> {
  const levels = input.levels || ["basic", "advanced", "challenge"];

  // 知识库检索（真实文献支撑）
  const chunks = await retrieveChunks(input.knowledgePoint, DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${input.knowledgePoint} 相关）】\n${chunks.slice(0, 4).map((c) => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";

  const prompt = `你是分层教学专家。为「${input.knowledgePoint}」（${input.subject}）输出 ${levels.length} 个版本的讲解（${levels.join("/")}）：
- basic（基础版）：零基础能懂，比喻+生活例子，5 分钟讲清
- advanced（进阶版）：有基础者，公式+推理+应用，10 分钟
- challenge（挑战版）：学有余力者，深度拓展+批判思考+前沿关联
输出 JSON: {"versions":[{"level":"basic|advanced|challenge","title":"版本标题","explanation":"讲解内容(按level深度)","example":"示例/类比","checkQuestion":"检验题","suitableFor":"适合谁"}],"recommendation":"建议先学哪个版本及原因"}${ctx}`;

  return { ok: true, versions: (await llmJson(prompt))?.versions ?? [], recommendation: (await llmJson(prompt))?.recommendation ?? "", linked: chunks.length > 0 };
}

export const adaptiveLearningService = { recordAnswer, getStudentProfile, adaptivePush, paceAdapt, layeredTeaching };
