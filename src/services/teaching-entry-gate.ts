// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// teaching-entry-gate.ts — 教学入口门（2026-08-29, 移植自 Inno Agent teaching-entry-gate.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 决定"本轮是否插入前置知识诊断", 并输出下一条回复协议:
//   learning 模式 → 默认允许诊断, resolvePrerequisites 决策(use/diagnose/teach/repair)
//   direct_task/urgent → 不插入诊断(直接回答)
//   skip_diagnosis → 学习者选择跳过
// 回复协议: diagnose 只诊断不给答案 / teach 只做最短桥接 / repair 只修误区 — 问完即停
import {
  resolvePrerequisites,
  type PrerequisiteEdge,
  type PrerequisiteResolution,
  type PrerequisiteAssessment,
} from "./prerequisite-resolver.js";
import type { DerivedKnowledgeState } from "./learner-state-engine.js";

export type TeachingRequestMode = "learning" | "direct_task" | "urgent";

export interface TeachingEntryRequest {
  targetConceptId: string;
  taskScope?: string;
  mode: TeachingRequestMode;
  isAtomic: boolean;
  skipDiagnosis?: boolean;
  prerequisites: PrerequisiteEdge[];
}

export interface TeachingEntryDecision extends PrerequisiteResolution {
  taskScope?: string;
  diagnosticsAllowed: boolean;
}

export function evaluateTeachingEntry(
  request: TeachingEntryRequest,
  states: DerivedKnowledgeState[],
): TeachingEntryDecision {
  const diagnosticsAllowed = request.mode === "learning" && request.skipDiagnosis !== true;
  if (!diagnosticsAllowed) {
    return {
      targetConceptId: request.targetConceptId,
      taskScope: request.taskScope,
      isAtomic: request.isAtomic,
      diagnosticsAllowed: false,
      action: "direct" as const,
      reason: request.mode === "learning"
        ? "学习者选择跳过诊断，本轮直接回应当前问题。"
        : "当前请求不是主动教学模式，不插入前置知识诊断。",
      assessments: [],
    };
  }
  const resolution = resolvePrerequisites(
    request.targetConceptId,
    request.prerequisites,
    states,
    { isAtomic: request.isAtomic },
  );
  return { ...resolution, taskScope: request.taskScope, diagnosticsAllowed: true };
}

/** 格式化为下一条回复协议(与源码 formatTeachingEntryDecision 一致) */
export function formatTeachingEntryDecision(decision: TeachingEntryDecision): string {
  const lines = [
    "## 教学入口判断",
    `- 目标概念：${decision.targetConceptId}`,
    decision.taskScope ? `- 当前任务：${decision.taskScope}` : "",
    `- 决策：${decision.action}`,
    `- 原因：${decision.reason}`,
  ].filter(Boolean);
  for (const item of decision.assessments.filter((a) => a.status !== "satisfied")) {
    lines.push(`- 前置 ${item.prerequisiteConceptId}: ${item.status}；动作 ${item.recommendedAction}；${item.reason}`);
  }
  const primary = decision.assessments.find((a) =>
    a.status !== "satisfied" && a.edge.relation === "required" && a.recommendedAction === decision.action);
  if (decision.action === "diagnose") {
    lines.push(
      "",
      "## 下一条回复协议（必须遵守）",
      `- 本轮只诊断前置 ${primary?.prerequisiteConceptId ?? "知识"}，不得讲解或给出原题答案。`,
      "- 只提出一道能观察学生实际表现的问题，不得同时给提示、公式或答案。",
      "- 问完立即停止并等待学生回答；收到回答后再记录学习证据并恢复原题。",
    );
  } else if (decision.action === "teach") {
    lines.push(
      "",
      "## 下一条回复协议（必须遵守）",
      `- 本轮只做前置 ${primary?.prerequisiteConceptId ?? "知识"} 的最短桥接，不得讲完原题。`,
      "- 桥接后只提出一道最小检查题，不得在同一回复中揭示检查题答案。",
      "- 问完立即停止并等待学生回答；验证后再记录学习证据并恢复原题。",
    );
  } else if (decision.action === "repair") {
    lines.push(
      "",
      "## 下一条回复协议（必须遵守）",
      `- 本轮只修复前置误区 ${primary?.prerequisiteConceptId ?? "知识"}，不得给出原题的完整推导、公式或结论。`,
      "- 用一个反例、对比或表征转换暴露误区，然后只提出一道学生必须作答的检查题。",
      "- 学生回答后记录学习证据；如果能定位具体误区，必须同时传 misconception_id。",
      "- 问完立即停止并等待学生回答；验证修复后再恢复原题。",
    );
  }
  return lines.join("\n");
}

export const teachingEntryGateService = { evaluateTeachingEntry, formatTeachingEntryDecision };
