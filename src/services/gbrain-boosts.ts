// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// gbrain-boosts.ts — 从 GBrain 源码移植的检索增强纯函数（MIT License）
// 移植来源: gbrain search hybrid (v0.43)
// 已适配我们的类型（EventRecord / SearchSection），保持 GBrain 算法语义
//
// ⚠️ 马理论/哲社科适配说明：
// - GBrain 的 boost 系数（backlink 0.05 / recency 半衰期 365d / chronicle 1.4/1.3/0.8）
//   是在 YC 创投语料上调参的；我们对哲社科语料保留算法、系数中性可调
// - recency 半衰期对政策文献偏长（老政策仍重要）——keep 365d 保守默认
// - chronicle 的 daily 0.8 在哲社科语料几乎不触发（无日常笔记），academic/policy 是主力
//
// 包含: rrfFusionWeighted（intent 调 k）· cosineReScore · backlink/salience/recency/title/chronicle boost · floor gate

export const RRF_K = 60;
export const COMPILED_TRUTH_BOOST = 2.0;
export const BACKLINK_BOOST_COEF = 0.05;

// ─── ① RRF 加权融合（GBrain rrfFusionWeighted，intent 调 k）───
// 每臂独立 k：意图可降低 keyword 的 k（提升其贡献）或抬高 vector 的 k
export interface RrfWeightedArm<T> {
  list: T[];
  k: number;
  keyOf: (item: T) => string;
}

export function rrfFusionWeighted<T>(
  arms: Array<{ list: T[]; k: number; keyOf: (item: T) => string; compiledTruth?: (item: T) => boolean }>,
  applyCompiledTruthBoost = true,
): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>();

  for (const arm of arms) {
    for (let rank = 0; rank < arm.list.length; rank++) {
      const item = arm.list[rank];
      const key = arm.keyOf(item);
      const rrfScore = 1 / (arm.k + rank);
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { item, score: rrfScore });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  const maxScore = Math.max(...entries.map((e) => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      if (applyCompiledTruthBoost) {
        for (const arm of arms) {
          if (arm.compiledTruth?.(e.item)) {
            e.score *= COMPILED_TRUTH_BOOST;
            break;
          }
        }
      }
    }
  }

  return entries.sort((a, b) => b.score - a.score);
}

// ─── ② Cosine 重打分（GBrain cosineReScore，RRF 后混合）───
// blended = 0.7 * normRrf + 0.3 * cosine（与 GBrain 一致）
export function cosineReScore<T>(
  results: Array<{ item: T; score: number }>,
  embeddings: Map<string, number[]>,
  queryVector: number[],
  keyOf: (item: T) => string,
): Array<{ item: T; score: number }> {
  if (embeddings.size === 0) return results;
  const maxRrf = Math.max(...results.map((r) => r.score));
  return results
    .map((r) => {
      const emb = embeddings.get(keyOf(r.item));
      if (!emb) return r;
      const cosine = cosineSimilarity(queryVector, emb);
      const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
      return { item: r.item, score: 0.7 * normRrf + 0.3 * cosine };
    })
    .sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── ③ Boost 链（GBrain runPostFusionStages 五件套）───

// floor gate：低于 topScore * floorRatio 的结果不参与 boost（防止长尾跳票）
export function computeFloorThreshold(scores: number[], floorRatio?: number): number {
  if (floorRatio === undefined || !Number.isFinite(floorRatio) || floorRatio < 0 || floorRatio > 1) {
    return Number.NEGATIVE_INFINITY;
  }
  let top = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (Number.isFinite(s) && s > top) top = s;
  }
  if (!Number.isFinite(top) || top <= 0) return Number.NEGATIVE_INFINITY;
  return top * floorRatio;
}

export interface BoostableScore<T> {
  item: T;
  score: number;
}

