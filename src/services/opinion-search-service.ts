// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// opinion-search-service.ts — 舆情检索: 多源采集 → 归一 → 去重 → 话题聚类 → 情感/立场 → 趋势统计
//
// 由来(2026-10-01): 旧项目 AItoolman 有 `get_public_opinion_sources_dict` 与一句
//   `舆情检索请求失败`, 本仓**零实现**。这里补的是**研究用途**的舆情检索, 不是商业舆情监控:
//     · 某政策出台后的公众讨论走向
//     · 某社会议题的媒体框架
//     · 网络舆论与官方话语的对照
//   三者的共同要求是"可复现 + 可核对", 所以:
//     · 采集只走 RSS / 公开 JSON / 开放 API / 已有检索链(源见 opinion-sources.ts);
//     · 情感与立场用**规则判据**(sentiment-service.ts), LLM 只做可选校准 —— 规则结果可复现,
//       研究者能核对命中词, 而模型换了标签不会跟着变;
//     · 每个源独立失败隔离: 一个源挂了, 结果里明写它挂了(softErrors), 而不是静默少几条。
//
// 三条口径上的实话(用之前必须知道, 否则会得出错误结论):
//   ① **没有发布时间的条目不进时间序列**。新华网 RSS 不写 pubDate, 若给它们补 now(),
//      "某天讨论量暴增"就变成"某天我抓得多" —— 这是最容易被当成真实趋势的假信号。
//   ② **去重按题名相似度 + 时间窗**, 同一事件的多家转载合并成一条(保留最早那条, 记下转载源)。
//      相似度阈值是**保守**的: 宁可少合, 不可把两件不同的事合成一件(那会凭空造出"全网在说").
//   ③ **热搜榜是榜单不是检索**: 它只作规模信号(scaleSignals), 不参与关键词筛选 —— 用关键词
//      去筛榜单永远是 0, 会被误读成"这个话题没人在讨论"。
//
// 缓存: 同一 query+参数在 opinion_search_cache 里直接返回(默认 30 分钟), 内存 Map 是快路径。
//   目的有二: 不把对方站点打爆; 让"同一问题反复看"不必反复等。
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  PUBLIC_OPINION_SOURCES, enabledSources,
  type OpinionSourceSpec, type OpinionCategory,
} from "./opinion-sources.js";
import { route as routeOpinion, type RoutePlan } from "./opinion-router.js";
import {
  analyzeSentimentBatch, distributionOf, calibrateWithLlm,
  type Sentiment, type Stance, type SentimentResult, type SentimentDistribution,
} from "./sentiment-service.js";
import { buildKeywordNetwork, extractCorpusKeywords, detectCorpusLang, type Lang } from "./keyword-network-service.js";

// ═══════════════════════════════════════════════════════════
// 统一结构
// ═══════════════════════════════════════════════════════════

export interface OpinionItem {
  title: string;
  summary: string;
  url: string;
  source: string;          // sourceId
  sourceName: string;
  category: OpinionCategory;
  publishedAt: string | null;   // ISO; null = 源站没给时间(不编造)
  fetchedAt: string;
  lang: Lang;
  sentiment: Sentiment;
  stance: Stance;
  intensity: number;
  topics: string[];
  /** 相关度(关键词命中), 0..1 */
  score: number;
  /** 被合并进来的其它转载源(题名相似且时间接近) */
  alsoReportedBy: string[];
  duplicateCount: number;
}

export interface SourceStat {
  sourceId: string;
  name: string;
  category: OpinionCategory;
  lang: Lang;
  fetched: number;   // 抓回来的原始条数
  kept: number;      // 关键词命中后留下的条数
  error?: string;    // 这个源失败的原因(失败隔离必须可见)
  note?: string;     // 源自身的限制(如"发布时间冻结")
}

export interface TrendPoint { date: string; count: number }

export interface OpinionCluster {
  id: number;
  label: string;
  size: number;
  keywords: string[];
  items: Array<Pick<OpinionItem, "title" | "url" | "sourceName" | "publishedAt" | "sentiment" | "stance">>;
}

export interface ScaleSignal {
  source: string;
  sourceName: string;
  rank: number;
  topic: string;
  heat: number;
  sentiment: Sentiment;
}

export interface OpinionSearchResult {
  query: string;
  keywords: string[];
  range: { since: string | null; until: string | null };
  items: OpinionItem[];
  total: number;
  clusters: OpinionCluster[];
  trend: TrendPoint[];
  trendGranularity: "day" | "week";
  distribution: SentimentDistribution;
  byCategory: Array<{ category: OpinionCategory; count: number }>;
  hotWords: Array<{ word: string; count: number; lang: Lang }>;
  scaleSignals: ScaleSignal[];
  scaleDistribution: SentimentDistribution | null;
  sources: SourceStat[];
  softErrors: Array<{ sourceId: string; name: string; error: string }>;
  /** 需要研究者知道的口径提示(去重合并了几条 / 有多少条没有时间 / LLM 是否校准成功) */
  notes: string[];
  llmCalibrated: number;
  cached: boolean;
  cacheAgeMs?: number;
  generatedAt: string;
  /** 本次的信源路由计划(没开路由时为 null) —— 界面据此展示"按什么选的源 / 建议别拿谁当主要依据" */
  route: RoutePlan | null;
}

export interface OpinionSearchInput {
  query: string;
  /** 时间范围(按**源站发布时间**筛, 不是抓取时间) */
  since?: Date | string | null;
  until?: Date | string | null;
  /** 指定源; 不给则用注册表里全部 enabled 的源 */
  sources?: string[];
  categories?: OpinionCategory[];
  /**
   * 开启信源路由(2026-10-03)。开了才按意图选源, 默认关。
   *
   * ⚠ 默认关是**有意的**: 路由是启发式的, 它能显著提速降噪, 但也可能对某个冷门主题
   *   选错而漏掉唯一有货的源。默认关 = 行为与加这个功能之前**逐字节一致**,
   *   谁想要谁显式开。路由结果会随结果一起返回(`route`), 界面如实展示按什么选的。
   */
  route?: boolean;
  granularity?: "day" | "week";
  limit?: number;
  /** 是否让 LLM 校准情感/立场(默认关: 研究场景优先可复现的规则结果) */
  llmCalibrate?: boolean;
  /** 跳过缓存(强制重抓) */
  bypassCache?: boolean;
  cacheTtlMs?: number;
  /** 采集/检索的依赖注入点 —— 测试用内置样本, 不联网 */
  fetcher?: Fetcher;
  searchFn?: SearchFn;
  userId?: string;
}

/** 采集函数(依赖注入)。返回文本体而不是 Response: 编码转换由实现负责 */
export type Fetcher = (url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; body: string; error?: string }>;
export type SearchFn = (query: string, opts: { maxResults?: number; site?: string }) => Promise<{
  ok: boolean; hits: Array<{ title: string; url: string; snippet: string; publishedAt?: string | null }>; error?: string;
}>;

// ═══════════════════════════════════════════════════════════
// HTTP(带超时 + 中文编码处理)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT_MS = Math.max(3_000, parseInt(process.env.OPINION_FETCH_TIMEOUT_MS || "12000", 10));
const UA = "Mozilla/5.0 (compatible; SocioSeek/1.0; +research)";

