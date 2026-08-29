// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-plan-service.ts — 版本化学习计划链(V386, 2026-08-29, 借鉴 TraitTutor LearningComponentPlan)
// 对照 TraitTutor 的设计:
//   1. 计划版本化 + supersede 链: 重规划不覆盖旧计划, 旧计划置 superseded 保留审计
//   2. 只重规划未开始的尾部: 已开始组件前缀不可变(历史证据), 新计划只重建 pending 尾部
//   3. 证据引用: 每步计划携带 evidence_refs, 可溯源回知识点/事件
// 迁移: 097_learning_plans.sql
import { pool } from "../db/pool.js";
import { llmJson, retrieveChunks, recallStudentMemory, DEFAULT_SOURCE } from "./education-service.js";
import { rebuildMastery } from "./learning-evidence-service.js";
import { selectComponents, determineStage } from "./learning-selector-service.js";

export interface PlanComponent {
  id: string;
  title: string;
  /** V392: 扩展为 14 种 TraitTutor 组件类型(兼容旧 6 类型) */
  type: "concept" | "practice" | "assessment" | "review" | "material" | "transfer"
    | "goal_map" | "concept_explanation" | "worked_example" | "visual_map" | "video_explanation"
    | "audio_explanation" | "diagnostic_check" | "guided_practice" | "calibration_checkpoint"
    | "retrieval_card" | "progress_checkpoint" | "reflection_prompt" | "transfer_challenge" | "review_queue";
  concept_refs: string[];
  evidence_refs: string[];
  status: "pending" | "started" | "completed" | "skipped";
  reason: string;
  /** V392: 模态(画布渲染用) */
  modality?: "text" | "interactive" | "visual" | "video" | "audio";
  required?: boolean;
  dependencies?: string[];
}

/**
 * 计算保留前缀(纯函数, TraitTutor build_learning_component_plan 语义):
 * 已开始(非 pending)组件前缀不可变(历史证据), 重规划只重建 pending 尾部
 */
export function computePreservedPrefix(components: PlanComponent[]): PlanComponent[] {
  const lastStarted = Math.max(-1, ...components.map((c, i) => (c.status !== "pending" ? i : -1)));
  return components.slice(0, lastStarted + 1);
}

export interface LearningPlan {
  id: string;
  studentId: string;
  subject: string;
  goal: string;
  version: number;
  status: "active" | "completed" | "superseded";
  supersedesPlanId: string | null;
  components: PlanComponent[];
  rationale: Record<string, unknown> | null;
  createdAt: string;
}

/** 从 BKT 画像生成概念参考与证据引用 */
async function conceptEvidence(studentId: string, subject: string, goal: string): Promise<{ conceptRefs: string[]; evidenceRefs: string[]; weakness: string }> {
  const cells = (await rebuildMastery(studentId)).filter((c) => c.subject === subject);
  const weak = cells.filter((c) => c.evidence_state !== "supported").sort((a, b) => (a.mastery_probability ?? 0) - (b.mastery_probability ?? 0)).slice(0, 5);
  return {
    conceptRefs: weak.map((c) => c.knowledge_point),
    evidenceRefs: cells.map((c) => `${c.knowledge_point}(${c.evidence_state}:${c.verified_observation_count}次)`),
    weakness: weak.length > 0 ? `薄弱点: ${weak.map((w) => `${w.knowledge_point}(${w.evidence_state})`).join("、")}` : "暂无薄弱点(新学习者)",
  };
}

/** 获取当前 active 计划 */
export async function getActivePlan(input: { studentId?: string; subject: string }): Promise<LearningPlan | null> {
  const r = await pool.query(
    `select * from learning_plans where student_id = $1 and subject = $2 and status = 'active'
     order by version desc limit 1`,
    [input.studentId || "default", input.subject]
  ).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id, studentId: row.student_id, subject: row.subject, goal: row.goal, version: row.version,
    status: row.status, supersedesPlanId: row.supersedes_plan_id, components: row.components,
    rationale: row.rationale, createdAt: row.created_at,
  };
}

