// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// daily-quality-service.ts — 每日简报的**采编判据层**(2026-10-04)
//
// ⚠ **源码移植**自开源项目 观澜/Guanlan(MIT, https://github.com/shenyangs/Guanlan)
//   的 `guanlan/daily_quality.py`(逐函数转 TypeScript: `classify_daily_source` /
//   `normalize_daily_freshness` / `annotate_daily_item(s)` / `build_daily_source_health` /
//   `daily_is_soft_seo` / `daily_is_recognized_external` / `daily_is_brand_owned` /
//   `daily_is_brand_owned_community` / `daily_is_brand_imitating_domain` /
//   `daily_is_trust_related` / `daily_is_search_entrypoint` / `daily_section_key` /
//   `daily_section_title` / `daily_domain` / `normalize_daily_time_window`)。
//   见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 它解决什么问题 ═══
//   把"官方口径"和"网友怎么说"和"某下载站的软文"**并排放在一个列表里**, 是自动聚合最危险的
//   失败模式: 读者会把三者当成同一种证据。观澜这套判据的贡献就是**在采集阶段就把层级钉死**:
//     A 一手/官方/监管   B 媒体/产业/开发者   C 社区/用户样本   D 弱线索/SEO/转载
//   外加时效分层(today / recent_3d / recent_7d / background / unknown)与栏目归属。
//   下游(选稿、主线聚类、日报正文)全部按这两个维度工作, 而不是靠"标题看着像"。
//
// ═══ 三条口径(照搬原文, 用之前必须知道) ═══
//   ① **tier 是"这类来源通常有多少证据效力", 不是"这条为真"** —— A 层也会有错, D 层也可能对。
//   ② **时间未知就是未知**。绝不把没有发布时间的条目补成 now() —— 那会把"今天我抓得多"
//      伪装成"今天讨论量暴增"。
//   ③ **D 层不是"要丢弃"**, 是"不能进正文"。它仍然进候补线索池。
//
// ═══ 与观澜的差别(我们自己的适配, 不是照抄) ═══
//   它这套判据是给**品牌舆情监测**调的(WPS 的自有域名、仿冒域名、下载站黑名单…)。
//   我们是**人文社科研究平台**, 所以:
//     · 自有域名/仿冒域名判别保留**机制**, 但域名表换成可配置项(`ownedDomains` /
//       `ownedCommunityHosts`), 默认给政务与央媒 —— 对社科研究来说"官方发布"才是 A 层主体;
//     · 新增 **`academic` 栏目**(同行评审归一档 A、预印本归 B) —— 它的栏目体系里没有
//       学术这一档, 文献会被挤进 "ecosystem"; 对科研平台这是不能忍的失真;
//     · 软 SEO 域名表换成中文内容农场/文库站的真实名单;
//     · 来源画像(权威/样本/时效三维)直接复用本仓 `opinion-router.ts` 的 `profileOf()`,
//       不另建一套 —— 一个仓里同一件事只能有一个真源。

import { profileOf, registeredSourceIds } from "./opinion-router.js";

export type SourceTier = "A" | "B" | "C" | "D";
export type DailySection = "official" | "academic" | "ecosystem" | "community" | "trust" | "other";
export type Freshness = "today" | "recent_3d" | "recent_7d" | "background" | "unknown";
export type TimeWindow = "today" | "24h" | "3d" | "7d";

export const SOURCE_TIER_LABELS: Record<SourceTier, string> = {
  A: "A 一手/官方/监管",
  B: "B 媒体/产业/开发者",
  C: "C 社区/用户样本",
  D: "D 弱线索/SEO/转载",
};

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  today: "今天",
  recent_3d: "近 3 天",
  recent_7d: "近 7 天",
  background: "背景资料",
  unknown: "时间未知",
};

const VALID_TIME_WINDOWS = new Set<string>(["today", "24h", "3d", "7d"]);

/**
 * 当事方自有域名(默认值 = 政务与央媒)。
 *
 * ⚠ 与观澜同名函数的**语义差别**: 它的这份表是 WPS 的自有域名, 用来判"这是品牌自述"。
 *   我们要判的是"这是不是**当事方自己发的**" —— 对社科研究, 主体通常不是企业而是
 *   **政府/机构**: 政策原文、统计公报、部门通报。所以默认表给政务与央媒,
 *   调用方研究具体机构时用 `opts.ownedDomains` 传自己的。
 */
const DEFAULT_OWNED_DOMAINS = [
  "gov.cn",
  "npc.gov.cn",
  "cppcc.gov.cn",
  "stats.gov.cn",
  "people.com.cn",
  "xinhuanet.com",
  "news.cn",
  "qstheory.cn",
  "gov.uk",
  "europa.eu",
];

