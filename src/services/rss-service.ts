// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// rss-service.ts — RSS 订阅 + arXiv 今日推荐（2026-08-27, Agentero 对照: 文献导入源）
// 能力: RSS 源抓取解析(标题/链接/日期/摘要) → 入库草稿; arXiv 按主题推荐今日论文
// 免依赖: 全用 fetch, RSS 用正则解析(xml 简单结构)
import { pool } from "../db/pool.js";

export interface RssEntry {
  title: string;
  link: string;
  date?: string;
  summary?: string;
}

/** 解析 RSS XML（简化: 只处理 <item>/<entry> 的 title/link/pubDate/description） */
export function parseRss(xml: string): RssEntry[] {
  const entries: RssEntry[] = [];
  const itemRe = /<(item|entry)[^>]*>([\s\S]*?)<\/(item|entry)>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[2];
    const get = (tag: string): string => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(body);
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const title = get("title");
    if (!title) continue;
    entries.push({
      title,
      link: get("link").trim(),
      date: get("pubDate") || get("updated") || get("date"),
      summary: (get("description") || get("summary")).slice(0, 500),
    });
  }
  return entries;
}

/** 抓取并解析 RSS 源 */
export async function fetchRss(url: string): Promise<{ ok: boolean; entries: RssEntry[]; error?: string }> {
  try {
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(15_000) });
    if (!resp.ok) return { ok: false, entries: [], error: `HTTP ${resp.status}` };
    const xml = await resp.text();
    return { ok: true, entries: parseRss(xml).slice(0, 30) };
  } catch (e: any) {
    return { ok: false, entries: [], error: String(e?.message || e).slice(0, 150) };
  }
}