/** 组件状态推进(校验合法迁移: 依赖前置必须 completed) */
export async function updateComponentStatus(input: { planId: string; componentId: string; status: "started" | "completed" | "skipped" }): Promise<Record<string, unknown>> {
  const planR = await pool.query("select * from learning_plans where id = $1", [input.planId]).catch(() => ({ rows: [] }));
  if (planR.rows.length === 0) return { ok: false, error: "计划不存在" };
  const plan = planR.rows[0];
  const comps = plan.components as PlanComponent[];
  const idx = comps.findIndex((c) => c.id === input.componentId);
  if (idx === -1) return { ok: false, error: "组件不存在" };
  const comp = comps[idx];

  // 依赖: 前面的组件(同计划内)必须全部 completed 才能 completed/skipped
  if (input.status === "completed" || input.status === "skipped") {
    const prevIncomplete = comps.slice(0, idx).find((c) => c.status !== "completed");
    if (prevIncomplete) return { ok: false, error: `前置组件「${prevIncomplete.title}」未完成` };
  }
  if (comp.status === "completed" && input.status !== "completed") return { ok: false, error: "已完成的组件不能回退" };

  comps[idx] = { ...comp, status: input.status };
  const allDone = comps.every((c) => c.status === "completed");
  await pool.query(
    `update learning_plans set components = $1::jsonb, status = $2, updated_at = now() where id = $3`,
    [JSON.stringify(comps), allDone ? "completed" : plan.status, input.planId]
  );
  return { ok: true, component: comps[idx], planCompleted: allDone };
}

/**
 * 创建/重建计划 — 只重规划未开始的尾部(TraitTutor build_learning_component_plan)
 * - 首次: 全量生成计划
 * - 重建: 已开始(非 pending)组件前缀不可变, 新计划 = 前缀 + LLM 重建的尾部; 旧计划 superseded
 */
