// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// daily-brief-service.ts — 每日简报编排 + 渲染(2026-10-04)
//
// ⚠ **源码移植**自开源项目 观澜/Guanlan(MIT, https://github.com/shenyangs/Guanlan)
//   的 `guanlan/daily.py`(逐函数转 TypeScript: `build_daily_report` / `format_daily_markdown` /
//   `format_daily_context` / `_normalize_*_items` / `_merge_daily_items` / `_select_daily_items` /
//   `_build_daily_overflow_items` / `_daily_section_caps` / `_build_daily_sections` / `_daily_score` /
//   `_daily_boundaries` / `_daily_next_steps` / `_build_editorial_health` / `_query_overlap_score` /
//   `_topic_match_strict` / `_daily_fingerprint` / `_canonical_url` / `_daily_story_*` 等)。
//   判据层在 `daily-quality-service.ts`, 主线层在 `daily-storyline-service.ts`。
//   见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 它解决什么问题 ═══
//   把"外部检索 / 舆情检索 / 热榜 / 归档"四条链**合成一份可读的当期判断**: 今天有哪些线、
//   每条线的证据是哪几层、哪条现在还不能下结论、下一步该去核什么。
//   它不是搜索结果的再排序 —— 它的输出形态是**有主线的简报**, 不是列表。
//
// ═══ 移植时改动的地方(都是**我们这边的现实**, 不是审美偏好) ═══
//   ① **采集层换成本仓既有服务**: 原文自己串 search/feeds/hotnews/watch; 我们用
//      `searchOpinion`(舆情检索) + `fetchBoards`(热榜) + 本地归档。选它们是因为
//      这三条在本仓是**已有的、可独立运行的**链, 日报只是它们的下游消费者。
//   ② **没有移植 `_run_daily_lane_searches`(多变体扇形检索)**。它在原文里是"同一 query
//      换 4 个 scope 各跑一遍"。本仓的舆情检索一次要跑 28 个源, 扇形就是 4×28 次请求 ——
//      而换来的只是同一批源上多几个关键词变体。**这是我不做的取舍, 写在这里而不是悄悄省掉**:
//      需要更宽的覆盖时, 正确做法是把 variant 交给舆情检索的路由层, 不是在这里叠请求。
//   ③ **`_enrich_daily_reads`(回读代表原文)改用本地归档**: 原文把 top-N URL 现场抓一遍,
//      失败率高且慢。我们有归档(带段落偏移与质量报告), 直接读它 —— 而且**归档过的页面
//      才是可引用的页面**, 现场抓来的正文没进证据链。
//   ④ `edition` 取值换成社科语境: research(默认) / policy / market / teaching。
//
// ═══ 三条口径(照搬原文, 用之前必须知道) ═══
//   ① **日报是公开信号与证据入口, 不是最终判断**。热点、转载与公开网页样本都应在需要时回读原文。
//   ② **没有发布时间的条目不进时间序列**。绝不补 now()。
//   ③ **D 层(弱线索)不进正文**, 但进候补池 —— 候补池的意义是"以后可能有用", 不是"质量还行"。

import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";
import { route as routeOpinion, profileOf, type RoutePlan } from "./opinion-router.js";
import { searchOpinion, type OpinionSearchResult } from "./opinion-search-service.js";
import { fetchBoards, listBoards, type HotBoardResult } from "./hotboard-service.js";
import { listArchives } from "./web-archive-service.js";
import {
  annotateDailyItems, buildSourceHealth, compactText,
  isSearchEntrypoint, sectionTitle, normalizeTimeWindow,
  type AnnotatedItem, type DailyCandidate, type DailySection as SectionKey, type SourceHealth, type TimeWindow,
} from "./daily-quality-service.js";
import {
  buildDailyStorylines, buildStorylineHighlights, buildEditorialDecisions,
  buildHistoryDelta, recordDailyHistory,
  type Storyline, type EditorialDecision, type HistoryDelta,
} from "./daily-storyline-service.js";

export const DEFAULT_DAILY_LIMIT = 12;
export const MAX_DAILY_LIMIT = 30;
export const DEFAULT_OVERFLOW_LIMIT = 20;
export const MAX_OVERFLOW_LIMIT = 80;

const VALID_EDITIONS = new Set(["research", "policy", "market", "teaching", "general"]);

export interface DailyBriefInput {
  userId: string;
  query?: string;
  /** 时间窗: today / 24h / 3d / 7d */
  timeWindow?: string;
  edition?: string;
  /** 正文条数上限 */
  limit?: number;
  /** 候补池条数上限 */
  overflowLimit?: number;
  /** 热榜平台 id 白名单 —— 空 = 不取热榜 */
  hotBoards?: string[];
  /** 舆情检索的源 id 白名单(空 = 按路由计划走) */
  sourceIds?: string[];
  includeOpinion?: boolean;
  includeHotboard?: boolean;
  includeArchive?: boolean;
  /** 与往期对比的天数(0 = 不对比) */
  compareDays?: number;
  /** 落一期历史, 供下期对比 */
  recordHistory?: boolean;
}

export interface DailyDiagnostic {
  status: "ok" | "skipped" | "error" | "empty";
  count: number;
  error: string;
  limit: number;
  source?: string;
  note?: string;
}

export interface DailySection {
  key: SectionKey;
  title: string;
  summary: string;
  items: AnnotatedItem[];
}

export interface DailyBrief {
  schemaVersion: "daily_report_v1";
  title: string;
  query: string;
  mode: "query_daily" | "hot_daily" | "overview_daily";
  generatedAt: string;
  timeWindow: TimeWindow;
  edition: string;
  routePlan: Pick<RoutePlan, "primary" | "secondary" | "preferredSourceIds" | "avoidAsPrimary" | "reason" | "lowConfidence"> | null;
  diagnostics: Record<string, DailyDiagnostic>;
  sourceMix: Record<string, number>;
  originMix: Record<string, number>;
  tierMix: Record<string, number>;
  candidateCount: number;
  itemCount: number;
  highlights: string[];
  items: AnnotatedItem[];
  overflowItems: AnnotatedItem[];
  overflowCount: number;
  sections: DailySection[];
  storylines: Storyline[];
  editorialDecisions: EditorialDecision[];
  sourceHealth: SourceHealth;
  editorialHealth: { status: "ok" | "warn" | "block"; coverage: Record<string, number>; warnings: string[] };
  boundaries: string[];
  nextSteps: string[];
  historyDelta: HistoryDelta;
  boundary: string;
}

