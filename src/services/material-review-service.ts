// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// material-review-service.ts — 产物审查三态机 + 材料分析快照(V387, 2026-08-30, 借鉴 TraitTutor needs_review)
// 对照 TraitTutor:
//   1. needs_review 三态机: 质量未过关的生成物可预览/丢弃/确认/重试, 但未确认前不可附加到学习计划
//   2. 材料分析快照: 学科/难度/概念候选/页级证据/模态适配, LLM 失败降级确定性启发式
// 迁移: 098_generation_reviews.sql
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks } from "./education-service.js";
import { getActivePlan } from "./learning-plan-service.js";

// ═══ 确定性材料分析启发式(LLM 失败降级, 参考 TraitTutor infer_material_affordances) ═══
export function heuristicMaterialAnalysis(text: string, title: string): {
  subject: string; difficulty: string; language: string; conceptCandidates: string[]; affordances: Record<string, { suitable: boolean; reason: string }>;
} {
  const lower = (title + " " + text.slice(0, 3000)).toLowerCase();
  const isCjk = /[一-鿿]/.test(text.slice(0, 500));
  const language = isCjk ? "zh" : "en";

  // 学科关键词
  const subjectMap: Array<[string, RegExp]> = [
    ["马克思主义理论", /(马克思|资本论|剩余价值|唯物|辩证法|社会主义)/],
    ["政治经济学", /(政治经济学|价值规律|商品|货币|资本|市场)/],
    ["历史", /(历史|朝代|革命|战争|王朝)/],
    ["哲学", /(哲学|本体论|认识论|存在|伦理)/],
    ["计算机科学", /(algorithm|neural|python|程序|算法|compute)/],
    ["经济学", /(economics|gdp|supply|demand|市场|经济)/],
  ];
  let subject = "综合";
  for (const [name, re] of subjectMap) { if (re.test(lower)) { subject = name; break; } }

  // 难度: 关键词密度/术语密度
  const terms = lower.match(/(定理|原理|模型|推导|证明|公式|paradox|theorem|corollary)/g)?.length ?? 0;
  const difficulty = terms >= 3 ? "advanced" : terms >= 1 ? "intermediate" : "basic";

  // 概念候选: 中文 bigram 词频(2-gram 更稳健, 避免贪婪匹配把短词吞进长组合)
  const chars = text.slice(0, 3000).match(/[一-鿿]/g) ?? [];
  const freq = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const bg = chars[i] + chars[i + 1];
    freq.set(bg, (freq.get(bg) || 0) + 1);
  }
  const conceptCandidates = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

  // 模态适配(参考 TraitTutor: 图表词→visual, 音频词→audio...)
  const hasDiagram = /(图|图表|diagram|figure|示意)/.test(lower);
  const hasAudio = /(听|音频|朗读|发音|audio|listen)/.test(lower);
  const hasExample = /(例|示例|example|案例)/.test(lower);
  const hasExercise = /(练习|习题|测验|exercise|quiz|题目)/.test(lower);
  const affordances = {
    visual: { suitable: hasDiagram, reason: hasDiagram ? "材料含图表元素, 适合可视化讲解" : "材料以文本为主" },
    audio: { suitable: hasAudio, reason: hasAudio ? "材料含听说元素, 适合音频辅助" : "无音频需求信号" },
    worked_example: { suitable: hasExample, reason: hasExample ? "材料含示例, 适合例题示范" : "无示例信号" },
    practice: { suitable: hasExercise, reason: hasExercise ? "材料含练习信号, 适合配套练习" : "无练习信号" },
  };
  return { subject, difficulty, language, conceptCandidates, affordances };
}

