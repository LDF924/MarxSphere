// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// topic-wiki-service.ts — 归档 → 主题 wiki(2026-10-04)
//
// ⚠ **源码移植**自开源项目 观澜/Guanlan(MIT, https://github.com/shenyangs/Guanlan)
//   的 `guanlan/archive_wiki.py`(逐函数转 TypeScript: `build_archive_wiki` /
//   `build_archive_wiki_context` / `format_archive_wiki_context` / `build_archive_pack` /
//   `format_wiki_build_summary` / `_select_records` / `_enrich_wiki_record` / `_group_by_topic` /
//   `_topic_label` / `_wiki_record_priority` / `_context_excerpt_limit` / `_render_wiki_markdown` /
//   `_render_topic_markdown` / `_write_llm_wiki` 及全部 `_render_llm_*` / `_build_llm_wiki_graph` /
//   `_llm_wiki_entities` / `_record_entities` / `_record_stem` / `_slug` / `_compact` / `_pipe_safe`)。
//   见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 它解决什么问题 ═══
//   归档(web-archive-service)已经能回答"这页现在写了什么、和上个月比变了哪几段"。
//   但**归档到几百条之后就没人读了** —— 它们躺在列表里, 每条都对, 合起来没用。
//   这一层把归档**聚成主题**: 按主题分组、分 core/candidate 两档(能不能直接当证据)、
//   抽实体共现、生成一个可以整目录拷给本地模型/RAG 的 Markdown wiki。
//
// ═══ 三条口径(照搬原文, 这三条是它的灵魂) ═══
//   ① **它是 archive 的组织层, 不是全网知识库**。没命中只能说"本地没归档过",
//      不能推成"没有证据"。这句话要一路带到生成的每个文件里(原文写进了 schema.md 的
//      Answering Rules, 我们照做)。
//   ② **core/candidate 是"能不能直接复用", 不是"真假"**。candidate = 正文为空或阅读质量低,
//      意思是"先用之前核一下", 不是"别用"。
//   ③ **graph.json 是共现图, 不是语义向量图、更不是事实图谱**。原文在自己的 schema 里
//      专门写了这句, 因为一张图太容易被当真。
//
// ═══ 与观澜的差别 ═══
//   · 它的记录来自 SQLite `archive` 表; 我们来自 `web_archives/web_snapshots/web_passages`
//     三表(迁移 182)。字段映射写在 `loadRecords` 里, 一一对应。
//   · 它把 wiki 写到用户给的任意目录; 我们是**服务端**, 所以输出目录**由后台推导**
//     (基目录 + buildId), 不接受前端传路径 —— 这直接消掉了整类目录穿越问题。
//   · 实体抽取的停用词表按本仓语境调过(去掉「观澜」这类它自己的词)。

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

export const DEFAULT_WIKI_LIMIT = 200;
export const DEFAULT_CONTEXT_CHARS = 1200;

/** 输出根目录 —— 所有 wiki 都写在它下面, 前端传不进路径 */
export function wikiBaseDir(): string {
  return process.env.TOPIC_WIKI_DIR || path.join(process.cwd(), "data", "topic-wiki");
}

export interface WikiRecord {
  id: string;
  url: string;
  title: string;
  domain: string;
  /** 最新快照的正文 */
  content: string;
  /** 正文里最该被引用的一小段(渲染用; 不是摘要, 是原文片段) */
  excerpt: string;
  updatedAt: number;
  qualityScore: number | null;
  qualityLabel: string;
  quality: Record<string, unknown>;
  tags: string[];
  snapshotCount: number;
  /** 主题标签 —— 取归档 tags 的第一个, 没有就退回域名 */
  topicLabel: string;
  /** 正文层级: full_body / partial_body / snippet / unknown */
  contentMode: string;
  contentChars: number;
  wikiStatus: "core" | "candidate";
  wikiReasons: string[];
  updatedLabel: string;
}

interface RawArchiveRow {
  id: string;
  url: string;
  title: string;
  tags: unknown;
  snapshot_count: number;
  last_seen_at: Date | string;
  markdown: string | null;
  quality: unknown;
  fetched_at: Date | string | null;
  chars: number | null;
}

/**
 * 从三表读归档记录(对应原文的 `export_documents` + `search_documents`)。
 *
 * 检索用 **ILIKE 而不是全文索引**: 归档量级在本仓是几百到几万条, 顺序扫完全够;
 * 上 tsvector 要处理中文分词, 那是另一件事, 不该在这一层顺手做掉。
 */
