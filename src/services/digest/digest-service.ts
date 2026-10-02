// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// digest-service.ts — 研究速递: 抓取编排 + 持久化 + 查询
//
// 消费链: fetchAllForTopics(抓) → persistCandidates(落) → getDigest(读)
// 加源只改 ./digest/sources.ts, 本文件不认具体源。

import { pool } from "../../db/pool.js";
import { logger } from "../../observability/logger.js";
import { HTTP_SOURCES, type DigestCandidate, type FetchResult } from "./sources.js";
import { normalizeDoi, normalizeTitle, plausibleDateFor } from "./normalize.js";

export interface DigestSubscription {
  topics: string[];
  preferredJournals: string[];
  days: number;
}

export interface DigestPaper {
  id: string;
  source: string;
  title: string;
  doi: string;
  url: string;
  journal: string;
  authors: string[];
  abstract: string;
  cnSummary: string;
  publishedAt: string | null;
  fetchedAt: string;
  lang: string;
  topics: string[];
  read: boolean;
}

export interface DigestResponse {
  date: string;
  total: number;
  topics: Record<string, DigestPaper[]>;
  /** 订阅期刊的目录/征稿 —— 与主题无关, 单独一桶(见 runDigestFetch 的说明) */
  journals: Record<string, DigestPaper[]>;
  /** 订阅了但取不到动态的刊名 —— 前端要如实显示, 避免"空列表"被误读成"没更新" */
  uncoveredJournals: string[];
  runs: Array<{ startedAt: string; ok: boolean; inserted: number; perSource: any[]; error?: string }>;
}

const DEFAULT_TOPICS = ["马克思主义中国化", "政治经济学"];
const DEFAULT_DAYS = 7;

/** 读用户的订阅配置; 没有则返回默认(前端首次进面板就是这个状态) */
export async function getSubscription(userId: string): Promise<DigestSubscription> {
  const r = await pool.query(
    `select topics, preferred_journals, days from digest_subscriptions where user_id = $1`,
    [userId]
  );
  if (!r.rows.length) {
    return { topics: DEFAULT_TOPICS, preferredJournals: [], days: DEFAULT_DAYS };
  }
  const row = r.rows[0];
  return {
    topics: Array.isArray(row.topics) ? row.topics.filter(Boolean) : [],
    preferredJournals: Array.isArray(row.preferred_journals) ? row.preferred_journals.filter(Boolean) : [],
    days: Number(row.days) || DEFAULT_DAYS
  };
}

/** 检查订阅的期刊名在本仓期刊库里能否取到动态。
 *
 *  为什么要有这个: 用户订阅《财贸经济》却一条收不到时, 他无法分辨是
 *  "这本刊最近没更新"还是"我们压根没有这本刊的数据"。实测该刊**不在**
 *  `cjournal_journals` 的 80 本里(那是马理论刊库, 财贸经济是经济类刊),
 *  所以永远取不到 —— 而界面上看不出任何区别。这里把能取到的与取不到的分开,
 *  让前端能如实说"这 2 本暂无动态数据", 而不是让用户对着空列表猜。
 */
export async function checkJournalCoverage(names: string[]): Promise<{ covered: string[]; uncovered: string[] }> {
  const clean = names.map((n) => String(n).trim()).filter(Boolean);
  if (!clean.length) return { covered: [], uncovered: [] };
  const r = await pool.query(
    `select distinct j.name from cjournal_journals j
      where j.name = any($1::text[])
        and exists (
          select 1 from cjournal_journal_updates u
           where u.journal_id = j.id and u.kind <> 'hotspot'
        )`,
    [clean]
  );
  const covered = new Set(r.rows.map((x: any) => String(x.name)));
  return { covered: clean.filter((n) => covered.has(n)), uncovered: clean.filter((n) => !covered.has(n)) };
}

/** 写订阅配置(整条 upsert —— 首选项是整体提交的, 不是逐项增删) */
export async function setSubscription(
  userId: string,
  input: { topics?: string[]; preferredJournals?: string[]; days?: number }
): Promise<DigestSubscription> {
  const cur = await getSubscription(userId);
  const topics = (input.topics ?? cur.topics).map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
  const journals = (input.preferredJournals ?? cur.preferredJournals).map((j) => String(j).trim()).filter(Boolean).slice(0, 60);
  const days = Math.min(Math.max(Number(input.days ?? cur.days) || DEFAULT_DAYS, 1), 30);
  await pool.query(
    `insert into digest_subscriptions (user_id, topics, preferred_journals, days)
     values ($1, $2, $3, $4)
     on conflict (user_id) do update set
       topics = excluded.topics,
       preferred_journals = excluded.preferred_journals,
       days = excluded.days,
       updated_at = now()`,
    [userId, topics, journals, days]
  );
  return { topics, preferredJournals: journals, days };
}

