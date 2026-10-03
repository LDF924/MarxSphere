// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// web-archive-service.ts — 网页归档: 快照序列 + 段落定位 + 差异比对(2026-10-03)
//
// 由来(对照开源项目 观澜/Guanlan 的 archive, MIT): 本仓此前没有网页快照能力
//   (编辑器版本 / PPT 版本 / git 快照都是**我们自己的东西**, 不是外部网页)。
//   "这条政策三个月前怎么写的、上周改了什么"在这以前无处可答。
//
// ═══ 三条口径(决定了这个服务的行为) ═══
//   ① **同一内容不重复存**: 判据是 `content_hash`, 不是抓取时间。定时抓一个没变的页面
//      不该产生第二份快照 —— 否则"变了没有"这件事会被噪声淹没。
//   ② **段落偏移要能回查**: 存快照时顺手切段并记 offset, 于是可以回答
//      "这句话出自哪一版、第几段"。与 `doc_anchors` 是同一口径(它管我们自己的文档)。
//   ③ **质量报告随快照一起存**: 事后要能回答"这条证据当时抽得干不干净"。
//      只存正文的话, 三个月后没人知道那份文本是怎么来的。
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";
import { readWebPage, type ReadQuality } from "./web-read-service.js";

/**
 * URL 归一 —— 同一篇文章的不同分享链接必须归到一条。
 *
 * ⚠ 踩过的坑: 微信/知乎/微博的分享链接会带一大堆追踪参数(`utm_*`、`from=`、`share_token=`),
 *   不归一的话同一篇文章会被存成十几条, "这个页面变了吗"就永远答不准。
 *   但**不能删所有参数** —— 像 `mp.weixin.qq.com/s?__biz=…&mid=…` 那种, 参数就是文章 id。
 *   所以只删**明确是追踪用的**那批。
 */
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "from", "share_token", "share_from", "spm", "ref", "referer", "src",
  "fbclid", "gclid", "scene", "clicktime", "enterid", "sourcetype",
];

export function normalizeUrl(raw: string): { url: string; key: string } {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    // 参数顺序不同 = 同一个页面, 排一下序
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of sorted) u.searchParams.append(k, v);
    // 去掉末尾斜杠(但保留根路径的)
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return { url: s, key: s };
  } catch {
    return { url: raw, key: raw };
  }
}

/** 切段: 按空行切, 过短的合并 —— 段落是"定位"的最小单位, 太碎就没法引 */
function splitPassages(markdown: string): Array<{ ord: number; startOffset: number; text: string }> {
  const out: Array<{ ord: number; startOffset: number; text: string }> = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let m: RegExpExecArray | null;
  let ord = 0;
  let buf = "";
  let bufStart = 0;
  const flush = () => {
    const t = buf.trim();
    if (t.length >= 8) out.push({ ord: ord++, startOffset: bufStart, text: t });
    buf = "";
  };
  while ((m = re.exec(markdown))) {
    if (!buf) bufStart = m.index;
    buf += (buf ? "\n" : "") + m[0];
    // 攒到 60 字以上成一段 —— 更碎的段落引用时看不出上下文
    if (buf.length >= 60) flush();
  }
  flush();
  return out;
}

export interface ArchiveSummary {
  id: string;
  url: string;
  title: string;
  snapshotCount: number;
  lastSeenAt: string;
  firstSeenAt: string;
  /** 最新一版的质量分 —— 列表页要能看出"这条证据干不干净" */
  qualityScore: number | null;
  qualityLabel: string;
  tags: string[];
}

/**
 * 归档一个 URL。
 *
 * 返回 `status` 三态, 与"成功/失败"是**两回事**:
 *   created   这次抓到的内容与既往都不同 → 新增一版快照
 *   unchanged 内容与最新一版完全相同 → 只更新 last_seen_at(这正是"盯着它"的价值)
 *   failed    没抓到
 */