/** 当事方自有社区(论坛/BBS) —— 那里的样本"能看使用场景, 不能当独立第三方评价" */
const DEFAULT_OWNED_COMMUNITY_HOSTS: string[] = [];

/**
 * 软 SEO / 内容农场 / 文库站。
 *
 * 判据不是"这站low", 而是**这类页面的标题与正文是按搜索词生成的**, 不是自然表达:
 * 同一段内容换三十个标题反复出现, 拿它做"公众怎么想"的证据会系统性失真。
 * (观澜那份表是给 WPS 关键词调的, 这里是中文社科议题常撞上的那批。)
 */
const SOFT_SEO_DOMAINS = [
  "baijiahao.baidu.com",
  "360doc.com",
  "docin.com",
  "doc88.com",
  "book118.com",
  "renrendoc.com",
  "pc6.com",
  "onlinedown.net",
  "downza.cn",
  "crsky.com",
  "xiangjiao.com",
  "wenku.baidu.com",
];

/**
 * 可识别的外部媒体/产业媒体白名单。
 *
 * 作用: 当一条线索**没有** evidenceRole 也没有 source_card 时, 域名是最后的判据 ——
 * 有它在, 至少能确定"这是有人做编辑的媒体", 而不是"某个我认不出的网页"。
 * 白名单之外的通用网页归 D(候补), 因为无法判断它是不是自建站/转载站。
 */
const RECOGNIZED_EXTERNAL_DOMAINS = [
  "thepaper.cn", "jiemian.com", "yicai.com", "caixin.com", "cls.cn", "stcn.com",
  "36kr.com", "huxiu.com", "leiphone.com", "sspai.com", "geekpark.net", "ifanr.com",
  "tmtpost.com", "donews.com", "ithome.com",
  "sina.com.cn", "sina.cn", "new.qq.com", "qq.com", "163.com", "sohu.com", "ifeng.com",
  "chinanews.com.cn", "cctv.com", "gmw.cn", "guangming.com.cn", "bjnews.com.cn",
  "nbd.com.cn", "21jingji.com", "eeo.com.cn", "zaobao.com",
  "nature.com", "science.org", "sciencedirect.com", "springer.com", "wiley.com",
  "tandfonline.com", "sagepub.com", "jstor.org", "ssrn.com", "arxiv.org", "osf.io",
];

/** 证据角色 → 层级 A(一手/监管/同行评审)。与舆情源的 evidenceRole 同一套值。 */
const OFFICIAL_ROLES = new Set([
  "company_primary", "product_primary", "official_primary", "government",
  "company_filing", "security_advisory", "authoritative_report", "regulator_notice",
  "database_official", "publisher_guideline",
]);

/** 学术来源角色 —— 本仓新增(A 档=同行评审, B 档=预印本/工作论文, 在下方分流) */
const ACADEMIC_PRIMARY_ROLES = new Set(["research_primary", "peer_reviewed", "journal_article"]);
const ACADEMIC_PREPRINT_ROLES = new Set(["preprint_record", "preprint", "working_paper"]);

const ECOSYSTEM_ROLES = new Set([
  "industry_report", "vertical_report", "fresh_news", "news_signal", "tech_news_signal",
  "market_news", "market_quote", "reading_signal", "ai_vertical_discovery_signal",
  "technical_note",
]);

const COMMUNITY_ROLES = new Set([
  "community_discussion", "developer_discussion", "user_sample", "review",
  "platform_metric", "public_discussion", "social_signal", "sentiment_sample",
  "user_visible_sample",
]);

/**
 * 风险/信任议题的命中词 —— **分强/弱两档, 这是本仓改过的地方**。
 *
 * ⚠ 原文是一张平坦的词表, 命中**任意一个**就归 trust 栏目。那在品牌监测里没问题
 *   (它盯的就是自己那几个关键词)。放到通用研究检索上会立刻失真 —— 实测:
 *   「国庆长假自驾出行 怎么开才**安全**」「机票…**数据**」这类**与风险无关的日常新闻**
 *   全被判成「风险与信任」, 于是整个栏目被噪声占满, 而真正该看的合规材料被埋掉。
 *   根因是「安全」「数据」这两个词在中文里太常见了。
 *
 *   改法: 强词(本身即风险议题)一个就够; 弱词(需要上下文才成立)要**凑够两个不同词**。
 *   这条判据把"某个词出现过"换成"这个材料的风险语境是复合的", 误报率立刻降下来,
 *   而真正的合规材料(通常同时提隐私/数据/伦理)照旧命中。
 */
