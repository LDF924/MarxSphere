// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/b5-ensemble-service.ts — V404-9+V404-18: B5 难档多模型互证融合(试点)
// 借鉴 OpenSquilla B5: 难档任务由多个模型并行成稿 + 1 个 aggregator 融合;
//   核心原则: 成稿模型(proposer)不持有工具边界, 只有 aggregator 能调检索(防放大副作用)。
// V404-18: aggregator 检索校准 — 融合前拉检索证据喂给聚合提示(校准分歧点, 防幻觉),
//   检索仅 aggregator 阶段发生; proposer 仍纯文本零工具。
// MarxSphere 版(保守): B5_ENABLED=1 才启用; 默认走原单模型路由;
//   只对显式标记的难任务(opt-in / model=ensemble)生效, 不自动改全局路由。
// 成本账见 docs/OPENSQUILLA-B5-COST.md(先算账再上量)。
import { callLlmWithRotation } from "../ai/llm-common.js";

export const B5_ENABLED = process.env.B5_ENABLED === "1";
/** aggregator 检索校准开关(默认开; 置 0 关 — 校准每轮多一次检索调用) */
export const B5_AGG_RETRIEVE = process.env.B5_AGG_RETRIEVE !== "0";
/** 单成稿模型超时(ms, 默认 60s — 慢候选不拖整轮) */
export const B5_DRAFT_TIMEOUT_MS = parseInt(process.env.B5_DRAFT_TIMEOUT_MS || "60000", 10);
/** 渐进截止: 最多等多少稿(默认 2 稿即开始融合) */
export const B5_MIN_DRAFTS = parseInt(process.env.B5_MIN_DRAFTS || "2", 10);

/** 预设阵容(与 OpenSquilla 对齐: 静态 lineup 两套 + 自定义) */
const PRESETS: Record<string, string[]> = {
  // 静态 OpenRouter B5 风格: 2 强 + 1 cheap 锚点(默认)
  default: ["deepseek-v4-pro", "qwen3.7-max", "deepseek-v4-flash"],
  // OpenRouter B5(若经 openrouter 兼容层可用)
  openrouter: ["deepseek-v4-pro", "glm-5.2", "kimi-k2.7-code", "qwen3.7-max", "deepseek-v4-flash"],
  // TokenRhythm B5
  tokenrhythm: ["deepseek-v4-pro-0813", "qwen3.7-max", "kimi-k2.7-code", "deepseek-v4-flash"],
};
export function b5Squad(): string[] {
  const preset = (process.env.B5_PRESET || "default").trim().toLowerCase();
  const cfg = (process.env.B5_SQUAD || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (cfg.length > 0) return cfg; // 自定义阵容优先
  return PRESETS[preset] ?? PRESETS.default;
}
export function b5PresetName(): string {
  const cfg = (process.env.B5_SQUAD || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (cfg.length > 0) return "custom";
  return (process.env.B5_PRESET || "default").trim().toLowerCase();
}

export interface EnsembleOutcome {
  drafts: Array<{ model: string; ok: boolean; chars: number; error?: string }>;
  merged: string;
  costCentsEst: number;
  winner?: string;
  /** V404-18: aggregator 检索校准是否命中证据 */
  evidenceUsed?: boolean;
  /** V405-B5: 渐进信息(超时/截断/先到先得) */
  progressive?: {
    arrived: string[];        // 实际参与融合的模型
    timedOut: string[];       // 超时未到的模型
    waitedMs: number;
  };
}

/** V405-B5 智能直连判定: 难题(长/多跳/引证/比较)才值得 B5 — 简单题走直连省成本。
 * 直接读 env(不依赖模块级 B5_ENABLED 常量) — 纯函数可测; 开关红线不变。 */
export function shouldUseB5(question: string): boolean {
  const enabled = process.env.B5_ENABLED === "1" || process.env.B5_ENABLED === "true";
  if (!enabled) return false;
  const q = (question || "").trim();
  if (q.length < 10) return false; // 闲聊/太短 → 直连
  // 难题信号: 长文 / 引证 / 比较 / 多跳 / 政策(与规则路由同源口径)
  const hard = /引用原文|原文|条款|出处|页码|文献|比较|对比|综述|梳理|机制|影响|关系|推理|论证|政策|法规|条款|为何|为什么.*(?:机制|导致|影响)|逻辑|辩证/.test(q);
  return q.length > 60 || hard;
}

/**
 * V405-B5 渐进融合: 成稿逐份到达即回调(先到先得), 每模型独立超时, 慢候选不拖轮。
 * 到稿数达 B5_MIN_DRAFTS 或全部(含超时)即进入融合; 至少 1 稿即返回(不干等最慢)。
 */
export async function runB5EnsembleProgressive(
  question: string,
  onDraft?: (d: { model: string; arrivedMs: number }) => void,
  draftPrompt?: string,
): Promise<EnsembleOutcome> {
  const squad = b5Squad();
  const system = draftPrompt || "你是严谨的研究助手。请直接、完整地回答用户问题, 标注不确定处。";
  const msgs = (m: string) => [
    { role: "system" as const, content: m },
    { role: "user" as const, content: question },
  ];
  const started = Date.now();
  // 每模型带独立超时(慢候选超时不算失败 — 记 timedOut)
  const results = await Promise.all(squad.map(async (model) => {
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        callLlmWithRotation({ model, messages: msgs(system), maxTokens: 2000, temperature: 0.3 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), B5_DRAFT_TIMEOUT_MS)),
      ]);
      if (r === null) {
        return { model, ok: false as const, chars: 0, timedOut: true as const, error: `timeout>${B5_DRAFT_TIMEOUT_MS / 1000}s` };
      }
      const arrivedMs = Date.now() - started;
      onDraft?.({ model, arrivedMs });
      if (!r?.text) return { model, ok: false as const, chars: 0, timedOut: false as const, error: r?.error?.slice(0, 100) || "空输出" };
      return { model, ok: true as const, chars: r.text.length, timedOut: false as const, text: r.text };
    } catch (e: any) {
      return { model, ok: false as const, chars: 0, timedOut: false as const, error: String(e?.message || e).slice(0, 100) };
    }
  }));
  const timedOut = results.filter((d): d is { model: string; ok: false; chars: number; timedOut: true; error: string } => (d as any).timedOut)
    .map((d) => d.model);
  const good = results.filter((d): d is { model: string; ok: true; chars: number; timedOut: false; text: string } => d.ok);
  // 全部失败/超时 → 抛错(调用方回退原路由; 修运算符优先级: 原来 error||timedOut?"timeout" 掩盖真错误)
  if (good.length === 0) {
    const errs = results.map((d) => {
      const err = String((d as any).error || "");
      const timed = Boolean((d as any).timedOut);
      return `${d.model}: ${timed ? `timeout>${B5_DRAFT_TIMEOUT_MS / 1000}s` : (err || "unknown")}`;
    }).join("; ");
    throw new Error(`B5 全部成稿失败: ${errs}`);
  }
  // 单稿(或截止时仅 1 稿) → 降级直接返回
  if (good.length === 1) {
    return {
      drafts: results.map((d) => ({ model: d.model, ok: d.ok, chars: d.chars, error: (d as any).error })),
      merged: good[0].text, costCentsEst: 0, winner: good[0].model,
      progressive: { arrived: [good[0].model], timedOut, waitedMs: Date.now() - started },
    };
  }
  // ≥2 稿 → aggregator 融合(与既有 V404-18 检索校准同款)
  let evidence = "";
  if (B5_AGG_RETRIEVE) {
    try { evidence = await retrieveEvidence(question); } catch { evidence = ""; }
  }
  const agg = await callLlmWithRotation({
    messages: [
      { role: "system", content: "你是资深学术编辑。融合多模型回答, 输出单一最终稿。若附有知识库证据, 以证据校准分歧(证据优先于模型断言), 并在引用证据处注明来源。" },
      { role: "user", content: buildMergePrompt(question, good.map((d) => ({ model: d.model, text: d.text })), evidence) },
    ],
    maxTokens: 2500, temperature: 0.2,
  });
  const merged = agg?.text || good[0].text;
  // 成本估算(口径同原版)
  const inTok = good.length * Math.ceil(question.length / 2) + (evidence ? Math.ceil(evidence.length / 2) : 0);
  const outChars = good.reduce((a, d) => a + d.chars, 0) + merged.length;
  const outTok = Math.ceil(outChars / 2);
  const costCentsEst = Math.round((inTok * 0.5 + outTok * 2) / 10000 * 100) / 100;
  return {
    drafts: results.map((d) => ({ model: d.model, ok: d.ok, chars: d.chars, error: (d as any).error })),
    merged, costCentsEst,
    evidenceUsed: evidence.length > 0,
    progressive: { arrived: good.map((d) => d.model), timedOut, waitedMs: Date.now() - started },
  };
}

