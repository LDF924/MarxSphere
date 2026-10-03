// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// claim-ledger-service.ts — 论断台账 + 跨源冲突检测(2026-10-03)
//
// ⚠ **源码移植**自开源项目 观澜/Guanlan(MIT, https://github.com/shenyangs/Guanlan)
//   的 `guanlan/claim_ledger.py`(逐函数转 TypeScript: `_extract_claims` / `_claim_record` /
//   `_build_conflict_sets` / `_attach_conflict_sets` / `_claim_confidence` /
//   `_normalize_value` / `_normalized_key` / `_claim_id` / `_subject` / `_date_from_item`)。
//   见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 它解决什么问题 ═══
//   我们已经有网页归档(快照 + 段落偏移), 但只能回答"这页写了什么"。
//   研究者真正会卡住的地方是: **同一个数字, 几份材料说法不一样** ——
//   政策文件写补贴 30%, 新闻报道写 50%; 参数表写 1M 上下文, 评测文写 128K。
//   手工核对要来回翻。这个台账把那类**可核对的具体值**(价格/百分比/参数量/模型版本/日期)
//   逐条抽出来, 按"同类同主体"归拢, 值不一致且来源不同 → 标成一个冲突集。
//
// ═══ 三条不可越界的口径(原文写得很清楚, 照搬) ═══
//   ① **它不判断真假** —— 只报"这里有个需要人看一眼的分歧"。冲突 ≠ 有人错。
//   ② **不做网络与排序决策** —— 纯函数, 输入是已读到的正文。
//   ③ 冲突的最低条件是**来源 URL 至少两个** —— 同一篇文章里前后不一致是另一回事。

/** 一条被抽出来的论断候选 */
export interface Claim {
  claimId: string;
  category: ClaimCategory;
  /** 归一化后的可读值(如 `30%` / `¥99` / `2026-09`) */
  value: string;
  /** 用于比较的键(去空格、大小写等) */
  normalizedValue: string;
  /** 主体 —— 取标题, 让"谁说的"一眼可见 */
  subject: string;
  sourceTitle: string;
  url: string;
  domain: string;
  /** 来源在证据体系里的角色(政务/党央媒/学术/社区…), 决定置信度 */
  evidenceRole: string;
  date: string;
  /** 0.05-0.95 —— **不是"真假概率"**, 是"这类来源说这个值通常有多可靠" */
  confidence: number;
  /** 所属冲突集 id(不在任何冲突里就是空串) */
  conflictSet: string;
}

export type ClaimCategory =
  | "model_version" | "price" | "parameter_count" | "percentage_metric" | "date";

export interface ConflictSet {
  conflictSet: string;
  category: ClaimCategory;
  /** 各来源给出的不同值 —— 缺哪个都可能只是没提, 不代表反对 */
  values: string[];
  claimIds: string[];
  sources: Array<{ claimId: string; value: string; sourceTitle: string; url: string; date: string; evidenceRole: string; confidence: number }>;
  severity: "needs_review";
}

/**
 * 可核对的模式 —— **移植时把英文语境改成了中文社科语境**。
 *
 * 原文的 `model_version` 认的是 `GPT|Claude|GLM|Qwen|Gemini|DeepSeek` 这类大模型名。
 * 我们的用户是人文社科研究者, 真正的痛点不是模型版本, 而是**政策/统计数字**:
 *   "补贴标准 30%"、"覆盖面 85%"、"投入 2.3 亿元"、"2026 年 3 月实施"。
 *   所以这里**保留原类别名**(便于与上游对照), 但把正则换成两类都认 ——
 *   模型版本对技术向用户仍有用, 政策数字才是这一平台的主场景。
 */