/** 抓取一批主题的全部源。**逐源记账** —— 一个源挂了不影响其他源。 */
export async function fetchAllForTopics(
  topics: string[],
  opts: { since?: Date; journals?: string[]; limit?: number } = {}
): Promise<{ results: FetchResult[]; byTopic: Map<string, DigestCandidate[]> }> {
  const byTopic = new Map<string, DigestCandidate[]>();
  const results: FetchResult[] = [];
  // ⚠ 期刊订阅与主题订阅是**两类东西**, 不能互相顶替:
  //   《党政研究》的「2024年第3期目录」与"政治经济学"没有任何主题关系, 它只是
  //   用户订了这本刊。早先的写法是 journals 过滤**替换** topic 匹配, 结果同一批
  //   期刊公告在每个主题下都出现一次 —— 看起来像"这两个主题的研究成果",
  //   实际是重复渲染的订阅通知。现在拆开:
  //     · 主题桶: 只跑会做主题检索的源(openalex/crossref)
  //     · 期刊桶: journal-updates 只跑**一次**(不按主题重复), topics 记为空数组
  const topicSources = HTTP_SOURCES.filter((s) => s.id !== "journal-updates");
  const journalSource = HTTP_SOURCES.find((s) => s.id === "journal-updates");

  for (const topic of topics) {
    const collected: DigestCandidate[] = [];
    for (const src of topicSources) {
      try {
        const r = await src.fetch(topic, { since: opts.since, journals: opts.journals, limit: opts.limit });
        results.push(r);
        collected.push(...r.candidates);
      } catch (e: any) {
        results.push({ source: src.id, ok: false, candidates: [], error: String(e?.message || e).slice(0, 150) });
      }
    }
    byTopic.set(topic, collected);
  }

  // 期刊动态: 有期刊订阅时按刊取(与主题无关); 没订阅期刊时才按第一个主题搜标题
  if (journalSource) {
    try {
      const hasJournals = (opts.journals ?? []).length > 0;
      const r = await journalSource.fetch(hasJournals ? "" : (topics[0] ?? ""), {
        since: opts.since, journals: opts.journals, limit: opts.limit
      });
      results.push(r);
      // topics 留空 —— 由编排层放进"期刊桶", 不再冒充某个主题的成果
      byTopic.set("", r.candidates.map((c) => ({ ...c, topics: [] })));
    } catch (e: any) {
      results.push({ source: journalSource.id, ok: false, candidates: [], error: String(e?.message || e).slice(0, 150) });
    }
  }
  return { results, byTopic };
}

/** 落库。**返回真正新插入的条数** —— 重复的靠唯一索引挡掉, 不算新增。
 *
 *  去重的两条路(对应 174 迁移里的两条部分唯一索引):
 *    · 有 doi   → item_doi_key 唯一
 *    · 无 doi   → item_title_key 唯一
 *  `on conflict do nothing` 配合 `returning id` 就能分辨"插入了"与"已存在":
 *  冲突时 returning 不返回行。
 */
export async function persistCandidates(
  candidates: DigestCandidate[]
): Promise<{ inserted: number; dup: number }> {
  let inserted = 0;
  let dup = 0;
  for (const c of candidates) {
    const doiKey = normalizeDoi(c.doi) || null;
    const titleKey = normalizeTitle(c.title) || null;
    // 两个键都空(标题与 doi 都没有意义)才跳过 —— 但 title 是 NOT NULL,
    // 所以实际只有"标题全是标点"这种极端情况会落到这里
    if (!doiKey && !titleKey) { dup++; continue; }
    try {
      const r = await pool.query(
        `insert into digest_items
           (source, external_id, title, doi, url, journal, authors, abstract,
            published_at, lang, topics, item_doi_key, item_title_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict do nothing
         returning id`,
        [
          c.source, c.externalId || null, c.title, c.doi || null, c.url || "",
          c.journal || "", c.authors, c.abstract || "",
          plausibleDateFor(c.publishedAt), c.lang || "", c.topics,
          doiKey, titleKey
        ]
      );
      // on conflict do nothing 时 rowCount=0, 即"已存在"
      if (r.rowCount) inserted++; else dup++;
    } catch (e: any) {
      // 单条失败不该中断整批 —— 记 dup 而不是抛
      logger.warn({ err: String(e?.message || e).slice(0, 120), title: c.title.slice(0, 40) }, "digest persist 单条失败");
      dup++;
    }
  }
  return { inserted, dup };
}

