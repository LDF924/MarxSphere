// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learner-state-engine.ts — 掌握度状态机（2026-08-29, 对照移植 Inno Agent state-engine.ts）
// 核心算法(与源码一致):
//   - 证据权重: exposure=0 recognition=0.25 guided_recall=0.45 free_recall=0.75
//               application=0.85 transfer=1 self_report=0.1
//   - 掌握度更新: mastery += LEARNING_RATE(0.35) × weight × (observed - mastery)
//   - 遗忘曲线: retrievability = 0.9^(elapsedDays / stabilityDays)
//   - 稳定性: 答对 ×(1+0.6w+0.3(1-retrievability)); 答错 ×(0.8-0.4w)
//   - 六态: stable / fragile / learning / review_due / misconception / unknown
//   - 复习调度: next_review_at 由 stabilityDays 推算(0.9^t = 0.7 → t = stability × ln0.7/ln0.9)

export type EvidenceKind = "exposure" | "recognition" | "guided_recall" | "free_recall" | "application" | "transfer" | "self_report";
export type EvidenceResult = "correct" | "partial" | "incorrect";
export type StateLabel = "stable" | "fragile" | "learning" | "review_due" | "misconception" | "unknown";

export interface LearningEvidence {
  conceptId: string;
  kind: EvidenceKind;
  result?: EvidenceResult;
  score?: number;        // 0-1, 与 result 带约束(正确≥0.8, 部分0.2-0.79)
  occurredAt?: string;
}

export interface KnowledgeState {
  mastery: number;             // 0-1
  confidence: number;          // 0-1 估计置信度
  stabilityDays: number;       // 稳定性(天)
  lastSuccessfulRetrievalAt?: string;
  lastResult?: EvidenceResult;
  exposureCount: number;
  retrievalCount: number;
  lapseCount: number;
  successfulTransferCount: number;
  evidenceIds: string[];
  hasActiveMisconception?: boolean;
}

export interface DerivedKnowledgeState extends KnowledgeState {
  conceptId: string;           // 与 Inno Agent concept_id 对齐(前置解析按 id 匹配)
  retrievability?: number;     // 0-1 当前可提取性
  nextReviewAt?: string;
  stateLabel: StateLabel;
  diagnosis: string;
  nextActions?: string[];      // 与 Inno Agent next_actions 对齐(context-pack 推荐动作)
}