/**
 * 中文源站的编码是三种并存的: 人民网 UTF-8、求是网 gb2312、部分政府站 gbk。
 * 按 UTF-8 硬解会得到一串 U+FFFD, 而**它不会报错** —— 结果里全是乱码却一路"成功"。
 * 所以先读字节, 再按 content-type / XML 声明选解码器, gb* 一律交给 gb18030 超集。
 */
export function decodeBody(buf: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 400));
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] || /encoding=["']([\w-]+)/i.exec(head)?.[1] || "";
  const enc = declared.toLowerCase();
  if (enc.startsWith("gb") || enc === "gb2312" || enc === "gbk" || enc === "gb18030") {
    try { return new TextDecoder("gb18030").decode(bytes); } catch { /* 落到 utf-8 */ }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export const httpFetcher: Fetcher = async (url, opts = {}) => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, application/json, text/xml, */*", ...(opts.headers ?? {}) },
    });
    const buf = await res.arrayBuffer();
    return { ok: res.ok, status: res.status, body: decodeBody(buf, res.headers.get("content-type") || "") };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: String((e as Error)?.message || e).slice(0, 160) };
  }
};

/** 默认检索函数: 复用平台已有的 provider 注册表(有 key 用 API, 否则 Edge 抓取兜底) */
export const registrySearchFn: SearchFn = async (query, opts) => {
  try {
    const { searchWithRegistry, rankedProviders } = await import("./search-provider-registry.js");
    const providers = rankedProviders(["web"]).map((p) => p.providerId);
    const r = await searchWithRegistry(query, { maxResults: opts.maxResults ?? 8, providers });
    if (!r.ok) return { ok: false, hits: [], error: r.error };
    return {
      ok: true,
      hits: r.hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, publishedAt: h.publishedAt ?? null })),
    };
  } catch (e) {
    return { ok: false, hits: [], error: String((e as Error)?.message || e).slice(0, 160) };
  }
};

// ═══════════════════════════════════════════════════════════
// 解析(RSS / Atom / 政府 JSON / OSF JSON / 微博榜单)
// ═══════════════════════════════════════════════════════════

export interface RawEntry {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  /** 榜单类源才有 */
  rank?: number;
  heat?: number;
}

export function stripTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * RSS/Atom 解析。
 *
 * ⚠ 比 rss-service.ts 的 parseRss 多处理两件这里必须处理的事:
 *   ① **时间裸在 description 之前**(新华网就是这样: `...<link>URL</link>Wed,14-Dec-2022 11:37:37 GMT<description>`)
 *      —— 只认 `<pubDate>` 标签会把整个新华源判成"没有时间"。这里额外在条目体里扫 RFC822 时间串。
 *   ② **Atom 的 link 在 href 属性里**(arXiv/OSF); `<link>...</link>` 那种取不到 URL。
 * 解析不出时间的条目 publishedAt=null(不补 now())。只有日期没有时刻的(人民网 `2025-06-05`)
 * 按 UTC 零点解释 —— 用于按天分桶够用, 且不会把条目挤到别的日子。
 */
export function parseFeedEntries(xml: string): RawEntry[] {
  const out: RawEntry[] = [];
  const itemRe = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[2];
    const tag = (name: string): string => {
      const r = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(body);
      return r ? stripTags(r[1]) : "";
    };
    const title = tag("title");
    if (!title) continue;
    let url = tag("link");
    if (!url) {
      url = /<link[^>]*href=["']([^"']+)["']/i.exec(body)?.[1] || "";
      if (url.startsWith("/")) {
        // 相对链接(Taylor & Francis 的 rdf:about 那种): 由调用方拼 base, 这里原样带出
        url = url;
      }
    }
    const plain = stripTags(body);
    // 裸时间: 有的站(新华网)把时间直接写在 <link> 后面而不包标签。
    //   RFC822 与 `2025-06-05` / `2025/06/05` 两种都扫 —— 只扫 RFC822 会让"日期型"的源
    //   整片被判成没有发布时间, 而那是**静默**的(结果里只是时间序列少几天)。
    // 分隔符要放宽到 [,\s]+ 与 [- ]: 新华网写的是 `Wed,14-Dec-2022 11:37:37 GMT`(逗号后无空格、
    //   日月年用连字符), 而中新网写的是 `Wed, 30 Sep 2026 23:58:14 +0800` —— 只认后者的话
    //   前者整片源被判成"没有发布时间"。
    const bareDate = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[,\s]+\d{1,2}[\s-]\w{3}[\s-]\d{4}[\s,]+\d{2}:\d{2}:\d{2}\s*[A-Z]{0,4}/.exec(plain)?.[0]
      || /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(plain)?.[0]
      || "";
    const rawDate = tag("pubDate") || tag("published") || tag("updated") || tag("dc:date") || tag("date") || bareDate;
    const summary = (tag("description") || tag("summary") || tag("content:encoded") || "").slice(0, 600);
    out.push({ title, url, summary, publishedAt: parseDate(rawDate) });
  }
  return out;
}

/** 宽松日期解析: RFC822 / ISO / `2025-06-05`(按 UTC 零点) / `YYYY/MM/DD`。认不出返回 null */
export function parseDate(raw: string): string | null {
  // 归一: 全角数字/全角冒号部分站会用, 零宽字符(BOM)常粘在时间串开头。
  //   不做这一步时 `２026-09-30` 这类**看着是日期**的串会解析成 null, 而 null 意味着
  //   "源站没给时间" —— 于是条目被静默排除出时间序列, 看起来像"那天没有舆情"。
  const s = (raw || "").trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[​-‍﻿]/g, "")
    .replace(/：/g, ":")
    .trim();
  if (!s) return null;
  // RFC822 的两种写法都要认: `Wed, 30 Sep 2026 23:58:14 +0800` 与 `Wed,14-Dec-2022 11:37:37 GMT`
  //   (逗号后有无空格、日月年之间是空格还是连字符, 各站不同)
  const rfc = /^(\w{3})[,\s]+(\d{1,2})[\s-](\w{3})[\s-](\d{4})[\s,]+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|GMT|UTC|[A-Z]{2,4})?/.exec(s);
  if (rfc) {
    const [, , d, mon, y, hh, mm, ss, tz] = rfc;
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = months.indexOf(mon.toLowerCase());
    if (mi >= 0) {
      let iso = `${y}-${String(mi + 1).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}T${hh}:${mm}:${ss || "00"}`;
      if (tz && /^[+-]\d{4}$/.test(tz)) iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
      else iso += "Z";
      const t = Date.parse(iso);
      if (!isNaN(t)) return new Date(t).toISOString();
    }
  }
  // ISO: **偏移必须保留**。arXiv 的 Atom 写的是 `2026-09-30T00:00:00-04:00`,
  //   把它当 Z 处理会让每条时间差 4 小时(跨天时直接错到前一天/后一天)。
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (iso) {
    const [, y, mo, d, hh = "00", mi = "00", ss = "00", tzRaw = ""] = iso;
    // 没有时区的裸时间按 UTC 解释 —— 编一个本站时区更糟, 至少这里的行为是确定的
    const tz = !tzRaw ? "Z" : (tzRaw.length === 5 && !tzRaw.includes(":") ? `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}` : tzRaw);
    const t = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${tz}`);
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  const slash = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(s);
  if (slash) {
    const t = Date.parse(`${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}T00:00:00Z`);
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

/** 中国政府网 pushinfo JSON: [{author, description, link, pubDate, title}] */
export function parseGovPushInfo(body: string): RawEntry[] {
  let arr: any;
  try { arr = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => ({
      title: String(it?.title ?? "").trim(),
      url: String(it?.link ?? "").trim(),
      summary: String(it?.description ?? "").trim().slice(0, 600),
      publishedAt: parseDate(String(it?.pubDate ?? "")),
    }))
    .filter((e) => e.title);
}

/** OSF/SocArXiv 预印本 JSON:API: {data:[{attributes:{title,description,date_published},links}]} */
export function parseOsfPreprints(body: string): RawEntry[] {
  let j: any;
  try { j = JSON.parse(body); } catch { return []; }
  const rows = Array.isArray(j?.data) ? j.data : [];
  return rows
    .map((it: any) => ({
      title: String(it?.attributes?.title ?? "").trim(),
      url: String(it?.links?.html ?? (it?.id ? `https://osf.io/preprints/socarxiv/${it.id}` : "")),
      summary: String(it?.attributes?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      publishedAt: parseDate(String(it?.attributes?.date_published ?? it?.attributes?.date_created ?? "")),
    }))
    .filter((e: RawEntry) => e.title);
}

