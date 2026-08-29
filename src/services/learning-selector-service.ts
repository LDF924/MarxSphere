// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-selector-service.ts — 确定性组件选择器(V392, 2026-08-30, 源码移植 TraitTutor LearningComponentSelector.select)
// 移植自 traittutor/learning_components.py L1073-1452(源码对照):
//   1. _stage 四步判定: 空→needs_support→(未校准/<3观测/后验缺失)→min(posteriors)>=0.75
//   2. 主干 4 分支: unobserved/needs_support/developing/supported
//   3. 结构不变量: 评估后必跟 calibration_checkpoint(成对追加); 两个评分评估永不相邻
//   4. 附加顺序固定: worked_example→visual_map→video→audio→guided_practice→retrieval_card→progress→reflection→review_queue
import { randomUUID } from "node:crypto";

// ═══ 常量(源码 L32-66 直接照抄) ═══
export type ComponentType =
  | "goal_map" | "concept_explanation" | "worked_example" | "visual_map" | "video_explanation"
  | "audio_explanation" | "diagnostic_check" | "guided_practice" | "calibration_checkpoint"
  | "retrieval_card" | "progress_checkpoint" | "reflection_prompt" | "transfer_challenge" | "review_queue";

export type BktStage = "unobserved" | "needs_support" | "developing" | "supported";

/** 评估组件(含 diagnostic); 证据评估(不含 diagnostic — 只有它们更新 BKT) */
const ASSESSMENT_TYPES = new Set<string>(["diagnostic_check", "guided_practice", "transfer_challenge"]);
const EVIDENCE_ASSESSMENT_TYPES = new Set<string>(["guided_practice", "transfer_challenge"]);
const SUPPORT_DIMENSIONS = new Set<string>(["goal_planning", "monitoring_regulation", "motivation_emotion", "reflection_transfer"]);

/** 组件目录(源码 learning_component_catalog.json 摘要: executor 决定模态) */
const CATALOG: Record<ComponentType, { label_zh: string; label_en: string; executor: string; completion_event: string }> = {
  goal_map: { label_zh: "目标地图", label_en: "Goal map", executor: "lesson", completion_event: "courseware_outcome" },
  concept_explanation: { label_zh: "概念讲解", label_en: "Concept explanation", executor: "lesson", completion_event: "courseware_outcome" },
  worked_example: { label_zh: "分步例题", label_en: "Worked example", executor: "lesson", completion_event: "courseware_outcome" },
  visual_map: { label_zh: "概念关系图", label_en: "Visual map", executor: "image", completion_event: "courseware_outcome" },
  video_explanation: { label_zh: "短视频讲解", label_en: "Video explanation", executor: "video", completion_event: "courseware_outcome" },
  audio_explanation: { label_zh: "语音讲解", label_en: "Audio explanation", executor: "audio", completion_event: "courseware_outcome" },
  diagnostic_check: { label_zh: "起点判断", label_en: "Diagnostic check", executor: "assessment", completion_event: "quiz_answer" },
  guided_practice: { label_zh: "引导练习", label_en: "Guided practice", executor: "assessment", completion_event: "quiz_answer" },
  calibration_checkpoint: { label_zh: "校准检查点", label_en: "Calibration checkpoint", executor: "deterministic", completion_event: "self_assessment" },
  retrieval_card: { label_zh: "主动回忆卡", label_en: "Retrieval card", executor: "retrieval", completion_event: "flashcard_review" },
  progress_checkpoint: { label_zh: "进度检查点", label_en: "Progress checkpoint", executor: "deterministic", completion_event: "self_assessment" },
  reflection_prompt: { label_zh: "反思提示", label_en: "Reflection prompt", executor: "deterministic", completion_event: "self_assessment" },
  transfer_challenge: { label_zh: "迁移挑战", label_en: "Transfer challenge", executor: "assessment", completion_event: "mastery_attempt" },
  review_queue: { label_zh: "今日复习", label_en: "Review queue", executor: "retrieval", completion_event: "flashcard_review" },
};

