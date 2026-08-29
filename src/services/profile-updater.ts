// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// profile-updater.ts — 画像更新器（2026-08-29, 移植自 Inno Agent profile-updater.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// LLM/工具更新画像的统一入口:
//   updateProfile: 部分更新(数组按 ID 合并, 简单字段覆盖)
//   patchProfile: 细粒度补丁(单概念掌握度增量/诊断/偏好追加)
import type { GoalRecord, KnowledgeRecord, MisconceptionRecord, LearnerProfile } from "./auto-profile.js";

export interface ProfileUpdate {
  goals?: GoalRecord[];
  knowledge?: KnowledgeRecord[];
  misconceptions?: MisconceptionRecord[];
  preferences?: Record<string, string[]>;
  summary?: string;
}

export interface ProfilePatch {
  conceptId?: string;
  masteryDelta?: number;
  mastery?: number;
  confidence?: number;
  stabilityDelta?: number;
  diagnosis?: string;
  nextActionsAppend?: string[];
  evidenceIdsAppend?: string[];
  lastPracticedAt?: string;
  reviewDueAt?: string;
  preferencesAppend?: Record<string, string[]>;
  summaryAppend?: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const uniqueStrings = (values: string[]) => Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));

/** 按 ID 字段合并数组(同 ID 替换, 新项追加) */
function mergeById<T>(existing: T[], incoming: T[], idField: keyof T): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const idx = result.findIndex((e) => e[idField] === item[idField]);
    if (idx >= 0) result[idx] = item;
    else result.push(item);
  }
  return result;
}

/** 部分更新画像(与源码 updateProfile 一致) */
export function updateProfile(profile: LearnerProfile, update: ProfileUpdate): LearnerProfile {
  if (update.goals) profile.goals = mergeById(profile.goals, update.goals, "goalId");
  if (update.knowledge) profile.knowledge = mergeById(profile.knowledge, update.knowledge, "conceptId");
  if (update.misconceptions) profile.misconceptions = mergeById(profile.misconceptions, update.misconceptions, "misconceptionId");
  if (update.preferences) {
    for (const [k, v] of Object.entries(update.preferences)) {
      profile.preferences[k] = uniqueStrings([...(profile.preferences[k] ?? []), ...v]);
    }
  }
  if (update.summary !== undefined) profile.summary = update.summary;
  return profile;
}

/** 细粒度补丁(与源码 patchProfile 一致) */
export function patchProfile(profile: LearnerProfile, patch: ProfilePatch): LearnerProfile {
  if (patch.conceptId) {
    let k = profile.knowledge.find((x) => x.conceptId === patch.conceptId);
    if (!k) {
      k = { conceptId: patch.conceptId, mastery: 0.05, confidence: 0.1, stability: 0.1, evidenceIds: [] };
      profile.knowledge.push(k);
    }
    if (patch.masteryDelta) k.mastery = clamp01(k.mastery + patch.masteryDelta);
    if (patch.mastery !== undefined) k.mastery = clamp01(patch.mastery);
    if (patch.confidence !== undefined) k.confidence = clamp01(patch.confidence);
    if (patch.stabilityDelta) k.stability = clamp01(k.stability + patch.stabilityDelta);
    if (patch.diagnosis !== undefined) k.diagnosis = patch.diagnosis;
    if (patch.nextActionsAppend) k.nextActions = uniqueStrings([...(k.nextActions ?? []), ...patch.nextActionsAppend]).slice(0, 5);
    if (patch.evidenceIdsAppend) k.evidenceIds = uniqueStrings([...(k.evidenceIds ?? []), ...patch.evidenceIdsAppend]);
    if (patch.lastPracticedAt) k.lastPracticedAt = patch.lastPracticedAt;
    if (patch.reviewDueAt) k.reviewDueAt = patch.reviewDueAt;
  }
  if (patch.preferencesAppend) {
    for (const [k, v] of Object.entries(patch.preferencesAppend)) {
      profile.preferences[k] = uniqueStrings([...(profile.preferences[k] ?? []), ...v]);
    }
  }
  if (patch.summaryAppend) profile.summary = `${profile.summary ?? ""}\n${patch.summaryAppend}`.trim();
  return profile;
}

export const profileUpdaterService = { updateProfile, patchProfile };
