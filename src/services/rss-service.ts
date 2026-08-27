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

export const rssService = {
  parseRss, fetchRss, fetchArxivToday, saveRssSubscription,
};