export async function loadRecords(
  userId: string,
  opts: { topic?: string; limit?: number } = {}
): Promise<WikiRecord[]> {
  const params: unknown[] = [userId];
  const where = ["a.user_id = $1"];
  const topic = String(opts.topic ?? "").trim();
  if (topic) {
    params.push(`%${topic}%`);
    where.push(`(a.title ilike $${params.length} or a.url ilike $${params.length} or a.tags::text ilike $${params.length} or s.markdown ilike $${params.length})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? DEFAULT_WIKI_LIMIT, 1), 500));
  const r = await pool.query(
    `select a.id, a.url, a.title, a.tags, a.snapshot_count, a.last_seen_at,
            s.markdown, s.quality, s.fetched_at, length(s.markdown) as chars
       from web_archives a
       left join lateral (
         select markdown, quality, fetched_at from web_snapshots ws
          where ws.archive_id = a.id order by ws.fetched_at desc limit 1
       ) s on true
      where ${where.join(" and ")}
      order by a.last_seen_at desc
      limit $${params.length}`,
    params
  );
  return (r.rows as RawArchiveRow[]).map(toWikiRecord);
}

function toWikiRecord(x: RawArchiveRow): WikiRecord {
  const quality = (x.quality && typeof x.quality === "object" ? x.quality : {}) as Record<string, unknown>;
  const content = String(x.markdown ?? "");
  const tags = Array.isArray(x.tags) ? x.tags.map(String) : [];
  const domain = domainOf(String(x.url));
  // 主题标签: 优先用人工打的 tag, 否则退回**域名** —— 退回域名不是凑数,
  // 它让"同一个站的一批材料"自然成组, 对来源导向的阅读是有意义的
  const topicLabel = String(tags[0] ?? "").trim() || domain || "general";
  const updatedAt = x.fetched_at ? new Date(x.fetched_at).getTime() / 1000 : 0;
  return {
    id: String(x.id),
    url: String(x.url),
    title: String(x.title || ""),
    domain,
    content,
    excerpt: compact(content, 400),
    updatedAt,
    qualityScore: qualityScore(quality),
    qualityLabel: String(quality.label ?? ""),
    quality,
    tags,
    snapshotCount: Number(x.snapshot_count) || 0,
    topicLabel,
    contentMode: String(quality.contentMode ?? quality.content_mode ?? inferContentMode(content, quality)),
    contentChars: content.length,
    // 先按 candidate 落, 随后 `enrichWikiRecord` 按正文与质量分重新定档
    wikiStatus: "candidate",
    wikiReasons: [],
    updatedLabel: formatTime(updatedAt),
  };
}

/**
 * 打 core/candidate 档(移植 `_enrich_wiki_record`)。
 *
 * 判据只有两条, 刻意保持简单:
 *   正文为空            → candidate(reason: empty_content)
 *   质量分 < minQuality → candidate(reason: low_read_quality)
 * 其余 → core。
 *
 * ⚠ **qualityScore 为 null 不等于低质量** —— 那是"没有评分"(老数据/人工导入的没跑过质量判据),
 *   这种情况归 core, 但 `wiki_reasons` 里会留空让人自己判断。原文专门写了这句, 照搬。
 */
export function enrichWikiRecord(record: WikiRecord, opts: { minQuality?: number } = {}): WikiRecord {
  const minQuality = opts.minQuality ?? 60;
  const score = record.qualityScore;
  const content = String(record.content ?? "");
  let wikiStatus: "core" | "candidate";
  let wikiReasons: string[];
  if (!content.trim()) {
    wikiStatus = "candidate";
    wikiReasons = ["empty_content"];
  } else if (score !== null && score < minQuality) {
    wikiStatus = "candidate";
    wikiReasons = ["low_read_quality"];
  } else {
    wikiStatus = "core";
    wikiReasons = [];
  }
  return {
    ...record,
    qualityScore: score,
    wikiStatus,
    wikiReasons,
    contentMode: String(record.contentMode || inferContentMode(content, record.quality)),
    contentChars: Number(record.contentChars || content.length),
  };
}

/**
 * 正文层级推断。
 *
 * ⚠ 这是本仓**新增**的一小步(观澜的 content_mode 由它自己的 read 层写入, 我们历史上
 *   没记这个字段)。判据照它的语义: full_body=抽到成篇正文 / snippet=只有摘要级 /
 *   unknown=没有质量报告。**不猜**成 full_body —— 那会让界面把所有归档都标成"全文可引用"。
 */
function inferContentMode(content: string, quality: Record<string, unknown>): string {
  const explicit = quality.content_mode ?? quality.contentMode;
  if (typeof explicit === "string" && explicit) return explicit;
  const label = String(quality.label ?? "");
  if (!content.trim()) return "snippet";
  if (label === "clean") return "full_body";
  if (label === "noisy") return "partial_body";
  if (label === "thin") return "partial_body";
  if (label === "failed") return "snippet";
  return "unknown";
}

function qualityScore(quality: Record<string, unknown>): number | null {
  for (const key of ["score", "quality_score", "readability_score"]) {
    const v = quality[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export function groupByTopic(records: WikiRecord[]): Record<string, WikiRecord[]> {
  const groups: Record<string, WikiRecord[]> = {};
  for (const r of records) {
    const topic = String(r.topicLabel || "general");
    (groups[topic] ??= []).push(r);
  }
  // 组大的在前, 同大小按名字 —— 与原文一致(让人先看到材料最多的主题)
  return Object.fromEntries(
    Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  );
}

/**
 * 记录优先级(移植 `_wiki_record_priority`) —— 决定 context 里谁排前面。
 *
 * ⚠ 顺序即判据: core 优先 → 正文层级 → 质量分 → **正文长度上限 12000**
 *   (超过就不再加分, 防止一篇超长文档靠体量压过其他证据) → 匹配度 → 时间 → id。
 */
export function recordPriority(r: WikiRecord & { matchScore?: number }): number[] {
  const status = r.wikiStatus === "core" ? 1 : 0;
  const contentRank = { full_body: 3, partial_body: 2, snippet: 1 }[r.contentMode] ?? 0;
  return [
    status,
    contentRank,
    r.qualityScore ?? 0,
    Math.min(Number(r.contentChars) || 0, 12000),
    Number(r.matchScore ?? 0),
    Number(r.updatedAt) || 0,
  ];
}

function comparePriority(a: WikiRecord & { matchScore?: number }, b: WikiRecord & { matchScore?: number }): number {
  const pa = recordPriority(a);
  const pb = recordPriority(b);
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

/** 节选长度按正文层级给(移植 `_context_excerpt_limit`) —— 全文的多给, 摘要级的少给 */
export function contextExcerptLimit(r: WikiRecord, maxChars: number): number {
  if (r.contentMode === "full_body") return Math.max(maxChars, 1600);
  if (r.contentMode === "partial_body") return Math.max(maxChars, 1000);
  return maxChars;
}

// ═══════════════════════════════════════════════════════════
// 证据包(移植 `build_archive_wiki_context` — 给 Agent 用的那一半)
// ═══════════════════════════════════════════════════════════

export interface WikiContextPayload {
  query: string;
  records: Array<WikiRecord & { contentExcerpt: string }>;
  context: string;
  boundary: string;
}

/**
 * 把归档命中打成一份**证据包**给 Agent/本地模型。
 *
 * ⚠ 它和 RAG 的差别就是这一份的用意: RAG 给"最相似的片段", 这里给的是
 *   **带状态与边界的证据清单** —— 每条都明写 core/candidate、正文层级、质量分,
 *   末尾还有一段 "Answering Rule" 要求模型先声明证据薄弱再下结论。
 *   少这一层, 模型会把 candidate(只有摘要的那条)讲得跟全文一样肯定。
 */
export async function buildArchiveWikiContext(
  userId: string,
  query: string,
  opts: { limit?: number; minQuality?: number; maxChars?: number } = {}
): Promise<WikiContextPayload> {
  const q = String(query ?? "").trim();
  const limit = Math.max(opts.limit ?? 20, 1);
  const maxChars = opts.maxChars ?? DEFAULT_CONTEXT_CHARS;
  const minQuality = opts.minQuality ?? 0;
  const records = q
    ? await loadRecords(userId, { topic: q, limit })
    : (await loadRecords(userId, { limit })).slice(0, limit);

  const enriched = records.map((raw) => {
    const r = enrichWikiRecord(raw, { minQuality });
    // 检索命中后再按质量降档 —— 原文是同一个做法: minQuality 在这里是**二次过滤**,
    // 而不是让 SQL 少取几条(少取会让"低质量的都不出现在证据包里", 那是另一种隐瞒)
    if (minQuality && r.qualityScore !== null && r.qualityScore < minQuality) {
      r.wikiStatus = "candidate";
      if (!r.wikiReasons.includes("low_read_quality")) r.wikiReasons.push("low_read_quality");
    }
    return { ...r, contentExcerpt: compact(r.content, contextExcerptLimit(r, maxChars)) };
  });
  enriched.sort(comparePriority);
  const payload = { query: q, records: enriched };
  return {
    query: q,
    records: enriched,
    context: formatArchiveWikiContext(payload),
    boundary: "local-archive-context; semantic=not-vector",
  };
}

/**
 * 证据包 → Markdown(移植 `format_archive_wiki_context`)。
 *
 * ⚠ 两个细节值得留意, 都是原文踩过的:
 *   ① 表格里的 `|` 必须转义, 否则一个含竖线的标题会把整张表撕开;
 *   ② **命中为空时也要给一行说明**(「本地 archive 未命中; 可先补搜」), 而不是留一张空表 ——
 *      空表会被模型读成"检索到了, 什么都没有"。
 */
export function formatArchiveWikiContext(payload: { query: string; records: Array<WikiRecord & { contentExcerpt?: string; matchScore?: number; matchedTerms?: string[] }> }): string {
  const query = String(payload.query ?? "");
  const records = Array.isArray(payload.records) ? payload.records : [];
  const L: string[] = [
    `# 本地归档证据包 / ${query || "全部归档"}`,
    "",
    "这份材料只反映**本地已归档**的文档, 不是全网检索结果。",
    "**没命中不等于全网没有证据** —— 只说明本地还没归档过相关材料。",
    "",
    "来源 | 状态 | 主题 | 内容层级 | 标题 | 摘要",
    "--- | --- | --- | --- | --- | ---",
  ];
  if (!records.length) {
    L.push("无结果 | - | - | - | - | 本地归档未命中; 可先去「外部检索/舆情检索」补搜再归档。");
    return L.join("\n");
  }
  for (const r of records) {
    const excerpt = pipeSafe(String(r.contentExcerpt || r.excerpt || "")).slice(0, 220);
    L.push(
      `${pipeSafe(r.domain)} | ${pipeSafe(r.wikiStatus)} | ${pipeSafe(r.topicLabel)} | ${pipeSafe(r.contentMode)} | [${pipeSafe(r.title)}](${r.url}) | ${excerpt}`
    );
  }
  L.push("", "## 证据明细");
  records.forEach((r, i) => {
    L.push(`### [${i + 1}] ${r.title}`);
    L.push(`- URL: ${r.url}`);
    L.push(`- Domain: ${r.domain}`);
    L.push(`- 状态: ${r.wikiStatus}${r.wikiReasons.length ? ` (${r.wikiReasons.join(", ")})` : ""}`);
    L.push(`- 主题: ${r.topicLabel}`);
    L.push(`- 内容层级: ${r.contentMode}`);
    if (r.qualityScore !== null) L.push(`- 阅读质量分: ${r.qualityScore}${r.qualityLabel ? ` (${r.qualityLabel})` : ""}`);
    if (r.matchedTerms?.length) L.push(`- 命中词: ${r.matchedTerms.join(", ")}`);
    const excerpt = String(r.contentExcerpt || r.excerpt || "").trim();
    if (excerpt) L.push("", excerpt);
    L.push("");
  });
  L.push(
    "## 回答规则",
    "- 优先使用上面的归档证据, 不要用记忆替代它。",
    "- 证据薄弱或只有 candidate 材料时, **先说清这一点再给结论**。",
    "- 引用事实时给出标题/域名或 URL。"
  );
  return L.join("\n").replace(/\s+$/, "");
}

// ═══════════════════════════════════════════════════════════
// 构建 wiki(移植 `build_archive_wiki`)
// ═══════════════════════════════════════════════════════════

export interface WikiBuildResult {
  status: "ok";
  buildId: string;
  output: string;
  format: string;
  topic: string;
  documents: number;
  coreDocuments: number;
  candidateDocuments: number;
  topics: number;
  files: string[];
  boundary: string;
  graphSummary: { nodes: number; edges: number; topEntities: Array<{ name: string; count: number }> };
}

/**
 * 生成主题 wiki。
 *
 * `outputFormat`:
 *   markdown    index.md + topics/*.md
 *   html        index.html + topics/*.html(深色单页, 与原文同款)
 *   llm-wiki    完整目录树: purpose/schema/index/log/graph.json/manifest.json
 *               + raw/sources + wiki/{sources,topics,entities,queries}
 *   both        markdown + html
 *
 * ⚠ 输出目录**不接受调用方传路径**: 由 `wikiBaseDir()` + buildId 推导。
 *   一个能写文件的接口如果路径可控, 就是任意写。
 */
export async function buildTopicWiki(
  userId: string,
  opts: { topic?: string; outputFormat?: string; limit?: number; minQuality?: number; includeCandidates?: boolean } = {}
): Promise<WikiBuildResult> {
  const topic = String(opts.topic ?? "").trim();
  const outputFormat = String(opts.outputFormat ?? "markdown");
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_WIKI_LIMIT, 1), 500);
  const minQuality = opts.minQuality ?? 60;
  const includeCandidates = opts.includeCandidates ?? true;

  const buildId = randomUUID();
  const output = path.join(wikiBaseDir(), buildId);
  // 双保险: 推导出来的路径必须真的在基目录下(理论上恒真, 但这条断言是"路径可控"这一类
  // 问题的最后一道闸, 成本近零)
  const resolved = path.resolve(output);
  if (!resolved.startsWith(path.resolve(wikiBaseDir()) + path.sep)) {
    throw new Error("wiki 输出路径越界");
  }

  let records = (await loadRecords(userId, { topic, limit })).map((r) => enrichWikiRecord(r, { minQuality }));
  if (!includeCandidates) records = records.filter((r) => r.wikiStatus === "core");
  const groups = groupByTopic(records);
  const files: string[] = [];

  await fs.mkdir(resolved, { recursive: true });

  if (outputFormat === "llm-wiki") {
    files.push(...(await writeLlmWiki(resolved, records, groups, topic)));
  }
  const formats = outputFormat === "both" ? ["markdown", "html"] : [outputFormat];
  if (formats.includes("markdown")) {
    const indexPath = path.join(resolved, "index.md");
    await fs.writeFile(indexPath, renderWikiMarkdown(records, groups, topic), "utf8");
    files.push(indexPath);
    const topicsDir = path.join(resolved, "topics");
    await fs.mkdir(topicsDir, { recursive: true });
    for (const [name, list] of Object.entries(groups)) {
      const p = path.join(topicsDir, `${slug(name)}.md`);
      await fs.writeFile(p, renderTopicMarkdown(name, list), "utf8");
      files.push(p);
    }
  }
  if (formats.includes("html")) {
    const indexPath = path.join(resolved, "index.html");
    await fs.writeFile(indexPath, renderWikiHtml(records, groups, topic), "utf8");
    files.push(indexPath);
    const topicsDir = path.join(resolved, "topics");
    await fs.mkdir(topicsDir, { recursive: true });
    for (const [name, list] of Object.entries(groups)) {
      const p = path.join(topicsDir, `${slug(name)}.html`);
      await fs.writeFile(p, renderTopicHtml(name, list), "utf8");
      files.push(p);
    }
  }

  const graph = buildWikiGraph(records, groups);
  const entities = wikiEntities(records);
  const result: WikiBuildResult = {
    status: "ok",
    buildId,
    output: resolved,
    format: outputFormat,
    topic,
    documents: records.length,
    coreDocuments: records.filter((r) => r.wikiStatus === "core").length,
    candidateDocuments: records.filter((r) => r.wikiStatus !== "core").length,
    topics: Object.keys(groups).length,
    // 前端只用相对名 —— 绝对路径是服务端的事
    files: files.map((f) => path.relative(resolved, f).split(path.sep).join("/")),
    boundary: "local-static-wiki; archive-derived; not whole-web knowledge",
    graphSummary: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      topEntities: entities.slice(0, 12).map((e) => ({ name: e.name, count: e.count })),
    },
  };

  await recordWikiBuild(userId, result, { minQuality });
  return result;
}