export async function archiveUrl(input: {
  userId: string;
  url: string;
  projectId?: string;
  tags?: string[];
  /** 人工导入的正文(不走网络抓取) —— 用于"我已经有正文了, 只是想归档" */
  manualText?: string;
  manualTitle?: string;
  maxChars?: number;
}): Promise<{ ok: boolean; status: "created" | "unchanged" | "failed"; archiveId?: string; snapshotId?: string; error?: string; quality?: ReadQuality }> {
  const { url, key } = normalizeUrl(input.url);

  let title = input.manualTitle ?? "";
  let markdown = input.manualText ?? "";
  let quality: ReadQuality | null = null;
  let via = "manual";
  let httpStatus: number | null = null;

  if (!markdown) {
    const r = await readWebPage(url, { maxChars: input.maxChars ?? 200_000 });
    if (!r.ok || !r.markdown) {
      return { ok: false, status: "failed", error: r.error ?? "抓取失败" };
    }
    title = r.title;
    markdown = r.markdown;
    quality = r.quality;
    via = "fetch";
  }
  markdown = markdown.slice(0, input.maxChars ?? 200_000);
  const contentHash = createHash("sha256").update(markdown).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 主记录 upsert
    const a = await client.query(
      `insert into web_archives (user_id, url, url_key, title, project_id, tags, snapshot_count)
       values ($1,$2,$3,$4,$5,$6::jsonb,0)
       on conflict (user_id, url_key) do update set
         last_seen_at = now(),
         title = case when excluded.title <> '' then excluded.title else web_archives.title end,
         project_id = coalesce(excluded.project_id, web_archives.project_id)
       returning id, title`,
      [input.userId, url, key, title, input.projectId ?? null, JSON.stringify(input.tags ?? [])]
    );
    const archiveId = String(a.rows[0].id);
    if (!title) title = String(a.rows[0].title ?? "");

    // 与最新一版比内容 —— **判据是 hash, 不是时间**
    const last = await client.query(
      `select id, content_hash from web_snapshots where archive_id=$1 order by fetched_at desc limit 1`,
      [archiveId]
    );
    const lastHash = last.rows.length ? String(last.rows[0].content_hash) : "";
    if (lastHash === contentHash) {
      await client.query(`commit`);
      return { ok: true, status: "unchanged", archiveId, snapshotId: String(last.rows[0].id), quality: quality ?? undefined };
    }

    /**
     * ⚠ **内容回退**要比"和最新一版相同"更早判 —— 否则整笔归档会静默失败。
     *
     * 场景: 政策页改了(第 2 版), 后来又改回原样。此时新内容 == 第 1 版的 hash,
     *   而 `web_snapshots_hash_uniq (archive_id, content_hash)` 会挡住插入 →
     *   抛错 → 整个事务回滚 → 返回 `failed`。用户看到"归档失败", 但页面明明是好的。
     *   (这就是"两版内容不同、却与更早某一版相同"的那类边界。)
     *
     * 处理: 认出这个 hash **本来就是这条归档的某一版**, 回它 ——
     *   `unchanged` 的语义在这里照样成立("与既有版本相同, 没有新内容")。
     *   同时把 last_seen_at 推上去, 让"我一直在盯着它"这件事留痕。
     */
    const dup = await client.query(
      `select id from web_snapshots where archive_id=$1 and content_hash=$2 limit 1`,
      [archiveId, contentHash]
    );
    if (dup.rows.length) {
      await client.query(`update web_archives set last_seen_at = now() where id=$1`, [archiveId]);
      await client.query(`commit`);
      return { ok: true, status: "unchanged", archiveId, snapshotId: String(dup.rows[0].id), quality: quality ?? undefined };
    }

    const s = await client.query(
      `insert into web_snapshots (archive_id, content_hash, title, markdown, quality, via, http_status)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning id`,
      [archiveId, contentHash, title, markdown, JSON.stringify(quality ?? {}), via, httpStatus]
    );
    const snapshotId = String(s.rows[0].id);

    // 段落切片
    const passages = splitPassages(markdown);
    for (const p of passages) {
      await client.query(
        `insert into web_passages (snapshot_id, start_offset, ord, text) values ($1,$2,$3,$4)`,
        [snapshotId, p.startOffset, p.ord, p.text]
      );
    }
    await client.query(
      `update web_archives set snapshot_count = (select count(*) from web_snapshots where archive_id=$1) where id=$1`,
      [archiveId]
    );
    await client.query(`commit`);
    return { ok: true, status: "created", archiveId, snapshotId, quality: quality ?? undefined };
  } catch (e: any) {
    await client.query("rollback").catch(() => {});
    logger.warn({ err: String(e?.message || e).slice(0, 160), url }, "网页归档失败");
    return { ok: false, status: "failed", error: String(e?.message || e).slice(0, 160) };
  } finally {
    client.release();
  }
}

/** 归档列表 —— 带最新一版的质量分 */
export async function listArchives(userId: string, opts: { limit?: number; projectId?: string; q?: string } = {}): Promise<ArchiveSummary[]> {
  const params: unknown[] = [userId];
  const where = ["a.user_id = $1"];
  if (opts.projectId) { params.push(opts.projectId); where.push(`a.project_id = $${params.length}`); }
  if (opts.q) { params.push(`%${opts.q}%`); where.push(`(a.title ilike $${params.length} or a.url ilike $${params.length})`); }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const r = await pool.query(
    `select a.id, a.url, a.title, a.snapshot_count, a.first_seen_at, a.last_seen_at, a.tags,
            s.quality
       from web_archives a
       left join lateral (
         select quality from web_snapshots ws where ws.archive_id = a.id order by ws.fetched_at desc limit 1
       ) s on true
      where ${where.join(" and ")}
      order by a.last_seen_at desc
      limit $${params.length}`,
    params
  );
  return r.rows.map((x: any) => ({
    id: String(x.id),
    url: String(x.url),
    title: String(x.title || ""),
    snapshotCount: Number(x.snapshot_count) || 0,
    firstSeenAt: x.first_seen_at ? new Date(x.first_seen_at).toISOString() : "",
    lastSeenAt: x.last_seen_at ? new Date(x.last_seen_at).toISOString() : "",
    qualityScore: x.quality?.score ?? null,
    qualityLabel: String(x.quality?.label ?? ""),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
  }));
}

