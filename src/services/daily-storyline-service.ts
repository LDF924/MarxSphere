// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// daily-storyline-service.ts — 主线聚类 + 编辑决策 + 历史对比(2026-10-04)
//
// ⚠ **源码移植**自开源项目 观澜/Guanlan(MIT, https://github.com/shenyangs/Guanlan):
//   `guanlan/daily_storylines.py`(`build_daily_storylines` / `build_daily_storyline_highlights` /
//   `build_daily_editorial_decisions` / `_storyline_key` / `_source_spread` / `_dominant_section` /
//   `_best_headline` / `_risk_flags` / `_confidence` / `_recommended_action` / `_risk_level` /
//   `_recommended_teams` / `_storyline_sort_key` / `_storyline_boundary` / `_decision_reason`)
//   与 `guanlan/daily_history.py`(含本仓的持久化改造, 见下)。
//   见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 它解决什么问题 ═══
//   日报最没用的形态是**一张按分数排的列表**: 十二条线索彼此无关, 读者读完不知道
//   "今天到底发生了什么"。主线聚类把同事件的条目合成一条**线**(带证据锚点、来源层分布、
//   风险标记、动作建议), 于是"今天有 3 条线, 其中 1 条是风险线"变成可读的判断。
//
//   聚类的判据很朴素但很关键: **标题里的实词**(去掉 query 自身的词与「今天/最新/年份」
//   这类虚词)取前 4 个做簇键。它不完美 —— 但比"按 URL 域名聚"好得多, 且**可解释**:
//   用户能一眼看出为什么这两条被归成一条线。
//
// ═══ 与观澜的差别 ═══
//   · 原文的 `_recommended_teams` 给的是公关团队(PR/市场/舆情/销售支持), 那是品牌监测的
//     产物; 这里是**研究平台**, 团队换成"谁该看这条线": 研究者 / 写作 / 数据 / 伦理。
//     动作建议同样换: 「立即跟进」→「今日核验」, 「社交传播」→「可作案例」。
//   · 历史对比原文写 **JSONL 文件**(`~/.guanlan/daily/history.jsonl`), 单机单用户的假设。
//     本仓是多用户服务, 所以落到 `daily_brief_history` 表(迁移 183), 按 user 隔离 ——
//     否则 A 用户的对比基准会掺进 B 用户的采集记录。**判据一行业没改**, 只换了存储。
import { pool } from "../db/pool.js";
import {
  domainOf, compactText, sectionTitle, stripBoilerplate,
  type AnnotatedItem, type DailySection, type Freshness, type SourceHealth,
} from "./daily-quality-service.js";

export interface StorylineEvidence {
  title: string;
  url: string;
  source: string;
  origin: string;
  sourceTier: string;
  sourceTierLabel: string;
  section: string;
  evidenceRole: string;
  freshness: string;
  freshnessLabel: string;
  summary: string;
}

export interface Storyline {
  id: string;
  clusterKey: string;
  headline: string;
  whatHappened: string;
  whyItMatters: string;
  freshness: Freshness;
  freshnessLabel: string;
  evidenceItems: StorylineEvidence[];
  overflowItems: StorylineEvidence[];
  sourceSpread: SourceSpread;
  riskFlags: string[];
  confidence: "high" | "medium" | "low";
  recommendedAction: string;
  riskLevel: "high" | "medium" | "low";
  teams: string[];
  storylineType: DailySection;
  storylineTypeLabel: string;
  timeWindow: string;
}

export interface SourceSpread {
  domainCount: number;
  domains: Record<string, number>;
  tierCounts: Record<string, number>;
  sectionCounts: Record<string, number>;
  originCounts: Record<string, number>;
}

export interface EditorialDecision {
  storylineId: string;
  headline: string;
  recommendedAction: string;
  riskLevel: string;
  teams: string[];
  confidence: string;
  reason: string;
}

const FRESHNESS_RANK: Record<string, number> = {
  today: 0, recent_3d: 1, recent_7d: 2, unknown: 3, background: 4,
};