/** 微博热搜榜单: {ok:1, data:{realtime:[{word, num, rank, label_name}]}} */
export function parseWeiboHot(body: string): RawEntry[] {
  let j: any;
  try { j = JSON.parse(body); } catch { return []; }
  const rows = Array.isArray(j?.data?.realtime) ? j.data.realtime : [];
  return rows
    .map((it: any, i: number) => ({
      title: String(it?.word ?? it?.note ?? "").trim(),
      url: String(it?.word_scheme || it?.word || "").includes("http")
        ? String(it.word_scheme)
        : `https://s.weibo.com/weibo?q=${encodeURIComponent(String(it?.word ?? ""))}`,
      summary: "",
      publishedAt: null,   // 榜单没有发布时间 —— 也不该有
      rank: Number(it?.rank ?? i),
      heat: Number(it?.num ?? 0),
    }))
    .filter((e: RawEntry) => e.title);
}

export function parseSourceBody(spec: OpinionSourceSpec, body: string): RawEntry[] {
  switch (spec.id) {
    case "gov-cn-policy": return parseGovPushInfo(body);
    case "osf-socarxiv": return parseOsfPreprints(body);
    case "weibo-hot": return parseWeiboHot(body);
    default: return parseFeedEntries(body);
  }
}

// ═══════════════════════════════════════════════════════════
// 关键词匹配与相关度
// ═══════════════════════════════════════════════════════════

const STOP_QUERY_WORDS = new Set([
  "的", "了", "和", "与", "及", "在", "对", "关于", "情况", "问题", "研究", "分析", "the", "of", "and", "for", "a", "an", "on", "in", "about",
]);

/**
 * 查询 → 关键词。整串是主关键词(权重最高), 再拆出词元作为辅助。
 * 拆词元是为了让"农村土地流转政策"也能命中只写了"土地流转"的条 —— 但也因此
 * **必须给主串更高权重**, 否则辅助词会把不相关的条顶到前面。
 */
export function keywordsFromQuery(query: string): { primary: string; keywords: string[] } {
  const q = (query || "").trim();
  const primary = q;
  const parts = new Set<string>();
  if (q) parts.add(q);
  for (const seg of q.split(/[\s,，、;；/|]+/)) {
    const t = seg.trim();
    if (t && !STOP_QUERY_WORDS.has(t.toLowerCase())) parts.add(t);
  }
  // 中文无空格长串: 用 bigram 之外的粗粒度切法收益有限, 这里只按显式分隔符切 ——
  //   宁可少切(留整串), 不要把"农村土地流转"切成"农村/土地/流转"三个泛词把结果灌水
  return { primary, keywords: [...parts] };
}

/** 相关度: 主串命中权重 0.6, 其余关键词均分 0.4; 命中标题再加 0.15(上限 1) */
export function relevanceOf(hay: string, title: string, kw: { primary: string; keywords: string[] }): number {
  const text = hay.toLowerCase();
  const t = title.toLowerCase();
  const others = kw.keywords.filter((k) => k !== kw.primary);
  let score = 0;
  if (kw.primary && text.includes(kw.primary.toLowerCase())) score += 0.6;
  if (others.length) {
    const hit = others.filter((k) => text.includes(k.toLowerCase())).length;
    // ⚠ 中文查询常没有分隔符("农村土地流转"是一个词元), 拆出来的"词元"就是整串本身 →
    //   它天然不会出现在正文里 → 命中数 0 → 得分恒 0.4, 与不相关文本看不出差别。
    //   所以补一条: 整条查询作为子串直接出现时按满命中算。
    const whole = text.includes(kw.primary.toLowerCase());
    score += 0.4 * (whole ? 1 : hit / others.length);
  } else if (kw.primary && text.includes(kw.primary.toLowerCase())) {
    score += 0.4;
  }
  if (kw.primary && t.includes(kw.primary.toLowerCase())) score += 0.15;
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════
// 去重(题名相似度 + 时间窗)
// ═══════════════════════════════════════════════════════════

/** 归一题名: 去版面标记/标点/空白, 英文小写。`【独家】XXX｜YYY` 与 `XXX-YYY` 应当同形 */
export function normalizeOpinionTitle(t: string): string {
  return (t || "")
    .replace(/[【】\[\]（）()《》<>「」『』"'“”‘’]/g, "")
    // 中文站点多用 ｜(全角竖线)/ · 分隔栏目与正题, 表里少了它们时 `【独家】X｜全文`
    //   与 `X-全文` 的归一结果不同 —— 去重会静默失效
    .replace(/[，,。.、；;：:!！?？~～\-—_|｜/\\·・]+/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 题名相似度。中文/短串用 **字符 bigram Dice**(对语序与插入词更宽容), 纯英文长串用**词 Jaccard**。
 * 单一字符的题名(如微博榜单的短词)直接判不相似 —— 长度 1 的串相似度没有意义,
 * 两个不同的单字话题会被判成同一条。
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeOpinionTitle(a), nb = normalizeOpinionTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const hasCjk = /[一-鿿]/.test(na + nb);
  if (!hasCjk && /\s/.test(a + b)) {
    const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) || []);
    const wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) || []);
    if (!wa.size || !wb.size) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    return inter / (wa.size + wb.size - inter);
  }
  const grams = (s: string): Map<string, number> => {
    const g = new Map<string, number>();
    for (let i = 0; i + 1 < s.length; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); }
    return g;
  };
  const ga = grams(na), gb = grams(nb);
  let inter = 0, total = 0;
  for (const [k, c] of ga) { total += c; const b = gb.get(k); if (b) inter += Math.min(c, b); }
  for (const c of gb.values()) total += c;
  const dice = total ? (2 * inter) / total : 0;
  // ⚠ 已知边界(实测过, 不是推测): 阈值能分开**短**题名的同模板不同主体
  //   (`教育部发布新规` vs `交通部发布新规` = 0.667, 见测试), 但分不开**长**题名的:
  //   `教育部发布中小学作业管理新规` vs `交通部发布中小学作业管理新规` = 0.846, 会被合并。
  //   试过用最长公共子串做二次判据 —— 实测对这一类**无效**(公共部分本来就很长),
  //   反而会切断"加后缀/加括号"的真转载, 所以不做, 只把这个边界写在这里。
  //   合并结果不是黑盒: 每条都带 duplicateCount 与 alsoReportedBy, 研究者能核对是不是同一条。
  return dice;
}