const CLAIM_PATTERNS: Array<[ClaimCategory, RegExp]> = [
  ["model_version",
    /\b(?:GPT|Claude|GLM|Qwen|Gemini|DeepSeek)[-\s]?[A-Za-z]*(?:\s+)?\d+(?:\.\d+)?\b/gi],
  ["price",
    /(?:[$¥￥]\s?\d+(?:\.\d+)?(?:\s*(?:\/|per|每)\s*(?:1m|million|百万|千|k|tokens?|token))?|(?:\d+(?:\.\d+)?\s*(?:元|美元|人民币)(?:\s*(?:\/|每)\s*(?:百万|千|tokens?|token|次))?))/gi],
  ["parameter_count",
    /(?:\b\d+(?:\.\d+)?\s*(?:B|M|K|T)\s*(?:parameters?|params?)?\b|\d+(?:\.\d+)?\s*(?:万亿|千亿|百亿|亿|万)\s*(?:参数|人|户|亩|吨|平方米|公里|个县|个村)?)/gi],
  ["percentage_metric", /\d+(?:\.\d+)?\s?%/g],
  /**
   * ⚠ 日期这条正则**改过**(2026-10-03 实测):
   *   照搬原文的 `\b20\d{2}[-/.年]\d{1,2}` 之后, 中文写法「2026 年 3 月」**一条都抽不到** ——
   *   因为中文习惯在数字与"年"之间**留一个空格**, 而原文那条要求紧邻。
   *   这不是"排版不规整", 是中文的常见写法(政策文件、新闻稿都这么写)。
   *   所以分隔符前补 `\s?`; `\b` 也去掉 —— 它对中文没有意义(中文全是非 `\w` 字符),
   *   留着只会让边界判定变成碰运气。
   */
  ["date", /20\d{2}\s?[-/.年]\s?\d{1,2}(?:\s?[-/.月]\s?\d{1,2}\s?日?)?/g],
];

/** 只有这几类才做冲突检测 —— 日期不一致往往是"不同时间发的", 不是冲突 */
const CONFLICT_CATEGORIES = new Set<ClaimCategory>(["model_version", "price", "parameter_count", "percentage_metric"]);

/** 来源角色 → 置信度。三档的划分与原文一致(强/中/样本)。 */
const STRONG_ROLES = new Set([
  "official_primary", "company_primary", "technical_primary", "vendor_patch",
  "regulator_notice", "database_official", "publisher_guideline", "market_quote", "company_filing",
]);
const MEDIUM_ROLES = new Set([
  "authoritative_report", "industry_report", "vertical_report", "technical_note",
  "developer_discussion", "research_primary", "preprint_record",
]);
const SAMPLE_ROLES = new Set([
  "user_sample", "community_discussion", "public_discussion", "social_signal",
  "sentiment_sample", "user_visible_sample",
]);