/** 一个归档的版本历史 */
export async function archiveHistory(userId: string, archiveId: string) {
  const own = await pool.query(`select id from web_archives where id=$1 and user_id=$2`, [archiveId, userId]);
  if (!own.rows.length) return null;
  const r = await pool.query(
    `select id, content_hash, title, fetched_at, via, quality, length(markdown) as chars,
            (select count(*)::int from web_passages p where p.snapshot_id = web_snapshots.id) as passages
       from web_snapshots where archive_id=$1 order by fetched_at asc`,
    [archiveId]
  );
  return r.rows.map((x: any) => ({
    id: String(x.id),
    contentHash: String(x.content_hash).slice(0, 12),
    title: String(x.title || ""),
    fetchedAt: x.fetched_at ? new Date(x.fetched_at).toISOString() : "",
    via: String(x.via),
    chars: Number(x.chars) || 0,
    passages: Number(x.passages) || 0,
    quality: x.quality ?? {},
  }));
}

/** 取某一版正文 */
export async function getSnapshot(userId: string, snapshotId: string): Promise<{ markdown: string; title: string } | null> {
  const r = await pool.query(
    `select s.markdown, s.title from web_snapshots s
       join web_archives a on a.id = s.archive_id
      where s.id=$1 and a.user_id=$2`,
    [snapshotId, userId]
  );
  if (!r.rows.length) return null;
  return { markdown: String(r.rows[0].markdown), title: String(r.rows[0].title || "") };
}

/**
 * 两版之间的差异 —— 按**段落**比, 不是按行。
 *
 * ⚠ 为什么按段落: 网页改一个字就会让行级 diff 全红(整页的行都错位了),
 *   而研究者要的是"哪几段被改了"。段落是语义单位, 也是我们能定位的单位。
 *   用集合差而不是 LCS: 网页改版常伴随整块移动, LCS 会把"移动"报成"删+增"两条,
 *   集合差给出的"新增了哪些段、删掉了哪些段"更接近人的读法。
 */
export async function diffSnapshots(userId: string, leftId: string, rightId: string): Promise<{
  ok: boolean;
  error?: string;
  added: string[];
  removed: string[];
  unchanged: number;
} | null> {
  const own = await pool.query(
    `select s.id, s.archive_id from web_snapshots s join web_archives a on a.id=s.archive_id
      where s.id = any($1::uuid[]) and a.user_id=$2`,
    [[leftId, rightId], userId]
  );
  if (own.rows.length !== 2) return null;

  const load = async (sid: string) => {
    const r = await pool.query(`select text from web_passages where snapshot_id=$1 order by ord`, [sid]);
    return r.rows.map((x: any) => String(x.text).trim()).filter(Boolean);
  };
  const [l, r] = await Promise.all([load(leftId), load(rightId)]);
  const lset = new Set(l);
  const rset = new Set(r);
  const added = r.filter((t) => !lset.has(t));
  const removed = l.filter((t) => !rset.has(t));
  return { ok: true, added, removed, unchanged: r.filter((t) => lset.has(t)).length };
}

/** 按句子找它出自哪一版哪一段 —— 段落偏移的用处就体现在这里 */
export async function locateInArchive(userId: string, needle: string, limit = 10) {
  const q = String(needle ?? "").trim();
  if (q.length < 4) return [];
  const r = await pool.query(
    `select p.id, p.text, p.ord, p.start_offset, s.id as snapshot_id, s.fetched_at,
            a.id as archive_id, a.url, a.title
       from web_passages p
       join web_snapshots s on s.id = p.snapshot_id
       join web_archives a on a.id = s.archive_id
      where a.user_id = $1 and p.text ilike $2
      order by s.fetched_at desc limit $3`,
    [userId, `%${q}%`, Math.min(Math.max(limit, 1), 50)]
  );
  return r.rows.map((x: any) => ({
    archiveId: String(x.archive_id), snapshotId: String(x.snapshot_id),
    url: String(x.url), title: String(x.title || ""),
    ord: Number(x.ord) || 0, startOffset: Number(x.start_offset) || 0,
    fetchedAt: x.fetched_at ? new Date(x.fetched_at).toISOString() : "",
    text: String(x.text).slice(0, 500),
  }));
}

/** 删除一个归档(级联删快照与段落) */
export async function deleteArchive(userId: string, archiveId: string): Promise<boolean> {
  const r = await pool.query(`delete from web_archives where id=$1 and user_id=$2`, [archiveId, userId]);
  return Boolean(r.rowCount);
}