/** 中文固定解释(源码 canvas-labels.ts L182-204 直接照抄) */
export const COMPONENT_REASON_ZH: Record<string, string> = {
  goal_map: "先明确目标、阶段与完成标准，让后续学习有清晰方向。",
  diagnostic_check: "可选的一次性起点判断；结果不写入 BKT，也不会触发新计划。",
  concept_explanation: "结合当前知识状态补足核心概念，再进入练习。",
  worked_example: "通过分步例题把概念连接到可执行的方法。",
  visual_map: "用关系图呈现重点概念和它们之间的联系。",
  video_explanation: "用短视频动态呈现课件中的核心概念。",
  audio_explanation: "把当前课件转成来源受限的播客脚本，并由导师语音讲解。",
  guided_practice: "在提示和即时反馈下完成练习，形成可判分证据。",
  calibration_checkpoint: "将作答前的把握度与核验结果对照，选定下一次更有效的学习策略。",
  retrieval_card: "用主动回忆检验保持程度，并安排后续复习。",
  progress_checkpoint: "回看当前证据，确认下一阶段最值得投入的内容。",
  reflection_prompt: "用简短反思整理本轮学习策略，不把自评当作掌握证据。",
  transfer_challenge: "把已学知识迁移到新情境，检验能否灵活运用。",
  review_queue: "优先复习已到期或仍需支持的概念。",
};

// ═══ 概念信号(来自 BKT 画像) ═══
export interface ConceptSignal {
  knowledge_point: string;
  support_level?: "needs_support" | "developing" | "supported";
  bkt_calibrated?: boolean;
  verified_observation_count?: number;
  mastery_probability?: number | null;
}

export interface MaterialAffordances {
  visual: boolean; audio: boolean; worked_example: boolean; practice: boolean;
}

export interface SelectorInput {
  conceptSignals: ConceptSignal[];
  affordances: MaterialAffordances;
  /** 保留前缀(已开始组件, 不可变历史) */
  preserved: Array<{ component_type: string; status: string; component_id: string }>;
  goalOnly?: boolean;
}

export interface SelectedComponent {
  id: string;
  component_type: ComponentType;
  label_zh: string;
  label_en: string;
  bkt_stage: BktStage;
  modality: "text" | "interactive" | "visual" | "video" | "audio";
  dependencies: string[];
  required: boolean;
  reason: string;
  status: "pending";
  concept_refs: string[];
}

// ═══ _stage 判定(源码 L1073-1095, 顺序不可重排) ═══
export function determineStage(signals: ConceptSignal[]): BktStage {
  if (signals.length === 0) return "unobserved";
  if (signals.some((s) => s.support_level === "needs_support")) return "needs_support";
  // 未校准 / 观察<3 / 后验缺失 → unobserved
  if (signals.some((s) => !s.bkt_calibrated || (s.verified_observation_count ?? 0) < 3 || s.mastery_probability === null || s.mastery_probability === undefined)) {
    return "unobserved";
  }
  const posteriors = signals.map((s) => s.mastery_probability as number).filter((p) => Number.isFinite(p));
  if (posteriors.length === 0) return "unobserved";
  return Math.min(...posteriors) >= 0.75 ? "supported" : "developing";
}

/** 保留前缀里是否有"证据评估但紧跟的不是校准"(源码 L1141-1151) — 抑制追加新评估 */
function preservedAssessmentWithoutCalibration(preserved: SelectorInput["preserved"]): boolean {
  return preserved.some((item, index) => {
    if (!EVIDENCE_ASSESSMENT_TYPES.has(item.component_type)) return false;
    const next = preserved[index + 1];
    return !next || (next.component_type !== "calibration_checkpoint" && next.component_id !== item.component_id);
  });
}

/**
 * 确定性选择器(源码 select L1104-1452 移植)
 */