export interface DedupeOptions {
  /** 相似度阈值。默认 0.72 —— 实测 0.6 会把"同主题不同事件"合成一条 */
  threshold?: number;
  /** 时间窗(小时)。默认 72: 超过三天的同题报道算"后续报道"而不是转载 */
  windowHours?: number;
}

/**
 * 同一事件被多家转载 → 合并成一条。
 * 代表条目取**发布时间最早**的那条(首发), 其余记进 alsoReportedBy。
 * 任一条缺发布时间时只比相似度(不比时间) —— 这在结果里会体现为 duplicateCount, 不静默。
 */
export function dedupeItems<T extends { title: string; sourceName: string; publishedAt: string | null }>(
  items: T[], opts: DedupeOptions = {},
): { items: Array<T & { alsoReportedBy: string[]; duplicateCount: number }>; merged: number } {
  const threshold = opts.threshold ?? 0.72;
  const windowMs = (opts.windowHours ?? 72) * 3_600_000;
  const groups: Array<{ rep: T; sources: Set<string>; count: number; times: number[] }> = [];

  for (const it of items) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
    let placed = false;
    for (const g of groups) {
      // 与**代表条**(而不是所有成员)比相似度: 两两比较会让"同一事件"沿相似链条无限传递,
      //   最后把整个话题合成一条。
      if (titleSimilarity(g.rep.title, it.title) < threshold) continue;
      const known = g.times.filter((x) => !isNaN(x));
      // 时间窗只在**双方都有时间**时生效; 组里全无时间则只按相似度合
      if (!isNaN(t) && known.length && !known.some((gt) => Math.abs(gt - t) <= windowMs)) continue;
      if (it.sourceName) g.sources.add(it.sourceName);
      // 代表取发布时间**最早**的那条(首发); 更早的才替换
      const earliest = known.length ? Math.min(...known) : Infinity;
      if (!isNaN(t) && t < earliest) g.rep = it;
      g.count++;
      g.times.push(t);
      placed = true;
      break;
    }
    if (!placed) groups.push({ rep: it, sources: new Set(it.sourceName ? [it.sourceName] : []), count: 1, times: [t] });
  }

  return {
    items: groups.map((g) => ({
      ...g.rep,
      alsoReportedBy: [...g.sources].filter((s) => s !== g.rep.sourceName),
      duplicateCount: g.count,
    })),
    merged: items.length - groups.length,
  };
}

// ═══════════════════════════════════════════════════════════
// 话题聚类(复用 keyword-network-service 的共现 + Louvain)
// ═══════════════════════════════════════════════════════════

/**
 * 通讯社通稿的**版式词**。它们在每条电讯里都出现, 于是词频很高 —— 不排掉的话
 * 热词榜与簇标签会被 `图为``中新社记者` 占满(实测中新网滚动源就是这样), 看起来像分词坏了,
 * 实际是"这些词确实高频, 只是没有信息量"。这与文献库那套停用词表无关, 是新闻语料特有的。
 */
const WIRE_STOPWORDS = [
  "图为", "记者", "摄影", "摄", "通讯员", "责任编辑", "本报", "来源", "综合报道", "报道",
  "中新社", "中新网", "新华网", "人民网", "视觉中国", "资料图", "图片", "消息", "客户端",
  "微信公众号", "扫码", "点击", "查看更多", "原标题",
];

export interface ClusterInputItem {
  title: string;
  summary: string;
  url: string;
  sourceName: string;
  publishedAt: string | null;
  sentiment: Sentiment;
  stance: Stance;
}

/**
 * 把条目聚成话题簇。
 *
 * 复用已有的关键词网络:**共现建图 + Louvain 社区发现**(keyword-network-service)是同一个问题
 * (哪些词总一起出现 → 那是同一个话题), 但有三处必须按舆情语料调:
 *   · `minCount: 1` / `minCoverage` 极小 —— 舆情里一个话题可能只有三五条, 用文献库那套阈值
 *     会一条词都留不下("结果为空"看起来像没数据, 其实是阈值问题);
 *   · 中文与英文**分开建图**: 混合语料一起跑, 中英文词不会共现, 图会碎成两半
 *     (更糟的是 Louvain 会把它们各切一簇, 看着像两个话题, 其实是一个);
 *   · 词簇 → 条目的归属用"这条命中了哪些词"投票, 一个词都没命中的进"其他"(id=-1) ——
 *     强行塞进最近的一簇会让簇的含义被稀释。
 */
export function clusterOpinionItems(
  items: ClusterInputItem[],
  opts: { maxNodes?: number; resolution?: number; seed?: number } = {},
): OpinionCluster[] {
  if (items.length < 2) return [];
  const byLang: Record<Lang, number[]> = { zh: [], en: [] };
  items.forEach((it, i) => byLang[detectCorpusLang(`${it.title} ${it.summary}`.slice(0, 400))].push(i));

  const out: OpinionCluster[] = [];
  for (const lang of ["zh", "en"] as Lang[]) {
    const idxs = byLang[lang];
    if (idxs.length < 2) continue;
    const docs = idxs.map((i, k) => ({ id: String(k), title: items[i].title, text: `${items[i].title}。${items[i].summary}` }));
    let net;
    try {
      net = buildKeywordNetwork(docs, lang, {
        windowSize: lang === "zh" ? 4 : 6,
        // 入图节点数按语料规模自适应: 一次检索常见几十条, 固定 60 会把"只出现一两次的洗稿片段"
        //   也画进图, 于是社区被切成一堆 1-2 个词的碎簇(实测 10 簇里 6 簇是垃圾标签)。
        maxNodes: opts.maxNodes ?? Math.min(40, Math.max(12, idxs.length * 3)),
        topEdges: 160,
        minCount: 1,
        // 覆盖率门槛: 逐篇几百字的舆情语料用文档里"文献库"那套默认值(0.0005 / 0.003)会留下
        //   跨词边界的垃圾长片段(`桩等基础设施` `革与乡村振兴`), 实测社区标签全是这种半截词。
        //   0.02 = 一个词至少覆盖全语料 2% 的汉字, 正好滤掉碎片又留得住真话题词。
        minCoverage: 0.02,
        stopwords: WIRE_STOPWORDS,
        minTermLength: lang === "zh" ? 2 : 4,
        maxTermLength: lang === "zh" ? 6 : 1,
        resolution: opts.resolution ?? 1,
        seed: opts.seed ?? 20261001,
        clusterKeywords: 6,
      });
    } catch {
      continue;   // 聚类失败不影响主结果(条照常有, 只是没有话题分组)
    }
    const nodeCluster = new Map(net.nodes.map((n) => [n.label.toLowerCase(), n.cluster]));
    const buckets = new Map<number, ClusterInputItem[]>();
    const bucketKws = new Map<number, string[]>();
    for (const c of net.clusters) bucketKws.set(c.id, c.keywords);

    for (let k = 0; k < idxs.length; k++) {
      const text = `${items[idxs[k]].title} ${items[idxs[k]].summary}`.toLowerCase();
      const votes = new Map<number, number>();
      for (const [word, cluster] of nodeCluster) {
        if (text.includes(word)) votes.set(cluster, (votes.get(cluster) ?? 0) + word.length);
      }
      let best = -1, bestV = 0;
      for (const [c, v] of votes) if (v > bestV) { best = c; bestV = v; }
      const list = buckets.get(best) ?? [];
      list.push(items[idxs[k]]);
      buckets.set(best, list);
    }

    for (const [cid, list] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const kws = bucketKws.get(cid) ?? [];
      out.push({
        id: out.length,
        label: cid === -1 ? "其他" : kws.slice(0, 2).join(" / ") || "其他",
        size: list.length,
        keywords: kws,
        items: list.slice(0, 12).map((it) => ({
          title: it.title, url: it.url, sourceName: it.sourceName, publishedAt: it.publishedAt,
          sentiment: it.sentiment, stance: it.stance,
        })),
      });
    }
  }
  return out.sort((a, b) => b.size - a.size).map((c, i) => ({ ...c, id: i }));
}

