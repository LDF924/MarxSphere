// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// prerequisite-resolver.ts — 前置知识解析器（2026-08-29, 移植自 Inno Agent prerequisite-resolver.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 教学前诊断: 目标概念的前置知识是否满足 → 推荐动作(use/diagnose/teach/repair/proceed)
// 决策优先级: 必需前置的 repair > teach > diagnose; 展示预算永不隐藏必需阻断项
import type { DerivedKnowledgeState, StateLabel } from "./learner-state-engine.js";

export type PrerequisiteRelation = "required" | "supporting";
export type PrerequisiteSource = "curated" | "teacher" | "imported" | "model_inferred";
export type PrerequisiteStatus = "satisfied" | "uncertain" | "missing" | "misconception";
export type PrerequisiteAction = "use" | "diagnose" | "teach" | "repair";
export type ResolutionAction = "direct" | "proceed" | "diagnose" | "teach" | "repair";

export interface PrerequisiteEdge {
  targetConceptId: string;
  prerequisiteConceptId: string;
  relation: PrerequisiteRelation;
  requiredLevel: number;
  importance: number;
  source: PrerequisiteSource;
  sourceConfidence: number;
  rationale: string;
  depth?: number;
}

export interface PrerequisiteAssessment {
  targetConceptId: string;
  prerequisiteConceptId: string;
  status: PrerequisiteStatus;
  requiredLevel: number;
  estimatedMastery?: number;
  retrievability?: number;
  estimateConfidence: number;
  reason: string;
  recommendedAction: PrerequisiteAction;
  edge: PrerequisiteEdge;   // 与 Inno Agent 一致: 保留评估所基于的前置边
}

export interface PrerequisiteResolution {
  targetConceptId: string;
  isAtomic: boolean;
  action: ResolutionAction;
  reason: string;
  assessments: PrerequisiteAssessment[];
}

