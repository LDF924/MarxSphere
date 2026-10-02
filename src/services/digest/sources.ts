// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// sources.ts — 研究速递的**源适配器**
//
// 每个导出一个 `fetch(topic, opts)`, 输出统一的 DigestCandidate[]。
// 加源不改服务(同 opinion-sources.ts 的思路: 数据与逻辑分开)。
//
// ═══ 源的选择依据(实测, 不是照抄别人) ═══
//
//   2026-10-02 实测本机连通性:
//     · OpenAlex  200  1.37s   —— 可用, 免 key, mailto 走礼貌池
//     · Crossref  200  4.08s   —— 可用, 免 key, 但慢(4s vs 1.4s)
//     · S2        429  0.72s   —— **限流**, 不作主源(见 memory: literature-source-openalex-integration)
//
// ═══ 每个源的真实短板(写在这里, 免得下游把"没抓到"误读成"没有") ═══
//
//   · OpenAlex: 对开放仓储条目元数据很薄 —— 实测一条 `type:book` 的条目
//     language=null / abstract=NULL / authors=[] / primary_location 是机构仓库名。
//     中文刊的 language **恒为 null**(澄启学刊/现代教育与教学创新两条都是),
//     所以语言判定不能靠源字段, 用 normalize.detectLang 按字符构成判。
//   · Crossref: 4 秒级延迟, 且大量中文刊未注册 DOI。定位为补充源而非主源。
//   · SAG 自有期刊动态(cjournal_journal_updates, 4546 行):
//     issue 目录 1820 / hotspot 1497 / trend 743 / cfp 486, 来源是微信公众号经搜狗。
//     它是**本仓独有、Respal 没有的中文社科资产**, 走本地查询不走 HTTP。

import { abstractFromInvertedIndex, detectLang, fixAuthorName, isRelevant, plausibleDateFor, yearFromTitle } from "./normalize.js";

export interface DigestCandidate {
  source: string;
  externalId: string;
  title: string;
  doi: string;
  url: string;
  journal: string;
  authors: string[];
  abstract: string;
  publishedAt: Date | null;
  topics: string[];
  lang: "zh" | "en" | "";
}

export interface FetchResult {
  source: string;
  ok: boolean;
  candidates: DigestCandidate[];
  error?: string;
}

export interface FetchOptions {
  /** 只取这个日期之后的出版(含) */
  since?: Date;
  /** 每个源最多取多少条 */
  limit?: number;
  /** 额外限定的期刊名(用户订阅的刊)。空=不限 */
  journals?: string[];
  /**
   * 当前主题(可多个)。journal-updates 用它去**期刊库的 topic_tags** 里挑刊 ——
   * 见 fetchJournalUpdates 里"按主题搜标题命中 0"那段实测说明。
   */
  topics?: string[];
}

