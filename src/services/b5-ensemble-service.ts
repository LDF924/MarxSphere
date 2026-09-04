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

/** 参与阵容: 按 provider 可用性配置(可 env 覆盖: B5_SQUAD="m1,m2,m3") */
const DEFAULT_SQUAD = ["deepseek-v4-pro", "qwen3.7-max", "deepseek-v4-flash"];
export function b5Squad(): string[] {
  const cfg = (process.env.B5_SQUAD || "").split(",").map((s) => s.trim()).filter(Boolean);
  return cfg.length > 0 ? cfg : DEFAULT_SQUAD;
}

export interface EnsembleOutcome {
  drafts: Array<{ model: string; ok: boolean; chars: number; error?: string }>;
  merged: string;
  costCentsEst: number;
  winner?: string;
  /** V404-18: aggregator 检索校准是否命中证据 */
  evidenceUsed?: boolean;
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

/**
 * B5 融合调用: N 模型并行成稿(共享输入, 独立输出) → aggregator 融合
 * @param question 用户问题/任务目标
 * @param draftPrompt 给成稿模型的完整提示(不含问题本身, 由内部拼接; 或直接用 question 短答)
 * @returns 融合结果; 任意单模型成功也可返回其稿(降级链)
 */
export async function runB5Ensemble(question: string, draftPrompt?: string): Promise<EnsembleOutcome> {
  const squad = b5Squad();
  const system = draftPrompt || "你是严谨的研究助手。请直接、完整地回答用户问题, 标注不确定处。";
  const msgs = (m: string) => [
    { role: "system" as const, content: m },
    { role: "user" as const, content: question },
  ];
  const drafts = await Promise.all(squad.map(async (model) => {
    try {
      const r = await callLlmWithRotation({ model, messages: msgs(system), maxTokens: 2000, temperature: 0.3 });
      if (!r?.text) return { model, ok: false as const, chars: 0, error: r?.error?.slice(0, 100) || "空输出" };
      return { model, ok: true as const, chars: r.text.length, text: r.text };
    } catch (e: any) {
      return { model, ok: false as const, chars: 0, error: String(e?.message || e).slice(0, 100) };
    }
  }));
  const good = drafts.filter((d): d is { model: string; ok: true; chars: number; text: string } => d.ok);
  // 全部失败 → 抛错(调用方回退原路由)
  if (good.length === 0) {
    const errs = drafts.map((d) => `${d.model}: ${d.error}`).join("; ");
    throw new Error(`B5 全部成稿失败: ${errs}`);
  }
  // 单模型成功 → 降级: 直接返回(不做融合, 省成本)
  if (good.length === 1) {
    return {
      drafts: drafts.map((d) => ({ model: d.model, ok: d.ok, chars: d.chars, error: (d as any).error })),
      merged: good[0].text, costCentsEst: 0, winner: good[0].model,
    };
  }
  // ≥2 稿 → aggregator 融合(aggregator 用标准模型即可)
  // V404-18: 融合前拉检索证据(校准分歧点; 检索仅在 aggregator 阶段, proposer 仍零工具)
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
  // 成本估算(¥/1M tok: 输入 0.5, 输出 2 — 与 llm-common 同口径; 单位: 分)
  // 成稿 N 份共享输入提示; 输出按各稿字符粗估(中英混合 ≈ 1.5-2 字/tok, 取 2)
  const inTok = good.length * Math.ceil(question.length / 2) + (evidence ? Math.ceil(evidence.length / 2) : 0);
  const outChars = good.reduce((a, d) => a + d.chars, 0) + merged.length;
  const outTok = Math.ceil(outChars / 2);
  const costCentsEst = Math.round((inTok * 0.5 + outTok * 2) / 10000 * 100) / 100;
  return {
    drafts: drafts.map((d) => ({ model: d.model, ok: d.ok, chars: d.chars, error: (d as any).error })),
    merged, costCentsEst,
    evidenceUsed: evidence.length > 0, // V404-18: aggregator 检索校准是否命中
  };
}

/** 显式 ensemble 工具入口(注册到 agent 工具; 只有它聚合, 成稿模型不碰工具 — B5 原则) */
export const b5EnsembleService = { runB5Ensemble, b5Squad, B5_ENABLED };