// ═══════════════════════════════════════════════════════════
// 采集 → 归一(移植 `_normalize_*_items`)
// ═══════════════════════════════════════════════════════════

function fromOpinion(r: OpinionSearchResult): DailyCandidate[] {
  return (r.items ?? []).slice(0, 300).map((it) => ({
    title: String(it.title ?? "").trim(),
    url: String(it.url ?? "").trim(),
    summary: String(it.summary ?? "").slice(0, 500),
    source: String(it.sourceName || it.source || "opinion"),
    sourceId: String(it.source ?? ""),
    origin: "opinion",
    // ⚠ 舆情条目的 evidence_role 由**信源画像**给, 不是猜的: 见 opinion-router 的 SOURCE_PROFILE
    evidenceRole: roleFromSourceId(String(it.source ?? "")),
    publishedAt: String(it.publishedAt ?? ""),
    riskTags: [],
    baseScore: Number(it.score ?? 0) * 3,
  })).filter((x) => x.title && x.url);
}

/**
 * 舆情源 id → 证据角色。
 *
 * ⚠ 这是**移植时新增的桥**: 舆情源有各自的类别(policy/media/preprint…), 而采编判据要的是
 *   `evidence_role`。两边都别改, 在这里映射 —— 让"源是什么"只有一处定义。
 *   映射不到时返回空串, 由判据层退到域名判断(而不是随便给个角色)。
 */
function roleFromSourceId(sourceId: string): string {
  const s = sourceId.toLowerCase();
  if (s.startsWith("arxiv") || s.includes("preprint") || s.includes("osf")) return "preprint_record";
  if (s.startsWith("sd-") || s.includes("journal") || s.includes("sciencedirect")) return "research_primary";
  if (s.includes("gov") || s.includes("stats") || s.includes("ndrc") || s.includes("moa")) return "government";
  if (s.includes("people") || s.includes("xinhua") || s.includes("qstheory") || s.includes("gmw")) return "official_primary";
  if (s.includes("weibo") || s.includes("hot")) return "public_discussion";
  if (s.includes("zhihu") || s.includes("forum") || s.includes("bbs")) return "community_discussion";
  if (s.includes("news") || s.includes("jiemian") || s.includes("thepaper") || s.includes("caixin")) return "fresh_news";
  return "";
}

function fromHotboard(results: HotBoardResult[]): DailyCandidate[] {
  const out: DailyCandidate[] = [];
  for (const board of results) {
    for (const [i, item] of (board.items ?? []).entries()) {
      out.push({
        title: String(item.title ?? "").trim(),
        url: String(item.url ?? "").trim(),
        summary: item.summary ? String(item.summary).slice(0, 500) : "",
        source: board.name,
        sourceId: board.id,
        origin: `hotboard:${board.id}`,
        // 热榜是**注意力样本**, 不是事实 —— 这个角色标错了, 后面整套判据都会歪
        evidenceRole: "public_discussion",
        riskTags: ["not_representative"],
        // 位次越靠前分越高; 100 名之后不再加分(长尾对判断没贡献)
        baseScore: Math.max(2.5 - i * 0.06, 0) ,
      });
    }
  }
  return out.filter((x) => x.title);
}

/**
 * 归档条目的证据角色 —— **按域名判, 不写死**。
 *
 * ⚠ 我第一版给所有归档硬编码了 `research_primary`, 那是错的: 那个角色在判据层的意思是
 *   **同行评审文献**, 会被分到「学术与预印本」栏目 A 档。于是一篇澎湃新闻的归档页
 *   被标成了"同行评审" —— 而这整套判据存在的唯一理由就是**不让这种事发生**。
 *   归档只说明"我们读过全文并留存了", 不改变来源本身的性质; 性质要看域名。
 *
 * 判不出来(常见: 个人博客/自建站)时返回空串, 让判据层按域名兜底 —— 那一路会归 D,
 * 进候补池而不是正文。**宁可算弱, 不要算进正文。**
 */
function roleFromUrl(url: string): string {
  const d = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
  if (!d) return "";
  if (/(^|\.)gov\.cn$|(^|\.)gov\.uk$|(^|\.)europa\.eu$/.test(d)) return "government";
  if (["sciencedirect.com", "springer.com", "wiley.com", "tandfonline.com", "sagepub.com", "jstor.org", "nature.com", "science.org"]
    .some((k) => d === k || d.endsWith(`.${k}`))) return "research_primary";
  if (["arxiv.org", "osf.io", "ssrn.com"].some((k) => d === k || d.endsWith(`.${k}`))) return "preprint_record";
  if (["zhihu.com", "csdn.net", "github.com", "v2ex.com", "douban.com", "weibo.com", "xiaohongshu.com", "reddit.com"]
    .some((k) => d === k || d.endsWith(`.${k}`))) return "community_discussion";
  if (["thepaper.cn", "jiemian.com", "yicai.com", "caixin.com", "36kr.com", "huxiu.com", "people.com.cn", "xinhuanet.com", "news.cn"]
    .some((k) => d === k || d.endsWith(`.${k}`))) return "fresh_news";
  return "";
}

function fromArchive(rows: Awaited<ReturnType<typeof listArchives>>): DailyCandidate[] {
  return rows.map((a) => ({
    title: String(a.title || a.url),
    url: String(a.url),
    // ⚠ **不给 summary**: 归档列表接口不返回正文, 而"3 个快照 · 质量 82"这类元信息
    //   不是"发生了什么"。塞进 summary 会让主线的「发生了什么」写成「1 个快照 · 未评分」——
    //   看起来像内容, 其实什么都没说。宁可空着, 让标题承担这一行。
    summary: "",
    source: "本地归档",
    origin: "archive",
    evidenceRole: roleFromUrl(String(a.url)),
    // ⚠ 用 archivedAt(最新一版**抓取**的时间)而**不是** lastSeenAt:
    //   lastSeenAt 每次命中都会更新, 拿它当发布时间会让一条 2024 年的政策变成"今天的线索"。
    publishedAt: String(a.archivedAt ?? ""),
    // 用户是**特意**把它归档的 —— 这个意图用采集分表达, 不能靠伪造证据层级表达。
    // (它只影响排序, 不影响 A/B/C/D 分层。)
    baseScore: 4.2,
  }));
}

