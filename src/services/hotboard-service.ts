// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// hotboard-service.ts — 中文平台热榜(2026-10-03)
//
// 由来(对照开源项目 观澜/Guanlan 的 hotnews, MIT): 本仓此前**只有一个热榜** ——
//   微博热搜(`opinion-sources.ts` 的 `weibo-hot`, track:true)。而"今天中文互联网在涌动什么"
//   恰恰是多平台的事: 知乎在议什么、B 站在看什么、财经圈在传什么, 三个榜单给出的答案很不一样。
//
// ═══ 数据来源: 为什么走聚合而不是自己抓 15 个站 ═══
//   实测(2026-10-03)逐站探测:
//     · `api.bilibili.com` 直连 **403**(需要签名/风控), 而 B 站的 `s.search.../hotword` 能通;
//     · `v2ex.com/api/*` 直连超时;
//     · 百度 `top.baidu.com/api/board` 与 IT 之家 `api.ithome.com` **能直连**。
//   而聚合端点 `newsnow.busiyi.world/api/s?id=<平台>` 一次覆盖 **15 个平台**且全部可用
//   (知乎/微博/抖音/B站/百度/贴吧/掘金/V2EX/少数派/IT之家/虎扑/澎湃/财联社/华尔街见闻/雪球)。
//   所以这里**主路走聚合, 直连端点作备份**: 聚合挂了不至于全瘫, 也免得为 15 个站各写一套
//   会随时间腐烂的解析器。
//
// ⚠ 聚合源的代价必须写进结果(不是写进注释就算): 它是**第三方**, 数据可能来自它的缓存
//   (`status: "cache"`), 也可能整体不可用。所以每条都带 `via`(走的哪条路)与 `stale`,
//   界面上如实显示 —— 研究者需要知道"这个榜单是不是刚抓的"。
//
// ⚠ 热榜是**注意力样本**, 不是事实: 微博热度 136 万不等于 136 万人在讨论这件事。
//   这条口径在 `evidenceRole` 里逐条带着, 由界面显示。
import { logger } from "../observability/logger.js";

export interface HotBoard {
  /** 稳定 id, 与聚合端的 `id` 参数一致 */
  id: string;
  name: string;
  /** 平台大类 —— 决定它在界面上的分组 */
  category: "综合" | "社区" | "科技" | "财经" | "视频";
  /** 这个榜单回答的是"谁在议"还是"谁在看" —— 两者不能互相顶替 */
  evidenceRole: string;
}

/**
 * 可用榜单 —— **实测过才写进来**(2026-10-03 逐个探活)。
 * `github-trending-ai` 与 `36kr` 实测返回 500, 所以**不收** ——
 * 收进来只会让"今天有多少榜抓到"这个数字虚高。
 */
export const HOT_BOARDS: HotBoard[] = [
  { id: "zhihu", name: "知乎热榜", category: "社区", evidenceRole: "public_discussion_signal" },
  { id: "weibo", name: "微博热搜", category: "综合", evidenceRole: "public_attention_signal" },
  { id: "baidu", name: "百度热搜", category: "综合", evidenceRole: "fresh_trend_signal" },
  { id: "douyin", name: "抖音热点", category: "视频", evidenceRole: "video_attention_signal" },
  { id: "bilibili-hot-search", name: "B站热搜", category: "视频", evidenceRole: "video_attention_signal" },
  { id: "tieba", name: "贴吧热议", category: "社区", evidenceRole: "public_discussion_signal" },
  { id: "hupu", name: "虎扑步行街", category: "社区", evidenceRole: "community_sample" },
  { id: "thepaper", name: "澎湃新闻", category: "综合", evidenceRole: "news_agenda_signal" },
  { id: "juejin", name: "掘金", category: "科技", evidenceRole: "dev_community_signal" },
  { id: "v2ex", name: "V2EX", category: "科技", evidenceRole: "dev_community_signal" },
  { id: "sspai", name: "少数派", category: "科技", evidenceRole: "tool_community_signal" },
  { id: "ithome", name: "IT之家", category: "科技", evidenceRole: "tech_news_signal" },
  { id: "cls-telegraph", name: "财联社电报", category: "财经", evidenceRole: "market_flash_signal" },
  { id: "wallstreetcn", name: "华尔街见闻", category: "财经", evidenceRole: "market_news_signal" },
  { id: "xueqiu", name: "雪球热帖", category: "财经", evidenceRole: "investor_sentiment_sample" },
];