/**
 * 风险词表(移植 `RISK_TERMS`, **两组按本仓语境改过**)。
 *
 * ⚠ 它是**关键词**判据, 不是分类器 —— 原文的用法是**提高敏感度而非定案**:
 *   命中即进 trust 栏目 + 标记 riskLevel, 由人去核。
 *
 * ⚠⚠ **本仓把「一个词就触发」改成了「强词一个 / 弱词两个」**(2026-10-04 实测)。
 *   原文是一张平坦的词表, 命中任意一词即成立。放到通用研究检索上会立刻失真:
 *   实测「国庆长假自驾出行 怎么开才**安全**」被判 high risk 并排到简报首位, 还生成了
 *   「优先核验风险线「自驾出行怎么开才安全」」这种荒谬的下一步。根因是中文里
 *   **「安全」「数据」「信任」都太常见**(行车安全/粮食安全/国家安全…), 单靠它们
 *   区分不出"这篇材料涉及安全风险"与"这篇材料碰巧用了安全两个字"。
 *
 *   所以每组拆成 strong(本身即风险)与 weak(需上下文), 判据是:
 *     **任一 strong 命中, 或 ≥2 个不同 weak 命中**。
 *   真合规材料通常同时提隐私/数据/伦理, 照旧命中; 日常新闻不再误报。
 *
 *   另一处改动: `reputation` 去掉了「道歉」与「舆情」—— 那是品牌监测的口径
 *   (「有人在网上骂我们的产品」)。一条新闻里有"道歉"两个字, 对研究者不构成风险。
 */
const RISK_TERMS: Record<string, { strong: readonly string[]; weak: readonly string[] }> = {
  privacy: {
    strong: ["隐私", "个人信息", "数据出境", "训练数据", "隐私政策"],
    weak: ["数据", "权限", "retention"],
  },
  security: {
    strong: ["漏洞", "攻击", "泄露", "数据泄露", "勒索", "入侵", "供应链攻击", "cve"],
    weak: ["安全", "security"],
  },
  compliance: {
    strong: ["合规", "版权", "伦理审查", "知情同意", "审计"],
    weak: ["监管", "copyright"],
  },
  trust: {
    strong: ["数据治理", "信创", "企业信任"],
    weak: ["信任", "采购"],
  },
  // 学术语境下的"争议"标记: 它说明这事有分歧值得看, **不是风险** → 只判 medium(见 riskLevelOf)
  reputation: {
    strong: ["投诉", "差评", "争议"],
    weak: [],
  },
};