async function recordWikiBuild(userId: string, result: WikiBuildResult, opts: { minQuality: number }): Promise<void> {
  try {
    await pool.query(
      `insert into daily_wiki_builds
         (id, user_id, topic, output_format, output_dir, documents, core_documents, candidate_docs,
          topics, min_quality, files, graph_summary)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
       on conflict (id) do nothing`,
      [
        result.buildId, userId, result.topic, result.format, result.output,
        result.documents, result.coreDocuments, result.candidateDocuments,
        result.topics, opts.minQuality,
        JSON.stringify(result.files), JSON.stringify(result.graphSummary),
      ]
    );
  } catch (e: any) {
    // 落库失败不该让"文件已经写好了"这次构建报错 —— 但要留痕, 否则界面上查不到记录
    logger.warn({ err: String(e?.message || e).slice(0, 160) }, "wiki 构建记录落库失败");
  }
}

export async function listWikiBuilds(userId: string, limit = 20) {
  const r = await pool.query(
    `select id, topic, output_format, output_dir, documents, core_documents, candidate_docs,
            topics, files, graph_summary, created_at
       from daily_wiki_builds where user_id=$1 order by created_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 100)]
  );
  return r.rows.map((x: any) => ({
    id: String(x.id),
    topic: String(x.topic || ""),
    format: String(x.output_format || ""),
    outputDir: String(x.output_dir || ""),
    documents: Number(x.documents) || 0,
    coreDocuments: Number(x.core_documents) || 0,
    candidateDocuments: Number(x.candidate_docs) || 0,
    topics: Number(x.topics) || 0,
    files: Array.isArray(x.files) ? x.files.map(String) : [],
    graphSummary: x.graph_summary ?? {},
    createdAt: x.created_at ? new Date(x.created_at).toISOString() : "",
  }));
}

// ═══════════════════════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════════════════════

export function formatWikiBuildSummary(result: WikiBuildResult): string {
  const L: string[] = [
    "# 主题 Wiki 构建结果",
    "",
    `- 状态: ${result.status}`,
    `- 输出目录: ${result.output}`,
    `- 格式: ${result.format}`,
    `- 文档数: ${result.documents}`,
    `- Core / Candidate: ${result.coreDocuments} / ${result.candidateDocuments}`,
    `- 主题数: ${result.topics}`,
    `- 边界: ${result.boundary}`,
    "",
    "## 生成的文件",
    ...result.files.map((f) => `- ${f}`),
    "",
    "## 使用提示",
    "- 这个 Wiki 是**归档的组织层**, 只代表本地已归档资料, 不代表全网知识。",
    "- 引用时优先带页面来源; candidate 材料需要提醒继续核验。",
    "- 要给本地模型/RAG 用, 选 `llm-wiki` 格式, 它带 purpose/schema 与共现图。",
  ];
  return L.join("\n");
}

function renderWikiMarkdown(records: WikiRecord[], groups: Record<string, WikiRecord[]>, topic: string): string {
  const L: string[] = [
    "# 主题 Wiki",
    "",
    `范围: ${topic ? `主题 / ${topic}` : "全部本地归档"}`,
    "",
    "本 Wiki 由**本地归档**生成, 不是全网知识库。",
    "",
    `- 文档数: ${records.length}`,
    `- Core: ${records.filter((r) => r.wikiStatus === "core").length}`,
    `- Candidate: ${records.filter((r) => r.wikiStatus !== "core").length}`,
    "",
    "## 主题",
  ];
  for (const [name, list] of Object.entries(groups)) L.push(`- [${name}](topics/${slug(name)}.md) (${list.length})`);
  L.push("", "## 最近文档");
  for (const r of records.slice(0, 30)) L.push(`- [${r.title}](${r.url}) / ${r.wikiStatus} / ${r.domain}`);
  return L.join("\n");
}

function renderTopicMarkdown(name: string, records: WikiRecord[]): string {
  const L: string[] = [
    `# ${name}`,
    "",
    "由本地归档生成。**core 更适合直接复用; candidate 需要先核验。**",
    "",
  ];
  for (const r of records) {
    L.push(`## ${r.title}`);
    L.push(`- URL: ${r.url}`);
    L.push(`- 域名: ${r.domain}`);
    L.push(`- 状态: ${r.wikiStatus}${r.wikiReasons.length ? ` (${r.wikiReasons.join(", ")})` : ""}`);
    if (r.qualityScore !== null) L.push(`- 质量分: ${r.qualityScore}`);
    L.push("", r.excerpt, "");
  }
  return L.join("\n");
}