/** 统一的取 JSON 帮助函数 —— 超时、UA、错误归一都在这里, 源适配器只管映射字段 */
async function getJson(url: string, timeoutMs = 25_000): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const resp = await fetch(url, {
      signal: (AbortSignal as any).timeout(timeoutMs),
      headers: {
        // Crossref 要求有个可辨识的 UA 才会给礼貌池; OpenAlex 认 mailto 参数
        "User-Agent": "SocioSeek-Digest/1.0 (mailto:sag@socioseek.local)",
        Accept: "application/json"
      }
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true, data: await resp.json() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════ OpenAlex ═══════════════════════════

const OPENALEX_SELECT = [
  "id", "doi", "title", "publication_date", "language", "type",
  "primary_location", "authorships", "abstract_inverted_index", "topics"
].join(",");

export async function fetchOpenAlex(topic: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const filters = [`default.search:${topic}`];
  if (opts.since) filters.push(`from_publication_date:${isoDate(opts.since)}`);
  // 只要 article/review —— book/chapter/dataset 的元数据太薄(实测 book 那条
  // 连标题作者都没有), 混进来只会让用户看到一堆空卡片
  filters.push("type:article|review");

  // ⚠ 中文召回的固有短板(实测, 不是没调好):
  //   `default.search` 对中文是**宽松匹配** —— 查「地方政府行为」返回的第一条是
  //   「云南瓦猫非遗传承的衍化特征研究」(《澄启学刊》), 主题相关性很差。
  //   换成 `title.search` 更糟: 同条件下 **count=0**, 因为它的分词器对中文无效。
  //   两个都试过的结论是 default.search 已是当前最优, 但**相关性不能靠 OpenAlex**
  //   —— 所以速递的中文内容主要由本仓自有的期刊动态链路承担(见下方 fetchJournalUpdates),
  //   OpenAlex 只作英文/交叉补充。
  /**
   * ⚠ 排序: `relevance_score:desc`, **不是** publication_date(2026-10-03 实测修正)。
   *
   *   `default.search` 对中文是宽泛全文匹配 —— 查「马克思主义中国化」会返回
   *   非遗民俗、音乐教育、土力学这类只是碰巧含相同词组的文献。按**日期**降序取前 25 条时,
   *   下游 `isRelevant` 只能通过 **1 条**; 按**相关性**降序则通过 **5 条**(实测同一窗口)。
   *   根因是"最新的"与"最相关的"在这类宽匹配里几乎是两批东西, 而我们要的是后者 ——
   *   速递的价值是"跟我研究相关的新东西", 不是"全库最新的东西"。
   */
  const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filters.join(","))}`
    + `&per-page=${limit}&sort=relevance_score:desc&select=${OPENALEX_SELECT}`
    + `&mailto=sag@socioseek.local`;

  const r = await getJson(url);
  if (!r.ok) return { source: "openalex", ok: false, candidates: [], error: r.error };

  const results: any[] = Array.isArray(r.data?.results) ? r.data.results : [];
  const candidates = results.map((w): DigestCandidate => {
    const authors = (w.authorships || [])
      .map((a: any) => fixAuthorName(String(a?.author?.display_name || "")))
      .filter(Boolean);
    const src = w.primary_location?.source || {};
    const doi = String(w.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
    const abstract = abstractFromInvertedIndex(w.abstract_inverted_index);
    const title = String(w.title || "").trim();
    return {
      source: "openalex",
      externalId: String(w.id || "").replace("https://openalex.org/", ""),
      title,
      doi,
      url: doi ? `https://doi.org/${doi}` : String(w.id || ""),
      journal: String(src.display_name || ""),
      authors,
      abstract,
      // publication_date 是 YYYY-MM-DD; 用 UTC 解释避免时区把日期拨前一天
      publishedAt: plausibleDateFor(w.publication_date ? parseYmd(String(w.publication_date)) : null),
      topics: [topic],
      // OpenAlex 的 language 对中文刊恒为 null, 所以这里**不采信它**, 一律自己判
      lang: detectLang(title, abstract)
    };
  }).filter((c) => c.title && isRelevant(topic, c.title, c.abstract));

  return { source: "openalex", ok: true, candidates };
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ═══════════════════════════ Crossref ═══════════════════════════

export async function fetchCrossref(topic: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const limit = Math.min(opts.limit ?? 20, 50);
  /**
   * ⚠ 排序用 `score`(相关性), **不是** `published`(2026-10-03 实测修正)。
   *
   *   `query.bibliographic=马克思主义中国化` 在 Crossref 上 total≈57 万, 是个**宽松全文匹配** ——
   *   按**出版日**降序取前 25 条, 下游 `isRelevant` 通过 **0 条**(全是"最新但不相干"); 按
   *   **相关性**降序通过 **6 条**。与 OpenAlex 那边是同一个坑: 在这类宽匹配里
   *   "最新的"与"最相关的"几乎是两批东西, 而速递要的是后者。
   */
  const params = new URLSearchParams({
    "query.bibliographic": topic,
    rows: String(limit),
    sort: "score",
    order: "desc",
    select: "DOI,title,author,container-title,abstract,published,issued,type,URL",
    // 只要期刊论文 —— 不加这条会把书籍章节(「第七章 內地的離婚法律及程序」)
    // 与出版社自我宣传页混进"最新论文」
    filter: "type:journal-article",
    mailto: "sag@socioseek.local"
  });
  if (opts.since) params.set("filter", `type:journal-article,from-pub-date:${isoDate(opts.since)}`);

  const r = await getJson(`https://api.crossref.org/works?${params.toString()}`, 30_000);
  if (!r.ok) return { source: "crossref", ok: false, candidates: [], error: r.error };

  const items: any[] = Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  const candidates = items.map((it): DigestCandidate => {
    const title = String((Array.isArray(it.title) ? it.title[0] : it.title) || "").trim();
    // Crossref 的 abstract 是 **JATS XML**(`<jats:p>…</jats:p>`), 不去标签的话
    // 下游 LLM 会对着标签做概括 —— 实测出版社给的 abstract 大量长这样
    const rawAbstract = String(it.abstract || "");
    const abstract = rawAbstract
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ").trim();
    const authors = (it.author || [])
      .map((a: any) => fixAuthorName([a?.given, a?.family].filter(Boolean).join(" ").trim()))
      .filter(Boolean);
    const doi = String(it.DOI || "");
    // published 是 Crossref 的结构化日期 {date-parts:[[y,m,d]]}; issued 是兜底
    const parts = it.published?.["date-parts"]?.[0] || it.issued?.["date-parts"]?.[0];
    const publishedAt = Array.isArray(parts) && parts.length
      ? new Date(Date.UTC(Number(parts[0]), Number(parts[1] || 1) - 1, Number(parts[2] || 1)))
      : null;
    return {
      source: "crossref",
      externalId: doi,
      title,
      doi,
      url: String(it.URL || (doi ? `https://doi.org/${doi}` : "")),
      journal: String((Array.isArray(it["container-title"]) ? it["container-title"][0] : it["container-title"]) || ""),
      authors,
      abstract,
      publishedAt: plausibleDateFor(publishedAt),
      topics: [topic],
      lang: detectLang(title, abstract)
    };
  }).filter((c) => c.title && isRelevant(topic, c.title, c.abstract));

  return { source: "crossref", ok: true, candidates };
}

