// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// capability-registry-service.ts — Capability 注册表 + 确定性候选生成(V397, 2026-08-30, 借鉴 LingxiLearn)
// 三词汇表分层的第一层落地(渐进版, 不推翻现有架构):
//   意图层: 教育意图(intent) — 由 education-intent-service 分类
//   规划层: Capability 封闭词表 — 本服务定义, 词表外 tag 是硬错误
//   执行层: 服务/工具 — 注册表把 capability 映射到具体实现
// 核心: 确定性候选生成(收益/成本排序) + 模型只能重排不能发明(供 Agent 规划参考)
import { pool } from "../db/pool.js";

// ═══ 封闭 Capability 词表(借鉴 LingxiLearn: 词表外 tag 是硬错误) ═══
export const CAPABILITY_WHITELIST = [
  // 理解学习者
  "model.reflect", "graph.build", "graph.prerequisite", "review.schedule",
  // 生产材料
  "content.lesson", "content.deck", "content.visual", "content.flashcards", "content.quiz",
  // 教学
  "teach.strategy", "teach.explain", "dialog.answer", "dialog.tutor", "dialog.socratic",
  // 评估
  "assess.generate", "assess.grade", "assess.diagnose",
  // 计划与复习
  "plan.create", "plan.replan", "review.due",
] as const;
export type Capability = (typeof CAPABILITY_WHITELIST)[number];
const CAPABILITY_SET = new Set<string>(CAPABILITY_WHITELIST);

/** 词表外 tag 抛错(借鉴 LingxiLearn UnknownCapability) */
export function parseCapability(tag: string): Capability {
  if (!CAPABILITY_SET.has(tag)) throw new Error(`未知能力标签: ${tag}(封闭词表拒绝)`);
  return tag as Capability;
}

// ═══ 注册表(能力 → 实现/成本/前置条件) ═══
export interface CapabilityEntry {
  capability: Capability;
  label: string;
  service: string;          // 提供者(服务文件/工具 action)
  cost: number;             // latency-class 派生(interactive=1/background=2/offline=4)
  learnerFacing: boolean;
  preconditions: string[];  // 状态前置(如 has_deck 时 content.deck 被拒)
}

export const CAPABILITY_REGISTRY: CapabilityEntry[] = [
  // 理解学习者
  { capability: "model.reflect", label: "学习状态反思", service: "education-eval-service", cost: 2, learnerFacing: false, preconditions: [] },
  { capability: "graph.build", label: "知识图谱构建", service: "knowledge-graph-edu", cost: 4, learnerFacing: false, preconditions: [] },
  { capability: "graph.prerequisite", label: "先修检测", service: "knowledge-graph-edu", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "review.schedule", label: "复习调度", service: "spaced-repetition-service", cost: 1, learnerFacing: false, preconditions: [] },
  // 生产材料
  { capability: "content.lesson", label: "概念讲解", service: "component-executor/lesson", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "content.deck", label: "课件生成", service: "component-executor/lesson", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "content.visual", label: "可视化讲解", service: "component-executor/lesson", cost: 4, learnerFacing: true, preconditions: [] },
  { capability: "content.flashcards", label: "回忆卡生成", service: "component-executor/retrieval", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "content.quiz", label: "测验生成", service: "component-executor/assessment", cost: 2, learnerFacing: true, preconditions: [] },
  // 教学
  { capability: "teach.strategy", label: "教学策略决策", service: "education-service/adaptive", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "teach.explain", label: "讲解", service: "education-service/tutoring", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "dialog.answer", label: "问答", service: "education-service/tutoring", cost: 1, learnerFacing: true, preconditions: [] },
  { capability: "dialog.tutor", label: "作业辅导", service: "homework-help-service", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "dialog.socratic", label: "苏格拉底提问", service: "agent-education", cost: 2, learnerFacing: true, preconditions: [] },
  // 评估
  { capability: "assess.generate", label: "出题", service: "component-executor/assessment", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "assess.grade", label: "判分", service: "learning-evidence-service", cost: 1, learnerFacing: false, preconditions: [] },
  { capability: "assess.diagnose", label: "学情诊断", service: "education-service/diagnosis", cost: 2, learnerFacing: true, preconditions: [] },
  // 计划与复习
  { capability: "plan.create", label: "创建学习计划", service: "learning-plan-service", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "plan.replan", label: "重建计划", service: "learning-plan-service", cost: 2, learnerFacing: true, preconditions: [] },
  { capability: "review.due", label: "到期复习", service: "spaced-repetition-service", cost: 1, learnerFacing: true, preconditions: [] },
];

// ═══ 学习者状态(供候选收益评估) ═══
export interface LearnerContext {
  weakPoints: string[];          // 薄弱知识点
  unobservedPoints: string[];    // 未观察知识点
  hasDeck?: boolean;             // 已有课件
  dueReviews?: number;           // 到期复习数
  misconceptions?: string[];     // 误区
}

