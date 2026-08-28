// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// auto-profile.ts — 自动画像更新器（2026-08-29, 移植自 Inno Agent auto-profile.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 学习事件 → 画像自动更新:
//   goal_declared → 创建/归档目标(归档意图检测: "不再学X"等)
//   exercise_attempt/milestone → 掌握度增量(MASTERY_DELTAS) + 复习调度(按掌握度 1/3/7 天)
//   preference_stated / derived_signals.preference_candidates → 偏好合并
//   derived_signals.misconception_candidates → 误解记录(去重/证据追加)
//   concept_explained → 只记 exposure, 不提升掌握度(防"解释了就以为会了")

export interface LearnerEvent {
  eventType: string;                       // goal_declared | exercise_attempt | milestone_reached | concept_explained | preference_stated | ...
  timestamp: string;
  conceptIds?: string[];
  payload: Record<string, unknown>;
  derivedSignals?: {
    masteryDelta?: number;
    preferenceCandidates?: string[];
    misconceptionCandidates?: string[];
  };
  eventId?: string;
}

export interface GoalRecord {
  goalId: string;
  title: string;
  status: "active" | "archived";
  priority: number;
  updatedAt: string;
}

export interface KnowledgeRecord {
  conceptId: string;
  mastery: number;          // 0-1
  confidence: number;
  stability: number;
  lastPracticedAt?: string;
  reviewDueAt?: string;
  evidenceIds: string[];
  diagnosis?: string;
  nextActions?: string[];
}

export interface MisconceptionRecord {
  misconceptionId: string;
  conceptId: string;
  description: string;
  status: "active" | "resolved";
  severity: number;
  confidence: number;
  evidenceIds: string[];
  lastSeenAt: string;
}

export interface LearnerProfile {
  goals: GoalRecord[];
  knowledge: KnowledgeRecord[];
  misconceptions: MisconceptionRecord[];
  preferences: Record<string, string[]>;
  summary?: string;
}