export interface HotItem {
  rank: number;
  title: string;
  url: string;
  /** 平台侧的热度值(有就给, 没有就 0) —— 各平台口径不同, 跨榜不可比 */
  heat: number;
  summary?: string;
}

export interface HotBoardResult {
  id: string;
  name: string;
  category: HotBoard["category"];
  evidenceRole: string;
  ok: boolean;
  /** 走的哪条路: aggregate(聚合) / direct(直连) */
  via: "aggregate" | "direct";
  /** 聚合端标记为缓存 —— 界面要能显示"这份不是刚抓的" */
  stale: boolean;
  items: HotItem[];
  error?: string;
  fetchedAt: string;
}

const AGGREGATE_BASE = "https://newsnow.busiyi.world/api/s";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

/**
 * 聚合有个必须处理的坑: 它**不是每次都真抓** —— 命中它自己的缓存时回 `status: "cache"`,
 * 这时 items 仍然有效(只是旧)。所以不能只看 HTTP 200 就当"刚抓到"。
 */
async function fetchAggregate(id: string, timeoutMs = 12_000): Promise<{ ok: boolean; items: HotItem[]; stale: boolean; error?: string }> {
  try {
    const r = await fetch(`${AGGREGATE_BASE}?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) return { ok: false, items: [], stale: false, error: `HTTP ${r.status}` };
    const d = (await r.json()) as { status?: string; items?: Array<Record<string, any>> };
    const rows = Array.isArray(d?.items) ? d.items : [];
    const items = rows
      .map((x, i) => ({
        // rank 聚合端**不给**(实测全是 undefined) —— 按数组顺序自己编, 界面直接显示序号
        rank: Number(x.rank) || i + 1,
        title: String(x.title ?? "").trim(),
        url: String(x.url ?? x.mobileUrl ?? "").trim(),
        heat: Number(x.extra?.info ?? x.heat ?? 0) || 0,
        summary: x.extra?.hover ? String(x.extra.hover) : undefined,
      }))
      .filter((x) => x.title);
    return { ok: true, items, stale: String(d?.status ?? "") === "cache" };
  } catch (e: any) {
    return { ok: false, items: [], stale: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 直连备份: 只给实测**能通**的三个(百度 / IT之家 / B站热词) */
async function fetchDirect(id: string, timeoutMs = 12_000): Promise<{ ok: boolean; items: HotItem[]; error?: string }> {
  try {
    if (id === "baidu") {
      const r = await fetch("https://top.baidu.com/api/board?platform=wise&tab=realtime", {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": UA, Referer: "https://top.baidu.com/" },
      });
      if (!r.ok) return { ok: false, items: [], error: `HTTP ${r.status}` };
      const d = (await r.json()) as any;
      // ⚠ 百度的 content 可能是**嵌套**的(实测外层是 tab 卡片、真正的行在 content[].content 里),
      //   只取一层会得到 0 条 —— 与观澜 _flatten_baidu_content 记的是同一个坑
      const cards: any[] = d?.data?.cards ?? [];
      let rows: any[] = [];
      for (const c of cards) {
        const flat: any[] = [];
        for (const e of (c?.content ?? [])) {
          if (e?.word || e?.query || e?.title) flat.push(e);
          else if (Array.isArray(e?.content)) flat.push(...e.content);
        }
        if (flat.length) { rows = flat; break; }
      }
      return {
        ok: true,
        items: rows.slice(0, 50).map((x: any, i: number) => ({
          rank: i + 1,
          title: String(x.word ?? x.query ?? x.title ?? "").trim(),
          url: String(x.url ?? x.rawUrl ?? (x.word ? `https://www.baidu.com/s?wd=${encodeURIComponent(x.word)}` : "")),
          heat: Number(x.hotScore ?? x.hot_score ?? 0) || 0,
          summary: x.desc ? String(x.desc) : undefined,
        })).filter((x) => x.title),
      };
    }
    if (id === "ithome") {
      const r = await fetch("https://api.ithome.com/json/newslist/news", {
        signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA },
      });
      if (!r.ok) return { ok: false, items: [], error: `HTTP ${r.status}` };
      const d = (await r.json()) as any;
      return {
        ok: true,
        items: (d?.newslist ?? []).slice(0, 50).map((x: any, i: number) => ({
          rank: i + 1, title: String(x.title ?? "").trim(),
          url: String(x.url ?? ""), heat: 0,
          summary: x.description ? String(x.description).slice(0, 200) : undefined,
        })).filter((x: any) => x.title),
      };
    }
    if (id === "bilibili-hot-search") {
      const r = await fetch("https://s.search.bilibili.com/main/hotword", {
        signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA },
      });
      if (!r.ok) return { ok: false, items: [], error: `HTTP ${r.status}` };
      const d = (await r.json()) as any;
      return {
        ok: true,
        items: (d?.list ?? []).slice(0, 50).map((x: any, i: number) => ({
          rank: i + 1, title: String(x.keyword ?? x.show_name ?? "").trim(),
          url: x.keyword ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(x.keyword))}` : "",
          heat: Number(x.heat_score ?? 0) || 0,
        })).filter((x: any) => x.title),
      };
    }
    return { ok: false, items: [], error: "该榜单没有直连实现" };
  } catch (e: any) {
    return { ok: false, items: [], error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * 抓一个榜: 聚合 → 直连备份。
 *
 * ⚠ 失败**不是异常**, 是这条源的结果之一(`ok:false`)。多源聚合里"某个榜挂了"
 *   是完全正常的, 把它抛出去会让"其余 14 个都抓到了"这件事一起丢掉。
 */
export async function fetchBoard(id: string): Promise<HotBoardResult> {
  const meta = HOT_BOARDS.find((b) => b.id === id);
  if (!meta) {
    return { id, name: id, category: "综合", evidenceRole: "", ok: false, via: "aggregate", stale: false, items: [], error: "未知榜单", fetchedAt: new Date().toISOString() };
  }
  const agg = await fetchAggregate(id);
  if (agg.ok && agg.items.length) {
    return { ...meta, ok: true, via: "aggregate", stale: agg.stale, items: agg.items, fetchedAt: new Date().toISOString() };
  }
  const direct = await fetchDirect(id);
  if (direct.ok && direct.items.length) {
    return { ...meta, ok: true, via: "direct", stale: false, items: direct.items, fetchedAt: new Date().toISOString() };
  }
  logger.warn({ board: id, aggErr: agg.error, directErr: direct.error }, "热榜抓取失败(两条路都不通)");
  return {
    ...meta, ok: false, via: "aggregate", stale: false, items: [],
    error: `聚合: ${agg.error ?? "无数据"}; 直连: ${direct.error ?? "无数据"}`,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 抓多个榜(并发上限 6)。
 * ⚠ 与舆情检索同一个理由: 15 个榜顺序抓会慢到不可用, 而全部并发会把对方站点打爆。
 */
export async function fetchBoards(ids?: string[], concurrency = 6): Promise<HotBoardResult[]> {
  const wanted = (ids?.length ? HOT_BOARDS.filter((b) => ids.includes(b.id)) : HOT_BOARDS);
  const out: HotBoardResult[] = [];
  for (let i = 0; i < wanted.length; i += concurrency) {
    const chunk = wanted.slice(i, i + concurrency);
    out.push(...await Promise.all(chunk.map((b) => fetchBoard(b.id))));
  }
  return out;
}

/** 榜单目录(界面先渲染目录, 再逐榜出数据) */
export function listBoards(): HotBoard[] {
  return HOT_BOARDS;
}