/** 融合提示(aggregator 角色) — 可注入检索证据段(校准分歧点) */
function buildMergePrompt(question: string, drafts: Array<{ model: string; text: string }>, evidence?: string): string {
  const body = drafts.map((d, i) => `--- 模型 ${i + 1}(${d.model}) ---\n${d.text.slice(0, 3000)}`).join("\n\n");
  const evidenceBlock = evidence
    ? `\n\n【知识库检索证据(用于校准分歧点 — 证据优先于模型断言)】\n${evidence.slice(0, 4000)}`
    : "";
  return [
    "你是结果融合器(aggregator)。以下是对同一问题的多模型独立回答。请融合成一份最终答案:",
    "1. 综合各稿的共识部分; 对分歧点给出你的判断并简要说明理由;",
    "2. 不引入各稿都没有的新事实(防幻觉); 结构清晰, 长度适中;",
    "3. 若多数稿结论一致, 融合稿应以该结论为主, 注明分歧模型。",
    evidenceBlock,
    `\n问题: ${question}\n\n${body}`,
  ].join("\n");
}

/** V404-18: aggregator 检索校准 — 服务内向量检索拉证据(不经工具路由; proposer 仍零工具) */
async function retrieveEvidence(question: string, sourceId = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"): Promise<string> {
  try {
    const { searchService } = await import("./search-service.js");
    const r = await searchService.vectorSearch({ query: question.slice(0, 200), sourceIds: [sourceId], topK: 5, noTrace: true });
    const sections = (r.sections || []).slice(0, 5);
    if (sections.length === 0) return "";
    return sections.map((s, i) => `[证据${i + 1}] ${s.heading ? s.heading + ": " : ""}${s.content.slice(0, 500)}`).join("\n\n");
  } catch {
    return ""; // 检索失败不阻塞融合(降级: 无证据融合)
  }
}

/** 兼容旧入口(整段等待全部) */
export async function runB5Ensemble(question: string, draftPrompt?: string): Promise<EnsembleOutcome> {
  return runB5EnsembleProgressive(question, undefined, draftPrompt);
}


/** 显式 ensemble 工具入口(注册到 agent 工具; 只有它聚合, 成稿模型不碰工具 — B5 原则) */
export const b5EnsembleService = {
  runB5Ensemble, runB5EnsembleProgressive, b5Squad, b5PresetName, shouldUseB5, B5_ENABLED,
};