export function applyBacklinkBoost<T>(
  results: BoostableScore<T>[],
  countsByKey: Map<string, number>,
  keyOf: (item: T) => string,
  floorThreshold = Number.NEGATIVE_INFINITY,
): void {
  for (const r of results) {
    if (!Number.isFinite(r.score) || r.score < floorThreshold) continue;
    const count = countsByKey.get(keyOf(r.item)) ?? 0;
    if (count > 0) {
      r.score *= 1.0 + BACKLINK_BOOST_COEF * Math.log(1 + count);
    }
  }
}

export function applySalienceBoost<T>(
  results: BoostableScore<T>[],
  scoresByKey: Map<string, number>,
  keyOf: (item: T) => string,
  strength: "on" | "strong" = "on",
  floorThreshold = Number.NEGATIVE_INFINITY,
): void {
  const k = strength === "strong" ? 0.30 : 0.15;
  for (const r of results) {
    if (!Number.isFinite(r.score) || r.score < floorThreshold) continue;
    const score = scoresByKey.get(keyOf(r.item));
    if (!score || score <= 0) continue;
    r.score *= 1.0 + k * Math.log(1 + score);
  }
}

export function applyRecencyBoost<T>(
  results: BoostableScore<T>[],
  datesByKey: Map<string, Date>,
  keyOf: (item: T) => string,
  strength: "on" | "strong" = "on",
  floorThreshold = Number.NEGATIVE_INFINITY,
  nowMs = Date.now(),
): void {
  const strengthMul = strength === "strong" ? 1.5 : 1.0;
  for (const r of results) {
    if (!Number.isFinite(r.score) || r.score < floorThreshold) continue;
    const d = datesByKey.get(keyOf(r.item));
    if (!d) continue;
    const daysOld = Math.max(0, (nowMs - d.getTime()) / 86_400_000);
    // 半衰期 365 天，系数 0.2（对应 GBrain recency-decay 的默认值）
    const halflifeDays = 365;
    const coefficient = 0.2;
    const recencyComponent = (coefficient * halflifeDays) / (halflifeDays + daysOld);
    r.score *= 1.0 + strengthMul * recencyComponent;
  }
}

export function applyTitleBoost<T>(
  results: BoostableScore<T>[],
  query: string,
  keyOf: (item: T) => string,
  titleOf: (item: T) => string,
  factor = 1.25,
  floorThreshold = Number.NEGATIVE_INFINITY,
): void {
  if (!query || !Number.isFinite(factor) || factor <= 1.0) return;
  const q = query.trim();
  if (!q) return;
  for (const r of results) {
    if (!Number.isFinite(r.score) || r.score < floorThreshold) continue;
    const title = titleOf(r.item) ?? "";
    // 查询词是标题的连续子串（或标题包含查询词）→ 精确名命中
    if (title.includes(q) || q.includes(title)) {
      r.score *= factor;
    }
  }
}

export function applyChronicleTypeBoost<T>(
  results: BoostableScore<T>[],
  typeOf: (item: T) => string | undefined,
  factors: Record<string, number> = { academic: 1.4, policy: 1.3, daily: 0.8 },
  floorThreshold = Number.NEGATIVE_INFINITY,
): void {
  for (const r of results) {
    if (!Number.isFinite(r.score) || r.score < floorThreshold) continue;
    const t = typeOf(r.item);
    if (!t) continue;
    const factor = factors[t];
    if (factor) r.score *= factor;
  }
}

// ─── ④ Alias hop（GBrain applyAliasHop 简化移植）───
// 查询词完全匹配实体别名时，把权威实体的事件加入候选（提升命名实体命中）
export function aliasHop(
  query: string,
  aliasDict: Record<string, string>,
  candidates: Array<{ name: string; score: number }>,
  boost = 1.5,
): Array<{ name: string; score: number }> {
  const qNorm = query.trim();
  if (!qNorm || Object.keys(aliasDict).length === 0) return candidates;
  const result = [...candidates];
  // 查询词是某别名 → 权威名提升
  for (const [alias, canonical] of Object.entries(aliasDict)) {
    if (qNorm === alias || qNorm.includes(alias)) {
      const existing = result.find((c) => c.name === canonical);
      if (existing) {
        existing.score *= boost;
      } else {
        result.push({ name: canonical, score: boost });
      }
      break;
    }
  }
  return result;
}

