// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// context-pack.ts — 学习者上下文包（2026-08-29, 移植自 Inno Agent context-pack.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 每轮注入系统提示词的学习者上下文:
//   当前目标 / 相关概念(按状态优先级排序: misconception<review_due<unknown<learning<fragile<stable)
//   活跃误区 / 教学提示(偏好映射) / 到期复习(动态+静态合并去重) / 最近学习事件
import { projectKnowledgeState, type DerivedKnowledgeState } from "./learner-state-engine.js";

export interface ProfileForPack {
  goals: Array<{ title: string; status: string; priority: number }>;
  knowledge: KnowledgeForPack[];
  misconceptions: Array<{ status: string; description: string }>;
  preferences: Record<string, string[]>;
}

export interface KnowledgeForPack {
  conceptId: string;
  mastery: number;
  confidence?: number;
  stabilityDays?: number;
  lastSuccessfulRetrievalAt?: string;
  lastResult?: string;
  evidenceIds?: string[];
  reviewDueAt?: string;
  diagnosis?: string;
  nextActions?: string[];
  stateLabel?: string;
}

export interface LearnerContextPack {
  activeGoal?: string;
  relevantConcepts: Array<{
    conceptId: string;
    mastery: number;
    diagnosis: string;
    estimateConfidence?: number;
    retrievability?: number;
    stateLabel: string;
    recommendedAction?: string;
  }>;
  activeMisconceptions: string[];
  teachingHints: string[];
  recentEvents: Array<{ eventType: string; timestamp: string; summary: string }>;
  reviewDueConcepts: Array<{ conceptId: string; reviewDueAt: string; mastery: number }>;
}

const STATE_PRIORITY: Record<string, number> = { misconception: 0, review_due: 1, unknown: 2, learning: 3, fragile: 4, stable: 5 };

/** 从画像构建上下文包(与 buildContextPack 一致) */
export function buildContextPack(profile: ProfileForPack, events: Array<{ eventType: string; timestamp: string; summary: string }> = []): LearnerContextPack {
  const activeGoals = profile.goals.filter((g) => g.status === "active").sort((a, b) => b.priority - a.priority);
  const activeGoal = activeGoals[0]?.title;

  // 用状态机投影每个知识点(应用 evidenceIds 去重)
  const projectedStates: DerivedKnowledgeState[] = profile.knowledge.map((k) =>
    projectKnowledgeState(
      {
        mastery: k.mastery, confidence: k.confidence ?? 0.1,
        stabilityDays: k.stabilityDays ?? 0.25,
        lastSuccessfulRetrievalAt: k.lastSuccessfulRetrievalAt,
        lastResult: (k.lastResult as any) || undefined,
        exposureCount: 0, retrievalCount: (k.evidenceIds ?? []).length > 0 ? 1 : 0,
        lapseCount: k.lastResult === "incorrect" ? 1 : 0,
        successfulTransferCount: 0,
        evidenceIds: k.evidenceIds ?? [],
      },
      k.conceptId,
      [],
    ));

  const relevantConcepts = projectedStates
    .filter((ks) => ks.mastery < 1.0)
    .sort((a, b) => (STATE_PRIORITY[a.stateLabel] ?? 9) - (STATE_PRIORITY[b.stateLabel] ?? 9) || a.mastery - b.mastery)
    .slice(0, 5)
    .map((ks) => ({
      conceptId: ks.conceptId,
      mastery: ks.mastery,
      diagnosis: ks.diagnosis,
      estimateConfidence: ks.confidence,
      retrievability: ks.retrievability,
      stateLabel: ks.stateLabel,
      recommendedAction: ks.nextActions?.[0],
    }));

  const activeMisconceptions = profile.misconceptions.filter((m) => m.status === "active").map((m) => m.description);

  // 教学提示: 偏好 → 中文映射
  const teachingHints: string[] = [];
  const styleMap: Record<string, string> = { example_first: "例子优先", code_first: "代码优先", theory_first: "理论优先", visual: "图示优先" };
  const practiceMap: Record<string, string> = { small_steps: "小步练习", immediate_feedback: "即时反馈", spaced_repetition: "间隔复习" };
  const toneMap: Record<string, string> = { direct: "直接", encouraging: "鼓励性", socratic: "苏格拉底式提问" };
  for (const s of profile.preferences.explanation_style ?? []) if (styleMap[s]) teachingHints.push(styleMap[s]);
  for (const s of profile.preferences.practice_style ?? []) if (practiceMap[s]) teachingHints.push(practiceMap[s]);
  for (const t of profile.preferences.feedback_tone ?? []) if (toneMap[t]) teachingHints.push(toneMap[t]);
  for (const a of profile.preferences.avoid ?? []) teachingHints.push(`避免：${a}`);

  // 到期复习: 动态(状态机投影) + 静态(画像 reviewDueAt) 合并去重
  const now = Date.now();
  const reviewDueByConcept = new Map<string, { conceptId: string; reviewDueAt: string; mastery: number }>();
  for (const ks of projectedStates) {
    if (ks.nextReviewAt && Date.parse(ks.nextReviewAt) <= now) {
      reviewDueByConcept.set(ks.conceptId, { conceptId: ks.conceptId, reviewDueAt: ks.nextReviewAt, mastery: ks.mastery });
    }
  }
  for (const k of profile.knowledge) {
    if (!k.reviewDueAt || Date.parse(k.reviewDueAt) > now || reviewDueByConcept.has(k.conceptId)) continue;
    reviewDueByConcept.set(k.conceptId, { conceptId: k.conceptId, reviewDueAt: k.reviewDueAt, mastery: k.mastery });
  }
  const reviewDueConcepts = [...reviewDueByConcept.values()].sort((a, b) => Date.parse(a.reviewDueAt) - Date.parse(b.reviewDueAt)).slice(0, 5);

  return { activeGoal, relevantConcepts, activeMisconceptions, teachingHints, recentEvents: events.slice(-5).reverse(), reviewDueConcepts };
}