export function buildDailyStorylines(
  items: AnnotatedItem[],
  overflowItems: AnnotatedItem[] | null = null,
  opts: { query?: string; edition?: string; timeWindow?: string; limit?: number } = {}
): Storyline[] {
  const query = opts.query ?? "";
  const edition = opts.edition ?? "general";
  const timeWindow = opts.timeWindow ?? "3d";
  const limit = Math.max(opts.limit ?? 8, 1);
  const overflow = overflowItems ?? [];

  const groups: Array<{ key: string; items: AnnotatedItem[]; overflow: AnnotatedItem[] }> = [];
  const byKey = new Map<string, { key: string; items: AnnotatedItem[]; overflow: AnnotatedItem[] }>();
  const groupOf = (row: AnnotatedItem) => {
    const key = storylineKey(row, query);
    let g = byKey.get(key);
    if (!g) {
      g = { key, items: [], overflow: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    return g;
  };
  for (const row of items) groupOf(row).items.push(row);
  for (const row of overflow) groupOf(row).overflow.push(row);

  const storylines: Storyline[] = [];
  for (const group of groups) {
    const primary = group.items.length ? group.items : group.overflow;
    if (!primary.length) continue;
    const evidenceItems = compactEvidence(primary, 5);
    const spread = sourceSpread([...primary, ...group.overflow]);
    const section = dominantSection(primary);
    const headline = bestHeadline(primary);
    const riskFlags = riskFlagsOf([...primary, ...group.overflow]);
    const freshness = bestFreshness(primary);
    const confidence = confidenceOf(spread, primary, freshness);
    const action = recommendedAction({ section, riskFlags, confidence, freshness, edition });
    const riskLevel = riskLevelOf({ section, riskFlags, spread });
    storylines.push({
      id: storyId(group.key, headline),
      clusterKey: group.key,
      headline,
      whatHappened: whatHappenedOf(primary, section),
      whyItMatters: whyItMatters(primary, section, edition),
      freshness,
      freshnessLabel: FRESH_LABEL(freshness),
      evidenceItems,
      overflowItems: compactEvidence(group.overflow, 4),
      sourceSpread: spread,
      riskFlags,
      confidence,
      recommendedAction: action,
      riskLevel,
      teams: recommendedTeams({ section, riskFlags, edition }),
      storylineType: section,
      storylineTypeLabel: sectionTitle(section),
      timeWindow,
    });
  }
  storylines.sort(storylineSortKey);
  return storylines.slice(0, limit);
}

/**
 * 主线摘要(移植 `build_daily_storyline_highlights`)。
 *
 * 每条摘要都带**来源层分布 A/B/C/D=n/n/n/n** —— 这是这套设计里最该学的一点:
 * 一句话说不说得出"证据够不够", 取决于有没有把分布摆在读者眼前。
 */
export function buildStorylineHighlights(
  storylines: Storyline[],
  sourceHealth?: SourceHealth | null
): string[] {
  const bullets: string[] = [];
  for (const story of storylines.slice(0, 4)) {
    const tiers = story.sourceSpread.tierCounts;
    const anchor = firstEvidenceTitle(story);
    bullets.push(
      `${story.headline}: ${anchor}。来源层分布 A/B/C/D=${tiers.A ?? 0}/${tiers.B ?? 0}/${tiers.C ?? 0}/${tiers.D ?? 0}; ${storylineBoundary(story)}`
    );
  }
  for (const warning of sourceHealth?.warnings ?? []) bullets.push(warning);
  return bullets.slice(0, 5);
}

export function buildEditorialDecisions(storylines: Storyline[]): EditorialDecision[] {
  return storylines.map((story) => ({
    storylineId: story.id,
    headline: story.headline,
    recommendedAction: story.recommendedAction,
    riskLevel: story.riskLevel,
    teams: story.teams,
    confidence: story.confidence,
    reason: decisionReason(story),
  }));
}

// ═══════════════════════════════════════════════════════════
// 簇键与聚合(移植 `_storyline_key` 及以下)
// ═══════════════════════════════════════════════════════════

/**
 * 簇键 —— 标题实词前 4 个。
 *
 * ⚠ 两个刻意的取舍:
 *   ① **去掉 query 自身的词**: 否则所有条目都含 query 词, 全部聚成一条。
 *   ② **去掉年份/「今天」「最新」**: 它们出现在每条新闻标题里, 对区分事件零贡献。
 *   ③ 实词不足时退到"整标题前缀", 再退到域名 —— 保证**永远有一条线**,
 *      而不是把条目静默丢掉(丢了就变成"今天没有相关消息")。
 *
 * ⚠⚠ **中文无分隔符标题这一档是本仓改过的**(2026-10-04 实测, 原文在此处失效):
 *   原文的兜底是 `tokens()` 返回的 **4 字滑窗**, 再退 `compact_title[:32]`。
 *   但中文新闻标题常常整句没有分隔符, 滑窗是**位置相关**的 ——
 *   「工商资本下乡的规范路径」(3 个窗)与「工商资本下乡的规范路径探讨」(4 个窗)
 *   因此得到**不同的键**, 同一件事的转载会各成一条主线。
 *   实测: 两条明显同事件的标题聚成 2 条线, 而不是 1 条。
 *   改法: 标题没有分隔符时, 簇键取**紧凑标题前 8 字**。
 *   取 8 是权衡: 4 字会把「工商资本下乡…」与「工商资本进入农业…」错误合并(相关但不同事件),
 *   而原文的 32 字在中文里几乎永不碰撞(= 等于不聚类)。
 *   **这是本仓对上游行为的有意偏离**, 与 `daily_quality` 那几处移植改动同性质。
 */
function storylineKey(item: AnnotatedItem, query: string): string {
  const url = String(item.url ?? "");
  const domain = domainOf(url);
  const title = String(item.title ?? "");
  const compactTitle = compactText(title);
  const queryTokens = new Set(tokens(query));
  const filtered = tokens(title).filter(
    (t) => !queryTokens.has(t) && !["今天", "今日", "最新", "2025", "2026", "2024"].includes(t)
  );
  if (filtered.length >= 2) return "t:" + filtered.slice(0, 4).join("-");
  // 无分隔符的中文标题: 用固定长度前缀, 让同事件的不同转载落到同一个键上
  if (!/[\s/,_:+|｜\-—–]/.test(title) && compactTitle.length > 8) {
    return "t:" + compactTitle.slice(0, 8);
  }
  if (compactTitle) return "t:" + compactTitle.slice(0, 32);
  if (domain) return "d:" + domain;
  return "unknown";
}

function storyId(key: string, headline: string): string {
  const base = compactText(key || headline).slice(0, 40) || "daily-story";
  return `daily-${base}`;
}

function compactEvidence(items: AnnotatedItem[], max: number): StorylineEvidence[] {
  return items.slice(0, max).map((row) => ({
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
    source: String(row.source ?? ""),
    origin: String(row.origin ?? ""),
    sourceTier: String(row.sourceTier ?? ""),
    sourceTierLabel: String(row.sourceTierLabel ?? ""),
    section: String(row.sourceSection ?? ""),
    evidenceRole: String(row.evidenceRole ?? ""),
    freshness: String(row.freshness ?? "unknown"),
    freshnessLabel: String(row.freshnessLabel ?? ""),
    summary: String(row.summary ?? "").slice(0, 240),
  }));
}

function sourceSpread(items: AnnotatedItem[]): SourceSpread {
  const domains: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  const sections: Record<string, number> = {};
  const origins: Record<string, number> = {};
  for (const row of items) {
    const domain = domainOf(String(row.url ?? ""));
    const tier = String(row.sourceTier ?? "unknown");
    const section = String(row.sourceSection ?? "other");
    const origin = String(row.origin ?? "");
    if (domain) domains[domain] = (domains[domain] ?? 0) + 1;
    if (tier) tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (section) sections[section] = (sections[section] ?? 0) + 1;
    if (origin) origins[origin] = (origins[origin] ?? 0) + 1;
  }
  return {
    domainCount: Object.keys(domains).length,
    domains: sortCounts(domains),
    tierCounts: Object.fromEntries(Object.entries(tiers).sort((a, b) => a[0].localeCompare(b[0]))),
    sectionCounts: sortCounts(sections),
    originCounts: sortCounts(origins),
  };
}

function sortCounts(c: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function dominantSection(items: AnnotatedItem[]): DailySection {
  const order: Record<string, number> = { trust: 0, academic: 1, ecosystem: 2, community: 3, official: 4, other: 5 };
  const counts: Record<string, number> = {};
  for (const row of items) {
    const s = String(row.sourceSection ?? "other");
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const keys = Object.keys(counts);
  if (!keys.length) return "other";
  keys.sort((a, b) => counts[b] - counts[a] || (order[a] ?? 9) - (order[b] ?? 9) || a.localeCompare(b));
  return keys[0] as DailySection;
}

/**
 * 头条取哪条(移植 `_best_headline`)。
 *
 * ⚠ 排序键的顺序就是判据, 别调换: **先排 D 层**(D 一律靠后, 哪怕它分高),
 *   再看采集分, **最后才看标题长度**(短的通常更像新闻标题, 长的多是聚合页)。
 *   把长度放前面会让「短标题党」赢过「长但准确的官方通稿」。
 */
function bestHeadline(items: AnnotatedItem[]): string {
  const candidates = [...items].sort((a, b) => {
    const da = String(a.sourceTier ?? "D") === "D" ? 1 : 0;
    const db = String(b.sourceTier ?? "D") === "D" ? 1 : 0;
    if (da !== db) return da - db;
    const sa = Number(a.dailyScore ?? a.baseScore ?? 0);
    const sb = Number(b.dailyScore ?? b.baseScore ?? 0);
    if (sa !== sb) return sb - sa;
    return String(a.title ?? "").length - String(b.title ?? "").length;
  });
  return String(candidates[0]?.title ?? "未命名主线");
}

function whatHappenedOf(items: AnnotatedItem[], section: DailySection): string {
  const row = items[0];
  if (!row) return sectionTitle(section);
  const summary = String(row.summary ?? "").trim();
  const title = String(row.title ?? "").trim();
  const source = String(row.source ?? "").trim();
  const text = shorten(summary.length > title.length ? summary : title, 120);
  return source ? `${text}(${source})` : text || sectionTitle(section);
}

/**
 * 「为什么值得看」(移植 `_why_it_matters`)。
 *
 * ⚠ 它**不是摘要**, 是**采编理由** —— 说的是"把它放在这个栏目是为了什么"。
 *   两者混起来会写出一堆同义反复的废话, 这一层职责分离要保住。
 */
function whyItMatters(items: AnnotatedItem[], section: DailySection, edition: string): string {
  if (section === "official") return "这是可核验的一手口径, 适合先确认发布动作、政策原文与官方边界。";
  if (section === "academic") return "这是学界的判断, 可用于定位争鸣位置; 注意其样本范围与结论适用条件。";
  if (section === "ecosystem") return "这是官方之外的媒体与产业视角, 可用于判断外部关注点与议题框架。";
  if (section === "community") return "这是公开讨论样本, 适合发现真实关切与话语走向, **不能外推为总体民意**。";
  if (section === "trust") return "这条线涉及安全、合规、伦理或数据治理, 是需要单独跟进的风险面。";
  if (edition === "market") return "这条线索可作选题补充, 但需要补强来源后再进入正文。";
  return "这是候补线索, 适合做后续补证或选题扩展。";
}

function bestFreshness(items: AnnotatedItem[]): Freshness {
  const list = items.map((r) => String(r.freshness ?? "unknown"));
  if (!list.length) return "unknown";
  list.sort((a, b) => (FRESHNESS_RANK[a] ?? 9) - (FRESHNESS_RANK[b] ?? 9));
  return list[0] as Freshness;
}

function FRESH_LABEL(f: Freshness): string {
  return { today: "今天", recent_3d: "近 3 天", recent_7d: "近 7 天", background: "背景资料", unknown: "时间未知" }[f] ?? f;
}

/** 风险标记: 任一强词, 或 ≥2 个不同弱词(见 RISK_TERMS 的注释) */
function riskFlagsOf(items: AnnotatedItem[]): string[] {
  const parts: string[] = [];
  for (const row of items) {
    parts.push(
      (row.riskTags ?? []).join(" "),
      String(row.title ?? ""),
      // ⚠ 摘要**必须先剥样板文字** —— 中文站的摘要几乎全都带版权声明, 不剥的话
      //   「版权所有」会让每条 B 层媒体都命中 compliance 强词(实测: 一条亚运会新闻被判 high risk)。
      //   见 stripBoilerplate 的注释。
      stripBoilerplate(String(row.summary ?? ""))
    );
  }
  const text = parts.join(" ").toLowerCase();
  const flags: string[] = [];
  for (const [flag, { strong, weak }] of Object.entries(RISK_TERMS)) {
    const strongHit = strong.some((t) => text.includes(t.toLowerCase()));
    const weakHits = weak.filter((t) => text.includes(t.toLowerCase())).length;
    if (strongHit || weakHits >= 2) flags.push(flag);
  }
  if (items.some((r) => String(r.sourceTier ?? "") === "D")) flags.push("weak_lead");
  return [...new Set(flags)];
}

/** 置信度(移植 `_confidence`) —— 判据只有两条: 强来源够不够, 弱线索有没有 */
function confidenceOf(spread: SourceSpread, items: AnnotatedItem[], freshness: Freshness): "high" | "medium" | "low" {
  const tiers = spread.tierCounts;
  const strong = (tiers.A ?? 0) + (tiers.B ?? 0);
  const weak = tiers.D ?? 0;
  if (strong >= 2 && weak === 0 && ["today", "recent_3d", "recent_7d"].includes(freshness)) return "high";
  if (strong >= 1 && weak < Math.max(items.length, 1)) return "medium";
  return "low";
}

/**
 * 动作建议(移植 `_recommended_action`, **团队口径已换成本仓语境**)。
 *
 * 原文给的是品牌公关的动作(立即跟进/社交传播/深写观察/暂不动作)。这里是研究平台:
 *   今日核验  → 时间紧且涉风险, 今天就该回读原文
 *   可作案例  → 有社区样本, 能当鲜活材料用
 *   深写观察  → 有事实锚点但还不够成稿
 *   暂不动作  → 强度不足, 留在观察池
 */
function recommendedAction(opts: {
  section: DailySection; riskFlags: string[]; confidence: string; freshness: Freshness; edition: string;
}): string {
  const risky = opts.riskFlags.some((f) => ["privacy", "security", "compliance", "trust", "reputation"].includes(f));
  if (risky) return ["today", "recent_3d"].includes(opts.freshness) ? "今日核验" : "深写观察";
  if (opts.section === "community") return ["high", "medium"].includes(opts.confidence) ? "可作案例" : "深写观察";
  if (opts.section === "academic" && ["high", "medium"].includes(opts.confidence)) return "深写观察";
  if (opts.section === "ecosystem" && ["high", "medium"].includes(opts.confidence)) return "深写观察";
  if (opts.section === "official" && ["brand", "market", "general"].includes(opts.edition)) return "深写观察";
  return "暂不动作";
}

/**
 * 风险等级(移植 `_risk_level`, **reputation 降了一档**)。
 *
 * ⚠ 原文把 reputation 与 privacy/security/compliance 并列判 high —— 那是品牌监测的口径:
 *   网上有人投诉, 对品牌就是当天要处理的事。对研究者不是: 「争议」只说明这事有分歧。
 *   所以这里 reputation 单独走 medium, 而 privacy/security/compliance 仍是 high
 *   (它们标记的是**材料本身涉及的伦理与合规约束**, 那是研究者真会踩的线)。
 */
function riskLevelOf(opts: {
  section: DailySection; riskFlags: string[]; spread: SourceSpread;
}): "high" | "medium" | "low" {
  if (opts.riskFlags.some((f) => ["privacy", "security", "compliance"].includes(f))) return "high";
  if (opts.riskFlags.includes("reputation")) return "medium";
  if (opts.section === "trust" || (opts.spread.tierCounts.D ?? 0) > 0) return "medium";
  return "low";
}

/** 谁该看这条线(移植 `_recommended_teams`, 团队换成本仓角色) */
function recommendedTeams(opts: { section: DailySection; riskFlags: string[]; edition: string }): string[] {
  const teams = ["研究者"];
  if (opts.edition === "market" || ["ecosystem", "official"].includes(opts.section)) teams.push("写作");
  if (opts.section === "community") teams.push("写作", "数据");
  if (opts.section === "academic") teams.push("文献");
  if (opts.riskFlags.some((f) => ["privacy", "security", "compliance", "trust", "reputation"].includes(f)) || opts.section === "trust") {
    teams.push("伦理");
  }
  if (opts.section === "official") teams.push("政策");
  return [...new Set(teams)];
}

/** 主线排序(移植 `_storyline_sort_key`): 风险 → 时效 → 栏目 → 标题 */
function storylineSortKey(a: Storyline, b: Storyline): number {
  const riskRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sectionRank: Record<string, number> = { trust: 0, academic: 1, ecosystem: 2, community: 3, official: 4, other: 5 };
  const ra = riskRank[a.riskLevel] ?? 2;
  const rb = riskRank[b.riskLevel] ?? 2;
  if (ra !== rb) return ra - rb;
  const fa = FRESHNESS_RANK[a.freshness] ?? 9;
  const fb = FRESHNESS_RANK[b.freshness] ?? 9;
  if (fa !== fb) return fa - fb;
  const sa = sectionRank[a.storylineType] ?? 9;
  const sb = sectionRank[b.storylineType] ?? 9;
  if (sa !== sb) return sa - sb;
  return a.headline.localeCompare(b.headline);
}

function firstEvidenceTitle(story: Storyline): string {
  const evidence = story.evidenceItems;
  if (!evidence.length) return story.whatHappened;
  const row = evidence[0];
  const title = shorten(row.title, 72);
  return row.source ? `${title}(${row.source})` : title;
}

function storylineBoundary(story: Storyline): string {
  const freshness = story.freshnessLabel || "时间未知";
  if (story.confidence === "low") return `证据强度偏低, 当前只能作为线索; 时间层为${freshness}。`;
  return `当前可作为主线, 但结论需保留来源边界; 时间层为${freshness}。`;
}

function decisionReason(story: Storyline): string {
  if (story.recommendedAction === "今日核验") return "涉及风险/信任或高敏感议题, 适合当天回读原文、补证并同步相关方。";
  if (story.recommendedAction === "可作案例") return "有社区或用户样本, 适合提炼真实关切与话语素材。";
  if (story.recommendedAction === "深写观察") return "已有可用事实锚点, 但仍需代表原文与更多外部来源支撑成稿。";
  return "来源强度或时间证据不足, 先保留在观察池。";
}

function tokens(text: string): string[] {
  const raw = String(text ?? "");
  const parts = raw.split(/[\s/,_:+|｜\-—–]+/);
  const out: string[] = [];
  for (const part of parts) {
    const clean = compactText(part);
    if (clean.length >= 2) out.push(clean);
  }
  if (!out.length) {
    // 没有分隔符的长标题(中文常见): 按 4 字窗切, 让"实词"判据仍有东西可用
    const compact = compactText(raw);
    for (let i = 0; i < Math.min(compact.length, 24); i += 4) {
      const chunk = compact.slice(i, i + 4);
      if (chunk.length >= 2) out.push(chunk);
    }
  }
  return [...new Set(out)];
}

function shorten(text: string, limit: number): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().replace(/^[，。]+|[，。]+$/g, "");
  if (clean.length <= limit) return clean;
  return clean.slice(0, Math.max(limit - 2, 1)).replace(/\s+$/, "") + "...";
}

// ═══════════════════════════════════════════════════════════
// 历史对比(移植 `daily_history.py`, **存储换成表**)
// ═══════════════════════════════════════════════════════════

export interface HistoryDelta {
  enabled: boolean;
  compareDays: number;
  recordsChecked: number;
  newStorylines: CompactStory[];
  continuedStorylines: CompactStory[];
  cooledStorylines: CompactStory[];
  /** 连续两期都在的风险线 —— 这才是真正需要盯的 */
  persistentRisks: CompactStory[];
}

export interface CompactStory {
  id: string;
  headline: string;
  freshness: string;
  riskLevel: string;
  recommendedAction: string;
  confidence: string;
}

function compactStory(story: { id?: string; headline?: string; freshness?: string; riskLevel?: string; recommendedAction?: string; confidence?: string }): CompactStory {
  return {
    id: String(story.id ?? ""),
    headline: String(story.headline ?? ""),
    freshness: String(story.freshness ?? ""),
    riskLevel: String(story.riskLevel ?? ""),
    recommendedAction: String(story.recommendedAction ?? ""),
    confidence: String(story.confidence ?? ""),
  };
}

/**
 * 对比上一期。
 *
 * ⚠ 三个桶的语义(照搬原文, 别合并):
 *   · **新增**   —— 这期才有: 可能是刚发生的事, 也可能是这期的检索终于覆盖到了
 *   · **延续**   —— 两期都在: 它在持续发酵, 值得盯
 *   · **降温**   —— 上期有这期没有: **不代表事情结束了** —— 很可能只是这期没抓到。
 *     所以界面上的措辞必须是「本期未见」而不是「已消退」, 除非连续多期缺失。
 */
export async function buildHistoryDelta(
  userId: string,
  report: { query?: string; storylines?: Storyline[]; generatedAt?: string },
  opts: { compareDays?: number } = {}
): Promise<HistoryDelta> {
  const days = Math.max(opts.compareDays ?? 0, 0);
  if (days <= 0) {
    return {
      enabled: false, compareDays: 0, recordsChecked: 0,
      newStorylines: [], continuedStorylines: [], cooledStorylines: [], persistentRisks: [],
    };
  }
  const current = new Map<string, CompactStory>();
  for (const s of report.storylines ?? []) {
    const key = s.id || s.headline;
    if (key) current.set(key, compactStory(s));
  }

  let rows: Array<{ storylines: unknown }> = [];
  try {
    const r = await pool.query(
      `select storylines from daily_brief_history
        where user_id = $1
          and ($2 = '' or query_key = $3)
          and generated_at >= now() - ($4 || ' days')::interval
        order by generated_at desc
        limit 60`,
      [userId, normalizeQuery(report.query ?? ""), normalizeQuery(report.query ?? ""), String(days)]
    );
    rows = r.rows as Array<{ storylines: unknown }>;
  } catch {
    // 表还没建 / 查询失败 —— **不把它变成"没有历史"**: enabled 保持 true 但记录数为 0,
    // 界面会显示"无对比基准", 与"对比结果为空"是两回事。
    return {
      enabled: true, compareDays: days, recordsChecked: 0,
      newStorylines: [...current.values()],
      continuedStorylines: [], cooledStorylines: [], persistentRisks: [],
    };
  }
  void rows;

  const previous = new Map<string, CompactStory>();
  for (const row of rows) {
    const list = Array.isArray(row.storylines) ? (row.storylines as Array<Record<string, unknown>>) : [];
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      const key = String(s.id ?? s.headline ?? "");
      if (key) previous.set(key, compactStory(s as never));
    }
  }
  const currentKeys = new Set(current.keys());
  const previousKeys = new Set(previous.keys());
  const newStorylines = [...currentKeys].filter((k) => !previousKeys.has(k)).sort().map((k) => current.get(k)!);
  const continued = [...currentKeys].filter((k) => previousKeys.has(k)).sort();
  const cooled = [...previousKeys].filter((k) => !currentKeys.has(k)).sort().slice(0, 8).map((k) => previous.get(k)!);
  const persistentRisks = continued
    .filter((k) => ["high", "medium"].includes(current.get(k)!.riskLevel) || ["high", "medium"].includes(previous.get(k)!.riskLevel))
    .map((k) => current.get(k)!);

  return {
    enabled: true,
    compareDays: days,
    recordsChecked: rows.length,
    newStorylines,
    continuedStorylines: continued.map((k) => current.get(k)!),
    cooledStorylines: cooled,
    persistentRisks,
  };
}

/** 落一期历史 —— 供下一期对比 */
export async function recordDailyHistory(
  userId: string,
  report: { query?: string; title?: string; generatedAt?: string; timeWindow?: string; edition?: string; storylines?: Storyline[]; sourceHealth?: SourceHealth }
): Promise<void> {
  try {
    await pool.query(
      `insert into daily_brief_history
         (user_id, query_key, title, generated_at, time_window, edition, storylines, source_health)
       values ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7::jsonb, $8::jsonb)`,
      [
        userId,
        normalizeQuery(report.query ?? ""),
        String(report.title ?? ""),
        report.generatedAt || null,
        String(report.timeWindow ?? ""),
        String(report.edition ?? ""),
        // ⚠ 必须 stringify: node-postgres 会把 JS 数组当 **Postgres 数组字面量**, 不是 jsonb
        JSON.stringify((report.storylines ?? []).map(compactStory)),
        JSON.stringify(report.sourceHealth ?? {}),
      ]
    );
  } catch {
    // 记不上历史不该让整期日报失败 —— 但**下一期就没有基准**, 由调用方在响应里说明
  }
}

function normalizeQuery(value: string): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}