export function selectComponents(input: SelectorInput): SelectedComponent[] {
  const stage = determineStage(input.conceptSignals);
  const preserved = input.preserved;
  const preservedAssessmentOrphan = preservedAssessmentWithoutCalibration(preserved);
  const goalMapMissing = !preserved.some((c) => c.component_type === "goal_map");
  const hasAssessment = input.conceptSignals.length > 0;  // 简化: 信号非空即可能已有评估

  const sequence: Array<{ type: ComponentType; required: boolean; reason: string }> = [];

  const append = (type: ComponentType, required: boolean, reason: string) => sequence.push({ type, required, reason });
  /** 评估后必跟校准(成对追加 — 评估永远不是裸 append) */
  const appendAssessment = (type: "guided_practice" | "transfer_challenge", reason: string) => {
    if (preservedAssessmentOrphan) return;
    append(type, true, reason);
    append("calibration_checkpoint", true, COMPONENT_REASON_ZH.calibration_checkpoint);
  };

  // (a) goal_map 前置(每个 plan 的第一个组件)
  if (goalMapMissing) append("goal_map", true, COMPONENT_REASON_ZH.goal_map);

  // (b) 按阶段的主干(源码 L1187-1243)
  if (stage === "unobserved") {
    append("concept_explanation", true,
      input.goalOnly
        ? "从学习目标建立教学基础, 在提供可选练习组件之前。"
        : "直接从来源讲解开始; 起点判断不是使用学习组件的前提。");
    const hasCompletedDiagnostic = preserved.some((c) => c.component_type === "diagnostic_check" && c.status === "completed");
    if (!hasCompletedDiagnostic) append("diagnostic_check", false, COMPONENT_REASON_ZH.diagnostic_check);
  } else if (stage === "needs_support") {
    append("concept_explanation", true, COMPONENT_REASON_ZH.concept_explanation);
    append("worked_example", true, COMPONENT_REASON_ZH.worked_example);
  } else if (stage === "developing") {
    appendAssessment("guided_practice", "发展中的知识需要支持的回忆与即时反馈。");
  } else { // supported
    appendAssessment("transfer_challenge", "当前证据支持在新情境中应用该概念。");
  }

  // (c) worked_example 双来源追加(守卫: 序列中尚无)
  const hasWorkedExample = sequence.some((s) => s.type === "worked_example") || preserved.some((c) => c.component_type === "worked_example");
  if (input.affordances.worked_example && !hasWorkedExample) {
    append("worked_example", false, "材料包含步骤、计算或案例, 适合分步例题。");
  }

  // (d) 三个媒体组件无条件追加(required=false)
  append("visual_map", false, input.affordances.visual ? "材料含图表元素, 适合可视化讲解。" : "可选的关系图讲解。");
  append("video_explanation", false, "可选: 一段简短的来源相关概念动画。");
  append("audio_explanation", false, input.affordances.audio ? "材料含听说元素, 适合语音讲解。" : "可选的语音讲解。");

  // (e) 末尾 guided_practice(材料适配 + 无评估时)
  const seqHasAssessment = sequence.some((s) => EVIDENCE_ASSESSMENT_TYPES.has(s.type)) || preserved.some((c) => EVIDENCE_ASSESSMENT_TYPES.has(c.component_type));
  if (input.affordances.practice && !seqHasAssessment && !preservedAssessmentOrphan) {
    appendAssessment("guided_practice", "练习产生可安全调整下一步的证据。");
  }

  // (f) retrieval_card 无条件追加(required=true)
  append("retrieval_card", true, COMPONENT_REASON_ZH.retrieval_card);

  // (g) progress_checkpoint(条件: 信号非空时)
  if (input.conceptSignals.length > 0) append("progress_checkpoint", false, COMPONENT_REASON_ZH.progress_checkpoint);

  // (h) reflection_prompt(条件)
  append("reflection_prompt", false, COMPONENT_REASON_ZH.reflection_prompt);

  // (i) review_queue(stage != unobserved 且信号非空)
  if (stage !== "unobserved" && input.conceptSignals.length > 0) append("review_queue", false, COMPONENT_REASON_ZH.review_queue);

  // ─── 物化(源码 L1356-1431) ───
  const components: SelectedComponent[] = [];
  let pendingAssessmentId: string | null = null;
  let seqIndex = 0;
  // goal_map 前插: 若 preserved 有内容且缺 goal_map, 新 goal_map 必须在最前
  const componentsFromPreserved = [...preserved];
  for (const item of sequence) {
    if (goalMapMissing && componentsFromPreserved.length > 0 && seqIndex === 0) { seqIndex++; continue; }
    const def = CATALOG[item.type];
    const id = `cmp_${String(components.length + 1).padStart(2, "0")}_${randomUUID().slice(0, 10)}`;
    const modality: SelectedComponent["modality"] =
      item.type === "visual_map" ? "visual"
      : item.type === "video_explanation" ? "video"
      : item.type === "audio_explanation" ? "audio"
      : def.executor === "assessment" || def.executor === "retrieval" ? "interactive"
      : "text";
    components.push({
      id,
      component_type: item.type,
      label_zh: def.label_zh,
      label_en: def.label_en,
      bkt_stage: stage,
      modality,
      dependencies: item.type === "calibration_checkpoint" && pendingAssessmentId ? [pendingAssessmentId] : [],
      required: item.required,
      reason: item.reason,
      status: "pending",
      concept_refs: input.conceptSignals.slice(0, 8).map((s) => s.knowledge_point),
    });
    if (ASSESSMENT_TYPES.has(item.type)) pendingAssessmentId = id;
    else if (item.type === "calibration_checkpoint") pendingAssessmentId = null;
    seqIndex++;
  }
  return components;
}

/** 中文"为何此步"(源码 componentReason 直接照抄) */
export function componentReason(type: string, zh: boolean, fallbackReason = ""): string {
  if (!zh) return fallbackReason;
  return COMPONENT_REASON_ZH[type] ?? fallbackReason;
}

export const learningSelector = { selectComponents, determineStage, componentReason, COMPONENT_REASON_ZH };