// ═══════════════════════════════════════════════════════════
// 趋势 / 分布 / 热词
// ═══════════════════════════════════════════════════════════

/** 按天(或按周一起始日)分桶。**只有带发布时间的条目参与** —— 见文件头口径① */
export function buildTrend(items: Array<{ publishedAt: string | null }>, granularity: "day" | "week" = "day"): TrendPoint[] {
  const bucket = new Map<string, number>();
  for (const it of items) {
    if (!it.publishedAt) continue;
    const t = Date.parse(it.publishedAt);
    if (isNaN(t)) continue;
    let key = new Date(t).toISOString().slice(0, 10);
    if (granularity === "week") {
      // 桶标签 = 该周的**周一**日期。`getUTCDay()` 里周日=0, 先转成"距周一多少天"再回退:
      //   写成 `getUTCDay() - 1` 会让周日回退到本周一(差 6 天), 与周一的条目落进同一个桶。
      const back = (new Date(t).getUTCDay() + 6) % 7;   // 周一→0, 周日→6
      key = new Date(t - back * 86_400_000).toISOString().slice(0, 10);
    }
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  return [...bucket.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
}

export function sourceDistribution(items: Array<{ source: string; sourceName: string; category: OpinionCategory }>) {
  const bySource = new Map<string, { sourceId: string; name: string; category: OpinionCategory; count: number }>();
  const byCategory = new Map<OpinionCategory, number>();
  for (const it of items) {
    const s = bySource.get(it.source) ?? { sourceId: it.source, name: it.sourceName, category: it.category, count: 0 };
    s.count++;
    bySource.set(it.source, s);
    byCategory.set(it.category, (byCategory.get(it.category) ?? 0) + 1);
  }
  return {
    bySource: [...bySource.values()].sort((a, b) => b.count - a.count),
    byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
  };
}

/** 该词是不是通稿版式词: 整体命中, 或**包含**版式词(分词把 `中新社记者` 切成了一个词) */
function isWireWord(word: string): boolean {
  return WIRE_STOPWORDS.some((w) => word === w || word.includes(w));
}

/**
 * 热词: 复用 keyword-network 的语料级分词与词频(与词云/图谱同一口径)。
 *
 * 两处收紧(都是实测出来的):
 *   · **重复出现才算热词**。小语料里只出现一次的候选多半是跨词边界的碎片
 *     (`图为武警官兵` `旅客在杭州东`) 或人名机构名 —— 实测 4 条语料时它们会占满整张榜。
 *     真的一条都留不下时才降级到 1 次, 而不是一上来就放开。
 *   · **通稿版式词整词/包含都排掉** —— `中新社记者` 会被分词切成一个词, 只按整词匹配排不掉。
 */
export function hotWordsOf(items: Array<{ title: string; summary: string }>, topK = 30): Array<{ word: string; count: number; lang: Lang }> {
  const groups: Record<Lang, string[]> = { zh: [], en: [] };
  for (const it of items) {
    const text = `${it.title}。${it.summary}`;
    groups[detectCorpusLang(text)].push(text);
  }
  const collect = (lang: Lang, minCount: number) => {
    try {
      return extractCorpusKeywords(groups[lang], lang, {
        topK, minCount, minCoverage: 0.02, stopwords: WIRE_STOPWORDS,
        minTermLength: lang === "zh" ? 2 : 4, maxTermLength: lang === "zh" ? 6 : 1,
      }).filter((k) => !(lang === "zh" && isWireWord(k.word)));
    } catch { return []; }   // 分词失败不影响主结果
  };
  const out: Array<{ word: string; count: number; lang: Lang }> = [];
  for (const lang of ["zh", "en"] as Lang[]) {
    const docs = groups[lang];
    if (!docs.length) continue;
    // **文档频率**才是"热"的定义: 一个词在**多条**里出现, 说明它是这批语料共同在谈的东西;
    //   只在一条里重复出现(标题+摘要各一次)的, 是那一条自己的措辞(实测: `旅客在杭州东`
    //   只来自一篇稿子, 却因标题与摘要各命中一次而进入词频前几名)。
    //   只有一条语料时退化为 1 —— 没有第二条可比。
    const need = Math.min(2, docs.length);
    // 文档频率用**子串出现在几篇里**算, 不逐篇再分词一次 —— 逐篇分词会踩 tokenizeZhCorpus
    //   文档里写明的那个坑: 语料级统计退化, 切出来的词与整批口径对不上, 于是频率恒 0。
    const inDocs = (w: string) => docs.reduce((a, d) => a + (d.includes(w) ? 1 : 0), 0);
    let kw = collect(lang, 2).filter((k) => inDocs(k.word) >= need);
    if (kw.length === 0) kw = collect(lang, 1).filter((k) => inDocs(k.word) >= need);
    for (const k of kw) out.push({ ...k, lang });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, topK);
}

// ═══════════════════════════════════════════════════════════
// 源采集(并发受限 + 失败隔离 + 熔断)
// ═══════════════════════════════════════════════════════════

export interface SourceHealth {
  sourceId: string;
  name: string;
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
  lastSuccessAt?: string;
  circuitOpenUntil?: string;
}

const CIRCUIT_FAILURES = Math.max(1, parseInt(process.env.OPINION_SOURCE_CIRCUIT_FAILURES || "3", 10));
const CIRCUIT_OPEN_MS = Math.max(10_000, parseInt(process.env.OPINION_SOURCE_CIRCUIT_MS || "600000", 10));
/** 并发上限: 25 个源同时开打对谁都不礼貌, 且本机出口带宽是共享的 */
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.OPINION_FETCH_CONCURRENCY || "6", 10));

const health = new Map<string, SourceHealth>();

function healthOf(spec: OpinionSourceSpec): SourceHealth {
  const h = health.get(spec.id) ?? { sourceId: spec.id, name: spec.name, consecutiveFailures: 0 };
  health.set(spec.id, h);
  return h;
}

function circuitIsOpen(spec: OpinionSourceSpec): boolean {
  const h = health.get(spec.id);
  return !!h?.circuitOpenUntil && Date.parse(h.circuitOpenUntil) > Date.now();
}

function recordSuccess(spec: OpinionSourceSpec): void {
  const h = healthOf(spec);
  h.consecutiveFailures = 0;
  h.circuitOpenUntil = undefined;
  h.lastError = undefined;
  h.lastSuccessAt = new Date().toISOString();
}