/** 跑一次完整抓取并登记批次 */
export async function runDigestFetch(
  input: { topics: string[]; journals?: string[]; days?: number; trigger?: string; limit?: number }
): Promise<{ runId: string; inserted: number; dup: number; perSource: any[] }> {
  const topics = input.topics.filter(Boolean).slice(0, 30);
  const days = Math.min(Math.max(input.days ?? DEFAULT_DAYS, 1), 30);
  const since = new Date(Date.now() - days * 86_400_000);
  const startedAt = new Date();

  const ins = await pool.query(
    `insert into digest_runs (trigger, topics) values ($1, $2) returning id`,
    [input.trigger || "manual", topics]
  );
  const runId = String(ins.rows[0].id);

  let totalInserted = 0;
  let totalDup = 0;
  const perSource: any[] = [];
  let ok = true;
  let firstError: string | undefined;

  try {
    const { results, byTopic } = await fetchAllForTopics(topics, {
      since, journals: input.journals, limit: input.limit
    });
    // 逐源汇总(与"逐主题"无关 —— 用户关心的是"哪个源坏了", 不是"哪个主题的哪个源坏了")
    const agg = new Map<string, { source: string; ok: boolean; fetched: number; inserted: number; dup: number; error?: string }>();
    for (const r of results) {
      const a = agg.get(r.source) ?? { source: r.source, ok: true, fetched: 0, inserted: 0, dup: 0 };
      a.fetched += r.candidates.length;
      if (!r.ok) { a.ok = false; a.error = r.error; ok = false; firstError = firstError || `${r.source}: ${r.error}`; }
      agg.set(r.source, a);
    }
    // 全部主题的候选合到一批落库 —— 跨主题重复(同一篇命中两个主题)由唯一索引挡住,
    // 但 topics 数组会因此少一个主题。所以先按唯一键合并 topics 再落。
    const merged = mergeTopics([...byTopic.values()].flat());
    const { inserted, dup } = await persistCandidates(merged);
    totalInserted = inserted;
    totalDup = dup;

    // 把"新增"分摊记到各源上(按候选来源比例)—— 精确到条会需要逐条 returning 源名,
    // 这里只求可读的近似: fetched 是精确的, inserted 是分摊的
    const totalFetched = [...agg.values()].reduce((s, a) => s + a.fetched, 0);
    for (const a of agg.values()) {
      a.inserted = totalFetched > 0 ? Math.round((a.fetched / totalFetched) * inserted) : 0;
      a.dup = a.fetched - a.inserted;
      perSource.push(a);
    }
  } catch (e: any) {
    ok = false;
    firstError = String(e?.message || e).slice(0, 200);
  }

  await pool.query(
    `update digest_runs set finished_at = now(), per_source = $2::jsonb,
            inserted = $3, dup = $4, ok = $5, error = $6
      where id = $1`,
    [runId, JSON.stringify(perSource), totalInserted, totalDup, ok, firstError ?? null]
  ).catch(() => { /* 批次台账写失败不影响已入库的条目 */ });

  return { runId, inserted: totalInserted, dup: totalDup, perSource };
}

/** 同一篇文献命中多个主题时合并 topics —— 否则唯一索引会让后来的主题白抓 */
export function mergeTopics(candidates: DigestCandidate[]): DigestCandidate[] {
  const byKey = new Map<string, DigestCandidate>();
  for (const c of candidates) {
    const key = normalizeDoi(c.doi) || normalizeTitle(c.title);
    if (!key) continue;
    const cur = byKey.get(key);
    if (cur) {
      for (const t of c.topics) if (!cur.topics.includes(t)) cur.topics.push(t);
      // 字段级补全: 已存在的条目若某字段为空而后来的有值, 用后来的补 ——
      // 同一篇在 OpenAlex 有摘要、在 Crossref 只有标题, 合并后应两者都有
      if (!cur.abstract && c.abstract) cur.abstract = c.abstract;
      if (!cur.journal && c.journal) cur.journal = c.journal;
      if (!cur.authors.length && c.authors.length) cur.authors = c.authors;
      if (!cur.url && c.url) cur.url = c.url;
      if (!cur.publishedAt && c.publishedAt) cur.publishedAt = c.publishedAt;
    } else {
      byKey.set(key, { ...c, topics: [...c.topics] });
    }
  }
  return [...byKey.values()];
}