/** 事件 → 掌握度增量(与源码 MASTERY_DELTAS 一致) */
export const MASTERY_DELTAS: Record<string, number> = {
  exercise_attempt: 0.03,
  milestone_reached: 0.02,
  self_assessed: 0.01,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const uniqueStrings = (arr: string[]) => [...new Set(arr.filter(Boolean))];

function normalizeIdPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** 归档意图检测: "不再学X"/"放弃X"/"停止学习X" 等 */
export function hasArchiveIntent(text: string): boolean {
  return /(不再|放弃|停止|终止|不学|算了|学完了|已掌握).{0,20}(学|习|研究|练|看)|(学|习|研究|练).{0,10}(算了|告一段落|结束)/.test(text)
    || /^(archive|stop|quit|done with|finished)/i.test(text.trim());
}

/** 单事件应用(与 applyLearningEventToProfile 一致) */
export function applyLearningEventToProfile(profile: LearnerProfile, event: LearnerEvent): boolean {
  let changed = false;
  changed = updateGoalFromEvent(profile, event) || changed;
  changed = updateKnowledgeFromEvent(profile, event) || changed;
  changed = updatePreferencesFromEvent(profile, event) || changed;
  changed = updateMisconceptionsFromEvent(profile, event) || changed;
  return changed;
}

function ensureKnowledgeState(profile: LearnerProfile, conceptId: string): KnowledgeRecord {
  let s = profile.knowledge.find((k) => k.conceptId === conceptId);
  if (!s) {
    s = { conceptId, mastery: 0.05, confidence: 0.1, stability: 0.1, evidenceIds: [] };
    profile.knowledge.push(s);
  }
  return s;
}

function updateKnowledgeFromEvent(profile: LearnerProfile, event: LearnerEvent): boolean {
  const conceptIds = event.conceptIds ?? [];
  if (conceptIds.length === 0) return false;
  // 解释是 exposure 不是掌握证据; concept_explained 永不提升掌握度
  const delta = event.eventType === "concept_explained"
    ? 0
    : typeof event.derivedSignals?.masteryDelta === "number"
      ? event.derivedSignals.masteryDelta
      : (MASTERY_DELTAS[event.eventType] ?? 0);
  let changed = false;
  for (const conceptId of conceptIds) {
    const state = ensureKnowledgeState(profile, conceptId);
    const eid = event.eventId ?? `${event.eventType}:${event.timestamp}`;
    const hasSeenEvidence = state.evidenceIds.includes(eid);
    if (!hasSeenEvidence) { state.evidenceIds.push(eid); changed = true; }
    if (delta !== 0 && !hasSeenEvidence) {
      state.mastery = clamp01(state.mastery + delta);
      state.confidence = clamp01(Math.max(state.confidence, 0.45) + Math.abs(delta) * 0.2);
      state.stability = clamp01(state.stability + Math.max(0, delta) * 0.15);
      changed = true;
    }
    // 复习调度: 按掌握度 1/3/7 天(与源码一致)
    if (event.eventType === "exercise_attempt" || event.eventType === "concept_explained") {
      const due = new Date(event.timestamp);
      due.setDate(due.getDate() + (state.mastery < 0.4 ? 1 : state.mastery < 0.75 ? 3 : 7));
      const nextReview = due.toISOString();
      if (state.reviewDueAt !== nextReview) { state.reviewDueAt = nextReview; changed = true; }
    }
    const topic = typeof event.payload.topic === "string" ? event.payload.topic
      : typeof event.payload.concept === "string" ? event.payload.concept
      : typeof event.payload.summary === "string" ? event.payload.summary
      : undefined;
    if (topic) {
      const before = JSON.stringify({ d: state.diagnosis, a: state.nextActions });
      state.diagnosis = `最近学习/讨论了「${topic}」，需要后续练习验证掌握度。`;
      state.nextActions = uniqueStrings([
        `用自己的话复述 ${conceptId} 的核心机制。`,
        `完成一个小练习来验证 ${conceptId} 的掌握情况。`,
        ...(state.nextActions ?? []),
      ]).slice(0, 5);
      if (before !== JSON.stringify({ d: state.diagnosis, a: state.nextActions })) changed = true;
    }
  }
  return changed;
}

function updateGoalFromEvent(profile: LearnerProfile, event: LearnerEvent): boolean {
  if (event.eventType !== "goal_declared") return false;
  const rawGoal = typeof event.payload.goal === "string" ? event.payload.goal : "";
  const previousGoal = typeof event.payload.previous_goal === "string" ? event.payload.previous_goal : "";
  const goalDescription = typeof event.payload.goal_description === "string" ? event.payload.goal_description : "";
  const text = [rawGoal, previousGoal, goalDescription, JSON.stringify(event.payload)].filter(Boolean).join(" ");
  let changed = false;

  const archiveMatching = (target: string) => {
    for (const g of profile.goals) {
      if (g.status === "active" && (target.includes(g.title) || g.title.includes(target))) {
        g.status = "archived"; g.priority = 0; changed = true;
      }
    }
  };
  if (previousGoal && hasArchiveIntent(text)) { archiveMatching(previousGoal); }
  if (hasArchiveIntent(text)) {
    archiveMatching(goalDescription ?? previousGoal ?? rawGoal ?? text);
  }
  if (!rawGoal || hasArchiveIntent(rawGoal)) return changed;

  const goalId = `goal_${normalizeIdPart(rawGoal) || "unknown"}`;
  const existing = profile.goals.find((g) => g.goalId === goalId);
  const goal: GoalRecord = existing ?? { goalId, title: rawGoal, status: "active", priority: 0.8, updatedAt: event.timestamp };
  goal.title = rawGoal;
  goal.status = "active";
  if (goal.priority <= 0) goal.priority = 0.8;
  goal.updatedAt = event.timestamp;
  if (!existing) { profile.goals.push(goal); changed = true; }
  return changed;
}

function updatePreferencesFromEvent(profile: LearnerProfile, event: LearnerEvent): boolean {
  const candidates = [
    ...(event.derivedSignals?.preferenceCandidates ?? []),
    ...(event.eventType === "preference_stated" && typeof event.payload.preference === "string" ? [event.payload.preference] : []),
  ];
  if (candidates.length === 0) return false;
  let changed = false;
  for (const c of candidates) {
    const [key, ...rest] = String(c).split(":");
    const value = rest.join(":").trim() || String(c);
    const k = (key || "general").trim();
    if (!profile.preferences[k]) profile.preferences[k] = [];
    if (!profile.preferences[k].includes(value)) { profile.preferences[k].push(value); changed = true; }
  }
  return changed;
}

function updateMisconceptionsFromEvent(profile: LearnerProfile, event: LearnerEvent): boolean {
  const candidates = event.derivedSignals?.misconceptionCandidates ?? [];
  if (candidates.length === 0) return false;
  const conceptId = event.conceptIds?.[0] ?? "general";
  let changed = false;
  for (const description of candidates) {
    const trimmed = String(description).trim();
    if (!trimmed) continue;
    const id = `misc_${normalizeIdPart(trimmed).slice(0, 24)}`;
    const eid = event.eventId ?? `${event.eventType}:${event.timestamp}`;
    let m = profile.misconceptions.find((x) => x.misconceptionId === id);
    if (!m) {
      m = { misconceptionId: id, conceptId, description: trimmed, status: "active", severity: 0.5, confidence: 0.4, evidenceIds: [eid], lastSeenAt: event.timestamp };
      profile.misconceptions.push(m);
      changed = true;
    } else if (!m.evidenceIds.includes(eid)) {
      m.evidenceIds.push(eid);
      m.lastSeenAt = event.timestamp;
      changed = true;
    }
  }
  return changed;
}

export const autoProfileService = { applyLearningEventToProfile, hasArchiveIntent, MASTERY_DELTAS };