// ═══ 材料分析(LLM 优先, 失败确定性降级) ═══
export async function analyzeMaterial(input: { studentId?: string; title: string; content: string; sourceId?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const contentHash = sha256(input.content.slice(0, 200_000));

  // 查重: 同内容不重复分析
  const dup = await pool.query("select id from material_analyses where student_id = $1 and content_hash = $2", [studentId, contentHash]).catch(() => ({ rows: [] }));
  if (dup.rows.length > 0) return { ok: true, duplicate: true, analysisId: dup.rows[0].id };

  // LLM 分析(带页级证据与概念候选)
  const chunks = await retrieveChunks(input.title, input.sourceId || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a", 6).catch(() => []);
  const ctx = chunks.length > 0
    ? `\n\n【知识库相关切片(可作为页级证据)】\n${chunks.slice(0, 4).map((c: any, i: number) => `[${i + 1}] ${String(c.title || "").slice(0, 60)}: ${String(c.content || "").slice(0, 150)}`).join("\n")}`
    : "";
  const llm = await llmJson(`你是教育材料分析专家。分析以下学习材料，输出:
1. 学科(subject)、难度(difficulty: basic|intermediate|advanced)、语言(language: zh|en)、置信度(confidence 0-1)
2. concept_candidates: 最多8个核心概念候选
3. page_evidence: 从材料中提取的关键知识点及所在片段(evidence: 片段文本)
4. component_affordances: 适合哪些学习组件(visual/audio/worked_example/practice, 各含 suitable 布尔与 reason)

材料标题: ${input.title}
材料内容(前6000字):
${input.content.slice(0, 6000)}${ctx}

输出 JSON: {"subject":"","difficulty":"basic|intermediate|advanced","language":"zh|en","confidence":0.8,"concept_candidates":[""],"page_evidence":[{"concept":"","evidence":""}],"component_affordances":{"visual":{"suitable":true,"reason":""},"audio":{"suitable":false,"reason":""},"worked_example":{"suitable":true,"reason":""},"practice":{"suitable":true,"reason":""}}}`).catch(() => null);

  let row: any;
  if (llm?.subject) {
    row = {
      subject: String(llm.subject).slice(0, 60),
      difficulty: ["basic", "intermediate", "advanced"].includes(llm.difficulty) ? llm.difficulty : "intermediate",
      language: ["zh", "en"].includes(llm.language) ? llm.language : "zh",
      confidence: Number(llm.confidence ?? 0.8),
      conceptCandidates: Array.isArray(llm.concept_candidates) ? llm.concept_candidates.slice(0, 8) : [],
      pageEvidence: Array.isArray(llm.page_evidence) ? llm.page_evidence.slice(0, 12) : [],
      affordances: llm.component_affordances || {},
      source: "llm",
    };
  } else {
    // 降级: 确定性启发式
    const h = heuristicMaterialAnalysis(input.content, input.title);
    row = {
      subject: h.subject, difficulty: h.difficulty, language: h.language, confidence: 0.4,
      conceptCandidates: h.conceptCandidates, pageEvidence: [], affordances: h.affordances, source: "heuristic",
    };
  }

  const r = await pool.query(
    `insert into material_analyses (student_id, title, content_hash, subject, difficulty, language, confidence, concept_candidates, page_evidence, component_affordances, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11) returning *`,
    [studentId, input.title.slice(0, 200), contentHash, row.subject, row.difficulty, row.language, row.confidence,
     JSON.stringify(row.conceptCandidates), JSON.stringify(row.pageEvidence), JSON.stringify(row.affordances), row.source]
  );
  return { ok: true, analysis: r.rows[0], source: row.source, degraded: row.source === "heuristic" };
}

// ═══ 产物审查三态机(TraitTutor needs_review) ═══
export interface ReviewIssue { dimension: string; score: number; note: string }

/**
 * 登记生成产物 → needs_review(可预览, 不可附加/评分)
 * 传入 issues 时: 任一维度低于下限(fail)才进 needs_review; 否则直接 confirmed
 */
export async function createGeneration(input: {
  studentId?: string; subject: string; goal: string; kind: string;
  content: unknown; issues?: ReviewIssue[]; planId?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const issues = (input.issues || []).slice(0, 10);
  const hardFail = issues.some((i) => i.score < 0.6); // TraitTutor: 硬性 fail 才需人工
  const status = hardFail ? "needs_review" : "confirmed";
  const r = await pool.query(
    `insert into generation_reviews (student_id, subject, goal, kind, status, content, issues, plan_id, review_history, confirmed_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb, $10)
     returning *`,
    [studentId, input.subject, input.goal, input.kind, status, JSON.stringify(input.content ?? {}),
     JSON.stringify(issues), input.planId ?? null,
     JSON.stringify([{ action: "created", at: new Date().toISOString(), note: hardFail ? "自动进入审查(存在低分维度)" : "无低分维度, 直接确认" }]),
     hardFail ? null : new Date()]
  );
  const row = r.rows[0];
  return { ok: true, generationId: row.id, status: row.status, issues, needsReview: hardFail };
}

/** 人工确认(仅 needs_review 可确认) */
export async function confirmGeneration(input: { id: string }): Promise<Record<string, unknown>> {
  const r = await pool.query("select * from generation_reviews where id = $1", [input.id]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { ok: false, error: "产物不存在" };
  if (r.rows[0].status !== "needs_review") return { ok: false, error: `当前状态 ${r.rows[0].status}, 不可确认` };
  await pool.query(
    `update generation_reviews set status = 'confirmed', confirmed_at = now(),
       review_history = review_history || $2::jsonb where id = $1`,
    [input.id, JSON.stringify([{ action: "confirmed", at: new Date().toISOString(), note: "人工确认" }])]
  );
  return { ok: true, status: "confirmed" };
}

/** 丢弃 */
export async function discardGeneration(input: { id: string; note?: string }): Promise<Record<string, unknown>> {
  const r = await pool.query("select * from generation_reviews where id = $1", [input.id]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { ok: false, error: "产物不存在" };
  if (r.rows[0].status === "discarded") return { ok: false, error: "已丢弃" };
  await pool.query(
    `update generation_reviews set status = 'discarded',
       review_history = review_history || $2::jsonb where id = $1`,
    [input.id, JSON.stringify([{ action: "discarded", at: new Date().toISOString(), note: input.note ?? "人工丢弃" }])]
  );
  return { ok: true, status: "discarded" };
}

/**
 * 附加到学习计划(仅 confirmed 可附加 — TraitTutor: 未确认产物不可进入学习包)
 */
export async function attachToPlan(input: { id: string; planId: string }): Promise<Record<string, unknown>> {
  const r = await pool.query("select * from generation_reviews where id = $1", [input.id]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { ok: false, error: "产物不存在" };
  if (r.rows[0].status !== "confirmed") return { ok: false, error: `未确认产物不可附加(当前 ${r.rows[0].status})` };
  const plan = await getActivePlan({ studentId: r.rows[0].student_id, subject: r.rows[0].subject });
  // 附加目标: 传参优先, 否则当前 active 计划
  const targetPlanId = input.planId || plan?.id;
  if (!targetPlanId) return { ok: false, error: "无目标计划(先创建学习计划)" };
  await pool.query(
    `update generation_reviews set plan_id = $2,
       review_history = review_history || $3::jsonb where id = $1`,
    [input.id, targetPlanId, JSON.stringify([{ action: "attached", at: new Date().toISOString(), note: `附加到计划 ${targetPlanId.slice(0, 8)}` }])]
  );
  return { ok: true, attached: true, planId: targetPlanId };
}

/** 待审查列表 */
export async function listReviews(input: { studentId?: string; status?: string }): Promise<Record<string, unknown>> {
  const params: unknown[] = [input.studentId || "default"];
  let where = "student_id = $1";
  if (input.status) { params.push(input.status); where += " and status = $" + params.length; }
  const r = await pool.query(`select * from generation_reviews where ${where} order by created_at desc limit 20`, params).catch(() => ({ rows: [] }));
  return { ok: true, reviews: r.rows };
}

function sha256(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export const materialReviewService = { analyzeMaterial, createGeneration, confirmGeneration, discardGeneration, attachToPlan, listReviews, heuristicMaterialAnalysis };