// ─── ⑤ Dedup（GBrain dedupResults 简化移植 + Jaccard 层）───
// 4 路去重：同 id + 同标题 + 内容前缀 + Jaccard 相似度（修复⑤：防同标题事件误杀）
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/[\s，。、；：！？,.!?;:]+/).filter(Boolean));
  const setB = new Set(b.split(/[\s，。、；：！？,.!?;:]+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function dedupResults<T>(
  results: Array<{ item: T; score: number }>,
  keyOf: (item: T) => string,
  titleOf: (item: T) => string,
  contentOf: (item: T) => string,
): Array<{ item: T; score: number }> {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const seenContent = new Set<string>();
  const seenJaccard: Array<{ content: string; title: string }> = [];
  const out: Array<{ item: T; score: number }> = [];
  for (const r of results) {
    const id = keyOf(r.item);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const title = titleOf(r.item);
    const content = contentOf(r.item) || "";
    // 同标题去重（仅当内容也高度相似时——防同标题不同内容误杀，修复⑤）
    if (title) {
      const similarTitle = seenTitles.has(title);
      if (similarTitle) {
        const similarContent = seenJaccard.some((s) => jaccardSimilarity(s.content, content) >= 0.7);
        if (similarContent) continue; // 同标题 + 内容相似 → 真重复
      }
      seenTitles.add(title);
    }
    const contentPrefix = content.substring(0, 120).replace(/\s+/g, "");
    if (contentPrefix && seenContent.has(contentPrefix)) continue;
    if (contentPrefix) seenContent.add(contentPrefix);
    // Jaccard 层（GBrain 阈值 0.85 → 我们用 0.7 适配中文长文）
    if (content.length > 200) {
      const dup = seenJaccard.some((s) => jaccardSimilarity(s.content, content) >= 0.7);
      if (dup) continue;
      seenJaccard.push({ content, title });
    }
    out.push(r);
  }
  return out;
}

// ─── ⑥ Intent 分类器（GBrain query-intent 移植 + 中文适配）───
// GBrain 只有英文模式；我们补中文模式——「他没有的我们也有」
export type QueryIntent = "entity" | "temporal" | "event" | "general";

export interface QuerySuggestions {
  intent: QueryIntent;
  suggestedDetail: "low" | "medium" | "high" | undefined;
  suggestedRecency: "off" | "on" | "strong";
  suggestedSalience: "off" | "on" | "strong";
}

// 中文意图模式（GBrain 英文模式的对应 + 马理论/哲社科适配）
const CN_TEMPORAL_PATTERNS = [/什么时候|何时|最近|历史|时间线|最新的|多久|年份|年间|以来/];
const CN_EVENT_PATTERNS = [/宣布|发布|推出|融资|收购|合并|新闻|发生了什么|会议|召开|出台|印发|实施/];
const CN_ENTITY_PATTERNS = [/是谁|什么是|是什么|介绍一下|描述|概述|背景|简介|了解|理论|概念|内涵|本质|特征/];
const CN_CANONICAL_PATTERNS = [/是什么|什么是|定义|解释|概念|概述|介绍|内涵|本质/];
const CN_RECENCY_ON_PATTERNS = [/最新|最近|当前|本周|上个月|近况|进展|更新|新出台|新政策/];
const CN_SALIENCE_ON_PATTERNS = [/重要|关键|核心|重点|什么最重要|值得关注|根本|首要/];
const CN_STRONG_RECENCY_PATTERNS = [/今天|现在|刚刚|马上/];

// 英文模式（GBrain 原版）
const EN_TEMPORAL_PATTERNS = [/\bwhen\b/i, /\blast\s+(week|month|year)\b/i, /\brecent(ly)?\b/i, /\btimeline\b/i, /\blatest\b/i];
const EN_EVENT_PATTERNS = [/\bannounce[ds]?(ment)?\b/i, /\blaunch(ed|es|ing)?\b/i, /\bfund(ing|raise)\b/i, /\bIPO\b/i, /\bacquisition\b/i, /\bmerge[drs]?\b/i, /\bnews\b/i];
const EN_ENTITY_PATTERNS = [/\bwho\s+is\b/i, /\bwhat\s+(is|does|are)\b/i, /\btell\s+me\s+about\b/i, /\bdescribe\b/i, /\boverview\b/i, /\bprofile\b/i];
const EN_CANONICAL_PATTERNS = [/\bwho\s+is\b/i, /\bwhat\s+(is|are|does|means?)\b/i, /\bdefin(e|ition|ing)\b/i, /\bconcept\s+of\b/i, /\boverview\s+of\b/i];
const EN_RECENCY_ON_PATTERNS = [/\blatest\b/i, /\brecent(ly)?\b/i, /\bcurrent(ly)?\b/i, /\b(this|last)\s+(week|month)\b/i, /\bupdate(s)?\s+(on|from)\b/i];
const EN_STRONG_RECENCY_PATTERNS = [/\btoday\b/i, /\bright\s+now\b/i, /\bjust\s+now\b/i];
const EN_SALIENCE_ON_PATTERNS = [/\bwhat\s+matters\b/i, /\bwhat'?s\s+important\b/i, /\b(update|status|progress)\s+(on|with|from)\b/i];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/** 意图分类（中文优先，英文兜底）— 驱动 RRF k 调权 + boost 链 */
export function classifyQueryIntent(query: string): QuerySuggestions {
  const isCn = /[一-鿿]/.test(query);
  const temporal = isCn ? CN_TEMPORAL_PATTERNS : EN_TEMPORAL_PATTERNS;
  const event = isCn ? CN_EVENT_PATTERNS : EN_EVENT_PATTERNS;
  const entity = isCn ? CN_ENTITY_PATTERNS : EN_ENTITY_PATTERNS;
  const canonical = isCn ? CN_CANONICAL_PATTERNS : EN_CANONICAL_PATTERNS;
  const recencyOn = isCn ? CN_RECENCY_ON_PATTERNS : EN_RECENCY_ON_PATTERNS;
  const strongRecency = isCn ? CN_STRONG_RECENCY_PATTERNS : EN_STRONG_RECENCY_PATTERNS;
  const salienceOn = isCn ? CN_SALIENCE_ON_PATTERNS : EN_SALIENCE_ON_PATTERNS;

  let intent: QueryIntent = "general";
  if (matchesAny(temporal, query)) intent = "temporal";
  else if (matchesAny(event, query)) intent = "event";
  else if (matchesAny(entity, query)) intent = "entity";

  const suggestedDetail: "low" | "medium" | "high" | undefined =
    intent === "entity" ? "low" : intent === "temporal" || intent === "event" ? "high" : undefined;

  const hasCanonical = matchesAny(canonical, query);
  const hasStrongRecency = matchesAny(strongRecency, query);
  const hasRecencyOn = matchesAny(recencyOn, query);

  let suggestedRecency: "off" | "on" | "strong";
  if (hasCanonical && !hasStrongRecency && !hasRecencyOn) suggestedRecency = "off";
  else if (hasStrongRecency) suggestedRecency = "strong";
  else if (hasRecencyOn) suggestedRecency = "on";
  else suggestedRecency = "off";

  const suggestedSalience: "off" | "on" = matchesAny(salienceOn, query) && !hasCanonical ? "on" : "off";

  return { intent, suggestedDetail, suggestedRecency, suggestedSalience };
}

/** 意图 → RRF k 调权（GBrain intent-weights）：entity/event 意图降低 keyword k */
export function effectiveRrfK(baseK: number, intent: QueryIntent, arm: "keyword" | "vector"): number {
  if (intent === "entity" || intent === "event") {
    // 实体/事件意图：词法臂权重上调（k 降低）
    return arm === "keyword" ? Math.max(20, Math.round(baseK * 0.6)) : baseK;
  }
  if (intent === "temporal") {
    return arm === "keyword" ? Math.round(baseK * 0.8) : baseK;
  }
  return baseK;
}