/** 格式化为系统提示词 markdown(与 formatContextPackForPrompt 一致) */
export function formatContextPackForPrompt(pack: LearnerContextPack): string {
  const lines: string[] = ["## 学习者上下文"];
  lines.push(pack.activeGoal ? `\n当前目标：${pack.activeGoal}` : "\n当前目标：暂未设定");
  if (pack.relevantConcepts.length > 0) {
    lines.push("\n相关概念：");
    for (const c of pack.relevantConcepts) {
      const state = c.stateLabel ? `，状态 ${c.stateLabel}` : "";
      const confidence = c.estimateConfidence === undefined ? "" : `，估计置信度 ${c.estimateConfidence.toFixed(2)}`;
      const retrievability = c.retrievability === undefined ? "" : `，当前可提取概率 ${c.retrievability.toFixed(2)}`;
      lines.push(`- ${c.conceptId}: 长期掌握度 ${c.mastery.toFixed(2)}${state}${confidence}${retrievability}，诊断：${c.diagnosis}`);
      if (c.recommendedAction) lines.push(`  建议：${c.recommendedAction}`);
    }
  }
  if (pack.activeMisconceptions.length > 0) {
    lines.push("\n活跃误区：");
    for (const m of pack.activeMisconceptions) lines.push(`- ${m}`);
  }
  if (pack.teachingHints.length > 0) {
    lines.push("\n教学提示：");
    for (const h of pack.teachingHints) lines.push(`- ${h}`);
  }
  if (pack.reviewDueConcepts.length > 0) {
    lines.push("\n到期复习：");
    for (const c of pack.reviewDueConcepts) lines.push(`- ${c.conceptId}: 掌握度 ${c.mastery.toFixed(2)}，到期 ${c.reviewDueAt}`);
  }
  if (pack.recentEvents.length > 0) {
    lines.push("\n最近学习事件：");
    for (const e of pack.recentEvents) lines.push(`- ${e.timestamp.slice(0, 10)} ${e.eventType}: ${e.summary}`);
  }
  return lines.join("\n");
}

export const contextPackService = { buildContextPack, formatContextPackForPrompt };