const TRUST_STRONG = [
  "数据出境", "个人信息保护", "隐私政策", "伦理审查", "知情同意", "数据治理",
  "监管处罚", "算法备案", "security", "privacy", "compliance",
];
const TRUST_WEAK = [
  "安全", "合规", "隐私", "数据", "漏洞", "审计", "信创", "采购", "企业信任", "侵权",
];

/** 标题党/软文信号词 —— 用在**标题**上(不是正文)。命中即判 D。 */
const SOFT_TITLE_TERMS = [
  "秘密武器", "全解析", "告别加班", "一键做", "小白", "保姆级",
  "效率直接翻倍", "塞进", "全攻略", "领取", "激活智能",
  "资源导航站", "ai资源导航", "官网下载", "免费下载安装", "破解版", "绿色版", "安装包",
  "震惊", "不看后悔", "必看", "最全整理",
];

/**
 * 取源画像 —— 先按 **id**(登记表用的就是它), 再按**显示名**。
 *
 * ⚠ 为什么要两步(2026-10-04 实测): 热榜的 15 个榜 id(`zhihu`/`weibo`/`baidu`…)与舆情源的
 *   21 个画像键(`weibo-hot`/`gov-cn-policy`…)里**只有一个重合**。只按 id 查的话, 14 个榜
 *   会静默拿到中性默认值 0.5 —— 而我补 `sourceId` 的**全部理由**就是把"热榜是注意力样本,
 *   不是事实"那条价值(权威 0.15 / 样本 0.9)带进打分。
 *   第二步用 `registeredSourceIds()` 判断"到底有没有登记过", 而不是拿默认值的形状去猜 ——
 *   那些默认值长得跟真值一样(都是 0.5 + 一段中文说明), 猜不出来。
 */