const LEARNING_RATE = 0.35;
const REVIEW_RETRIEVABILITY_THRESHOLD = 0.7;
const KIND_WEIGHT: Record<EvidenceKind, number> = {
  exposure: 0, recognition: 0.25, guided_recall: 0.45, free_recall: 0.75,
  application: 0.85, transfer: 1, self_report: 0.1,
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const validTime = (v?: string) => { if (!v) return undefined; const t = Date.parse(v); return Number.isFinite(t) ? t : undefined; };

/** 证据结果值: result 带评分约束, 防止矛盾字段反转学习信号 */
function resultValue(e: LearningEvidence): number | undefined {
  if (e.result === "correct") return clamp(e.score ?? 1, 0.8, 1);
  if (e.result === "partial") return clamp(e.score ?? 0.5, 0.2, 0.79);
  if (e.result === "incorrect") return 0;
  return undefined;
}

const isRetrieval = (e: LearningEvidence) =>
  e.kind === "guided_recall" || e.kind === "free_recall" || e.kind === "application" || e.kind === "transfer";

/** 遗忘曲线: 上次成功提取后的可提取性(0.9^天数/stability) */
export function calculateRetrievability(lastSuccessfulRetrievalAt: string | undefined, stabilityDays: number, asOf: Date): number | undefined {
  const last = validTime(lastSuccessfulRetrievalAt);
  if (last === undefined) return undefined;
  const elapsedDays = Math.max(0, (asOf.getTime() - last) / 86_400_000);
  return clamp(0.9 ** (elapsedDays / Math.max(0.25, stabilityDays)), 0, 1);
}

/** 下次复习时间: 可提取性降到 0.7 时 */
function nextReviewAt(lastSuccessfulRetrievalAt: string | undefined, stabilityDays: number): string | undefined {
  const last = validTime(lastSuccessfulRetrievalAt);
  if (last === undefined) return undefined;
  const elapsedDays = stabilityDays * (Math.log(REVIEW_RETRIEVABILITY_THRESHOLD) / Math.log(0.9));
  return new Date(last + elapsedDays * 86_400_000).toISOString();
}

/** 投影知识状态: 应用证据序列更新掌握度/稳定性/标签 */
export function projectKnowledgeState(
  base: KnowledgeState | undefined,
  conceptId: string,
  evidence: LearningEvidence[],
  asOf: Date = new Date(),
): DerivedKnowledgeState {
  let mastery = clamp(base?.mastery ?? 0.05, 0, 1);
  let confidence = clamp(base?.confidence ?? 0.1, 0, 1);
  let stabilityDays = clamp(base?.stabilityDays ?? 0.25, 0.25, 365);
  let lastEvidenceAt = base?.lastSuccessfulRetrievalAt;
  let lastSuccessfulRetrievalAt = base?.lastSuccessfulRetrievalAt;
  let lastResult = base?.lastResult;
  let exposureCount = base?.exposureCount ?? 0;
  let retrievalCount = base?.retrievalCount ?? 0;
  let lapseCount = base?.lapseCount ?? 0;
  let successfulTransferCount = base?.successfulTransferCount ?? 0;
  const evidenceIds = new Set(base?.evidenceIds ?? []);
  const asOfTime = asOf.getTime();

  const relevant = evidence
    .filter((item) => {
      if (item.conceptId !== conceptId) return false;
      const t = validTime(item.occurredAt);
      return t === undefined || t <= asOfTime;
    })
    .sort((a, b) => (validTime(a.occurredAt) ?? 0) - (validTime(b.occurredAt) ?? 0));

  for (const item of relevant) {
    const eid = `${item.kind}:${item.occurredAt ?? "now"}:${item.score ?? item.result ?? "x"}`;
    if (evidenceIds.has(eid)) continue;
    evidenceIds.add(eid);
    lastEvidenceAt = item.occurredAt ?? lastEvidenceAt;
    if (item.kind === "exposure") exposureCount += 1;
    if (isRetrieval(item)) retrievalCount += 1;

    const observed = resultValue(item);
    const weight = KIND_WEIGHT[item.kind];
    if (observed === undefined || weight === 0) continue;
    if (isRetrieval(item)) lastResult = item.result;

    mastery = clamp(mastery + LEARNING_RATE * weight * (observed - mastery), 0, 1);
    confidence = clamp(1 - (1 - confidence) * (1 - 0.5 * weight), 0, 1);

    if (observed >= 0.8 && isRetrieval(item)) {
      const before = calculateRetrievability(lastSuccessfulRetrievalAt, stabilityDays, new Date(item.occurredAt ?? asOfTime)) ?? 1;
      stabilityDays = clamp(stabilityDays * (1 + 0.6 * weight + 0.3 * Math.max(0, 1 - before)), 0.25, 365);
      lastSuccessfulRetrievalAt = item.occurredAt ?? lastSuccessfulRetrievalAt;
      if (item.kind === "transfer") successfulTransferCount += 1;
    } else if (observed < 0.5 && isRetrieval(item)) {
      stabilityDays = clamp(stabilityDays * (0.8 - 0.4 * weight), 0.25, 365);
      lapseCount += 1;
    }
  }

  const retrievability = calculateRetrievability(lastSuccessfulRetrievalAt, stabilityDays, asOf);
  let stateLabel: StateLabel;
  if (base?.hasActiveMisconception) stateLabel = "misconception";
  else if (mastery >= 0.75 && confidence >= 0.65 && stabilityDays >= 7 && successfulTransferCount > 0) stateLabel = "stable";
  else if (lastResult === "incorrect") stateLabel = "learning";
  else if (retrievability !== undefined && retrievability < REVIEW_RETRIEVABILITY_THRESHOLD) stateLabel = "review_due";
  else if (lastSuccessfulRetrievalAt) stateLabel = "fragile";
  else if (relevant.length > 0) stateLabel = "learning";
  else stateLabel = "unknown";

  const diagnosis = {
    stable: "已掌握且稳定, 可进入迁移应用",
    fragile: "曾成功提取, 但稳定性不足, 建议间隔复习",
    learning: "学习进行中, 继续练习",
    review_due: "可提取性已低于阈值, 建议立即复习",
    misconception: "存在未纠正误解, 先澄清再练习",
    unknown: "尚无学习证据",
  }[stateLabel];
  const nextActions = {
    stable: ["进入迁移应用: 在新情境中使用该概念"],
    fragile: ["间隔复习巩固稳定性", "完成一次应用练习"],
    learning: ["用自己的话复述核心机制", "完成一个小练习验证掌握"],
    review_due: ["立即复习: 重新提取核心要点", "复习后做一次应用练习"],
    misconception: ["先澄清误解(反例/对比)", "澄清后重新练习"],
    unknown: ["先做一次低成本诊断任务"],
  }[stateLabel];

  return {
    conceptId,
    mastery, confidence, stabilityDays,
    lastSuccessfulRetrievalAt, lastResult,
    exposureCount, retrievalCount, lapseCount, successfulTransferCount,
    evidenceIds: [...evidenceIds],
    hasActiveMisconception: base?.hasActiveMisconception,
    retrievability,
    nextReviewAt: nextReviewAt(lastSuccessfulRetrievalAt, stabilityDays),
    stateLabel,
    diagnosis,
    nextActions,
  };
}

export const learnerStateEngine = { projectKnowledgeState, calculateRetrievability };