// ═══════════════════════════════════════════════════════════
// 合并 / 去重 / 打分(移植 `_merge_daily_items` / `_daily_score`)
// ═══════════════════════════════════════════════════════════

function canonicalUrl(url: string): string {
  const clean = String(url ?? "").trim();
  if (!clean) return "";
  try {
    const u = new URL(clean);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return clean;
  }
}

/** 指纹(移植 `_daily_fingerprint`): 优先按规范化 URL, 无 URL 才退到 来源+标题 */
export function dailyFingerprint(title: string, url: string, source: string): string {
  const canon = canonicalUrl(url);
  if (canon) return canon;
  const compact = compactText(title);
  return compact ? `${source}:${compact}` : "";
}

function originPriority(origin: string): number {
  if (origin === "archive") return 0;
  if (origin === "opinion") return 1;
  if (origin.startsWith("hotboard")) return 3;
  return 9;
}

/**
 * 打分(移植 `_daily_score`)。
 *
 * ⚠ 这是个**透明的加权和, 不是学习出来的排序器** —— 每一项都能被追责:
 *   通道底分 / 证据角色加分 / 源权威分 / 是否新增 / 与 query 的重叠 / 热榜意图加成 /
 *   风险标签扣分 / 软 SEO 重扣 / 搜索入口页重扣。
 *   为什么要写成这样而不是丢给模型: 用户会问"为什么这条排第一", 得答得出来。
 */
function dailyScore(row: AnnotatedItem, query: string, routeIntents: string[]): number {
  const origin = String(row.origin ?? "");
  const role = String(row.evidenceRole ?? "");
  const profile = profileOf(String(row.sourceId ?? row.source ?? ""));
  const riskTags = new Set(row.riskTags ?? []);
  let score = 0;

  if (origin === "archive") score += 4.6;
  else if (origin === "opinion") score += 4.2;
  else if (origin.startsWith("hotboard")) score += 2.5;
  else score += 2.0;

  if (["official_primary", "authoritative_report", "company_primary", "security_advisory",
       "company_filing", "government", "research_primary", "peer_reviewed"].includes(role)) {
    score += 1.2;
  }
  score += Math.min(profile.authority * 1.1, 1.0);
  score += Number(row.baseScore ?? 0) * 0.3;

  const overlap = queryOverlapScore(query, `${row.title} ${row.summary ?? ""}`);
  score += overlap;

  if (routeIntents.includes("public_opinion") && origin.startsWith("hotboard")) score += 0.5;
  else if (query && origin.startsWith("hotboard") && overlap === 0) score -= 1.4;

  if (riskTags.has("sample_bias") || riskTags.has("not_representative")) score -= 0.2;
  if (riskTags.has("seo_content") || riskTags.has("commercial_content") || riskTags.has("soft_article")) score -= 0.5;
  if (riskTags.has("vendor_framing") && origin === "opinion") score -= 0.2;
  if (row.sourceProfile?.isSoftSeo) score -= 3.0;
  if (row.sourceProfile?.isBrandOwned && row.sourceSection === "community") score -= 0.4;
  if (row.sourceProfile?.isRecognizedExternal) score += 0.9;
  if (isSearchEntrypoint(row)) score -= 2.0;
  return score;
}

function mergeDailyItems(items: DailyCandidate[], query: string, routeIntents: string[], ctx: Parameters<typeof annotateDailyItems>[1]): AnnotatedItem[] {
  const annotated = annotateDailyItems(items, ctx);
  const merged = new Map<string, AnnotatedItem>();
  for (const row of annotated) {
    const title = String(row.title ?? "").trim();
    const url = String(row.url ?? "").trim();
    const key = dailyFingerprint(title, url, String(row.source ?? ""));
    if (!title || !key) continue;
    const score = dailyScore(row, query, routeIntents);
    const overlap = round(queryOverlapScore(query, `${title} ${row.summary ?? ""}`), 3);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...row, dailyScore: round(score, 3), queryOverlap: overlap, mergedFrom: [String(row.origin ?? "")] } as AnnotatedItem);
      continue;
    }
    prev.dailyScore = round(Math.max(Number(prev.dailyScore ?? 0), score), 3);
    prev.queryOverlap = Math.max(Number(prev.queryOverlap ?? 0), overlap);
    (prev as AnnotatedItem & { mergedFrom?: string[] }).mergedFrom = [
      ...new Set([...((prev as AnnotatedItem & { mergedFrom?: string[] }).mergedFrom ?? []), String(row.origin ?? "")]),
    ];
    prev.riskTags = [...new Set([...(prev.riskTags ?? []), ...(row.riskTags ?? [])])];
    // 重叠条目里保留**更长**的摘要 —— 信息更多的那个, 与"先来的"无关
    if (String(row.summary ?? "").length > String(prev.summary ?? "").length) prev.summary = row.summary;
    if (!prev.publishedAt && row.publishedAt) prev.publishedAt = row.publishedAt;
  }
  return [...merged.values()].sort(
    (a, b) =>
      Number(b.dailyScore ?? 0) - Number(a.dailyScore ?? 0) ||
      originPriority(String(a.origin ?? "")) - originPriority(String(b.origin ?? "")) ||
      String(a.title ?? "").localeCompare(String(b.title ?? ""))
  );
}

// ═══════════════════════════════════════════════════════════
// 选稿(移植 `_select_daily_items` / `_daily_section_caps`)
// ═══════════════════════════════════════════════════════════

/**
 * 栏目配额。
 *
 * ⚠ 配额是这套设计的**核心机制, 不是美化**: 纯按分数取 top-N 的结果是
 *   "一手来源全占满"(它们底分高), 于是日报变成政策摘要汇编, 社区与外部视角全被挤掉。
 *   给每个栏目**保底 + 上限**, 才逼出"每条线都得有证据"的形态。
 */
function sectionCaps(limit: number): Record<string, number> {
  return {
    official: limit <= 15 ? 3 : 4,
    academic: Math.max(2, Math.floor(limit / 4)),
    ecosystem: Math.max(2, Math.floor(limit / 3)),
    community: Math.max(2, Math.floor(limit / 4)),
    trust: 3,
    other: Math.max(1, Math.floor(limit / 6)),
  };
}

const SECTION_ORDER: SectionKey[] = ["trust", "official", "academic", "ecosystem", "community", "other"];