function renderWikiHtml(records: WikiRecord[], groups: Record<string, WikiRecord[]>, topic: string): string {
  const topicRows = Object.entries(groups)
    .map(([name, list]) => `<a class="topic" href="topics/${esc(slug(name))}.html"><span>${esc(name)}</span><b>${list.length}</b></a>`)
    .join("\n");
  const cards = records.slice(0, 60).map(recordCard).join("\n");
  return htmlPage(
    "主题 Wiki",
    `本地归档 · ${esc(topic || "全部主题")}`,
    `<section class="metrics">
      <div><b>${records.length}</b><span>文档</span></div>
      <div><b>${records.filter((r) => r.wikiStatus === "core").length}</b><span>Core</span></div>
      <div><b>${records.filter((r) => r.wikiStatus !== "core").length}</b><span>Candidate</span></div>
      <div><b>${Object.keys(groups).length}</b><span>主题</span></div>
    </section>
    <section><h2>主题</h2><div class="topics">${topicRows || "<p>暂无主题。</p>"}</div></section>
    <section><h2>最近证据</h2><div class="cards">${cards || "<p>暂无归档。</p>"}</div></section>`
  );
}

function renderTopicHtml(name: string, records: WikiRecord[]): string {
  return htmlPage(
    name,
    "由本地归档生成。candidate 材料需要先核验。",
    `<section><h2>证据</h2><div class="cards">${records.map(recordCard).join("\n")}</div></section>`
  );
}