// ═══ 确定性收益估计(借鉴 LingxiLearn state/gain.py: 纯函数规则打分) ═══
export function estimateGain(capability: Capability, ctx: LearnerContext): number {
  switch (capability) {
    case "teach.explain":
      return ctx.misconceptions?.length ? 0.6 : ctx.weakPoints.length ? 0.45 : 0.2;
    case "content.lesson":
      return ctx.weakPoints.length ? 0.55 : 0.3;
    case "content.flashcards":
    case "review.due":
      return (ctx.dueReviews ?? 0) > 0 ? 0.5 : 0.15;
    case "content.quiz":
    case "assess.generate":
      return ctx.weakPoints.length ? 0.4 : 0.25;
    case "assess.diagnose":
      return ctx.unobservedPoints.length >= 3 ? 0.5 : 0.2;
    case "plan.create":
    case "plan.replan":
      return ctx.weakPoints.length ? 0.35 : 0.2;
    case "graph.prerequisite":
      return ctx.unobservedPoints.length ? 0.3 : 0.1;
    default:
      return 0.2;
  }
}

/** 前置条件检查(状态而非意图): 已有课件时 content.deck 被拒 */
export function preconditionBlocked(entry: CapabilityEntry, ctx: LearnerContext): boolean {
  if (entry.capability === "content.deck" && ctx.hasDeck) return true;
  if (entry.capability === "content.lesson" && !ctx.weakPoints.length && !ctx.unobservedPoints.length) return true;
  return false;
}

// ═══ 确定性候选生成(借鉴 LingxiLearn candidates.generate) ═══
export interface CapabilityCandidate {
  capability: Capability;
  label: string;
  service: string;
  cost: number;
  gain: number;
  utility: number;   // gain / cost
  blocked: boolean;
  blockedReason?: string;
}

export function generateCandidates(ctx: LearnerContext): CapabilityCandidate[] {
  const candidates = CAPABILITY_REGISTRY.map((entry) => {
    const blocked = preconditionBlocked(entry, ctx);
    const gain = blocked ? 0 : estimateGain(entry.capability, ctx);
    return {
      capability: entry.capability,
      label: entry.label,
      service: entry.service,
      cost: entry.cost,
      gain,
      utility: blocked ? -1 : gain / entry.cost,
      blocked,
      blockedReason: blocked ? (entry.capability === "content.deck" ? "已有课件, 无需重复生成" : "无薄弱点或未观察知识点") : undefined,
    };
  });
  // 完全确定性排序(借鉴 LingxiLearn: (-utility, capability, service))
  return candidates.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    if (b.utility !== a.utility) return b.utility - a.utility;
    return a.capability.localeCompare(b.capability);
  });
}

/** 意图 → 推荐 capability(供 Agent/前端规划参考) */
export async function recommendForIntent(input: { intent?: string; subject?: string; studentId?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  // 学习者上下文(从 BKT 画像 + 复习队列)
  let ctx: LearnerContext = { weakPoints: [], unobservedPoints: [], dueReviews: 0 };
  try {
    const { rebuildMastery } = await import("./learning-evidence-service.js");
    const cells = (await rebuildMastery(studentId)).filter((c) => !input.subject || c.subject === input.subject);
    ctx = {
      weakPoints: cells.filter((c) => c.evidence_state === "needs_support" || c.evidence_state === "developing").map((c) => c.knowledge_point),
      unobservedPoints: cells.filter((c) => c.evidence_state === "insufficient_evidence").map((c) => c.knowledge_point),
    };
    const due = await pool.query("select count(*)::int c from review_queue where student_id = $1 and due_at <= now()", [studentId]).catch(() => ({ rows: [{ c: 0 }] }));
    ctx.dueReviews = due.rows[0]?.c ?? 0;
    ctx.hasDeck = !!cells.find((c) => c.verified_observation_count >= 3);
  } catch { /* 画像不可用时用空上下文 */ }

  const candidates = generateCandidates(ctx);
  // 意图过滤: learning_path → 计划类优先; 问答 → dialog 类优先
  const intent = input.intent || "learning_path";
  const top = intent === "conversation"
    ? candidates.filter((c) => c.capability.startsWith("dialog") || c.capability === "teach.explain").slice(0, 3)
    : candidates.filter((c) => !c.blocked).slice(0, 5);

  return {
    ok: true,
    learnerContext: { weakPoints: ctx.weakPoints.slice(0, 5), unobservedPoints: ctx.unobservedPoints.slice(0, 5), dueReviews: ctx.dueReviews },
    top: top.map((c) => ({ capability: c.capability, label: c.label, service: c.service, utility: Number(c.utility.toFixed(3)) })),
    all: candidates.slice(0, 8).map((c) => ({ capability: c.capability, label: c.label, blocked: c.blocked, blockedReason: c.blockedReason, utility: c.blocked ? null : Number(c.utility.toFixed(3)) })),
    note: "候选由确定性规则生成(收益/成本), 模型只能重排不能发明 — 借鉴 LingxiLearn",
  };
}

export const capabilityRegistryService = { parseCapability, generateCandidates, recommendForIntent, CAPABILITY_REGISTRY, CAPABILITY_WHITELIST };