function recordFailure(spec: OpinionSourceSpec, error: string): void {
  const h = healthOf(spec);
  h.consecutiveFailures += 1;
  h.lastError = error.slice(0, 200);
  h.lastErrorAt = new Date().toISOString();
  if (h.consecutiveFailures >= CIRCUIT_FAILURES) h.circuitOpenUntil = new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString();
}

/** 各源健康度(运维/界面用) */
export function sourceHealth(): SourceHealth[] {
  return PUBLIC_OPINION_SOURCES.map((s) => health.get(s.id) ?? { sourceId: s.id, name: s.name, consecutiveFailures: 0 });
}

export function resetSourceHealth(id?: string): void {
  if (id) health.delete(id);
  else health.clear();
}

async function mapLimited<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchOneSource(
  spec: OpinionSourceSpec, q: { query: string; keywords: string[]; limit: number },
  fetcher: Fetcher, searchFn: SearchFn,
): Promise<{ entries: RawEntry[]; error?: string }> {
  if (circuitIsOpen(spec)) return { entries: [], error: `连续失败已熔断(${health.get(spec.id)?.lastError || ""})` };

  if (spec.fetchKind === "web_search") {
    const r = await searchFn(spec.site ? `site:${spec.site} ${q.query}` : q.query, { maxResults: q.limit, site: spec.site });
    if (!r.ok) { recordFailure(spec, r.error || "检索失败"); return { entries: [], error: r.error || "检索失败" }; }
    recordSuccess(spec);
    return {
      entries: r.hits.map((h) => ({ title: h.title, url: h.url, summary: h.snippet || "", publishedAt: h.publishedAt ? parseDate(h.publishedAt) : null })),
    };
  }

  const url = spec.url || "";
  if (!url) return { entries: [], error: "源未配置地址(部署时补 url)" };
  const res = await fetcher(url, { timeoutMs: DEFAULT_TIMEOUT_MS, headers: spec.headers });
  if (!res.ok) {
    const err = res.error || `HTTP ${res.status}`;
    recordFailure(spec, err);
    return { entries: [], error: err };
  }
  const entries = parseSourceBody(spec, res.body);
  if (!entries.length) {
    // 200 但解析不出条目 —— 当失败记: 这类"静默空"最容易被当成"没有舆情"
    recordFailure(spec, "响应可读但未解析出条目(站点结构可能已变)");
    return { entries: [], error: "响应可读但未解析出条目(站点结构可能已变)" };
  }
  recordSuccess(spec);
  return { entries };
}

// ═══════════════════════════════════════════════════════════
// 缓存(内存快路径 + 表里那份跨重启)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = Math.max(60_000, parseInt(process.env.OPINION_CACHE_TTL_MS || "1800000", 10));
const memoryCache = new Map<string, { at: number; result: OpinionSearchResult }>();
const MEMORY_CACHE_MAX = 50;