function selectDailyItems(items: AnnotatedItem[], limit: number): AnnotatedItem[] {
  if (limit <= 0 || !items.length) return [];
  if (limit <= 2) return items.slice(0, limit);
  const selected: AnnotatedItem[] = [];
  const cap = sectionCaps(limit);
  const sectionCount = (key: string) => selected.filter((r) => r.sourceSection === key).length;
  const chosen = new Set<string>();

  const add = (row: AnnotatedItem, allowSoft = false): boolean => {
    if (isSearchEntrypoint(row)) return false;
    if (row.sourceTier === "D" && !allowSoft) return false;
    if (row.sourceProfile?.isSoftSeo && !allowSoft) return false;
    const key = dailyFingerprint(String(row.title ?? ""), String(row.url ?? ""), String(row.source ?? ""));
    if (!key || chosen.has(key)) return false;
    if (sectionCount(row.sourceSection) >= (cap[row.sourceSection] ?? limit)) return false;
    selected.push(row);
    chosen.add(key);
    return true;
  };

  // 第一轮: 每个栏目先保一条 —— 让"一手/学术/外部/社区/风险"都有人
  for (const key of SECTION_ORDER) {
    for (const row of items) {
      if (row.sourceSection === key && add(row)) break;
    }
    if (selected.length >= limit) return selected.slice(0, limit);
  }
  // 第二轮: 按通道轮转, 保证形态多样(不会整版都是同一个通道来的)
  for (const origin of ["archive", "opinion", "hotboard:"]) {
    for (const row of items) {
      const o = String(row.origin ?? "");
      if (o === origin || (origin.endsWith(":") && o.startsWith(origin))) add(row);
      if (selected.length >= limit) return selected.slice(0, limit);
    }
  }
  for (const row of items) {
    add(row);
    if (selected.length >= limit) break;
  }
  // 第三轮才允许 D 层补位 —— 只在前面凑不够时发生
  if (selected.length < limit) {
    for (const row of items) {
      add(row, true);
      if (selected.length >= limit) break;
    }
  }
  return selected.slice(0, limit);
}