/** 查询速递 —— 前端 /api/digest 的落点。
 *
 *  ⚠ 排序用 `fetched_at DESC`, 与 Respal 的结论一致, 但**加了一条它没有的规则**:
 *  同一天内按 published_at 二次排序。理由是我们这边 80 本期刊的速报是分批抓的,
 *  同一批里既有"今天发的"也有"2019 年的旧目录被今天抓到" —— 只看 fetched_at
 *  会让旧目录与真新闻并列, 用户分不出来。
 */
export async function getDigest(
  userId: string,
  opts: { days?: number } = {}
): Promise<DigestResponse> {
  const sub = await getSubscription(userId);
  const days = Math.min(Math.max(opts.days ?? sub.days, 1), 30);
  const since = new Date(Date.now() - days * 86_400_000);

  const r = await pool.query(
    `select i.id, i.source, i.title, i.doi, i.url, i.journal, i.authors, i.abstract,
            i.cn_summary, i.published_at, i.fetched_at, i.lang, i.topics,
            (dr.item_id is not null) as read
       from digest_items i
       left join digest_reads dr on dr.item_id = i.id and dr.user_id = $1
      where i.fetched_at >= $2
        and (
          -- 有主题的条目: 用户 topics 为空(未设订阅)则全给, 否则取交集
          (coalesce(array_length(i.topics, 1), 0) > 0
            and (coalesce(array_length($3::text[], 1), 0) = 0 or i.topics && $3::text[]))
          -- 无主题的条目(订阅期刊的目录/征稿): **必须**按用户订阅的刊名过滤。
          -- 漏了这半边会让 A 用户看到 B 用户订阅的期刊动态 —— 速递条目是全局表,
          -- 隔离只能靠这条 where, 没有 user_id 兜底。
          or (coalesce(array_length(i.topics, 1), 0) = 0
            and coalesce(array_length($4::text[], 1), 0) > 0
            and i.journal = any($4::text[]))
        )
      order by i.fetched_at desc, i.published_at desc nulls last, i.id asc
      limit 500`,
    [userId, since, sub.topics, sub.preferredJournals]
  );

  const topics: Record<string, DigestPaper[]> = {};
  const journals: Record<string, DigestPaper[]> = {};
  const seen = new Set<string>();
  for (const row of r.rows) {
    const paper: DigestPaper = {
      id: String(row.id),
      source: String(row.source || ""),
      title: String(row.title || ""),
      doi: String(row.doi || ""),
      url: String(row.url || ""),
      journal: String(row.journal || ""),
      authors: Array.isArray(row.authors) ? row.authors : [],
      abstract: String(row.abstract || ""),
      cnSummary: String(row.cn_summary || ""),
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : "",
      lang: String(row.lang || ""),
      topics: Array.isArray(row.topics) ? row.topics : [],
      read: Boolean(row.read)
    };
    // 一条命中多个主题时在两个主题下都出现 —— 这是**有意的**(用户按主题浏览,
    // 不该因为"它在另一个主题里已出现过"就在这里消失), 但 total 只算唯一条数
    if (!paper.topics.length) {
      // 无主题 = 订阅期刊的目录/征稿, 归到期刊桶
      const key = paper.journal || "订阅期刊";
      (journals[key] ??= []).push(paper);
    } else {
      for (const t of paper.topics) {
        (topics[t] ??= []).push(paper);
      }
    }
    seen.add(paper.id);
  }

  const runs = await pool.query(
    `select started_at, ok, inserted, per_source, error from digest_runs
      order by started_at desc limit 5`
  );

  const coverage = await checkJournalCoverage(sub.preferredJournals).catch(() => ({ covered: [], uncovered: [] }));

  return {
    date: new Date().toISOString().slice(0, 10),
    total: seen.size,
    topics,
    journals,
    uncoveredJournals: coverage.uncovered,
    runs: runs.rows.map((x: any) => ({
      startedAt: x.started_at ? new Date(x.started_at).toISOString() : "",
      ok: Boolean(x.ok),
      inserted: Number(x.inserted) || 0,
      perSource: Array.isArray(x.per_source) ? x.per_source : [],
      error: x.error || undefined
    }))
  };
}

/** 全体用户订阅的**并集** —— 每日抓取按它跑一次。
 *
 *  为什么不按用户各抓一遍: 条目表 `digest_items` 是全局的(没有 user_id),
 *  十个用户订十个主题去抓十遍, 得到的是同一批网上的论文 —— 白耗十倍的源配额
 *  (OpenAlex/Crossref 都有礼貌池限流)。抓一次并集, 各用户查询时按自己的订阅过滤。
 */