function profileOfWithDefaults(id: string | undefined, displayName: string | undefined) {
  const registered = registeredSourceIds();
  const tryKey = (key: string) => {
    const k = key.trim().toLowerCase();
    return k && registered.includes(k) ? profileOf(k) : null;
  };
  const byId = tryKey(String(id ?? ""));
  if (byId) return byId;
  const nameKey = String(displayName ?? "").trim().toLowerCase();
  if (nameKey) {
    const byName = tryKey(nameKey);
    if (byName) return byName;
    // 显示名里含某个已登记 id(「知乎热榜」→ "zhihu"): 子串匹配, 取最长的那个命中。
    // 这不算模糊猜测 —— 显示名是登记 id 的扩展, 命中即同一个源。
    const hit = registered.filter((k) => nameKey.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (hit) return profileOf(hit);
  }
  return profileOf(String(id ?? ""));
}

export function normalizeTimeWindow(value: string): TimeWindow {
  const clean = String(value ?? "3d").trim().toLowerCase();
  return (VALID_TIME_WINDOWS.has(clean) ? clean : "3d") as TimeWindow;
}

// ═══════════════════════════════════════════════════════════
// 一条候选的归一
// ═══════════════════════════════════════════════════════════

export interface DailyCandidate {
  title: string;
  url: string;
  summary?: string;
  /** 来源显示名(给人看的, 如「澎湃新闻」「知乎热榜」) */
  source?: string;
  /**
   * 来源 **id** —— 查权威/样本/时效三维画像用这个, 不是显示名。
   * ⚠ 2026-10-04 补: 我第一版只传了显示名("百度热搜"), 而 `SOURCE_PROFILE` 的键是源 id
   *   ("weibo-hot" / "gov-cn-policy") —— 于是**每一次画像查询都落到中性默认值 0.5**,
   *   权威分那一项等于不存在。这是"静默降级": 不报错, 只是分权重永远不动。
   */
  sourceId?: string;
  /** 采集通道: search / opinion / hotboard / archive / digest / feeds:xxx */
  origin?: string;
  /** 证据角色(与舆情源同一套), 缺失时退到域名判据 */
  evidenceRole?: string;
  publishedAt?: string;
  riskTags?: string[];
  metrics?: Record<string, unknown>;
  /** 采集阶段的打分(检索相关度/热榜位次), 排序用 */
  baseScore?: number;
  /** 已归一时跳过重复分类 */
  sourceProfile?: SourceProfile;
}

export interface SourceProfile {
  domain: string;
  sourceTier: SourceTier;
  sourceTierLabel: string;
  section: DailySection;
  sectionTitle: string;
  /** 一句话边界 —— **它必须一路带到界面上**, 否则层级就白分了 */
  boundary: string;
  isSoftSeo: boolean;
  isBrandOwned: boolean;
  isBrandOwnedCommunity: boolean;
  isRecognizedExternal: boolean;
  isTrustRelated: boolean;
  authorityScore: number;
  sampleValue: number;
  freshnessValue: number;
  riskTags: string[];
}

export interface AnnotatedItem extends DailyCandidate {
  sourceProfile: SourceProfile;
  sourceTier: SourceTier;
  sourceTierLabel: string;
  sourceSection: DailySection;
  freshness: Freshness;
  freshnessLabel: string;
  freshnessDays: number | null;
  freshnessInWindow: boolean;
  freshnessEvidence: string;
  riskTags: string[];
  /** 采集阶段的打分, 供选稿排序 */
  dailyScore?: number;
  /** 与 query 的重叠分 —— 由编排层(去重合并时)填, 判据层不依赖它 */
  queryOverlap?: number;
  /** 这条线索被合并进来的通道(同一件事在多个源出现) */
  mergedFrom?: string[];
}

export function annotateDailyItem(
  item: DailyCandidate,
  opts: { generatedAt?: string; timeWindow?: string; ownedDomains?: string[]; ownedCommunityHosts?: string[] } = {}
): AnnotatedItem {
  const row = { ...item };
  const profile = classifyDailySource(row, opts);
  const freshness = normalizeFreshness(
    row.publishedAt ?? "",
    {
      generatedAt: opts.generatedAt ?? "",
      timeWindow: opts.timeWindow ?? "3d",
      text: `${row.title ?? ""} ${row.summary ?? ""}`,
    }
  );
  return {
    ...row,
    sourceProfile: profile,
    sourceTier: profile.sourceTier,
    sourceTierLabel: profile.sourceTierLabel,
    sourceSection: profile.section,
    freshness: freshness.freshness,
    freshnessLabel: freshness.label,
    freshnessDays: freshness.days,
    freshnessInWindow: freshness.inWindow,
    freshnessEvidence: freshness.evidence,
    riskTags: uniqueStrings([...(row.riskTags ?? []), ...profile.riskTags]),
  };
}

export function annotateDailyItems(
  items: DailyCandidate[],
  opts: { generatedAt?: string; timeWindow?: string; ownedDomains?: string[]; ownedCommunityHosts?: string[] } = {}
): AnnotatedItem[] {
  return items.map((it) => annotateDailyItem(it, opts));
}

// ═══════════════════════════════════════════════════════════
// 来源分层(移植 `classify_daily_source`)
// ═══════════════════════════════════════════════════════════

export function classifyDailySource(
  item: DailyCandidate,
  opts: { ownedDomains?: string[]; ownedCommunityHosts?: string[] } = {}
): SourceProfile {
  const url = String(item.url ?? "");
  const domain = domainOf(url);
  const role = String(item.evidenceRole ?? "");
  const source = String(item.source ?? "");
  const origin = String(item.origin ?? "");
  const titleSummary = `${item.title ?? ""} ${item.summary ?? ""}`;
  const riskTags = uniqueStrings([...(item.riskTags ?? [])]);

  // 三维价值分复用本仓 opinion-router 的源画像 —— 同一个仓里同一件事只能有一个真源
  const prof = profileOfWithDefaults(item.sourceId, source);
  const authorityScore = prof.authority;
  const sampleValue = prof.sample;
  const freshnessValue = prof.freshness;

  const soft = isSoftSeo(item, domain);
  const brandOwned = isBrandOwned(item, domain, opts.ownedDomains);
  const brandCommunity = isBrandOwnedCommunity(item, domain, opts.ownedCommunityHosts);
  const recognizedExternal = isRecognizedExternal(item, domain);
  const trust = isTrustRelated(item, titleSummary);

  let tier: SourceTier;
  let section: DailySection;
  let boundary: string;

  if (soft) {
    tier = "D";
    section = "other";
    boundary = "弱 SEO、下载站、文库转载或标题党, 只能作为候补线索, 不进正文。";
  } else if (trust) {
    // 信任议题**单独成栏**: 它可能是 A 层(监管通报)也可能是 B 层(媒体报道),
    // 但无论哪层都不能混在普通条目里 —— 这是采编上最容易漏的一类。
    tier = OFFICIAL_ROLES.has(role) || authorityScore >= 0.75 ? "A" : "B";
    section = "trust";
    boundary = "安全、合规、隐私、伦理审查或数据治理相关材料, 需要保留风险语境。";
  } else if (ACADEMIC_PRIMARY_ROLES.has(role)) {
    tier = "A";
    section = "academic";
    boundary = "同行评审文献, 可作学理依据; 注意样本范围与结论的适用条件。";
  } else if (ACADEMIC_PREPRINT_ROLES.has(role)) {
    tier = "B";
    section = "academic";
    boundary = "预印本/工作论文, 未经同行评审, 引用必须注明。";
  } else if (brandCommunity) {
    tier = "C";
    section = "community";
    boundary = "当事方自有社区的公开样本, 只能观察使用场景, 不能外推整体口碑。";
  } else if (brandOwned || role === "company_primary" || role === "product_primary" || role === "official_primary") {
    tier = "A";
    section = "official";
    boundary = "官方或当事方自有口径, 适合作为事实锚点, **不代表外部评价**。";
  } else if (
    OFFICIAL_ROLES.has(role) ||
    (role && /government|official|regulator/.test(role))
  ) {
    tier = "A";
    section = "official";
    boundary = "一手、监管、官方或权威入口。";
  } else if (COMMUNITY_ROLES.has(role) || looksLikeCommunity(domain, source, titleSummary)) {
    tier = "C";
    section = "community";
    boundary = "社区/用户/开发者样本, 只能代表局部公开讨论, **不能外推为总体**。";
  } else if (ECOSYSTEM_ROLES.has(role) || origin.startsWith("feeds:") || recognizedExternal) {
    tier = "B";
    section = "ecosystem";
    boundary = "外部报道、产业媒体、垂直媒体或开发者材料。";
  } else {
    // ⚠ 兜底不猜: 认不出来的通用网页归 D。**宁可把它算弱, 不要把它算进正文** ——
    //   把一个自建站当成媒体来源写进日报, 比少一条线索严重得多。
    tier = looksLikeMediaOrIndustry(source) ? "B" : "D";
    section = tier === "B" ? "ecosystem" : "other";
    boundary = "通用公开网页, 来源性质未识别, 引用前必须回读原文确认。";
  }

  const tags = [...riskTags];
  if (tier === "D") tags.push("weak_lead");
  if (brandOwned) tags.push("vendor_framing");
  if (brandCommunity) tags.push("vendor_moderation", "not_representative");

  return {
    domain,
    sourceTier: tier,
    sourceTierLabel: SOURCE_TIER_LABELS[tier],
    section,
    sectionTitle: sectionTitle(section),
    boundary,
    isSoftSeo: soft,
    isBrandOwned: brandOwned,
    isBrandOwnedCommunity: brandCommunity,
    isRecognizedExternal: recognizedExternal,
    isTrustRelated: trust,
    authorityScore,
    sampleValue,
    freshnessValue,
    riskTags: uniqueStrings(tags),
  };
}

// ═══════════════════════════════════════════════════════════
// 时效分层(移植 `normalize_daily_freshness`)
// ═══════════════════════════════════════════════════════════

export interface FreshnessResult {
  freshness: Freshness;
  label: string;
  days: number | null;
  inWindow: boolean;
  /** 判成这个桶的依据 —— 界面要能解释"为什么说它是今天的" */
  evidence: string;
}

export function normalizeFreshness(
  value: unknown,
  opts: { generatedAt?: string; timeWindow?: string; text?: string } = {}
): FreshnessResult {
  const window = normalizeTimeWindow(opts.timeWindow ?? "3d");
  const now = parseDatetime(opts.generatedAt ?? "") ?? new Date();
  const raw = String(value ?? "").trim();
  const parsed = parseDatetime(raw) ?? parseDatetimeFromText(opts.text ?? "");
  const evidence = raw;

  if (!parsed) {
    // 没有可解析的时间 —— 只在**文字里明说**相对时间时才兜底(「刚刚」「昨天」),
    // 否则一律 unknown。这就是原文那条纪律: 不拿抓取时刻冒充发布时间。
    const lowered = String(opts.text ?? "").toLowerCase();
    if (["今天", "今日", "刚刚", "小时前", "分钟前", "today"].some((t) => lowered.includes(t))) {
      return payload("today", 0, true, evidence || "text:today");
    }
    if (["昨天", "昨日", "1天前", "2天前", "3天前"].some((t) => lowered.includes(t))) {
      const days = ["昨天", "昨日", "1天前"].some((t) => lowered.includes(t)) ? 1 : 3;
      return payload("recent_3d", days, daysInWindow(days, window), evidence || "text:recent");
    }
    return payload("unknown", null, window !== "today" && window !== "24h", "");
  }
  const ms = now.getTime() - parsed.getTime();
  const days = Math.max(Math.floor(ms / 86_400_000), 0);
  let bucket: Freshness;
  if (days === 0) bucket = "today";
  else if (days <= 3) bucket = "recent_3d";
  else if (days <= 7) bucket = "recent_7d";
  else bucket = "background";
  return payload(bucket, days, daysInWindow(days, window), evidence || parsed.toISOString());
}

function payload(bucket: Freshness, days: number | null, inWindow: boolean, evidence: string): FreshnessResult {
  return { freshness: bucket, label: FRESHNESS_LABELS[bucket], days, inWindow, evidence };
}

function daysInWindow(days: number, window: TimeWindow): boolean {
  if (window === "today" || window === "24h") return days === 0;
  if (window === "3d") return days <= 3;
  if (window === "7d") return days <= 7;
  return days <= 3;
}

/**
 * 解析时间。
 *
 * ⚠ 与 Python `datetime.fromisoformat` 的**一处真实差别**: Python 对
 *   `"2026-10-04"`(纯日期)是**朴素时间**, 原文给它补 `tzinfo=utc`;
 *   而 JS 的 `new Date("2026-10-04")` 也按 UTC 解 —— 这一处两边一致, 可放心。
 *   但 `new Date("2026年10月4日")` 在 JS 里是 **Invalid Date**(V8 不认中文日期),
 *   所以中文格式必须走下面的显式列表 —— 漏了它, 中文站的时间会全变成 unknown,
 *   表现为"日报里没有一条今天的新闻"。
 */
export function parseDatetime(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace("Z", "+00:00");
  for (const candidate of [normalized, normalized.slice(0, 19), normalized.slice(0, 10)]) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) {
      if (candidate.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        return new Date(`${candidate}T00:00:00Z`);
      }
      return d;
    }
  }
  /**
   * 中文/斜杠/点号日期。
   *
   * ⚠ 分隔符两侧的 `\s*` **不能省**: 中文写作习惯在数字与单位之间留空格(「2026 年 10 月 4 日」),
   *   这是政策文件与新闻稿的常见写法, 不是排版不规整。少了它, 这类日期一律判成"时间未知",
   *   表现为"日报里一条今天的消息都没有" —— 与 claim-ledger 那次踩的是同一个坑。
   */
  const m = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(raw);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (!Number.isNaN(d.getTime())) return d;
    return null;
  }
  return parseDatetimeFromText(raw);
}

