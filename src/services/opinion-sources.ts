// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// opinion-sources.ts — 舆情检索的**源注册表**(数据与逻辑分开, 加源不改服务)
//
// 由来(2026-10-01): 旧项目 AItoolman 有一份 `get_public_opinion_sources_dict`, 本仓一份都没有。
//   移植时最要紧的不是"把那个字典抄过来", 而是**只登记真的能用、且不违规**的入口:
//     · RSS / 公开 JSON 接口 / 开放 API 是允许的;
//     · 需要登录、有反爬的站**一律不写爬虫** —— 那种源迟早会把平台变成对被采集方的骚扰,
//       而且研究用途用不到它: 要的是可复现的语料, 不是"能抓到就行"。
//   所以下面每个源都是**实测过状态码与首条时间**的; 没实测通的宁可不登记。
//
// 三条实测才发现的事实(都影响使用方式, 写在注册表里而不是文档里):
//   ① **人民网 RSS 的发布时间是冻结的** —— 政治/观点/社会等频道停在 2025-06, 教育更早(2016)。
//      内容是精选而非快讯, 按"近两天"筛就永远是空的。用 note 标出来, 由界面决定怎么用。
//   ② **新华网 RSS 的 300 条不带 pubDate**(时间裸在 description 前面), 解析出来没有发布时间。
//      故意**不填 now()** 冒充 —— 那会把"哪天讨论量高"变成"哪天抓得多"。
//   ③ 微博热搜是**榜单**不是检索: 拿它当"某话题在全网的讨论量"是误用。这里只登记、
//      标 track=true(可作规模信号), 且**不许用关键词去筛它**(筛出来永远是 0,
//      会伪装成"这个话题没人在讨论")。
//
// 分类(category)按**用途**分, 不按站点分: 研究问题通常是"官方怎么说 / 媒体怎么说 /
//   学术怎么评 / 公众怎么议", 分类就是这四条对照线。
import type { Lang } from "./keyword-network-service.js";

export type OpinionCategory = "news" | "official" | "academic" | "social" | "search";

/** 采集方式。**没有 http_scrape**: 不写需要登录/有反爬的站点的爬虫 */
export type FetchKind = "rss" | "json" | "web_search";

export interface OpinionSourceSpec {
  id: string;
  name: string;
  category: OpinionCategory;
  /** ISO 3166-1 alpha-2, 或 "intl" */
  country: string;
  lang: Lang;
  baseUrl: string;
  fetchKind: FetchKind;
  enabled: boolean;
  /** rss/json 的直取地址 */
  url?: string;
  /** web_search 的域名限定(传给检索 provider) */
  site?: string;
  /** 库内**规模**信号源: 条目数本身有含义(榜单类)。不参与关键词筛选 */
  track?: boolean;
  /** 源自身的限制/坑 —— 界面要能把这句原样告诉研究者, 别让人以为"没结果=没人讨论" */
  note?: string;
  /**
   * 该源要求的额外请求头。
   * 微博的公开榜单接口不带 Referer 直接 403 —— 这是源的**入口约定**, 不是反爬绕过:
   * 它要的就是"从微博页面发起的请求"。缺了它这个源会一直失败(在结果里表现为 softError)。
   */
  headers?: Record<string, string>;
}

/** 检索输入。web_search 类源的 URL 由它拼出 */
export interface SourceQuery {
  query: string;
  keywords: string[];
  limit?: number;
  since?: Date;
}