/** 候补池(移植 `_build_daily_overflow_items`) —— 落选但仍有价值的线索, 留着改稿/扩展用 */
function buildOverflowItems(
  ranked: AnnotatedItem[],
  selected: AnnotatedItem[],
  limit: number,
  query: string
): AnnotatedItem[] {
  if (limit <= 0) return [];
  const selectedKeys = new Set(
    selected.map((i) => dailyFingerprint(String(i.title ?? ""), String(i.url ?? ""), String(i.source ?? ""))).values()
  );
  selectedKeys.delete("");
  const out: AnnotatedItem[] = [];
  const seen = new Set<string>();
  for (const row of ranked) {
    if (!overflowRelevant(row, query)) continue;
    const key = dailyFingerprint(String(row.title ?? ""), String(row.url ?? ""), String(row.source ?? ""));
    if (!key || selectedKeys.has(key) || seen.has(key) || isSearchEntrypoint(row)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function overflowRelevant(row: AnnotatedItem, query: string): boolean {
  if (!query) return true;
  const text = `${row.title ?? ""} ${row.summary ?? ""}`;
  if (topicMatchStrict(query, text, 0.5)) return true;
  if (Number((row as AnnotatedItem & { queryOverlap?: number }).queryOverlap ?? 0) >= 0.7) return true;
  if (row.sourceProfile?.isBrandOwned) return true;
  if (row.sourceProfile?.isSoftSeo) return Number((row as AnnotatedItem & { queryOverlap?: number }).queryOverlap ?? 0) >= 0.35;
  return false;
}

// ═══════════════════════════════════════════════════════════
// 栏目(移植 `_build_daily_sections`)
// ═══════════════════════════════════════════════════════════

const SECTION_SUMMARIES: Record<string, string> = {
  official: "这一栏只放可直接核验的一手入口: 政策原文、官方发布、统计口径。",
  academic: "这一栏是学界的判断与预印本, 用于定位争鸣位置; 预印本未经同行评审。",
  ecosystem: "这一栏用媒体、产业与订阅源补外部事实, 避免简报退化成官方口径汇编。",
  community: "这一栏看公众与社区样本, 适合判断真实关切与话语走向, **不能外推为总体民意**。",
  trust: "这一栏专门补安全、合规、伦理与数据治理面。",
  other: "这一栏保留仍值得记录但暂不便归类的线索。",
};

function buildDailySections(items: AnnotatedItem[]): DailySection[] {
  const buckets = new Map<SectionKey, AnnotatedItem[]>();
  for (const row of items) {
    const list = buckets.get(row.sourceSection) ?? [];
    list.push(row);
    buckets.set(row.sourceSection, list);
  }
  return [...buckets.entries()].map(([key, rows]) => ({
    key,
    title: sectionTitle(key),
    summary: SECTION_SUMMARIES[key] ?? SECTION_SUMMARIES.other,
    items: rows,
  }));
}

// ═══════════════════════════════════════════════════════════
// 采编自检(移植 `_build_editorial_health`)
// ═══════════════════════════════════════════════════════════

function buildEditorialHealth(opts: {
  sections: DailySection[];
  diagnostics: Record<string, DailyDiagnostic>;
  candidateCount: number;
  query: string;
  routeIntents: string[];
  sourceHealth: SourceHealth;
  storylines: Storyline[];
  timeWindow: TimeWindow;
}): DailyBrief["editorialHealth"] {
  const coverage: Record<string, number> = {};
  for (const s of opts.sections) coverage[s.key] = s.items.length;
  const warnings: string[] = [];
  let status: "ok" | "warn" | "block" = "ok";

  if (opts.candidateCount < 12) warnings.push("候选池偏小, 简报只能当轻量线索, 不适合写强判断。");
  if (coverage.official && !coverage.ecosystem) warnings.push("一手来源已经出现, 但外部报道不足 —— 不能代表全网。");
  if (coverage.official && !coverage.academic) warnings.push("缺学术层: 只有官方口径, 没有学界判断。");
  if (opts.query && !coverage.community) warnings.push("缺公众讨论样本 —— 无法回答「公众怎么看」。");
  if (opts.diagnostics.opinion?.status === "error") warnings.push("舆情检索本轮不可用, 公开讨论层缺失。");
  if (opts.diagnostics.hotboard?.status === "error") warnings.push("热榜层本轮不可用, 不能判断今天是否形成注意力共振。");
  if (opts.diagnostics.archive?.count === 0) warnings.push("本地归档暂无相关材料, 简报引用的都是现场检索线索。");
  if (opts.timeWindow === "today" || opts.timeWindow === "24h") {
    if (!opts.sourceHealth.mainFreshnessCounts.today) {
      warnings.push("本简报时间窗要求今天/24h, 但主正文缺少明确今日证据 —— 不能用「今日最新」的口径。");
    }
  }
  warnings.push(...opts.sourceHealth.warnings);
  if (!opts.storylines.length) warnings.push("还没有形成稳定主线, 当前只能作为线索池。");
  if (warnings.length) status = "warn";
  if (coverage.official && Object.entries(coverage).every(([k, v]) => k === "official" || !v)) {
    status = "block";
    warnings.unshift("候选池只有官方/一手来源, 禁止把它写成简报正文。");
  }
  return { status, coverage, warnings: [...new Set(warnings)] };
}

// ═══════════════════════════════════════════════════════════
// 边界与下一步(移植 `_daily_boundaries` / `_daily_next_steps`)
// ═══════════════════════════════════════════════════════════

function buildBoundaries(opts: {
  routePlan: DailyBrief["routePlan"];
  diagnostics: Record<string, DailyDiagnostic>;
  hasQuery: boolean;
  timeWindow: TimeWindow;
}): string[] {
  const out: string[] = [];
  if (opts.routePlan?.reason) out.push(`选源理由: ${opts.routePlan.reason}`);
  for (const avoid of opts.routePlan?.avoidAsPrimary ?? []) out.push(`不作主要依据: ${avoid}`);
  if (opts.hasQuery) out.push("检索、热榜与公开网页线索适合做选题入口; 正式结论仍应回读代表原文。");
  out.push("热榜热度是平台机制产物, 只说明当下注意力, **不等于民意分布, 更不等于事实**。");
  if (opts.timeWindow === "today" || opts.timeWindow === "24h") {
    out.push("时间窗为今天/24h: 没有明确发布时间的条目不进时间序列(不拿抓取时刻冒充发布时间)。");
  }
  if (opts.diagnostics.opinion?.status === "error") out.push("本轮舆情检索部分源受限, 公开讨论层的覆盖不完整。");
  return [...new Set(out)];
}

/** 下一步(移植 `_daily_next_steps`) —— 给的是**可执行动作**, 不是"建议进一步研究" */
function buildNextSteps(opts: { query: string; items: AnnotatedItem[]; storylines: Storyline[] }): string[] {
  const steps: string[] = [];
  if (opts.query) {
    steps.push(`把最相关的 2-3 条原文归档, 再跑一次「论断台账」核对跨源数值分歧: ${opts.query}`);
  }
  const risky = opts.storylines.find((s) => s.riskLevel === "high" || s.riskLevel === "medium");
  // ⚠ 报**真实命中的标记**, 不要写死一句「涉及合规/伦理/信任面」—— 实测那句话在
  //   reputation 命中(如一条带"道歉"的新闻)时会变成凭空的断言。风险提示必须能被追溯到判据。
  if (risky) steps.push(`优先核验风险线「${risky.headline}」的原始出处(风险标记: ${risky.riskFlags.join("、") || "未标注"})。`);
  const lowConfidence = opts.storylines.find((s) => s.confidence === "low");
  if (lowConfidence) steps.push(`主线「${lowConfidence.headline}」证据强度偏低, 需要补一手或媒体来源再成稿。`);
  const archiveCount = opts.items.filter((i) => String(i.origin ?? "") === "archive").length;
  if (!archiveCount) steps.push("本期没有本地已归档材料支撑; 建议先归档代表页面, 让下一期有可引用底稿。");
  return [...new Set(steps)].slice(0, 5);
}

// ═══════════════════════════════════════════════════════════
// 主入口(移植 `build_daily_report`)
// ═══════════════════════════════════════════════════════════

export async function buildDailyBrief(input: DailyBriefInput): Promise<DailyBrief> {
  const cleanQuery = String(input.query ?? "").trim();
  const timeWindow = normalizeTimeWindow(input.timeWindow ?? "3d");
  let edition = String(input.edition ?? "research").trim().toLowerCase();
  if (!VALID_EDITIONS.has(edition)) edition = "research";
  const limit = Math.min(Math.max(Number(input.limit ?? DEFAULT_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT, 1), MAX_DAILY_LIMIT);
  const overflowLimit = Math.min(Math.max(Number(input.overflowLimit ?? DEFAULT_OVERFLOW_LIMIT) || 0, 0), MAX_OVERFLOW_LIMIT);
  const includeOpinion = input.includeOpinion !== false;
  const includeHotboard = input.includeHotboard !== false;
  const includeArchive = input.includeArchive !== false;

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const generatedAtMs = Date.now();
  const diagnostics: Record<string, DailyDiagnostic> = {
    opinion: { status: "skipped", count: 0, error: "", limit: 80 },
    hotboard: { status: "skipped", count: 0, error: "", limit: 15, source: (input.hotBoards ?? []).join(",") },
    archive: { status: "skipped", count: 0, error: "", limit: 40 },
  };

  // ── 路由(意图 → 信源) ──
  let routePlan: DailyBrief["routePlan"] = null;
  if (cleanQuery) {
    const plan = routeOpinion(cleanQuery);
    routePlan = {
      primary: plan.primary,
      secondary: plan.secondary,
      preferredSourceIds: plan.preferredSourceIds,
      avoidAsPrimary: plan.avoidAsPrimary,
      reason: plan.reason,
      lowConfidence: plan.lowConfidence,
    };
  }
  const routeIntents = [...(routePlan?.primary ?? []), ...(routePlan?.secondary ?? [])];

  const raw: DailyCandidate[] = [];

  // ── 舆情检索(公开讨论层) ──
  if (includeOpinion) {
    try {
      const ids = (input.sourceIds?.length ? input.sourceIds : routePlan?.preferredSourceIds) ?? [];
      const days = timeWindow === "today" || timeWindow === "24h" ? 1 : timeWindow === "7d" ? 7 : 3;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const r = await searchOpinion({
        userId: input.userId,
        query: cleanQuery || "今日热点",
        // ⚠ 路由在此**不开**(`route:false`): 选源已在上面显式做过一次(可能带用户白名单),
        //   再开一遍等于用两套判据选源 —— 结果对不上时无从解释。
        route: false,
        // 路由推荐里有具体源就按它来; 否则不传 sources, 由舆情检索自己跑全部启用源
        sources: ids.length ? ids : undefined,
        since,
        limit: 80,
        llmCalibrate: false,
      });
      const items = fromOpinion(r);
      raw.push(...items);
      diagnostics.opinion = {
        status: items.length ? "ok" : "empty",
        count: items.length,
        error: (r.softErrors ?? []).slice(0, 3).map((e) => `${e.name}: ${e.error}`).join("; ").slice(0, 300),
        limit: 80,
        source: ids.length ? `${ids.length} 个路由推荐源` : "全部启用源",
        note: (r.notes ?? [])[0] ?? "",
      };
    } catch (e: unknown) {
      diagnostics.opinion = { status: "error", count: 0, error: errText(e), limit: 80 };
      logger.warn({ err: errText(e) }, "日报: 舆情检索失败");
    }
  }

  // ── 热榜(注意力层) ──
  if (includeHotboard) {
    try {
      const boards = (input.hotBoards ?? []).length
        ? input.hotBoards!
        // 默认只取前 4 个平台: 15 个全抓是 15 次外网请求, 而日报要的是"此刻的注意力",
        // 4 个综合平台的交集已经够判断"有没有共振"
        : listBoards().slice(0, 4).map((b) => b.id);
      const results = await fetchBoards(boards, 4);
      const items = fromHotboard(results);
      raw.push(...items);
      diagnostics.hotboard = {
        status: items.length ? "ok" : "empty",
        count: items.length,
        error: results.filter((r) => r.error).map((r) => `${r.name ?? r.id}: ${r.error}`).join("; ").slice(0, 200),
        limit: 15,
        source: boards.join(","),
        note: `已取 ${results.filter((r) => r.items?.length).length}/${boards.length} 个平台`,
      };
    } catch (e: unknown) {
      diagnostics.hotboard = { status: "error", count: 0, error: errText(e), limit: 15 };
      logger.warn({ err: errText(e) }, "日报: 热榜抓取失败");
    }
  }

  // ── 本地归档(已读证据层) ──
  if (includeArchive) {
    try {
      const rows = await listArchives(input.userId, { limit: 40, q: cleanQuery || undefined });
      const items = fromArchive(rows) as DailyCandidate[];
      raw.push(...items);
      diagnostics.archive = {
        status: items.length ? "ok" : "empty",
        count: items.length,
        error: "",
        limit: 40,
        source: cleanQuery ? "按主题匹配" : "最近归档",
      };
    } catch (e: unknown) {
      diagnostics.archive = { status: "error", count: 0, error: errText(e), limit: 40 };
    }
  }

  // ── 归一 → 合并 → 打分 ──
  const ranked = mergeDailyItems(raw, cleanQuery, routeIntents, { generatedAt: nowIso, timeWindow });
  // 热榜条目与主题无关时剔掉 —— 否则"某明星离婚"会混进"农村土地政策"的日报
  const filtered = cleanQuery && !routeIntents.includes("public_opinion")
    ? ranked.filter((row) => !String(row.origin ?? "").startsWith("hotboard") || Number((row as AnnotatedItem & { queryOverlap?: number }).queryOverlap ?? 0) >= 0.35)
    : ranked;

  const items = selectDailyItems(filtered, limit);
  const overflowItems = buildOverflowItems(filtered, items, overflowLimit, cleanQuery);

  const sourceHealth = buildSourceHealth(items, overflowItems, { timeWindow });
  const sections = buildDailySections(items);
  const storylines = buildDailyStorylines(items, overflowItems, { query: cleanQuery, edition, timeWindow, limit: 8 });
  let highlights = buildStorylineHighlights(storylines, sourceHealth);
  if (!highlights.length) highlights = buildFallbackJudgments(sections, routePlan);
  const editorialDecisions = buildEditorialDecisions(storylines);
  const editorialHealth = buildEditorialHealth({
    sections, diagnostics, candidateCount: raw.length, query: cleanQuery,
    routeIntents, sourceHealth, storylines, timeWindow,
  });
  const boundaries = buildBoundaries({ routePlan, diagnostics, hasQuery: Boolean(cleanQuery), timeWindow });
  const nextSteps = buildNextSteps({ query: cleanQuery, items, storylines });

  const brief: DailyBrief = {
    schemaVersion: "daily_report_v1",
    title: cleanQuery || "中文互联网今日",
    query: cleanQuery,
    mode: cleanQuery ? "query_daily" : "hot_daily",
    generatedAt: nowIso,
    timeWindow,
    edition,
    routePlan,
    diagnostics,
    sourceMix: countBy(items, (r) => String(r.source ?? "")),
    originMix: countBy(items, (r) => String(r.origin ?? "")),
    tierMix: countBy(items, (r) => String(r.sourceTier ?? "")),
    candidateCount: raw.length,
    itemCount: items.length,
    highlights,
    items,
    overflowItems,
    overflowCount: overflowItems.length,
    sections,
    storylines,
    editorialDecisions,
    sourceHealth,
    editorialHealth,
    boundaries,
    nextSteps,
    historyDelta: await buildHistoryDelta(input.userId, { query: cleanQuery, storylines, generatedAt: nowIso }, { compareDays: input.compareDays ?? 0 }),
    boundary: "简报是公开信号与证据入口, 不是最终判断; 热点、转载与公开网页样本都应在需要时回读原文。",
  };

  if (input.recordHistory) {
    await recordDailyHistory(input.userId, {
      query: cleanQuery, title: brief.title, generatedAt: nowIso,
      timeWindow, edition, storylines, sourceHealth,
    });
    (brief as DailyBrief & { historyRecorded?: boolean }).historyRecorded = true;
  }
  void generatedAtMs;
  return brief;
}

function buildFallbackJudgments(sections: DailySection[], routePlan: DailyBrief["routePlan"]): string[] {
  const bullets: string[] = [];
  const first = (key: SectionKey) => sections.find((s) => s.key === key)?.items[0];
  const official = first("official");
  const academic = first("academic");
  const ecosystem = first("ecosystem");
  const community = first("community");
  if (official) bullets.push(`一手层可核验: ${shortClaim(official)} —— 这代表官方公开口径, 不代表外部分析。`);
  else bullets.push("一手层缺位: 今天没有可核验的政策原文或官方发布。");
  if (academic) bullets.push(`学术层可核验: ${shortClaim(academic)} —— 注意其样本范围与结论适用条件。`);
  if (ecosystem) bullets.push(`外部层可核验: ${shortClaim(ecosystem)} —— 优先回读原文补足语境。`);
  else bullets.push("外部报道层仍偏薄, 今天不能把官方口径写成「全网情况」。");
  if (community) bullets.push(`讨论层可核验: ${shortClaim(community)} —— 它是公开样本, 不能外推为总体民意。`);
  else bullets.push("公众讨论样本不足, 今天还回答不了「公众怎么看」。");
  if (routePlan?.lowConfidence) bullets.push("路由不确定: 已按兜底策略放宽选源, 覆盖可能不完整。");
  return bullets.slice(0, 5);
}

function shortClaim(item: AnnotatedItem | undefined): string {
  if (!item) return "";
  const title = String(item.title ?? "").trim();
  const summary = String(item.summary ?? "").trim();
  const source = String(item.source ?? "").trim();
  let text = summary && summary.length > title.length ? summary : title;
  text = text.replace(/\s+/g, " ").replace(/^[，。]+|[，。]+$/g, "");
  if (text.length > 86) text = text.slice(0, 84) + "...";
  return source ? `${text}(${source})` : text;
}

// ═══════════════════════════════════════════════════════════
// 渲染(移植 `format_daily_markdown` / `format_daily_context`)
// ═══════════════════════════════════════════════════════════

/**
 * 简报 → Markdown。
 *
 * ⚠ 章节顺序是有讲究的, 别重排: 摘要 → 主线 → **关键事实** → 风险与争议 →
 *   公众样本 → **采编自检** → 边界 → 下一步。
 *   把"采编自检"放在正文之前会让人先读免责声明; 放在之后才是"读完再看看哪里不牢"。
 */
export function formatDailyMarkdown(brief: DailyBrief): string {
  const title = brief.title || "中文互联网今日";
  const L: string[] = [
    `# 每日简报 / ${title}`,
    "",
    `> 从 ${brief.candidateCount} 条公开线索里, 筛出 ${brief.itemCount} 条值得继续跟进的内容。`,
    "",
    `- 生成时间: ${brief.generatedAt}`,
    `- 模式: ${brief.mode} · 时间窗: ${brief.timeWindow} · 版本: ${brief.edition}`,
  ];
  if (brief.routePlan) {
    L.push(`- 路由意图: ${[...brief.routePlan.primary, ...brief.routePlan.secondary].join(", ") || "（无）"}`);
    if (brief.routePlan.reason) L.push(`- 选源理由: ${brief.routePlan.reason}`);
  }
  if (Object.keys(brief.tierMix).length) {
    L.push("- 来源层级: " + Object.entries(brief.tierMix).map(([k, v]) => `${k}: ${v}`).join("；"));
  }

  if (brief.highlights.length) {
    L.push("", "## 今日摘要");
    L.push(...brief.highlights.map((h) => `- ${h}`));
  }

  if (brief.storylines.length) {
    L.push("", "## 今日主线");
    brief.storylines.forEach((s, i) => {
      L.push("", `### ${i + 1}. ${s.headline}`);
      L.push(`- 时间: ${s.freshnessLabel}；风险等级: ${s.riskLevel}；动作建议: ${s.recommendedAction}；适合: ${s.teams.join("、")}；信心: ${s.confidence}`);
      L.push(`- 发生了什么: ${s.whatHappened}`);
      L.push(`- 为什么值得看: ${s.whyItMatters}`);
      const tiers = s.sourceSpread.tierCounts;
      if (Object.keys(tiers).length) {
        L.push("- 来源层: " + Object.entries(tiers).map(([k, v]) => `${k}: ${v}`).join("；"));
      }
      if (s.evidenceItems.length) {
        L.push("- 证据锚点:");
        for (const e of s.evidenceItems) {
          const meta = [e.sourceTierLabel || e.sourceTier, e.source, e.freshnessLabel || e.freshness].filter(Boolean).join(" · ");
          L.push(`  - [${e.title}](${e.url})${meta ? ` · ${meta}` : ""}`);
        }
      }
    });

    L.push("", "## 关键事实");
    const facts = brief.storylines.flatMap((s) => s.evidenceItems).filter((e) => ["A", "B"].includes(e.sourceTier));
    if (facts.length) {
      for (const f of facts.slice(0, 8)) L.push(`- ${f.title}${f.source ? `(${f.source})` : ""}`);
    } else {
      L.push("- 目前缺少 A/B 层事实锚点, 不能当成成品简报。");
    }

    L.push("", "## 风险与争议");
    const risky = brief.storylines.filter((s) => ["high", "medium"].includes(s.riskLevel) || s.riskFlags.length);
    if (risky.length) {
      for (const s of risky) L.push(`- ${s.headline}: ${s.riskFlags.join("、") || "风险待核验"}；动作建议 ${s.recommendedAction}`);
    } else {
      L.push("- 未形成高风险主线; 仍需留意隐私、伦理、合规与数据治理信号。");
    }

    L.push("", "## 公众与样本");
    const community = brief.storylines.flatMap((s) => s.evidenceItems).filter((e) => e.section === "community" || e.sourceTier === "C");
    if (community.length) {
      for (const c of community.slice(0, 6)) L.push(`- ${c.title}(样本, 不外推总体民意)`);
    } else {
      L.push("- 公众样本不足; 今天不能下总体民意结论。");
    }

    L.push("", "## 下一步");
    if (brief.nextSteps.length) L.push(...brief.nextSteps.map((s) => `- ${s}`));
    else L.push("- 暂无。");
  }

  if (brief.historyDelta.enabled) {
    const d = brief.historyDelta;
    L.push("", "## 与往期对比");
    L.push(
      `- 新增主线: ${d.newStorylines.length}；延续: ${d.continuedStorylines.length}；` +
      `本期未见: ${d.cooledStorylines.length}；对比窗口: ${d.compareDays} 天(${d.recordsChecked} 期历史)`
    );
    for (const [label, rows] of [["今日新增", d.newStorylines], ["延续观察", d.continuedStorylines], ["本期未见", d.cooledStorylines]] as const) {
      if (rows.length) L.push(`- ${label}: ` + rows.slice(0, 5).map((r) => r.headline).join("；"));
    }
    if (d.persistentRisks.length) L.push(`- **持续风险**: ` + d.persistentRisks.map((r) => r.headline).join("；"));
    // ⚠ 「本期未见」不是「已消退」—— 更可能是这期没抓到。措辞必须留余地。
    L.push("- 说明: 「本期未见」只表示本期检索未覆盖到, **不等于事情结束了**。");
  }

  if (brief.sections.length) {
    L.push("", "## 今日重点");
    for (const section of brief.sections) {
      L.push("", `### ${section.title}`);
      L.push("", section.summary);
      for (const item of section.items) {
        L.push("");
        L.push(item.url ? `#### [${item.title}](${item.url})` : `#### ${item.title}`);
        const meta = [item.source, item.origin, item.evidenceRole, item.publishedAt].filter(Boolean).join(" · ");
        if (meta) L.push("", meta);
        if (item.summary) L.push("", `**事实锚点**: ${item.summary}`);
        L.push("", `**来源层级**: ${item.sourceTierLabel} · 时效: ${item.freshnessLabel}`);
        L.push("", `**今天的边界**: ${item.sourceProfile.boundary}`);
      }
    }
  }

  if (brief.overflowItems.length) {
    L.push("", "## 候补线索池");
    L.push("这些线索没有进入今日重点, 但仍保留给后续补证、改稿或扩展选题使用。");
    brief.overflowItems.forEach((item, i) => {
      const meta = [item.sourceTierLabel, item.source, item.freshnessLabel].filter(Boolean).join(" · ");
      L.push(`${i + 1}. ${item.url ? `[${item.title}](${item.url})` : item.title}${meta ? ` · ${meta}` : ""}`);
    });
  }

  L.push("", "## 采编自检");
  L.push(`- 状态: ${brief.editorialHealth.status}`);
  if (Object.keys(brief.editorialHealth.coverage).length) {
    L.push("- 覆盖: " + Object.entries(brief.editorialHealth.coverage).map(([k, v]) => `${sectionTitle(k)}: ${v}`).join("；"));
  }
  if (brief.sourceHealth.mainFreshnessCounts) {
    L.push("- 时间健康度: " + Object.entries(brief.sourceHealth.mainFreshnessCounts).map(([k, v]) => `${k}: ${v}`).join("；"));
  }
  L.push(...brief.editorialHealth.warnings.map((w) => `- ${w}`));

  L.push("", "## 边界提醒");
  L.push(...brief.boundaries.map((b) => `- ${b}`));
  L.push(`- ${brief.boundary}`);
  return L.join("\n");
}

/** 上下文块(移植 `format_daily_context`) —— 给 Agent 读的紧凑版 */
export function formatDailyContext(brief: DailyBrief): string {
  const L: string[] = [
    `# 每日简报上下文 / ${brief.title}`,
    "",
    `- mode: ${brief.mode}`,
    `- generated_at: ${brief.generatedAt}`,
    `- candidate_count: ${brief.candidateCount}`,
    `- item_count: ${brief.itemCount}`,
    `- time_window: ${brief.timeWindow}`,
    `- editorial_health: ${brief.editorialHealth.status}`,
  ];
  if (brief.routePlan) {
    L.push("- intents: " + [...brief.routePlan.primary, ...brief.routePlan.secondary].join(", "));
  }
  for (const h of brief.highlights) L.push(`- highlight: ${h}`);
  for (const s of brief.storylines) {
    L.push(
      `- storyline: id=${s.id} freshness=${s.freshness} risk=${s.riskLevel} ` +
      `action=${s.recommendedAction} confidence=${s.confidence} title=${s.headline}`
    );
    L.push(`  what_happened=${s.whatHappened}`);
    L.push(`  why_it_matters=${s.whyItMatters}`);
    for (const e of s.evidenceItems) {
      L.push(`  - evidence: tier=${e.sourceTier} source=${e.source} freshness=${e.freshness} title=${e.title}`);
      if (e.url) L.push(`    url=${e.url}`);
    }
  }
  for (const section of brief.sections) {
    L.push(`- section: ${section.title}`);
    for (const row of section.items) {
      L.push(`  - item: origin=${row.origin} source=${row.source} role=${row.evidenceRole} title=${row.title}`);
      if (row.url) L.push(`    url=${row.url}`);
      if (row.summary) L.push(`    summary=${row.summary}`);
      L.push(`    boundary=${row.sourceProfile.boundary}`);
    }
  }
  for (const w of brief.editorialHealth.warnings) L.push(`- editorial_warning: ${w}`);
  for (const b of brief.boundaries) L.push(`- boundary: ${b}`);
  for (const s of brief.nextSteps) L.push(`- next: ${s}`);
  return L.join("\n");
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

/** 与 query 的重叠(移植 `_query_overlap_score`): 命中一个词 0.35 分, 封顶 2.1 */
export function queryOverlapScore(query: string, text: string): number {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const haystack = compactText(text);
  let matched = 0;
  for (const t of tokens) if (compactText(t) && haystack.includes(compactText(t))) matched++;
  return Math.min(matched * 0.35, 2.1);
}

/** 严格主题匹配(移植 `_topic_match_strict`) */
export function topicMatchStrict(query: string, text: string, minRatio = 0.5): boolean {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const important = tokens.filter((t) => !["今天", "今日", "最新", "2025", "2026"].includes(compactText(t)));
  const check = important.length ? important : tokens;
  const haystack = compactText(text);
  const matched = check.filter((t) => haystack.includes(compactText(t))).length;
  if (!check.length) return true;
  if (check.length <= 2) return matched === check.length;
  return matched / check.length >= minRatio;
}

function queryTokens(query: string): string[] {
  const compact = String(query ?? "").trim();
  if (!compact) return [];
  const raw = compact.split(/[\s/,_:+\-]+/);
  const out: string[] = [];
  for (const t of raw) {
    const clean = t.trim();
    if (clean.length >= 2) out.push(clean);
  }
  // 中文 query 常常整句没有分隔符 —— 那就按 2-4 字滑窗切, 否则 overlap 恒为 0
  if (!out.length && compact.length >= 2) {
    for (let i = 0; i < Math.min(compact.length, 16); i += 2) {
      const chunk = compact.slice(i, i + 4);
      if (chunk.length >= 2) out.push(chunk);
    }
  }
  return [...new Set(out)].slice(0, 16);
}

function countBy<T>(items: T[], pick: (x: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const v = String(pick(it) ?? "").trim();
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function errText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).slice(0, 200);
}
