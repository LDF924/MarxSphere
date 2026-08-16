// adaptive-learning-service.ts — 自适应学习系统（V384）
// 四层能力：
//   ① 学情建模：答题历史→知识点掌握度（已掌握/模糊/未掌握），平滑更新
//   ② 自适应内容推送：薄弱点→微课/例题/拓展；学有余力→拔高
//   ③ 节奏适配：按掌握度调整习题难度/时长（避免简单重复/难度过载）
//   ④ 分层教学：同一知识点按水平输出不同版本讲解（基础/进阶/挑战）
// 复用: 教育服务 + 知识库(source_chunks) + OpenViking 记忆
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks, recallStudentMemory, DEFAULT_SOURCE } from "./education-service.js";

// ═══ ① 学情建模：记录答题 → 更新掌握度 ═══
export async function recordAnswer(input: {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  isCorrect: boolean;
  difficulty?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const difficulty = input.difficulty || "medium";

  // 写答题历史
  await pool.query(
    `insert into answer_history (student_id, subject, knowledge_point, question, user_answer, is_correct, difficulty)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [studentId, input.subject, input.knowledgePoint, input.question, input.userAnswer ?? null, input.isCorrect, difficulty]
  );

  // 更新掌握度（加权平滑：正确 +0.15，错误 -0.25；难度加成 hard 对正确 +0.05）
  const delta = input.isCorrect ? (difficulty === "hard" ? 0.2 : 0.15) : -0.25;
  const updated = await pool.query(
    `insert into knowledge_mastery (student_id, subject, knowledge_point, mastery_level, score, attempts, correct_count, last_answer_at)
     values ($1, $2, $3, 'unlearned', 0, 0, 0, now())
     on conflict (student_id, subject, knowledge_point) do update
       set score = least(1, greatest(0, knowledge_mastery.score + $4)),
           attempts = knowledge_mastery.attempts + 1,
           correct_count = knowledge_mastery.correct_count + $5,
           mastery_level = case
             when least(1, greatest(0, knowledge_mastery.score + $4)) >= 0.7 then 'mastered'
             when least(1, greatest(0, knowledge_mastery.score + $4)) >= 0.4 then 'fuzzy'
             else 'unlearned' end,
           last_answer_at = now(),
           updated_at = now()
     returning mastery_level, score, attempts, correct_count`,
    [studentId, input.subject, input.knowledgePoint, delta, input.isCorrect ? 1 : 0]
  );

  return { ok: true, mastery: updated.rows[0] };
}

// ═══ 学情画像：当前学生各知识点掌握度 ═══
export async function getStudentProfile(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }

  const r = await pool.query(
    `select knowledge_point, mastery_level, score, attempts, correct_count, last_answer_at
     from knowledge_mastery where ${where} order by score asc`,
    params
  );
  const points = r.rows;
  const mastered = points.filter((p) => p.mastery_level === "mastered").length;
  const fuzzy = points.filter((p) => p.mastery_level === "fuzzy").length;
  const unlearned = points.filter((p) => p.mastery_level === "unlearned").length;

  // 最近答题历史
  const hist = await pool.query(
    `select knowledge_point, is_correct, difficulty, answered_at from answer_history
     where student_id = $1 order by answered_at desc limit 20`,
    [studentId]
  );

  return {
    ok: true,
    studentId,
    summary: { total: points.length, mastered, fuzzy, unlearned },
    weakPoints: points.filter((p) => p.mastery_level !== "mastered").slice(0, 8),
    masteredPoints: points.filter((p) => p.mastery_level === "mastered").slice(0, 8),
    recentAnswers: hist.rows,
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

  // 薄弱点（模糊/未掌握）
  const weak = await pool.query(
    `select knowledge_point, mastery_level, score from knowledge_mastery
     where student_id = $1 and subject = $2 and mastery_level != 'mastered'
     order by score asc limit $3`,
    [studentId, input.subject, limit]
  );

  // 已掌握（学有余力 → 拔高）
  const strong = await pool.query(
    `select knowledge_point, score from knowledge_mastery
     where student_id = $1 and subject = $2 and mastery_level = 'mastered'
     order by score desc limit 3`,
    [studentId, input.subject]
  );

  const weakPoints = weak.rows;
  const strongPoints = strong.rows;

  // 记忆联动：学生历史画像
  const memory = await recallStudentMemory(`${input.subject} 学习 ${weakPoints.map((w) => w.knowledge_point).join("、") || ""}`);

  const prompt = `你是自适应学习推导师。学生画像：${input.subject}，薄弱点：${weakPoints.map((w) => `${w.knowledge_point}(${w.mastery_level})`).join("、") || "暂无"}，已掌握：${strongPoints.map((s) => s.knowledge_point).join("、") || "暂无"}。${memory}

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

  const r = await pool.query(
    `select mastery_level, count(*)::int as n from knowledge_mastery
     where student_id = $1 and subject = $2 group by mastery_level`,
    [studentId, input.subject]
  );
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[row.mastery_level] = row.n;

  const mastered = counts.mastered || 0;
  const fuzzy = counts.fuzzy || 0;
  const unlearned = counts.unlearned || 0;
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
