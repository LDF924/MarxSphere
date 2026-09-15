// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
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
 * 刷新全部 RSS 订阅（V417）。
 *
 * 由来: `saveRssSubscription` 只把 URL 写进 sources.metadata, **全仓没有任何拉取消费者** ——
 *   订阅了永远不会更新, 是个"写完即死"的功能。这里补上消费者。
 *
 * 落点选择: 拉到的条目写进 **alerts**(用户已有的统一入口, 告警中心按 category 归类展示),
 *   而不是新建一张 feed_items 表 —— 少一张表、少一个要维护的读取端, 且用户本来就会看告警中心。
 *
 * 去重: 用 source metadata 里的 seenLinks(最近 200 条)做增量判断, 只提醒**新条目**。
 *   不做全量存档: 订阅的用途是"有新东西告诉我", 不是"把整个 feed 搬进库"。
 *
 * 多副本: 由调用方通过 withRunLease 加跨副本租约(见 singleton-scheduler)。
 */
export async function refreshAllRssSubscriptions(maxFeeds = 20): Promise<{ feeds: number; newItems: number }> {
  let newItems = 0;
  const r = await pool.query(
    `select id, name, metadata from sources
      where metadata->>'semanticType' = 'rss-feed'
      order by created_at desc limit $1`,
    [maxFeeds]
  );
  for (const row of r.rows) {
    const meta = (row.metadata ?? {}) as { rssUrl?: string; seenLinks?: string[] };
    const url = String(meta.rssUrl || "").trim();
    if (!url) continue;
    const seen = new Set(Array.isArray(meta.seenLinks) ? meta.seenLinks : []);
    const feed = await fetchRss(url);
    if (!feed.ok || !feed.entries.length) continue;
    const fresh = feed.entries.filter((e) => e.link && !seen.has(e.link)).slice(0, 10);
    if (!fresh.length) continue;
    try {
      const { recordAlert } = await import("./alert-service.js");
      for (const e of fresh) {
        await recordAlert({
          level: "info",
          category: "rss_update",
          message: `【${row.name}】${String(e.title || "").slice(0, 120)}`,
          taskType: "rss",
          detail: { url: e.link, feed: url, publishedAt: e.date },
        });
        newItems++;
      }
    } catch { /* 告警写入失败 → 本轮跳过, 下次仍是"新" */ continue; }
    // 记下已见(保留最近 200, 防 metadata 无限膨胀)
    const merged = [...feed.entries.map((e) => e.link).filter(Boolean), ...seen].slice(0, 200);
    await pool.query(`update sources set metadata = metadata || $2::jsonb where id = $1`, [
      row.id, JSON.stringify({ seenLinks: merged }),
    ]).catch(() => { /* 去重记录失败只是下轮重复提醒一次 */ });
  }
  return { feeds: r.rows.length, newItems };
}

export const rssService = {
  parseRss, fetchRss, fetchArxivToday, saveRssSubscription, refreshAllRssSubscriptions,
};