export const PUBLIC_OPINION_SOURCES: OpinionSourceSpec[] = [
  // ════════════════ 新闻媒体(RSS) ════════════════
  {
    id: "people-politics", name: "人民网·时政", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/politics.xml",
    fetchKind: "rss", enabled: true,
    note: "精选型 RSS: 发布时间冻结在 2025-06(源站未再更新), 适合看'官方舆论场的基调', 不适合当作近两日增量",
  },
  {
    id: "people-opinion", name: "人民网·观点", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/opinion.xml",
    fetchKind: "rss", enabled: true, note: "同上: 发布时间冻结(源站 2025-06 后未更新)。评论版, 立场分析的主要素材",
  },
  {
    id: "people-world", name: "人民网·国际", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/world.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "people-culture", name: "人民网·文化", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/culture.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "people-society", name: "人民网·社会", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/society.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "people-edu", name: "人民网·教育", category: "news", country: "CN", lang: "zh",
    baseUrl: "http://www.people.com.cn", url: "http://www.people.com.cn/rss/edu.xml",
    fetchKind: "rss", enabled: true, note: "教育频道 RSS 停更较早(2016), 仅作历史素材",
  },
  {
    id: "xinhua-politics", name: "新华网·时政", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.news.cn", url: "https://www.news.cn/politics/news_politics.xml",
    fetchKind: "rss", enabled: true,
    note: "源站条目不写 pubDate(时间裸在描述前), 因此**没有发布时间** —— 这类条目不进时间序列",
  },
  {
    id: "chinanews-scroll", name: "中国新闻网·滚动", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.chinanews.com.cn", url: "https://www.chinanews.com.cn/rss/scroll-news.xml",
    fetchKind: "rss", enabled: true, note: "带完整 pubDate 的实时源, 30 条/次",
  },
  {
    id: "chinanews-society", name: "中国新闻网·社会", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.chinanews.com.cn", url: "https://www.chinanews.com.cn/rss/society.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "chinanews-theory", name: "中国新闻网·理论", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.chinanews.com.cn", url: "https://www.chinanews.com.cn/rss/theory.xml",
    fetchKind: "rss", enabled: true, note: "理论评论版, 条目少(约 13 条), 是官方话语侧的好素材",
  },
  {
    id: "chinanews-fz", name: "中国新闻网·法治", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.chinanews.com.cn", url: "https://www.chinanews.com.cn/rss/fz.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "chinanews-edu", name: "中国新闻网·教育", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.chinanews.com.cn", url: "https://www.chinanews.com.cn/rss/edu.xml",
    fetchKind: "rss", enabled: true,
  },
  {
    id: "jiemian", name: "界面新闻·快报", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://www.jiemian.com", url: "https://a.jiemian.com/index.php?m=article&a=rss",
    fetchKind: "rss", enabled: true, note: "财经/社会快讯, 30 条/次; 摘要多为空(正文在页内)",
  },
  {
    id: "sspai", name: "少数派", category: "news", country: "CN", lang: "zh",
    baseUrl: "https://sspai.com", url: "https://sspai.com/feed",
    fetchKind: "rss", enabled: true, note: "数字生活/科技评论, 10 条/次 —— 议题偏消费科技, 慎作社会议题语料",
  },

  // ════════════════ 政策/官方 ════════════════
  {
    id: "gov-cn-policy", name: "中国政府网·政策发布", category: "official", country: "CN", lang: "zh",
    baseUrl: "https://www.gov.cn", url: "https://www.gov.cn/pushinfo/v150203/pushinfo.json",
    fetchKind: "json", enabled: true,
    note: "官方公开 JSON 列表(约 60 条, 含 pubDate)。国务院文件/意见/办法的**一手发布**, 立场分析的基准线",
  },
  {
    id: "gov-cn-search", name: "中国政府网·政策检索", category: "official", country: "CN", lang: "zh",
    baseUrl: "https://www.gov.cn", site: "www.gov.cn", fetchKind: "web_search", enabled: true,
    note: "按关键词回查政策原文(走平台检索链, 不自己爬站)。政策类议题建议与 gov-cn-policy 一起看",
  },

  // ════════════════ 学术预印/期刊评论 ════════════════
  {
    id: "arxiv-cs-cy", name: "arXiv cs.CY(计算与社会)", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://arxiv.org", url: "https://export.arxiv.org/rss/cs.CY",
    fetchKind: "rss", enabled: true, note: "按日全量新文, **不支持关键词** —— 命中靠本地关键词筛选",
  },
  {
    id: "arxiv-econ-gn", name: "arXiv econ.GN(一般经济学)", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://arxiv.org", url: "https://export.arxiv.org/rss/econ.GN",
    fetchKind: "rss", enabled: true, note: "同上: 本地筛选",
  },
  {
    id: "arxiv-cs-si", name: "arXiv cs.SI(社会与信息网络)", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://arxiv.org", url: "https://export.arxiv.org/rss/cs.SI",
    fetchKind: "rss", enabled: true, note: "同上: 本地筛选",
  },
  {
    id: "osf-socarxiv", name: "SocArXiv(社科预印本)", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://osf.io", url: "https://api.osf.io/v2/preprints/?filter[provider]=socarxiv&page[size]=20&sort=-date_created",
    fetchKind: "json", enabled: true, note: "开放 API, 取最近上传; 关键词本地筛选(接口未提供全文检索参数)",
  },
  {
    id: "sd-world-development", name: "World Development", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/0305750X",
    fetchKind: "rss", enabled: true, note: "期刊最新上线文章(含卷期与出版日期); 无摘要, 只有题名+作者",
  },
  {
    id: "sd-rural-studies", name: "Journal of Rural Studies", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/07430167",
    fetchKind: "rss", enabled: true, note: "同上: 题名级摘要",
  },
  {
    id: "sd-land-use-policy", name: "Land Use Policy", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/02648377",
    fetchKind: "rss", enabled: true, note: "同上: 题名级摘要",
  },
  {
    id: "sd-political-geography", name: "Political Geography", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/09626298",
    fetchKind: "rss", enabled: true, note: "同上: 题名级摘要",
  },
  {
    id: "sd-gov-info-quarterly", name: "Government Information Quarterly", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/0740624X",
    fetchKind: "rss", enabled: true, note: "同上: 题名级摘要",
  },
  {
    id: "sd-china-economic-review", name: "China Economic Review", category: "academic", country: "intl", lang: "en",
    baseUrl: "https://www.sciencedirect.com", url: "https://rss.sciencedirect.com/publication/science/1043951X",
    fetchKind: "rss", enabled: true, note: "同上: 题名级摘要",
  },

  // ════════════════ 社媒(仅公开榜单接口) ════════════════
  {
    id: "weibo-hot", name: "微博热搜榜", category: "social", country: "CN", lang: "zh",
    baseUrl: "https://weibo.com", url: "https://weibo.com/ajax/side/hotSearch",
    fetchKind: "json", enabled: true, track: true,
    headers: { Referer: "https://weibo.com/", Accept: "application/json, text/plain, */*" },
    note: "公开榜单接口(50 条, 含热度 num)。**是榜单不是检索**: 只作议题规模信号, 不参与关键词筛选",
  },

  // ════════════════ 通用网页搜索(复用平台检索链) ════════════════
  {
    id: "web-search", name: "通用网页搜索", category: "search", country: "intl", lang: "zh",
    baseUrl: "", fetchKind: "web_search", enabled: true,
    note: "走 search-provider-registry(有 key 用 API provider, 否则 Edge 抓取兜底)。它**不是语料源而是补充线索**",
  },
];