function collapseWs(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * 置信度(移植 `_claim_confidence`)。
 * ⚠ 名字容易误读: 它**不是"这句话为真的概率"**, 而是"这类来源给出这类值时通常有多可信"。
 *   政务/一手资料 0.82 起, 社区样本 0.38 起, 读过全文的 +0.05。
 */
function claimConfidence(evidenceRole: string, sourceType: string, evidenceKind: string): number {
  const role = collapseWs(evidenceRole);
  const source = collapseWs(sourceType);
  let base: number;
  if (STRONG_ROLES.has(role)) base = 0.82;
  else if (MEDIUM_ROLES.has(role)) base = 0.62;
  else if (SAMPLE_ROLES.has(role)) base = 0.38;
  else if (source.includes("官方") || source.includes("政府")) base = 0.78;
  else if (source.includes("媒体") || source.includes("产业")) base = 0.55;
  else if (source.includes("社交") || source.includes("社区")) base = 0.36;
  else base = 0.46;
  if (evidenceKind === "read") base += 0.05;
  return Math.round(Math.min(Math.max(base, 0.05), 0.95) * 100) / 100;
}

/** 值归一(移植 `_normalize_value`): 全角￥→¥、去斜杠两侧空格、日期统一成 YYYY-MM[-DD] */
function normalizeValue(category: ClaimCategory, value: string): string {
  let n = collapseWs(value).replace(/￥/g, "¥");
  n = n.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
  if (category === "date") {
    // ⚠ 先把中文数字与单位之间的空格去掉再替换 —— 中文写作习惯是「2026 年 3 月」,
    //   而正则为了让这种写法能被命中, 分隔符前后允许了空格。不先收掉的话会归一成
    //   `2026 - 3`(实测), 与「2026年3月」判成两个不同的值, 冲突检测就失效了。
    n = n.replace(/\s*([-/.])\s*/g, "$1").replace(/\s*([年月日])\s*/g, "$1");
    n = n.replace(/年/g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/[/.]/g, "-");
    const parts = n.split("-").filter(Boolean);
    if (parts.length >= 2 && parts.slice(0, 2).every((p) => /^\d+$/.test(p))) {
      const year = parts[0];
      const month = parts[1].padStart(2, "0");
      const day = parts.length >= 3 && /^\d+$/.test(parts[2]) ? parts[2].padStart(2, "0") : "";
      return [year, month, day].filter(Boolean).join("-");
    }
  }
  return n;
}

/** 比较键(移植 `_normalized_key`) */
function normalizedKey(category: ClaimCategory, value: string): string {
  const v = normalizeValue(category, value);
  if (category === "model_version" || category === "parameter_count") return v.replace(/\s+/g, "").toLowerCase();
  if (category === "price") return v.replace(/\s+/g, "").toLowerCase();
  if (category === "percentage_metric") return v.replace(/\s+/g, "");
  return v.toLowerCase();
}

/** 从正文抽论断候选(移植 `_extract_claims`) —— 同一篇里同类同值只留一条 */
function extractClaims(text: string): Array<{ category: ClaimCategory; value: string; normalizedValue: string }> {
  const out: Array<{ category: ClaimCategory; value: string; normalizedValue: string }> = [];
  const seen = new Set<string>();
  for (const [category, pattern] of CLAIM_PATTERNS) {
    // ⚠ 正则带 `g` 标志时 `lastIndex` 会跨调用保留 —— 必须每次新建, 否则第二轮起会跳着匹配
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of String(text ?? "").matchAll(re)) {
      const raw = collapseWs(m[0]);
      const value = normalizeValue(category, raw);
      if (!value) continue;
      const key = `${category}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ category, value, normalizedValue: normalizedKey(category, value) });
    }
  }
  return out;
}

export interface LedgerInput {
  /** 已读到的正文(归档快照的 markdown / 检索到的摘要) */
  text: string;
  url: string;
  title: string;
  /** 来源在证据体系里的角色(与舆情源的 evidenceRole 同一套值) */
  evidenceRole?: string;
  sourceType?: string;
  /** read = 读了全文; search = 只有检索摘要 */
  evidenceKind?: string;
  /** 条目自身带的日期(发布时间) */
  date?: string;
}

/**
 * 建论断台账 + 冲突集(移植 `build_claim_ledger` + `_build_conflict_sets`)。
 *
 * ⚠ 冲突的最低条件是**来源 URL ≥ 2 个**: 同一篇文章里前后数值不一致, 属于文章自己的问题,
 *   不是"跨源分歧" —— 混在一起会让冲突集会满是无意义的噪声。
 */
export function buildClaimLedger(items: LedgerInput[], opts: { limit?: number } = {}): {
  claims: Claim[];
  conflictSets: ConflictSet[];
  byCategory: Record<string, number>;
} {
  const limit = Math.max(opts.limit ?? 48, 1);
  const claims: Claim[] = [];
  for (const it of items) {
    const url = String(it.url ?? "");
    const domain = domainOf(url);
    const role = String(it.evidenceRole ?? "");
    const sourceType = String(it.sourceType ?? "");
    const kind = String(it.evidenceKind ?? "search");
    const confidence = claimConfidence(role, sourceType, kind);
    const subject = collapseWs(it.title || domain || "未标注来源");
    for (const ex of extractClaims(it.text)) {
      const ordinal = claims.length + 1;
      const claimId = `CLM-${String(ordinal).padStart(3, "0")}-${stableSuffix(url, ex.category, ex.normalizedValue, ordinal)}`;
      claims.push({
        claimId, category: ex.category, value: ex.value, normalizedValue: ex.normalizedValue,
        subject, sourceTitle: collapseWs(it.title || ""), url, domain,
        evidenceRole: role, date: collapseWs(it.date ?? ""),
        confidence, conflictSet: "",
      });
      if (claims.length >= limit) break;
    }
    if (claims.length >= limit) break;
  }

  // ── 冲突集 ──
  const byCategory = new Map<ClaimCategory, Map<string, Claim[]>>();
  for (const c of claims) {
    if (!CONFLICT_CATEGORIES.has(c.category) || !c.normalizedValue) continue;
    const m = byCategory.get(c.category) ?? new Map<string, Claim[]>();
    const arr = m.get(c.normalizedValue) ?? [];
    arr.push(c);
    m.set(c.normalizedValue, arr);
    byCategory.set(c.category, m);
  }
  const conflictSets: ConflictSet[] = [];
  for (const [category, values] of byCategory) {
    if (values.size < 2) continue;
    const urls = new Set<string>();
    for (const group of values.values()) for (const c of group) if (c.url) urls.add(c.url);
    if (urls.size < 2) continue;
    const id = `CLF-${String(conflictSets.length + 1).padStart(3, "0")}`;
    const sources: ConflictSet["sources"] = [];
    for (const [value, group] of [...values.entries()].slice(0, 8)) {
      for (const c of group.slice(0, 2)) {
        sources.push({
          claimId: c.claimId, value, sourceTitle: c.sourceTitle, url: c.url,
          date: c.date, evidenceRole: c.evidenceRole, confidence: c.confidence,
        });
      }
    }
    conflictSets.push({
      conflictSet: id, category,
      values: [...values.values()].map((g) => g[0]?.value).filter(Boolean) as string[],
      claimIds: [...values.values()].flat().map((c) => c.claimId),
      sources, severity: "needs_review",
    });
  }
  // 回填归属
  const toConflict = new Map<string, string>();
  for (const cs of conflictSets) for (const id of cs.claimIds) toConflict.set(id, cs.conflictSet);
  for (const c of claims) c.conflictSet = toConflict.get(c.claimId) ?? "";

  const counts: Record<string, number> = {};
  for (const c of claims) counts[c.category] = (counts[c.category] ?? 0) + 1;
  return { claims, conflictSets, byCategory: counts };
}

/** 与原文 `_claim_id` 同形: 6 位哈希后缀, 让人工核对时能对上号 */
function stableSuffix(...parts: Array<string | number>): string {
  const seed = parts.join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

/** 台账 → Markdown(移植 `format_claim_ledger_markdown`) —— 可导出、可贴进写作舱 */
export function formatLedgerMarkdown(ledger: { claims: Claim[]; conflictSets: ConflictSet[] }, catLabel: Record<string, string>): string {
  const L: string[] = ["# 论断台账", ""];
  if (ledger.conflictSets.length) {
    L.push("## 需要人工核对的分歧", "");
    for (const cs of ledger.conflictSets) {
      L.push(`### ${cs.conflictSet} · ${catLabel[cs.category] ?? cs.category}`, "");
      for (const s of cs.sources) {
        L.push(`- **${s.value}** — ${s.sourceTitle || s.url}（${s.evidenceRole || "未标角色"}, 置信 ${s.confidence}）`);
        if (s.url) L.push(`  ${s.url}`);
      }
      L.push("");
    }
  }
  L.push("## 全部论断", "");
  for (const c of ledger.claims) {
    L.push(`- [${catLabel[c.category] ?? c.category}] **${c.value}** — ${c.sourceTitle || c.domain || c.url}${c.conflictSet ? ` ⚠ ${c.conflictSet}` : ""}`);
  }
  return L.join("\n");
}