export interface ResolvePrerequisiteOptions {
  isAtomic?: boolean;
  maxDepth?: number;
  maxActivePrerequisites?: number;
  minimumRelationConfidence?: number;
  minimumStateConfidence?: number;
  minimumRetrievability?: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 单条前置边评估(与 Inno Agent assessmentFor 一致) */
function assessmentFor(
  edge: PrerequisiteEdge,
  state: DerivedKnowledgeState | undefined,
  opts: { minimumRelationConfidence: number; minimumStateConfidence: number; minimumRetrievability: number },
): PrerequisiteAssessment {
  const base = {
    targetConceptId: edge.targetConceptId,
    prerequisiteConceptId: edge.prerequisiteConceptId,
    requiredLevel: edge.requiredLevel,
    estimatedMastery: state?.mastery,
    retrievability: state?.retrievability,
    estimateConfidence: state?.confidence ?? 0,
    edge,
  };
  if (!state || state.stateLabel === "unknown") {
    return { ...base, status: "uncertain" as const, reason: "记忆中没有足够可靠的掌握证据，不能默认学生已经会。", recommendedAction: "diagnose" as const };
  }
  if (state.stateLabel === "misconception") {
    return { ...base, status: "misconception" as const, reason: "存在与该前置概念相关的活跃误区。", recommendedAction: edge.sourceConfidence < opts.minimumRelationConfidence ? "diagnose" as const : "repair" as const };
  }
  if (
    state.confidence < opts.minimumStateConfidence
    || state.stateLabel === "review_due"
    || (state.retrievability !== undefined && state.retrievability < opts.minimumRetrievability)
  ) {
    return { ...base, status: "uncertain" as const, reason: "掌握证据不足或已经过期，需要用一个最小任务确认当前能否提取。", recommendedAction: "diagnose" as const };
  }
  const currentlyDemonstrated = state.lastResult === "correct"
    && state.retrievalCount > 0
    && state.retrievability !== undefined
    && state.retrievability >= opts.minimumRetrievability;
  if (state.mastery < edge.requiredLevel && !currentlyDemonstrated) {
    const lowConfidenceRelation = edge.source === "model_inferred" && edge.sourceConfidence < opts.minimumRelationConfidence;
    return {
      ...base, status: "missing" as const,
      reason: lowConfidenceRelation ? "模型推断该概念可能是前置，但关系置信度不足，先诊断而不直接阻断原任务。" : `可靠证据显示当前掌握度低于本任务要求的 ${edge.requiredLevel.toFixed(2)}。`,
      recommendedAction: lowConfidenceRelation ? "diagnose" as const : "teach" as const,
    };
  }
  return { ...base, status: "satisfied" as const, reason: "现有证据满足本次任务要求，可以直接使用该能力。", recommendedAction: "use" as const };
}

/** 评估优先级: 误解 > 缺失 > 不确定 */
function priority(a: PrerequisiteAssessment): number {
  const rank = { misconception: 4, missing: 3, uncertain: 2, satisfied: 1 } as const;
  return (rank[a.status] ?? 0) * a.edge.importance;
}

/** 解析目标概念的前置知识, 给出教学动作(与 Inno Agent resolvePrerequisites 一致) */
export function resolvePrerequisites(
  targetConceptId: string,
  edges: PrerequisiteEdge[],
  states: DerivedKnowledgeState[],
  options: ResolvePrerequisiteOptions = {},
): PrerequisiteResolution {
  const isAtomic = options.isAtomic ?? false;
  if (isAtomic || edges.length === 0) {
    return {
      targetConceptId, isAtomic, action: "direct" as const,
      reason: isAtomic ? "目标已达到本次教学的原子概念边界，不再继续追溯前置知识。" : "当前任务没有声明必要前置知识，直接从目标概念开始。",
      assessments: [],
    };
  }
  const maxDepth = options.maxDepth ?? 2;
  const maxActivePrerequisites = options.maxActivePrerequisites ?? 3;
  const thresholds = {
    minimumRelationConfidence: clamp01(options.minimumRelationConfidence ?? 0.6),
    minimumStateConfidence: clamp01(options.minimumStateConfidence ?? 0.4),
    minimumRetrievability: clamp01(options.minimumRetrievability ?? 0.65),
  };
  const stateById = new Map(states.map((s) => [s.conceptId, s]));
  const bestEdgeByPrerequisite = new Map<string, PrerequisiteEdge>();
  for (const edge of edges) {
    if (edge.targetConceptId !== targetConceptId || (edge.depth ?? 1) > maxDepth) continue;
    const normalized = { ...edge, requiredLevel: clamp01(edge.requiredLevel), importance: clamp01(edge.importance), sourceConfidence: clamp01(edge.sourceConfidence) };
    const existing = bestEdgeByPrerequisite.get(edge.prerequisiteConceptId);
    if (!existing || normalized.importance * normalized.sourceConfidence > existing.importance * existing.sourceConfidence) {
      bestEdgeByPrerequisite.set(edge.prerequisiteConceptId, normalized);
    }
  }
  const allAssessments = [...bestEdgeByPrerequisite.values()].map((edge) =>
    assessmentFor(edge, stateById.get(edge.prerequisiteConceptId), thresholds));
  const allActive = allAssessments.filter((item) => item.status !== "satisfied");
  const requiredActive = allActive.filter((item) => item.edge.relation === "required").sort((a, b) => priority(b) - priority(a));
  const supportingActive = allActive.filter((item) => item.edge.relation !== "required").sort((a, b) => priority(b) - priority(a));
  // 展示预算永不隐藏必需阻断项; 决策基于全部必需前置
  const active = [...requiredActive.slice(0, maxActivePrerequisites), ...supportingActive.slice(0, Math.max(0, maxActivePrerequisites - requiredActive.length))];
  const satisfied = allAssessments.filter((item) => item.status === "satisfied");
  const assessments = [...active, ...satisfied];

  const repair = requiredActive.find((item) => item.recommendedAction === "repair");
  if (repair) return { targetConceptId, isAtomic: false, action: "repair" as const, reason: `先修复前置误区 ${repair.prerequisiteConceptId}，再回到原问题。`, assessments };
  const teach = requiredActive.find((item) => item.recommendedAction === "teach");
  if (teach) return { targetConceptId, isAtomic: false, action: "teach" as const, reason: `先补足必要前置知识 ${teach.prerequisiteConceptId}，完成最小验证后回到原问题。`, assessments };
  const diagnose = requiredActive.find((item) => item.recommendedAction === "diagnose");
  if (diagnose) return { targetConceptId, isAtomic: false, action: "diagnose" as const, reason: `先用一个低成本任务诊断 ${diagnose.prerequisiteConceptId}，不要只问学生“会不会”。`, assessments };
  return { targetConceptId, isAtomic: false, action: "proceed" as const, reason: "必要前置知识均有足够证据，可以直接继续原问题。", assessments };
}

export const prerequisiteResolverService = { resolvePrerequisites };