export function opinionSourceById(id: string): OpinionSourceSpec | undefined {
  return PUBLIC_OPINION_SOURCES.find((s) => s.id === id);
}

/**
 * 可用源(注册表里 enabled 且有取数入口)。
 *
 * `includeTrack` 默认 **true**: 榜单类源要被抓回来当规模信号(在检索流程里走另一条分支),
 *   只有明确"只要可关键词检索的源"时才传 false。默认 false 的话榜单永远抓不到,
 *   scaleSignals 恒空 —— 而那是**静默**的(结果里只是少一块, 和"榜单没数据"看起来一样)。
 */
export function enabledSources(opts: { categories?: OpinionCategory[]; ids?: string[]; includeTrack?: boolean } = {}): OpinionSourceSpec[] {
  return PUBLIC_OPINION_SOURCES.filter((s) => {
    if (!s.enabled) return false;
    if (opts.ids?.length && !opts.ids.includes(s.id)) return false;
    if (opts.categories?.length && !opts.categories.includes(s.category)) return false;
    if (s.track && opts.includeTrack === false) return false;
    return s.fetchKind === "web_search" || !!s.url;
  });
}

/**
 * 关键词在 URL 上的安全拼接。
 * 只做 encodeURIComponent, 不做任何"清洗" —— 清洗过的关键词与用户输入不一致时,
 * 排查起来是噩梦(用户看到 A, 发出去的是 B)。
 */
export function endpointFor(spec: OpinionSourceSpec, q: SourceQuery): string {
  if (spec.fetchKind === "web_search") return spec.site ? `site:${spec.site} ${q.query}` : q.query;
  return spec.url || "";
}

export const PUBLISHER_FROZEN_NOTE =
  "来自源站的发布时间为历史值(该源站长期未更新 RSS), 不代表本次采集时间";

/** 面向前端的源清单(不含内部构建细节) */
export function describeSources(): Array<Pick<OpinionSourceSpec, "id" | "name" | "category" | "country" | "lang" | "baseUrl" | "fetchKind" | "enabled" | "track" | "note">> {
  return PUBLIC_OPINION_SOURCES.map(({ id, name, category, country, lang, baseUrl, fetchKind, enabled, track, note }) =>
    ({ id, name, category, country, lang, baseUrl, fetchKind, enabled, track, note }));
}