function parseDatetimeFromText(text: string): Date | null {
  const raw = String(text ?? "");
  const full = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(raw);
  if (full) {
    const d = new Date(Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // 「10月4日」这种年内短日期: 补**当年**。跨年时会差一岁, 所以只在没有完整年份时用。
  const short = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(raw);
  if (short) {
    const d = new Date(Date.UTC(new Date().getUTCFullYear(), Number(short[1]) - 1, Number(short[2])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 来源健康度(移植 `build_daily_source_health`)
// ═══════════════════════════════════════════════════════════

export interface SourceHealth {
  tierCounts: Record<string, number>;
  mainTierCounts: Record<string, number>;
  freshnessCounts: Record<string, number>;
  mainFreshnessCounts: Record<string, number>;
  sectionCounts: Record<string, number>;
  timeWindow: TimeWindow;
  weakLeadCount: number;
  mainWeakLeadCount: number;
  todayCount: number;
  unknownTimeCount: number;
  /** 采编自检警告 —— 直接给用户看, 说明这期日报**哪里不成立** */
  warnings: string[];
}

/**
 * 汇总证据质量。
 *
 * ⚠ 这里的 warnings 是给**读者**看的, 不是给开发者看的日志: 它们说的是
 *   "这期日报的哪个结论现在还不能下"(缺外部层 / 缺今日证据 / D 层混进正文)。
 *   一条"今天没有今天的证据"远比一个漂亮的摘要诚实。
 */
export function buildSourceHealth(
  items: AnnotatedItem[],
  overflowItems: AnnotatedItem[] = [],
  opts: { timeWindow?: string } = {}
): SourceHealth {
  const pool = items;
  const all = [...pool, ...overflowItems];
  const tierOf = (row: AnnotatedItem) => row.sourceTier ?? classifyDailySource(row).sourceTier;
  // ⚠ 逐字移植时这里最容易写回 Python 的生成器语法(`count(x for x in y)`) —— TS 里必须显式 map
  const tierCounts = count(all.map(tierOf));
  const mainTierCounts = count(pool.map(tierOf));
  const freshnessCounts = count(all.map((row) => String(row.freshness ?? "unknown")));
  const mainFreshnessCounts = count(pool.map((row) => String(row.freshness ?? "unknown")));
  const sectionCounts = count(pool.map((row) => String(row.sourceSection ?? "other")));
  const warnings: string[] = [];

  if (mainTierCounts.D) warnings.push("主正文仍含 D 层弱线索, 发布前应降入候补线索池或补强来源。");
  if (mainTierCounts.A && !mainTierCounts.B) warnings.push("主正文缺少 B 层外部媒体/产业/开发者来源, 不能代表全网情况。");
  const window = normalizeTimeWindow(opts.timeWindow ?? "3d");
  if (!mainFreshnessCounts.today && (window === "today" || window === "24h")) {
    warnings.push("当前时间窗要求今天/24h, 但主正文缺少明确今日证据。");
  }
  const unknownCount = mainFreshnessCounts.unknown ?? 0;
  if (pool.length && unknownCount / Math.max(pool.length, 1) >= 0.5) {
    warnings.push("主正文时间未知占比偏高, 避免使用「今天」「最新」等强时间表述。");
  }

  return {
    tierCounts,
    mainTierCounts,
    freshnessCounts,
    mainFreshnessCounts,
    sectionCounts,
    timeWindow: window,
    weakLeadCount: tierCounts.D ?? 0,
    mainWeakLeadCount: mainTierCounts.D ?? 0,
    todayCount: mainFreshnessCounts.today ?? 0,
    unknownTimeCount: unknownCount,
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════
// 单项判据
// ═══════════════════════════════════════════════════════════

export function sectionKeyOf(item: DailyCandidate): DailySection {
  if (item.sourceProfile?.section) return item.sourceProfile.section;
  return classifyDailySource(item).section;
}

export function sectionTitle(key: string): string {
  return (
    {
      official: "一手动态",
      academic: "学术与预印本",
      ecosystem: "外部报道与行业观察",
      community: "社区与样本",
      trust: "风险与信任",
      other: "其他线索",
    } as Record<string, string>
  )[String(key ?? "")] ?? "其他线索";
}

/** 搜索入口页(「XX - 百度搜索」这种)不是线索, 是路径 —— 选稿时排除 */
export function isSearchEntrypoint(item: DailyCandidate): boolean {
  const title = compactText(String(item.title ?? ""));
  const summary = compactText(String(item.summary ?? ""));
  const url = String(item.url ?? "").toLowerCase();
  if (!title.includes("搜索") && !url.includes("search")) return false;
  return summary.includes("入口") || url.includes("sousuo") || url.includes("/search");
}

export function isSoftSeo(item: DailyCandidate, domain?: string): boolean {
  if (item.sourceProfile?.isSoftSeo === true) return true;
  const title = String(item.title ?? "").toLowerCase();
  const d = domain ?? domainOf(String(item.url ?? ""));
  if (d && SOFT_SEO_DOMAINS.some((b) => d === b || d.endsWith(`.${b}`))) return true;
  if (isBrandImitatingDomain(d)) return true;
  if (isBrandOwned(item, d)) return false;
  return SOFT_TITLE_TERMS.some((t) => title.includes(t));
}

export function isRecognizedExternal(item: DailyCandidate, domain?: string): boolean {
  if (item.sourceProfile?.isRecognizedExternal === true) return true;
  const d = domain ?? domainOf(String(item.url ?? ""));
  if (d && RECOGNIZED_EXTERNAL_DOMAINS.some((k) => d === k || d.endsWith(`.${k}`))) return true;
  const source = String(item.source ?? "");
  return ["科技", "商业", "产业", "媒体", "财经", "新闻", "开发者", "期刊", "学报"].some((t) => source.includes(t));
}

export function isBrandOwned(item: DailyCandidate, domain?: string, ownedDomains?: string[]): boolean {
  if (item.sourceProfile?.isBrandOwned === true) return true;
  const d = domain ?? domainOf(String(item.url ?? ""));
  if (!d) return false;
  const list = ownedDomains ?? DEFAULT_OWNED_DOMAINS;
  return list.some((k) => d === k || d.endsWith(`.${k}`));
}

export function isBrandOwnedCommunity(item: DailyCandidate, domain?: string, hosts?: string[]): boolean {
  if (item.sourceProfile?.isBrandOwnedCommunity === true) return true;
  const d = domain ?? domainOf(String(item.url ?? ""));
  if (!d) return false;
  const list = hosts ?? DEFAULT_OWNED_COMMUNITY_HOSTS;
  return list.some((k) => d === k || d.endsWith(`.${k}`));
}

/**
 * 仿冒域名(移植 `daily_is_brand_imitating_domain`)。
 *
 * ⚠ 这条判据的**原语境是反钓鱼**: `jsbg-wps.com.cn` 这类站挂着官方名字却不是官方。
 *   移植时把它**降级成软 SEO 的一个子判据**并去掉了具体品牌名 —— 我们不做品牌维权,
 *   但"域名里塞着机构名却不是该机构"这条逻辑对研究用途仍然成立:
 *   一个自称某大学/某机构、域名却对不上的站, 它的内容不能当一手材料。
 */
export function isBrandImitatingDomain(domain: string | undefined, ownedDomains?: string[]): boolean {
  const value = String(domain ?? "").toLowerCase();
  if (!value) return false;
  const list = ownedDomains ?? DEFAULT_OWNED_DOMAINS;
  if (list.some((k) => value === k || value.endsWith(`.${k}`))) return false;
  return ["download", "office", "guanwang", "zhengfu", "gov-", "-gov"].some((t) => value.includes(t));
}

/**
 * 网页**样板文字** —— 风险词判据在匹配之前必须先剥掉它们。
 *
 * ⚠⚠ 这是本仓加的, 而且是**实测逼出来的**(2026-10-04): 一条亚运会新闻被标成 high risk,
 *   命中的是摘要结尾的「©2026 中央广播电视总台**版权所有**。未经许可, 请勿转载使用。」
 *   —— 那是页脚样板, 不是内容。
 *
 *   为什么这条必须在这里而不是"以后再说": 中文主流站的摘要**几乎全都**带版权/免责声明,
 *   于是「版权」这个词会把**整个 B 层媒体**全部判成合规风险 —— 误报率接近 100%,
 *   风险管理退化成"每条都是风险", 用户很快就不再看了。而这套判据的全部价值就在于
 *   "少数几条真需要人看的"。**一个恒真的判据等于没有判据。**
 *
 * 剥法是按句切掉**含样板标记的整句**(不是删词): 样板句里通常还混着别的内容词,
 * 只删"版权"两个字会把上下文一起弄坏。
 */
const BOILERPLATE_MARKERS = [
  "版权所有", "未经许可", "请勿转载", "免责声明", "责任编辑", "本文来自", "来源:",
  "来源：", "扫码关注", "点击查看", "更多精彩", "all rights reserved", "©", "(c)20",
];

export function stripBoilerplate(text: string): string {
  const raw = String(text ?? "");
  if (!raw) return "";
  // 先按句末切, 再按换行切 —— 样板句两种形态都有(网页摘要常是一整行无换行)
  return raw
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .filter((sentence) => {
      const s = sentence.toLowerCase();
      return !BOILERPLATE_MARKERS.some((m) => s.includes(m));
    })
    .join(" ");
}

/** 信任议题判据: 一个强词, 或**两个不同的弱词**(见 TRUST_STRONG/WEAK 的注释) */
export function isTrustRelated(item: DailyCandidate, text = ""): boolean {
  const role = String(item.evidenceRole ?? "");
  if (role === "security_advisory") return true;
  const url = String(item.url ?? "").toLowerCase();
  const haystack = `${stripBoilerplate(text)} ${url} ${(item.riskTags ?? []).join(" ")}`.toLowerCase();
  if (TRUST_STRONG.some((t) => haystack.includes(t.toLowerCase()))) return true;
  return TRUST_WEAK.filter((t) => haystack.includes(t.toLowerCase())).length >= 2;
}

/** 取域名(移植 `daily_domain`) —— ⚠ 去掉 userinfo **与端口**(`host` 会带上端口, 要用 `hostname`) */
export function domainOf(url: string): string {
  const clean = String(url ?? "").trim();
  if (!clean) return "";
  try {
    return new URL(clean).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// ═══════════════════════════════════════════════════════════
// 内部工具(与原文同名同义)
// ═══════════════════════════════════════════════════════════

function looksLikeCommunity(domain: string, source: string, text: string): boolean {
  const haystack = `${domain} ${source} ${text}`.toLowerCase();
  return [
    "zhihu.com", "csdn.net", "github.com", "v2ex.com", "bbs.", "forum.", "tieba.baidu.com",
    "douban.com", "xiaohongshu.com", "weibo.com", "reddit.com", "stackoverflow.com",
    "知乎", "豆瓣", "小红书", "贴吧", "微博", "论坛", "社交", "社区", "评论", "用户反馈",
  ].some((t) => haystack.includes(t));
}

function looksLikeMediaOrIndustry(source: string): boolean {
  return ["媒体", "财经", "科技", "商业", "产业", "开发者", "新闻", "研报", "垂类", "期刊", "学报"].some((t) =>
    source.includes(t)
  );
}

function count(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * 紧凑化文本(移植 `_compact_text`): 只留数字/小写字母/中文, 去掉一切标点与空白。
 * 用途是**做包含判断**(如 `_topic_match_strict`), 让「工商资本, 下乡」与「工商资本下乡」等价。
 * 显式字符类, 没有 `\w` —— 这一处原文就不踩 Python/JS 的 Unicode 语义差。
 */
export function compactText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/[^0-9a-z一-鿿]+/g, "");
}

export function uniqueStrings(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