export async function collectAllSubscriptions(): Promise<{ topics: string[]; journals: string[]; users: number }> {
  const r = await pool.query(
    `select user_id, topics, preferred_journals from digest_subscriptions where enabled = true`
  );
  const topics = new Set<string>();
  const journals = new Set<string>();
  for (const row of r.rows) {
    for (const t of (Array.isArray(row.topics) ? row.topics : [])) if (t) topics.add(String(t));
    for (const j of (Array.isArray(row.preferred_journals) ? row.preferred_journals : [])) if (j) journals.add(String(j));
  }
  return { topics: [...topics], journals: [...journals], users: r.rows.length };
}

/** 每日抓取入口 —— 由 src/index.ts 的定时任务调用(带跨副本租约)。
 *
 *  没有任何用户订阅时**不跑**(省源配额), 返回 zeroed 结果而不是硬凑默认主题。
 */
export async function runDailyDigest(): Promise<{
  users: number; topics: number; inserted: number; dup: number; summarized: number; failedSummaries: number;
}> {
  const { topics, journals, users } = await collectAllSubscriptions();
  if (!topics.length && !journals.length) {
    return { users: 0, topics: 0, inserted: 0, dup: 0, summarized: 0, failedSummaries: 0 };
  }
  const r = await runDigestFetch({
    // 只订了期刊没订主题时, topics 传空 —— 期刊源不依赖主题
    topics: topics.length ? topics : [],
    journals,
    days: DEFAULT_DAYS,
    trigger: "cron"
  });
  // 中文概括放在抓取之后、单独一步: 它烧 LLM, 失败不该让"抓取"这个动作算失败
  let summarized = 0;
  let failedSummaries = 0;
  try {
    const { backfillSummaries } = await import("./summarize.js");
    const s = await backfillSummaries(30);
    summarized = s.done;
    failedSummaries = s.failed;
  } catch (e: any) {
    logger.warn({ err: String(e?.message || e).slice(0, 120) }, "digest 中文概括步骤失败(不影响抓取)");
  }
  return { users, topics: topics.length, inserted: r.inserted, dup: r.dup, summarized, failedSummaries };
}

/** 有内容的日期列表(前端日期选择器用)—— 只返回真的有条目的日期 */
export async function getDigestDates(userId: string, limit = 30): Promise<string[]> {
  const r = await pool.query(
    `select distinct to_char(fetched_at, 'YYYY-MM-DD') as d
       from digest_items order by d desc limit $1`,
    [Math.min(Math.max(limit, 1), 90)]
  );
  return r.rows.map((x: any) => String(x.d));
}

/** 标记已读(整批; ids 为空即"全部已读") */
export async function markDigestRead(userId: string, ids: string[] = []): Promise<number> {
  if (!ids.length) {
    const r = await pool.query(
      `insert into digest_reads (user_id, item_id)
       select $1, id from digest_items
       on conflict (user_id, item_id) do nothing`,
      [userId]
    );
    return r.rowCount ?? 0;
  }
  const r = await pool.query(
    `insert into digest_reads (user_id, item_id)
     select $1, unnest($2::uuid[])
     on conflict (user_id, item_id) do nothing`,
    [userId, ids]
  );
  return r.rowCount ?? 0;
}

/** 未读数 —— 前端铃铛/徽标用 */
export async function unreadDigestCount(userId: string): Promise<number> {
  const sub = await getSubscription(userId);
  const since = new Date(Date.now() - sub.days * 86_400_000);
  const r = await pool.query(
    `select count(*)::int as n from digest_items i
       left join digest_reads dr on dr.item_id = i.id and dr.user_id = $1
      where i.fetched_at >= $2 and dr.item_id is null
        and (
          -- 有主题的条目: 用户 topics 为空(未设订阅)则全给, 否则取交集
          (coalesce(array_length(i.topics, 1), 0) > 0
            and (coalesce(array_length($3::text[], 1), 0) = 0 or i.topics && $3::text[]))
          -- 无主题的条目(订阅期刊的目录/征稿): **必须**按用户订阅的刊名过滤。
          -- 漏了这半边会让 A 用户看到 B 用户订阅的期刊动态 —— 速递条目是全局表,
          -- 隔离只能靠这条 where, 没有 user_id 兜底。
          or (coalesce(array_length(i.topics, 1), 0) = 0
            and coalesce(array_length($4::text[], 1), 0) > 0
            and i.journal = any($4::text[]))
        )`,
    [userId, since, sub.topics, sub.preferredJournals]
  );
  return Number(r.rows[0]?.n) || 0;
}