function recordCard(r: WikiRecord): string {
  const quality = r.qualityScore === null ? "" : ` · q=${r.qualityScore}`;
  return `<article class="card ${esc(r.wikiStatus)}">
      <div class="status">${esc(r.wikiStatus)}${esc(quality)}</div>
      <h3><a href="${esc(r.url)}">${esc(r.title)}</a></h3>
      <p>${esc(String(r.excerpt).slice(0, 280))}</p>
      <footer>${esc(r.domain)} · ${esc(r.updatedLabel)}</footer>
    </article>`;
}

function htmlPage(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    body { margin:0; background:#0a0b10; color:#eef1e8; font-family:"Avenir Next","PingFang SC",sans-serif; }
    main { width:min(1180px, calc(100vw - 36px)); margin:0 auto; padding:42px 0 70px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; border-bottom:1px solid rgba(255,255,255,.12); padding-bottom:24px; margin-bottom:26px; }
    h1 { margin:0; font-size:44px; letter-spacing:-.05em; }
    .sub { color:#aeb6c8; max-width:620px; line-height:1.55; }
    h2 { margin-top:34px; color:#f1d07a; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
    .metrics div, .card, .topic { border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.045); border-radius:18px; padding:18px; }
    .metrics b { display:block; font-size:36px; letter-spacing:-.04em; }
    .metrics span, footer, .status { color:#9da6b8; font-size:13px; }
    .topics { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
    .topic { display:flex; justify-content:space-between; color:#eef1e8; text-decoration:none; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; }
    .card.core { border-left:4px solid #72a348; }
    .card.candidate { border-left:4px solid #c78a2f; }
    h3 { margin:8px 0 10px; font-size:18px; }
    a { color:#f5f0dd; text-decoration:none; }
    a:hover { text-decoration:underline; }
    p { color:#c4cad6; line-height:1.55; }
    footer { margin-top:14px; }
    @media (max-width: 760px) { .metrics { grid-template-columns:1fr 1fr; } header { display:block; } h1 { font-size:34px; } }
  </style>
</head>
<body>
  <main>
    <header><div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div><div class="sub">local · evidence-bound · static</div></header>
    ${body}
  </main>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
// LLM Wiki 目录树(移植 `_write_llm_wiki` 及全部 `_render_llm_*`)
// ═══════════════════════════════════════════════════════════

/**
 * 生成给本地模型/RAG 用的目录树。
 *
 * ⚠ 这套目录结构的价值在 `purpose.md` 与 `schema.md` 两个文件: 它们**写死了边界** ——
 *   "这是本地归档, 不是全网""candidate 不能单独支撑强结论""graph.json 不是事实图谱"。
 *   把资料喂给模型时, 这几句话决定了它是"基于证据谨慎作答"还是"顺着材料编"。
 *   少这两个文件, 剩下的 Markdown 就只是一堆文本。
 */
async function writeLlmWiki(
  output: string,
  records: WikiRecord[],
  groups: Record<string, WikiRecord[]>,
  topic: string
): Promise<string[]> {
  const files: string[] = [];
  const dirs = {
    raw: path.join(output, "raw", "sources"),
    sources: path.join(output, "wiki", "sources"),
    topics: path.join(output, "wiki", "topics"),
    entities: path.join(output, "wiki", "entities"),
    queries: path.join(output, "wiki", "queries"),
  };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });

  const graph = buildWikiGraph(records, groups);
  const entities = wikiEntities(records);
  const index = renderLlmWikiIndex(records, groups, topic);

  const rootFiles: Record<string, string> = {
    "purpose.md": renderLlmPurpose(records, topic),
    "schema.md": renderLlmSchema(),
    "index.md": index,
    "log.md": renderLlmLog(records, topic),
    "graph.json": JSON.stringify(graph, null, 2),
    "manifest.json": JSON.stringify(llmManifest(records, groups, entities, topic), null, 2),
  };
  for (const [name, content] of Object.entries(rootFiles)) {
    const p = path.join(output, name);
    await fs.writeFile(p, content.replace(/\s+$/, "") + "\n", "utf8");
    files.push(p);
  }

  for (const r of records) {
    const stem = recordStem(r);
    const rawPath = path.join(dirs.raw, `${stem}.md`);
    const srcPath = path.join(dirs.sources, `${stem}.md`);
    await fs.writeFile(rawPath, renderLlmRawSource(r), "utf8");
    await fs.writeFile(srcPath, renderLlmSourcePage(r, path.relative(output, rawPath).split(path.sep).join("/")), "utf8");
    files.push(rawPath, srcPath);
  }
  for (const [name, list] of Object.entries(groups)) {
    const p = path.join(dirs.topics, `${slug(name)}.md`);
    await fs.writeFile(p, renderLlmTopicPage(name, list), "utf8");
    files.push(p);
  }
  for (const e of entities) {
    const p = path.join(dirs.entities, `${slug(e.name)}.md`);
    await fs.writeFile(p, renderLlmEntityPage(e), "utf8");
    files.push(p);
  }
  const qp = path.join(dirs.queries, `${slug(topic || "all-archive")}.md`);
  await fs.writeFile(qp, renderLlmQueryPage(topic, records), "utf8");
  files.push(qp);
  return files;
}

function renderLlmPurpose(records: WikiRecord[], topic: string): string {
  const scope = topic.trim() || "全部本地归档";
  return `# Purpose

本 Wiki 用于把本地归档中关于「${scope}」的材料沉淀为**可复用、可追溯**的知识库。

它适合:

- 给本地模型、RAG、长期 Agent 复用已归档证据。
- 在回答前快速确认资料来源、主题、质量状态和证据边界。
- 把一次检索/研究留下的材料整理成可维护的 Markdown 目录。

它**不适合**:

- 作为全网知识库或事实的最终裁决。
- 替代原始 URL、官方来源或后续核验。
- 自动生成没有来源约束的新结论。

当前文档数: ${records.length}。`;
}

function renderLlmSchema(): string {
  return `# Schema

## 页面类型

- \`raw/sources/*.md\`: 原始归档正文, 保留 URL、域名、归档 ID 与本地边界。
- \`wiki/sources/*.md\`: 面向 Agent 的来源卡, 含摘要、质量状态、主题与 wikilink。
- \`wiki/topics/*.md\`: 按主题聚合的证据页。
- \`wiki/entities/*.md\`: 从标题、主题与正文轻量抽取的实体共现页。
- \`wiki/queries/*.md\`: 本次构建的入口问题页。
- \`graph.json\`: **轻量共现图** —— 不是向量库, 也不是事实图谱。

## 稳定字段

- \`url\`: 原始来源链接。
- \`domain\`: 来源域名。
- \`wiki_status\`: \`core\` 或 \`candidate\`, 表示复用强度。
- \`topic\`: 本地主题标签。
- \`quality_score\`: 阅读质量分; **为空表示缺少评分, 不等于低质量**。
- \`content_mode\`: \`full_body\` / \`partial_body\` / \`snippet\` / \`unknown\`。

## 回答规则

- 引用时优先给出 \`wiki/sources\` 里的 URL / 域名。
- \`candidate\` 材料只能作为线索或样本, **不能单独支撑强结论**。
- 本 Wiki 无命中只能说明**本地归档暂无材料**, 不能说明全网没有证据。`;
}

function renderLlmWikiIndex(records: WikiRecord[], groups: Record<string, WikiRecord[]>, topic: string): string {
  const L: string[] = [
    "# 主题 Wiki",
    "",
    `范围: ${topic || "全部本地归档"}`,
    "",
    "本目录由本地归档记录生成 —— 仅本地、有证据边界、不依赖模型。",
    "",
    "## 从这里开始",
    "",
    "- 读 `purpose.md` 了解这个知识库的用途与边界。",
    "- 写答案之前先读 `schema.md`。",
    "- 用 `wiki/topics/` 做主题导航。",
    "- 引用证据用 `wiki/sources/`。",
    "- `graph.json` 只当轻量共现图用。",
    "",
    "## 指标",
    "",
    `- 文档数: ${records.length}`,
    `- Core: ${records.filter((r) => r.wikiStatus === "core").length}`,
    `- Candidate: ${records.filter((r) => r.wikiStatus !== "core").length}`,
    `- 主题数: ${Object.keys(groups).length}`,
    "",
    "## 主题",
  ];
  if (!Object.keys(groups).length) L.push("- 暂无主题。");
  for (const [name, list] of Object.entries(groups)) {
    L.push(`- [[topic:${name}]] / \`wiki/topics/${slug(name)}.md\` (${list.length})`);
  }
  L.push("", "## 来源");
  for (const r of records.slice(0, 60)) {
    L.push(`- [[source:${recordStem(r)}]] ${r.title} / ${r.domain} / ${r.wikiStatus}`);
  }
  return L.join("\n");
}

function renderLlmLog(records: WikiRecord[], topic: string): string {
  return `# Log

- 生成时间: ${formatTime(Date.now() / 1000)}
- 范围: ${topic || "全部本地归档"}
- 文档数: ${records.length}
- Core: ${records.filter((r) => r.wikiStatus === "core").length}
- Candidate: ${records.filter((r) => r.wikiStatus !== "core").length}
- 生成器: SocioSeek 主题 Wiki 构建(观澜 archive_wiki 移植)
- 边界: 仅本地归档; 不联网抓取; 不做模型推理; 不修改归档记录。`;
}

function renderLlmRawSource(r: WikiRecord): string {
  const L = sourceMetaLines(r, "# 原始来源");
  L.push("", String(r.content ?? "").trim(), "");
  return L.join("\n").replace(/\s+$/, "") + "\n";
}

function renderLlmSourcePage(r: WikiRecord, rawPath: string): string {
  const entities = recordEntities(r).slice(0, 8);
  const L = sourceMetaLines(r, `# ${r.title}`);
  L.push("", "## 链接", "", `- 主题: [[topic:${r.topicLabel}]]`, `- 域名: [[domain:${r.domain}]]`, `- 原文: \`${rawPath}\``);
  if (entities.length) L.push("- 实体: " + entities.map((e) => `[[entity:${e}]]`).join(", "));
  L.push("", "## 摘要", "", String(r.excerpt || "").trim() || "暂无摘要。", "", "## 复用边界", "",
    "- 作为证据时必须带 URL / 域名引用。",
    "- 状态是 candidate 时, 下强结论前先回原站核验。");
  return L.join("\n").replace(/\s+$/, "") + "\n";
}

function renderLlmTopicPage(name: string, records: WikiRecord[]): string {
  const L = [`# 主题: ${name}`, "", "本页按主题标签聚合本地归档证据。", "", "## 来源"];
  for (const r of records) L.push(`- [[source:${recordStem(r)}]] ${r.title} / ${r.domain} / ${r.wikiStatus}`);
  return L.join("\n").replace(/\s+$/, "") + "\n";
}

function renderLlmEntityPage(e: { name: string; count: number; records: WikiRecord[] }): string {
  const L = [`# 实体: ${e.name}`, "", `- 出现次数: ${e.count}`, "", "## 来源"];
  for (const r of e.records) L.push(`- [[source:${recordStem(r)}]] ${r.title} / ${r.domain}`);
  return L.join("\n").replace(/\s+$/, "") + "\n";
}

function renderLlmQueryPage(topic: string, records: WikiRecord[]): string {
  const L = [`# 查询: ${topic || "全部归档"}`, "", "本页是这次构建的入口。", "", "## 证据"];
  for (const r of records.slice(0, 80)) L.push(`- [[source:${recordStem(r)}]] / [[topic:${r.topicLabel}]] / ${r.wikiStatus}`);
  return L.join("\n").replace(/\s+$/, "") + "\n";
}

function sourceMetaLines(r: WikiRecord, title: string): string[] {
  const quality = r.qualityScore === null ? "unknown" : String(r.qualityScore);
  return [
    title, "", "## 元信息", "",
    `- 归档 ID: ${r.id}`,
    `- URL: ${r.url}`,
    `- 域名: ${r.domain}`,
    `- 状态: ${r.wikiStatus}${r.wikiReasons.length ? ` (${r.wikiReasons.join(", ")})` : ""}`,
    `- 主题: ${r.topicLabel}`,
    `- 内容层级: ${r.contentMode}`,
    `- 质量分: ${quality}`,
    `- 更新时间: ${r.updatedLabel}`,
  ];
}

function llmManifest(
  records: WikiRecord[],
  groups: Record<string, WikiRecord[]>,
  entities: Array<{ name: string; count: number }>,
  topic: string
) {
  return {
    tool: "socioseek",
    format: "llm-wiki",
    schema_version: 1,
    scope: topic || "all",
    documents: records.length,
    core_documents: records.filter((r) => r.wikiStatus === "core").length,
    candidate_documents: records.filter((r) => r.wikiStatus !== "core").length,
    topics: Object.keys(groups).sort(),
    entities: entities.map((e) => e.name),
    boundary: "local archive only; no web fetch; no model inference; not whole-web knowledge",
  };
}

// ═══════════════════════════════════════════════════════════
// 共现图与实体(移植 `_build_llm_wiki_graph` / `_llm_wiki_entities` / `_record_entities`)
// ═══════════════════════════════════════════════════════════

export interface WikiGraph {
  schema_version: number;
  boundary: string;
  nodes: Array<{ id: string; label: string; type: string; [k: string]: unknown }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

export function buildWikiGraph(records: WikiRecord[], groups: Record<string, WikiRecord[]>): WikiGraph {
  const nodes: WikiGraph["nodes"] = [];
  const edges: WikiGraph["edges"] = [];
  const seen = new Set<string>();
  const addNode = (id: string, label: string, type: string, extra: Record<string, unknown> = {}) => {
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({ id, label, type, ...extra });
  };
  for (const [name, list] of Object.entries(groups)) addNode(`topic:${name}`, name, "topic", { count: list.length });
  for (const r of records) {
    const sourceId = `source:${recordStem(r)}`;
    const domain = r.domain || "unknown";
    addNode(sourceId, r.title, "source", { url: r.url, status: r.wikiStatus });
    addNode(`domain:${domain}`, domain, "domain");
    addNode(`topic:${r.topicLabel}`, r.topicLabel, "topic");
    edges.push({ source: sourceId, target: `topic:${r.topicLabel}`, relation: "has_topic" });
    edges.push({ source: sourceId, target: `domain:${domain}`, relation: "from_domain" });
    for (const e of recordEntities(r).slice(0, 8)) {
      addNode(`entity:${e}`, e, "entity");
      edges.push({ source: sourceId, target: `entity:${e}`, relation: "mentions" });
    }
  }
  return {
    schema_version: 1,
    boundary: "lightweight local co-occurrence graph; not a semantic vector graph, not a fact graph",
    nodes,
    edges,
  };
}

export function wikiEntities(records: WikiRecord[], limit = 80): Array<{ name: string; count: number; records: WikiRecord[] }> {
  const buckets = new Map<string, WikiRecord[]>();
  for (const r of records) {
    for (const e of recordEntities(r)) {
      const list = buckets.get(e) ?? [];
      list.push(r);
      buckets.set(e, list);
    }
  }
  return [...buckets.entries()]
    .filter(([name]) => name.trim().length >= 2)
    .map(([name, list]) => ({ name, count: list.length, records: list.slice(0, 12) }))
    .sort((a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, limit);
}

/**
 * 实体抽取(移植 `_record_entities`) —— 两条正则: 英文词 / 2-8 个连续汉字。
 *
 * ⚠ 它**不是 NER**, 是共现用的粗抽。判据里有三条去噪规则, 都是原文踩出来的:
 *   ① 停用词表(https/www/com/html/正文/资料/相关…);
 *   ② 以虚词开头的串丢掉(「的」「和」「与」「及」「或」「而」「在」「为」「把」「将」「对」
 *      「从」「到」「里」「上」「中」「下」)—— 中文没有词边界, 抽出来的串常常从虚词开始;
 *   ③ 纯数字丢掉。
 *   本仓另加两条(实测撞出来的):
 *   ④ 去掉上游项目名(「观澜」/guanlan)—— 否则每个 wiki 的头号实体都是它;
 *   ⑤ **丢掉以助词/标点开头的串**(「了」「的」「, 依据」)—— 原文的正则没有前向约束,
 *      中文里 `了`、`的` 会被吞进下一个片段, 于是实体榜上全是「了本文研究表明」这种半截话。
 *      判据是: 首字若是助词/虚词则整串丢掉, 而不是截掉首字 —— 截出来的「本文研究表明」
 *      同样不是实体, 只是更难看出它是错的。
 */
export function recordEntities(r: WikiRecord): string[] {
  const seeds = [r.topicLabel, ...(r.tags ?? []), r.title];
  const text = `${seeds.join(" ")} ${String(r.content ?? r.excerpt ?? "").slice(0, 1200)}`;
  const candidates = text.match(/[A-Za-z][A-Za-z0-9_+.#-]{1,30}|[一-鿿]{2,8}/g) ?? [];
  const stop = new Set([
    "https", "http", "www", "com", "html", "unknown", "正文", "资料", "相关", "来源",
    "标题", "通用资料", "本地", "归档", "文档", "页面",
    // 上游项目名 —— 别人抄这套代码时同样要去掉它们自己的名字
    "观澜", "guanlan",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const value = raw.replace(/^[\s\-_#]+|[\s\-_#]+$/g, "");
    if (!value || stop.has(value.toLowerCase())) continue;
    if (/^[是的和与及或而在为把将对从到里上中下]/.test(value)) continue;
    if (/^\d+$/.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 24) break;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 小工具(与原文同名同义)
// ═══════════════════════════════════════════════════════════

export function recordStem(r: WikiRecord): string {
  const id = String(r.id || "doc");
  const title = String(r.title || r.domain || "source");
  return `${id}-${slug(title).slice(0, 60)}`;
}

/** slug 化 —— 保留中英文数字, 其余换连字符。也用于文件名, 所以它同时是**路径安全闸** */
export function slug(value: string): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "topic";
}

export function compact(value: string, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(limit - 1, 0)).replace(/\s+$/, "") + "…";
}

function pipeSafe(value: string): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function domainOf(url: string): string {
  try {
    // `hostname` 而不是 `host` —— 后者带端口, 会让 example.com:8443 与 example.com 分成两组
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