export function cacheKeyOf(userId: string, query: string, params: unknown): string {
  const norm = (query || "").trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${userId}|${norm}|${JSON.stringify(params)}`).digest("hex");
}

async function readCache(key: string): Promise<{ result: OpinionSearchResult; ageMs: number } | null> {
  const mem = memoryCache.get(key);
  if (mem) return { result: mem.result, ageMs: Date.now() - mem.at };
  try {
    const r = await pool.query(
      `select result, created_at from opinion_search_cache where query_hash=$1 and expires_at > now() order by created_at desc limit 1`,
      [key]);
    if (!r.rows.length) return null;
    const result = r.rows[0].result as OpinionSearchResult;
    return { result, ageMs: Date.now() - new Date(r.rows[0].created_at).getTime() };
  } catch {
    return null;   // 缓存不可用只是慢一点, 不是错误
  }
}

async function writeCache(key: string, userId: string, query: string, params: unknown, result: OpinionSearchResult, ttlMs: number): Promise<void> {
  memoryCache.set(key, { at: Date.now(), result });
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = [...memoryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) memoryCache.delete(oldest[0]);
  }
  try {
    await pool.query(
      `insert into opinion_search_cache (user_id, query, query_hash, params, result, item_count, expires_at)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6, now() + ($7 || ' milliseconds')::interval)`,
      [userId, query, key, JSON.stringify(params ?? {}), JSON.stringify(result), result.items.length, String(ttlMs)]);
  } catch { /* 写不进缓存不影响本次结果 */ }
}

export function clearMemoryCache(): void { memoryCache.clear(); }

// ═══════════════════════════════════════════════════════════
// 条目池(跨 query 复用: 换关键词重查 / 源当日故障时回补)
// ═══════════════════════════════════════════════════════════

export function contentHashOf(item: { source: string; url: string; title: string }): string {
  return createHash("sha256").update(`${item.source}|${item.url || item.title}`).digest("hex");
}

async function persistItems(items: OpinionItem[], firstQuery: string): Promise<number> {
  if (!items.length) return 0;
  let saved = 0;
  for (const it of items) {
    try {
      const r = await pool.query(
        `insert into opinion_items
           (source_id, source_name, category, title, summary, url, published_at, lang,
            sentiment, stance, intensity, topics, first_query, content_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
         on conflict (content_hash) do update set
           sentiment = excluded.sentiment, stance = excluded.stance,
           intensity = excluded.intensity, topics = excluded.topics,
           summary = case when opinion_items.summary = '' then excluded.summary else opinion_items.summary end
         returning (xmax = 0) as inserted`,
        [it.source, it.sourceName, it.category, it.title, it.summary, it.url, it.publishedAt, it.lang,
         it.sentiment, it.stance, it.intensity, JSON.stringify(it.topics ?? []), firstQuery, contentHashOf(it)]);
      if (r.rows[0]?.inserted) saved++;
    } catch { /* 单条落库失败不影响本次结果 */ }
  }
  return saved;
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

function toIso(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 舆情检索主入口。
 *
 * 失败语义: **没有任何一条链路能让整体失败** ——
 *   某个源失败 → 该源进 softErrors, 其它源照常; 缓存读写失败 → 忽略; LLM 校准失败 → 用规则结果;
 *   聚类/热词失败 → 结果里少那两块, 条目仍在。唯一会抛的是参数错误(空 query)。
 */
export async function searchOpinion(input: OpinionSearchInput): Promise<OpinionSearchResult> {
  const query = (input.query || "").trim();
  if (!query) throw new Error("query 不能为空");

  const since = toIso(input.since), until = toIso(input.until);
  const granularity = input.granularity ?? "day";
  const limit = Math.max(1, Math.min(80, input.limit ?? 30));
  const userId = input.userId || "00000000-0000-0000-0000-000000000000";
  const fetcher = input.fetcher ?? httpFetcher;
  const searchFn = input.searchFn ?? registrySearchFn;
  const ttl = input.cacheTtlMs ?? DEFAULT_TTL_MS;

  const kw = keywordsFromQuery(query);
  /**
   * 选源: 三档优先 —— 显式指定 > 路由 > 全量。
   * 显式指定永远最优先: 调用方说"我就查这两个源"时不该被路由改写。
   */
  const routed = input.route && !input.sources?.length && !input.categories?.length
    ? routeOpinion(query)
    : null;
  const sources = routed
    ? enabledSources({ ids: routed.preferredSourceIds })
    : enabledSources({ ids: input.sources, categories: input.categories });
  const cacheParams = {
    since: since?.toISOString() ?? null, until: until?.toISOString() ?? null,
    sources: input.sources ?? (routed ? routed.preferredSourceIds : null), categories: input.categories ?? null,
    granularity, limit, llm: !!input.llmCalibrate,
  };
  const cacheKey = cacheKeyOf(userId, query, cacheParams);

  if (!input.bypassCache) {
    const hit = await readCache(cacheKey);
    if (hit) return { ...hit.result, cached: true, cacheAgeMs: hit.ageMs };
  }

  const notes: string[] = [];
  const stats: SourceStat[] = [];
  const softErrors: Array<{ sourceId: string; name: string; error: string }> = [];
  const collected: Array<{ item: RawEntry; spec: OpinionSourceSpec }> = [];
  const scaleRaw: Array<{ entry: RawEntry; spec: OpinionSourceSpec }> = [];

  const results = await mapLimited(sources, MAX_CONCURRENCY, (spec) => fetchOneSource(spec, { query, keywords: kw.keywords, limit }, fetcher, searchFn));

  sources.forEach((spec, i) => {
    const r = results[i];
    const stat: SourceStat = { sourceId: spec.id, name: spec.name, category: spec.category, lang: spec.lang, fetched: r.entries.length, kept: 0, note: spec.note };
    if (r.error) { stat.error = r.error; softErrors.push({ sourceId: spec.id, name: spec.name, error: r.error }); }
    // 榜单类源不进关键词池(见文件头口径③): 它的条目数本身是规模信号
    if (spec.track) {
      for (const e of r.entries) scaleRaw.push({ entry: e, spec });
    } else {
      for (const e of r.entries) collected.push({ item: e, spec });
    }
    stats.push(stat);
  });

  // ① 归一 + 关键词筛 + 时间筛
  const sinceMs = since?.getTime(), untilMs = until?.getTime();
  const kept: OpinionItem[] = [];
  const fetchedAt = new Date().toISOString();
  let undatedSkipped = 0;
  for (const { item: e, spec } of collected) {
    const hay = `${e.title} ${e.summary}`;
    const score = relevanceOf(hay, e.title, kw);
    if (score <= 0) continue;
    const t = e.publishedAt ? Date.parse(e.publishedAt) : NaN;
    if ((sinceMs || untilMs) && isNaN(t)) { undatedSkipped++; continue; }
    if (sinceMs && t < sinceMs) continue;
    if (untilMs && t > untilMs) continue;
    kept.push({
      title: e.title, summary: e.summary, url: e.url,
      source: spec.id, sourceName: spec.name, category: spec.category,
      publishedAt: e.publishedAt, fetchedAt, lang: spec.lang,
      sentiment: "neutral", stance: "neutral", intensity: 0, topics: [],
      score, alsoReportedBy: [], duplicateCount: 1,
    });
  }
  if (undatedSkipped > 0) {
    notes.push(`有 ${undatedSkipped} 条命中关键词但没有发布时间, 无法判定是否落在所选时间范围内, 已排除`);
  }

  // ② 去重(同一事件多家转载)
  kept.sort((a, b) => b.score - a.score);
  const deduped = dedupeItems(kept.slice(0, limit * 4), { threshold: 0.72, windowHours: 72 });
  if (deduped.merged > 0) notes.push(`按题名相似度+72 小时窗合并了 ${deduped.merged} 条重复报道(保留首发, 其余记入转载源)`);

  const items = deduped.items.slice(0, limit);

  // ③ 情感/立场(规则兜底; LLM 可选校准)
  let calibrated = 0;
  const ruleResults: SentimentResult[] = analyzeSentimentBatch(items.map((it) => `${it.title}。${it.summary}`));
  if (input.llmCalibrate && items.length) {
    const cal = await calibrateWithLlm(items.map((it) => `${it.title}。${it.summary}`), ruleResults);
    calibrated = cal.calibrated;
    if (cal.error) notes.push(`LLM 校准未生效: ${cal.error}`);
    else notes.push(`LLM 校准了 ${calibrated}/${items.length} 条的情感与立场`);
  }
  items.forEach((it, i) => {
    const r = ruleResults[i];
    it.sentiment = r.sentiment; it.stance = r.stance; it.intensity = r.intensity;
  });

  // ④ 话题聚类(顺带把簇关键词回填到条目 topics)
  let clusters: OpinionCluster[] = [];
  try {
    clusters = clusterOpinionItems(items);
    const kwByItem = new Map<string, string[]>();
    for (const c of clusters) for (const ci of c.items) {
      if (c.id >= 0 && c.label !== "其他") kwByItem.set(`${ci.title}|${ci.url}`, c.keywords.slice(0, 4));
    }
    for (const it of items) it.topics = kwByItem.get(`${it.title}|${it.url}`) ?? [];
  } catch { notes.push("话题聚类失败(条目与统计仍然可用)"); }

  // ⑤ 统计
  const dist = distributionOf(ruleResults);
  const hotWords = hotWordsOf(items);
  // 空的热词榜看起来像坏了, 其实常见于"样本太少/各说各的"。把原因说出来。
  if (!hotWords.length && items.length >= 3) {
    notes.push("热词为空: 这批语料里没有一个词在两条以上出现(样本太少或各说各的), 不代表分词失败");
  }
  const { bySource, byCategory } = sourceDistribution(items);
  for (const s of stats) {
    const hit = bySource.find((x) => x.sourceId === s.sourceId);
    s.kept = hit?.count ?? 0;
  }

  // ⑥ 榜单类源的规模信号(只做情感, 不筛关键词)
  let scaleSignals: ScaleSignal[] = [];
  let scaleDistribution: SentimentDistribution | null = null;
  if (scaleRaw.length) {
    const scaleResults = analyzeSentimentBatch(scaleRaw.map((s) => s.entry.title));
    scaleDistribution = distributionOf(scaleResults);
    scaleSignals = scaleRaw.slice(0, 50).map((s, i) => ({
      source: s.spec.id, sourceName: s.spec.name,
      rank: s.entry.rank ?? i, topic: s.entry.title,
      heat: s.entry.heat ?? 0, sentiment: scaleResults[i].sentiment,
    }));
    notes.push("热搜榜为**榜单**而非检索结果: 只作议题规模信号, 不代表该话题的讨论量");
  }

  // ⑦ 落池 + 落缓存
  const saved = await persistItems(items, query).catch(() => 0);
  if (saved > 0) notes.push(`新入条目池 ${saved} 条(换关键词重查或某源当日故障时可从这里回补)`);

  const result: OpinionSearchResult = {
    query, keywords: kw.keywords,
    range: { since: since?.toISOString() ?? null, until: until?.toISOString() ?? null },
    items, total: items.length,
    clusters, trend: buildTrend(items, granularity), trendGranularity: granularity,
    distribution: dist, byCategory,
    hotWords,
    scaleSignals, scaleDistribution,
    sources: stats, softErrors, notes, llmCalibrated: calibrated,
    cached: false, generatedAt: new Date().toISOString(),
    route: routed,
  };
  await writeCache(cacheKey, userId, query, cacheParams, result, ttl);
  return result;
}

// ═══════════════════════════════════════════════════════════
// 条目池检索(不联网; 只查历史采集)
// ═══════════════════════════════════════════════════════════

const CATEGORY_VALUES: OpinionCategory[] = ["news", "official", "academic", "social", "search"];

/**
 * 只查条目池, **不打外部源**。
 * 用途: 复核同一个问题(语料已经采过)、或离线统计。带时间范围时**只返回有发布时间的条目**,
 * 并把被排除的条数报出来 —— 池里那些没时间的条目在时间维度上不存在, 不该假装它们在里面。
 */
export async function searchOpinionPool(input: {
  query: string; since?: Date | string | null; until?: Date | string | null;
  sources?: string[]; categories?: OpinionCategory[]; limit?: number; granularity?: "day" | "week";
}): Promise<OpinionSearchResult> {
  const query = (input.query || "").trim();
  if (!query) throw new Error("query 不能为空");
  const kw = keywordsFromQuery(query);
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const since = toIso(input.since), until = toIso(input.until);
  const granularity = input.granularity ?? "day";
  const notes: string[] = [];

  // 两套参数各自独立构建 —— 把"时间条件"和"其它条件"混在一个数组里再按下标回切,
  //   是这种查询最容易出错的地方(since/until 只给一个时下标就错位)。
  const baseConds: string[] = [];
  const baseParams: unknown[] = [];
  const like = (k: string) => { baseParams.push(`%${k}%`); return `(title ilike $${baseParams.length} or summary ilike $${baseParams.length})`; };
  baseConds.push(`(${kw.keywords.map(like).join(" or ")})`);
  if (input.sources?.length) { baseParams.push(input.sources); baseConds.push(`source_id = any($${baseParams.length})`); }
  if (input.categories?.length) { baseParams.push(input.categories); baseConds.push(`category = any($${baseParams.length})`); }

  const rangeOn = !!(since || until);
  const timeConds: string[] = [];
  const timeParams: unknown[] = [];
  // ⚠ 占位符编号必须**接着 baseParams 往下排**。时间条件从 $1 重新编号的话,
  //   在"只给时间不给 sources/categories"这种最常见的调用下会和关键词条件撞号
  //   —— 报的是 `could not determine data type of parameter $3`, 而根因是两个命名空间混用。
  const nextRef = () => `$${baseParams.length + timeParams.length}`;
  // 显式 ::timestamptz: 不写的话 pg 会把未定型参数判成 text, 报
  //   `operator does not exist: timestamp with time zone >= text` —— 整条池检索直接失败
  if (since) { timeParams.push(since.toISOString()); timeConds.push(`published_at >= ${nextRef()}::timestamptz`); }
  if (until) { timeParams.push(until.toISOString()); timeConds.push(`published_at <= ${nextRef()}::timestamptz`); }
  // 带时间范围时排除无发布时间的条目 —— 它们在时间维度上不存在, 不该被当成"落在范围内"
  const where = [...baseConds, ...(rangeOn ? ["published_at is not null", ...timeConds] : [])].join(" and ");

  let rows: any[] = [];
  let skippedUndated = 0;
  try {
    const allParams = [...baseParams, ...(rangeOn ? timeParams : []), limit];
    const r = await pool.query(
      `select source_id, source_name, category, title, summary, url, published_at, lang,
              sentiment, stance, intensity, topics, fetched_at, content_hash
         from opinion_items where ${where}
         order by published_at desc nulls last, fetched_at desc limit $${allParams.length}`,
      allParams);
    rows = r.rows;
    if (rangeOn) {
      const s = await pool.query(
        `select count(*)::int c from opinion_items where ${baseConds.join(" and ")} and published_at is null`,
        baseParams);
      skippedUndated = s.rows[0]?.c ?? 0;
    }
  } catch (e) {
    throw new Error(`条目池查询失败: ${String((e as Error)?.message || e).slice(0, 120)}`);
  }

  const items: OpinionItem[] = rows.map((r) => ({
    title: r.title, summary: r.summary ?? "", url: r.url ?? "",
    source: r.source_id, sourceName: r.source_name, category: (CATEGORY_VALUES.includes(r.category) ? r.category : "news") as OpinionCategory,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    fetchedAt: r.fetched_at ? new Date(r.fetched_at).toISOString() : new Date().toISOString(),
    lang: (r.lang === "en" ? "en" : "zh") as Lang,
    sentiment: r.sentiment, stance: r.stance, intensity: Number(r.intensity ?? 0),
    topics: Array.isArray(r.topics) ? r.topics : [],
    score: relevanceOf(`${r.title} ${r.summary ?? ""}`, r.title, kw),
    alsoReportedBy: [], duplicateCount: 1,
  }));
  if (skippedUndated > 0) notes.push(`条目池里另有 ${skippedUndated} 条命中但没有发布时间, 已按时间范围排除`);

  const results = analyzeSentimentBatch(items.map((it) => `${it.title}。${it.summary}`));
  const { bySource, byCategory } = sourceDistribution(items);
  let clusters: OpinionCluster[] = [];
  try { clusters = clusterOpinionItems(items); } catch { notes.push("话题聚类失败(条目与统计仍然可用)"); }

  return {
    query, keywords: kw.keywords,
    range: { since: since?.toISOString() ?? null, until: until?.toISOString() ?? null },
    items, total: items.length, clusters,
    trend: buildTrend(items, granularity), trendGranularity: granularity,
    distribution: distributionOf(results), byCategory,
    hotWords: hotWordsOf(items),
    scaleSignals: [], scaleDistribution: null,
    sources: bySource.map((s) => ({ sourceId: s.sourceId, name: s.name, category: s.category, lang: "zh" as Lang, fetched: s.count, kept: s.count })),
    softErrors: [], notes, llmCalibrated: 0,
    cached: false, generatedAt: new Date().toISOString(),
    // 条目池这条路**不选源**(它查的是已经落库的历史条目), 所以没有路由计划
    route: null,
  };
}

/** 条目池规模(运维/界面: 池子空的时候要说清楚, 否则用户会以为"没有舆情") */
export async function poolStats(): Promise<{ total: number; bySource: Array<{ sourceId: string; name: string; count: number }>; earliest: string | null; latest: string | null }> {
  try {
    const r = await pool.query(
      `select source_id, source_name, count(*)::int c, min(published_at) e, max(published_at) l
         from opinion_items group by source_id, source_name order by c desc`);
    const total = r.rows.reduce((a, row) => a + Number(row.c), 0);
    const dates = r.rows.map((row) => row.e).filter(Boolean).map((d) => new Date(d).getTime());
    const datesL = r.rows.map((row) => row.l).filter(Boolean).map((d) => new Date(d).getTime());
    return {
      total,
      bySource: r.rows.map((row) => ({ sourceId: row.source_id, name: row.source_name, count: Number(row.c) })),
      earliest: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      latest: datesL.length ? new Date(Math.max(...datesL)).toISOString() : null,
    };
  } catch {
    return { total: 0, bySource: [], earliest: null, latest: null };
  }
}

export const opinionSearchService = {
  searchOpinion, searchOpinionPool, poolStats, sourceHealth, resetSourceHealth,
  // 纯函数(测试/前端复用)
  keywordsFromQuery, relevanceOf, normalizeOpinionTitle, titleSimilarity, dedupeItems,
  clusterOpinionItems, buildTrend, hotWordsOf, parseFeedEntries, parseGovPushInfo,
  parseOsfPreprints, parseWeiboHot, decodeBody, contentHashOf, cacheKeyOf,
};