/** arXiv API 查询（按主题关键词, 返回今日/近期论文） */
export async function fetchArxivToday(topic: string, maxResults = 10): Promise<{ ok: boolean; entries: RssEntry[]; error?: string }> {
  try {
    const query = encodeURIComponent(`all:"${topic}"`);
    const url = `http://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(20_000) });
    if (!resp.ok) return { ok: false, entries: [], error: `HTTP ${resp.status}` };
    const xml = await resp.text();
    // arXiv 是 Atom 格式: <entry><title><link href><published><summary>
    const entries = parseRss(xml).map((e) => ({ ...e, link: e.link || extractArxivLink(xml, e.title) }));
    return { ok: true, entries };
  } catch (e: any) {
    return { ok: false, entries: [], error: String(e?.message || e).slice(0, 150) };
  }
}

function extractArxivLink(xml: string, title: string): string {
  const idx = xml.indexOf(title);
  if (idx < 0) return "";
  const before = xml.slice(0, idx);
  const linkRe = /<link[^>]*href="([^"]*abs[^"]*)"/g;
  let m: RegExpExecArray | null, last = "";
  while ((m = linkRe.exec(before)) !== null) last = m[1];
  return last;
}

/** 订阅源持久化（sources 表 metadata 或独立表 — 用 PG 简单表） */
export async function saveRssSubscription(url: string, name: string, sourceId: string): Promise<boolean> {
  try {
    await pool.query(
      `insert into sources (id, name, tenant_id, metadata)
       values (gen_random_uuid(), $1, 'default', $2::jsonb)`,
      [name, JSON.stringify({ rssUrl: url, rssFor: sourceId, semanticType: "rss-feed" })]
    );
    return true;
  } catch { return false; }
}

/**
 * 刷新全部 RSS / arXiv 订阅（V417, 2026-10-02 改落点）。
 *
 * 由来: `saveRssSubscription` 只把 URL 写进 sources.metadata, **全仓没有任何拉取消费者** ——
 *   订阅了永远不会更新, 是个"写完即死"的功能。V417 补上了消费者。
 *
 * ⚠ 落点改过两次, 记下来免得再绕回去:
 *   ① 原设计写 alerts(category=rss_update, level=info)。**两个问题**:
 *      · alerts 是**全局运维表, 没有 user_id** —— 而 sources 表也只有 tenant_id,
 *        所以"这条 feed 是谁订的"根本无从得知, 写了也不归属于任何人;
 *      · level=info 会被 `AlertToast.tsx:38` 的 `filter(a => a.level !== "info")` 滤掉,
 *        所以它连弹都弹不出来。写了等于没写。
 *   ② 现在写 **digest_items**(研究速递的条目表): 条目是**内容**(有标题有链接),
 *      与速递的其他源同构; 用户查速递时按自己订阅的主题/期刊过滤,
 *      归属问题由查询侧解决, 不再需要"这条 feed 属于谁"。
 *      同时把订阅的主题/期刊也带上, 让它能真的被对应的人看到。
 *
 * 去重: 交给 `digest_items` 的两条部分唯一索引(item_doi_key / item_title_key) ——
 *   本函数不再自己维护 seenLinks。原实现把已见链接存在 sources.metadata 里,
 *   既会让 metadata 无限膨胀, 又在多副本下互相覆盖。
 *
 * 多副本: 由调用方通过 withRunLease 加跨副本租约(见 singleton-scheduler)。
 */
export async function refreshAllRssSubscriptions(maxFeeds = 20): Promise<{ feeds: number; newItems: number }> {
  const r = await pool.query(
    `select id, name, metadata from sources
      where metadata->>'semanticType' = 'rss-feed'
      order by created_at desc limit $1`,
    [maxFeeds]
  );
  if (!r.rows.length) return { feeds: 0, newItems: 0 };

  const { persistCandidates } = await import("./digest/digest-service.js");
  const { plausibleDateFor } = await import("./digest/normalize.js");

  // 订阅的主题/期刊 —— 让 RSS 条目归属到真正订阅了相关方向的人。
  // 一个 feed 本身不带主题信息(它只是个 URL), 所以借用全体订阅者关心的主题集合。
  let sharedTopics: string[] = [];
  try {
    const { collectAllSubscriptions } = await import("./digest/digest-service.js");
    sharedTopics = (await collectAllSubscriptions()).topics;
  } catch { /* 无订阅时留空, 条目不挂主题, 由期刊维度或全量展示兜底 */ }

  let newItems = 0;
  for (const row of r.rows) {
    const meta = (row.metadata ?? {}) as { rssUrl?: string; rssFor?: string; feedKind?: string };
    const url = String(meta.rssUrl || "").trim();
    if (!url) continue;
    // feedKind=arxiv 的订阅走 arXiv API(排序按提交日, RSS 那套对 arXiv 不适用)
    const feed = meta.feedKind === "arxiv"
      ? await fetchArxivToday(String(meta.rssFor || "").trim() || "machine learning", 20)
      : await fetchRss(url);
    if (!feed.ok || !feed.entries.length) continue;

    const candidates = feed.entries
      .filter((e) => e.title && e.link)
      .slice(0, 20)
      .map((e) => ({
        source: "rss",
        externalId: e.link,
        title: String(e.title).trim(),
        doi: "",
        url: String(e.link),
        journal: String(row.name || ""),
        authors: [] as string[],
        abstract: String(e.summary || "").trim(),
        // pubDate 是各种格式(RFC-2822 / ISO / 裸日期), 统一交给 parsePublished 归一,
        // 解析不出即 NULL —— **不写 now()** 冒充(新华网 RSS 那条教训)
        publishedAt: plausibleDateFor(parseRssDate(e.date)),
        topics: sharedTopics.slice(0, 5),
        lang: "" as const
      }));
    if (!candidates.length) continue;

    const { inserted } = await persistCandidates(candidates as any);
    newItems += inserted;
  }
  return { feeds: r.rows.length, newItems };
}

/** RSS 的日期串 → Date。复用速递的四种格式归一, 解析不出返回 null。 */
function parseRssDate(raw: string | undefined): Date | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const rssService = {
  parseRss, fetchRss, fetchArxivToday, saveRssSubscription, refreshAllRssSubscriptions,
};