export async function createOrRebuildPlan(input: {
  studentId?: string;
  subject: string;
  goal: string;
  hoursPerWeek?: number;
  deadline?: string;
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const existing = await getActivePlan({ studentId, subject: input.subject });
  const { conceptRefs, evidenceRefs, weakness } = await conceptEvidence(studentId, input.subject, input.goal);

  // 知识库支撑
  const chunks = await retrieveChunks(input.goal || input.subject, input.sourceId || DEFAULT_SOURCE, 8);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库（${input.subject} 相关文献）】\n${chunks.slice(0, 5).map((c) => `[${c.title}] ${c.content.substring(0, 200)}`).join("\n")}`
    : "";
  const memory = await recallStudentMemory(`${input.subject} 学习 ${weakness}`);

  // ── 保留前缀(已开始的历史证据, 不可变) ──
  let preservedPrefix: PlanComponent[] = [];
  let previousId: string | null = null;
  let version = 1;
  if (existing) {
    previousId = existing.id;
    version = existing.version + 1;
    preservedPrefix = computePreservedPrefix(existing.components);
  }

  const prompt = `你是个性化学习规划专家。为学习者制定分阶段学习计划:
科目: ${input.subject}
目标: ${input.goal}
每周可投入: ${input.hoursPerWeek || 4} 小时
目标期限: ${input.deadline || "灵活"}
${weakness ? "已知" + weakness : ""}
${memory}${ctx}

要求:
1. 输出 4-8 个学习步骤(组件), 每步含: title / type(concept|practice|assessment|review|material|transfer) / reason(为什么这步) / concept_refs(关联知识点, 从上面薄弱点中选)
2. 覆盖: 概念讲解→练习→评估→复习→迁移应用 的完整闭环
3. 输出 JSON: {"components":[{"title":"步骤标题","type":"concept|practice|assessment|review|material|transfer","reason":"为什么这步","concept_refs":["知识点"]}],"adaptation":"如何根据进度动态调整","knowledgeGap":"该科目当前知识库覆盖情况"}`;

  // ── V392: 确定性组件选择器(源码移植 TraitTutor select)──
  // 核心: 不强迫生成器自由发挥 — 由 BKT 阶段分支决定组件序列(确定性), LLM 仅补整体策略
  const cells = (await rebuildMastery(studentId)).filter((c) => c.subject === input.subject);
  const conceptSignals = cells.map((c) => ({
    knowledge_point: c.knowledge_point,
    support_level: c.evidence_state === "needs_support" ? "needs_support" as const
      : c.evidence_state === "supported" ? "supported" as const : undefined,
    bkt_calibrated: c.calibrated,
    verified_observation_count: c.verified_observation_count,
    mastery_probability: c.mastery_probability,
  }));
  const stage = determineStage(conceptSignals);
  const selected = selectComponents({
    conceptSignals,
    affordances: {
      visual: /(图|图表|diagram|figure)/.test(`${input.goal} ${input.subject}`),
      audio: /(听|朗读|英语|语言)/.test(`${input.goal} ${input.subject}`),
      worked_example: /(计算|公式|步骤|案例|例)/.test(`${input.goal} ${input.subject}`),
      practice: true,
    },
    preserved: preservedPrefix.map((c) => ({ component_type: c.type, status: c.status, component_id: c.id })),
    goalOnly: false,
  });

  // LLM 仅补组件标题的具体化 + 整体策略(确定性序列不被 LLM 改变)
  const llmOut = await llmJson(prompt);
  const llmTitles = new Map<string, string>();
  for (const c of (llmOut?.components ?? [])) {
    if (c.title && llmTitles.size < 10) llmTitles.set(String(c.title).slice(0, 60), c.title);
  }
  const typeToTitleHint: Record<string, string> = {
    concept_explanation: "概念讲解", worked_example: "分步例题", guided_practice: "引导练习",
    transfer_challenge: "迁移挑战", retrieval_card: "主动回忆", review_queue: "今日复习",
  };
  const titleForKey = (key: string): string => llmTitles.get(key) || "";
  const tail: PlanComponent[] = selected.map((c, i) => {
    const hint = typeToTitleHint[c.component_type] || c.label_zh;
    const kp = c.concept_refs[0] ? ` · ${c.concept_refs[0].slice(0, 20)}` : "";
    // LLM 标题仅作补充(若有匹配); 确定性序列结构不变
    const llmTitle = titleForKey(hint) || titleForKey(c.label_zh) || titleForKey(c.label_en);
    return {
      id: c.id,
      title: (llmTitle || `${hint}${kp}`).slice(0, 120),
      type: c.component_type as PlanComponent["type"],
      concept_refs: c.concept_refs.slice(0, 4),
      evidence_refs: evidenceRefs.slice(0, 6),
      status: "pending",
      reason: c.reason,
      modality: c.modality,
      required: c.required,
      dependencies: c.dependencies,
    };
  });

  const components = [...preservedPrefix, ...tail];
  if (components.length === 0) return { ok: false, error: "计划生成失败(选择器未返回组件)" };

  // 旧计划 supersede(保留审计)
  if (previousId) {
    await pool.query("update learning_plans set status = 'superseded', updated_at = now() where id = $1", [previousId]);
  }

  const r = await pool.query(
    `insert into learning_plans (student_id, subject, goal, version, status, supersedes_plan_id, components, rationale)
     values ($1, $2, $3, $4, 'active', $5, $6::jsonb, $7::jsonb) returning *`,
    [studentId, input.subject, input.goal, version, previousId,
     JSON.stringify(components),
     JSON.stringify({ adaptation: llmOut?.adaptation ?? null, knowledgeGap: llmOut?.knowledgeGap ?? null, preservedPrefixCount: preservedPrefix.length })]
  );

  return {
    ok: true,
    plan: {
      id: r.rows[0].id, studentId, subject: input.subject, goal: input.goal, version,
      status: "active", supersedesPlanId: previousId, components, rationale: r.rows[0].rationale, createdAt: r.rows[0].created_at,
    },
    rebuilt: !!previousId,
    preservedPrefixCount: preservedPrefix.length,
  };
}

/** 计划列表(含 superseded 审计链) */
export async function listPlans(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const params: unknown[] = [input.studentId || "default"];
  let where = "student_id = $1";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }
  const r = await pool.query(`select * from learning_plans where ${where} order by created_at desc limit 20`, params).catch(() => ({ rows: [] }));
  return { ok: true, plans: r.rows.map((row: any) => ({
    id: row.id, studentId: row.student_id, subject: row.subject, goal: row.goal, version: row.version,
    status: row.status, supersedesPlanId: row.supersedes_plan_id, componentCount: (row.components || []).length,
    completedCount: (row.components || []).filter((c: PlanComponent) => c.status === "completed").length,
    components: row.components || [],   // V392: 画布需要完整组件
    artifacts: row.artifacts || { courseware: [], flashcards: [], quiz: [] },
    rationale: row.rationale, createdAt: row.created_at,
  })) };
}

export const learningPlanService = { getActivePlan, createOrRebuildPlan, updateComponentStatus, listPlans };