// ═══════════════════════ 本仓自有: 期刊动态 ═══════════════════════
//
// 这是 **Respal 没有的中文社科资产**, 也是中文主题召回差这个问题的正解:
//   `cjournal_journal_updates` 实测 4546 行(2026-08-15 ~ 10-02, 46 天):
//     issue 目录 1820 / hotspot 热点 1497 / trend 趋势 743 / cfp 征稿 486
//   来源是**微信公众号经搜狗搜索**(3698 条带 URL), 覆盖 80 本马理论期刊。
//
// 它走**本地查询不走 HTTP**, 所以失败模式与其他源不同(不会限流、不会超时,
// 只可能"查不到"), 但仍按同一 FetchResult 形状返回, 让编排层一视同仁记账。

export async function fetchJournalUpdates(topic: string, opts: FetchOptions = {}): Promise<FetchResult> {
  try {
    const { pool } = await import("../../db/pool.js");
    const since = opts.since ?? new Date(Date.now() - 14 * 86_400_000);
    /**
     * ⚠ 默认上限 20 → 500(2026-10-03 实测修正)。
     *
     * 由来: 这里是**本地 SQL 查询**, 不花网络也不花额度, 而 daily cron 每天只在
     * 7 天窗口里取最新的 20 条 —— 于是"新内容"永远只是最近那 20 条, 库里的存量
     * 永远进不了速递。实测: 14 天窗口里有 **893 条**可用动态(覆盖 72 本刊),
     * 而 digest_items 总共只有 19 条、来自 2 本刊。这正是用户看到的
     * "研究速递是空的"的根因 —— 不是源没数据, 是**只搬了 2%**。
     *
     * `order by found_at desc` + limit 的形状本身没错(要最新的), 错在 limit 太小:
     * 它把"每次搬一批"变成了"每天搬同一批最新的"。
     */
    const limit = Math.min(opts.limit ?? 500, 2000);
    const journals = (opts.journals ?? []).filter(Boolean);
    /**
     * 主题 → 该主题下的刊名(期刊库 cjournal_journals.topic_tags)。
     *
     * ⚠ 这是 2026-10-03 补的**第三条路**, 因为原文的两条路都不通:
     *   ① 按刊名过滤(journals 非空)—— 只在用户订阅了期刊时生效;
     *   ② 退化到"标题里搜主题词"—— 代码自己的注释就写明了实测「地方政府行为」在
     *      4546 条里命中 **0**, 因为期刊目录的标题形如《X刊》2026年第3期目录,
     *      **不含任何研究主题词**。
     *   于是**没订阅期刊的用户永远拿不到期刊动态** —— 而那正是默认状态。
     *   第三条路: 用期刊库已有的 topic_tags 反查刊名(80 本刊**全都**有 topic_tags),
     *   再按刊名取动态。实测「马克思主义中国化」这类主题能稳定命中原生刊目动态。
     */
    let topicJournals: string[] = [];
    if (!journals.length && (opts.topics ?? []).length) {
      const tj = await pool.query(
        `select name from cjournal_journals
          where topic_tags is not null and topic_tags && $1::text[]`,
        [opts.topics]);
      topicJournals = tj.rows.map((r: any) => String(r.name)).filter(Boolean);
    }

    // ⚠ 三条实测约束(写进 SQL 而不是留在文档里, 因为它们改变的是"取哪些行"):
    //   ① **排除 hotspot**: 实测热点条目的 title 就是一个光秃秃的标签
    //      (「政治经济学」「经济热点」「生产力」「理论创新」「中共党史」),
    //      没有标题也没有链接。当成论文卡片渲染出来就是一排看不懂的碎词。
    //      它们真实的用途是给 CJournalPanel 做热点词展示, 不是速递条目。
    //   ② **content 不是正文**: 全表 content 长度只有 15~23 字符, 内容固定是
    //      「来源: 微信公众号(搜狗搜索)」这条**来源注记**。当摘要展示会在卡片上
    //      出现"摘要: 来源: 微信公众号", 所以这里不取 content。
    //   ③ **按期刊订 > 按主题搜**: 用户订阅了《财贸经济》就该收到它的目录与征稿,
    //      而标题「《财贸经济》2026年第3期目录」里**不含**任何研究主题词 ——
    //      实测「地方政府行为」在 4546 条里命中 0, 「政治经济学」命中 94(全是 hotspot)。
    //      所以有期刊订阅时按期刊过滤, 没有时才退化成主题匹配。
    const r = await pool.query(
      `select u.journal_id, u.kind, u.title, u.source_url, u.found_at, j.name as journal_name
         from cjournal_journal_updates u
         left join cjournal_journals j on j.id = u.journal_id
        where u.found_at >= $1
          and u.kind <> 'hotspot'
          and (
            (array_length($2::text[], 1) is not null and j.name = any($2::text[]))
            or (array_length($2::text[], 1) is null and $3 <> '' and u.title ilike '%' || $3 || '%')
          )
        order by u.found_at desc
        limit $4`,
      [since, (journals.length ? journals : topicJournals).length ? (journals.length ? journals : topicJournals) : null, topic, limit]
    );
    const candidates = r.rows.map((row: any): DigestCandidate => ({
      source: "journal-updates",
      externalId: `cju:${row.journal_id}:${String(row.title).slice(0, 60)}`,
      title: String(row.title || "").trim(),
      doi: "",
      url: String(row.source_url || ""),
      journal: String(row.journal_name || row.journal_id || ""),
      authors: [],
      // 没有真摘要就**留空**, 不要拿 15 字的来源注记充数
      abstract: "",
      // ⚠ 用**标题里的内容年份**, 不用 found_at —— 见 normalize.yearFromTitle 的说明:
      //   found_at 全是我们抓到的日子(最近 46 天), 而标题写的可能是 2021 年。
      //   拿 found_at 当出版日会让 5 年前的旧目录显示成"今天发布"。
      //   标题里没有年份(如「社会科学」类无年份的目录)才退回 found_at。
      publishedAt: (() => {
        const y = yearFromTitle(row.title);
        return y ? new Date(Date.UTC(y, 0, 1)) : (row.found_at ? new Date(row.found_at) : null);
      })(),
      topics: [topic],
      lang: "zh"
    })).filter((c) => c.title);
    return { source: "journal-updates", ok: true, candidates };
  } catch (e: any) {
    // 表不存在(如空库未跑到该迁移)时**不能让整个速递失败** —— 它是补充源
    return { source: "journal-updates", ok: false, candidates: [], error: String(e?.message || e).slice(0, 150) };
  }
}

/** 全部源 —— 顺序即抓取顺序。
 *  journal-updates 排第一: 它是中文社科相关性最高的源(见上面的实测说明)。 */
export const HTTP_SOURCES = [
  { id: "journal-updates", name: "期刊动态(本仓)", fetch: fetchJournalUpdates },
  { id: "openalex", name: "OpenAlex", fetch: fetchOpenAlex },
  { id: "crossref", name: "Crossref", fetch: fetchCrossref }
] as const;
// 曾经接入过 bioRxiv, 2026-10-02 实测后**移除**:
//   它的 API 按日期区间取全量、每页固定 30 条, 而 14 天窗口的 total=3455 条
//   —— 意味着要走 115 页。实测单页 10.6~34 秒, 翻完约 **20 分钟**。
//   一个 20 分钟的源会把每日 cron 拖到不可接受, 且它只覆盖生命科学,
//   对本平台(社科/政经/马理论)的主题相关性本就最低。
//   留在代码里会变成"看起来支持但永远超时"的源, 所以删掉而不是降级。

export type HttpSourceId = (typeof HTTP_SOURCES)[number]["id"];

export function httpSourceById(id: string) {
  return HTTP_SOURCES.find((s) => s.id === id);
}
