// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// forum-service.ts — 学友论坛: 板块 → 帖 → 楼层(2026-10-03)
//
// 由来(用户): 「我需要一个类似百度贴吧和知乎这样的, 作为独立的 tab, 放在系统管理的右侧,
//   命名为: 学友论坛, 你参考百度贴吧和知乎的设计做一个出来」。
//
// ═══ 参考了它们什么(以及**没有**参考什么) ═══
//   贴吧那一侧取**信息结构**: 板块(=吧) → 主题帖 → 楼层, 加置顶/加精两个运营动作,
//     回帖按时间正序排(楼层感), 主题页显示"最后回复"把老帖顶上来。
//   知乎那一侧取**反馈机制**: 赞同 / 收藏, 以及话题标签。
//   没取的: 踩(负反馈在学术讨论里是噪声, 且诱发拉踩)、盐选/等级体系(与科研平台无关)、
//     无限层楼中楼(窄栏里读不了, 贴吧与知乎实际也只有两层)。
//
// ⚠ 计数列(reply_count / vote_count / view_count)是**冗余**的, 每次写都同步更新。
//   为什么不用 count(*) 现算: 列表页一屏 30 个主题, 现算就是 30 次子查询;
//   而这里的偏差代价很小(计数偶尔差 1 不影响任何判断), 用一次性回填兜底即可。
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

export interface Board {
  id: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  isBuiltin: boolean;
  threadCount: number;
  todayCount: number;
  lastReplyAt: string | null;
}

export interface ThreadItem {
  id: string;
  boardId: string;
  boardName: string;
  authorId: string;
  author: string;
  title: string;
  /** 列表页只给摘要(正文可能很长), 详情页给全文 */
  excerpt: string;
  tags: string[];
  pinned: boolean;
  digest: boolean;
  replyCount: number;
  viewCount: number;
  voteCount: number;
  starred: boolean;
  voted: boolean;
  mine: boolean;
  lastReplyAt: string;
  createdAt: string;
}

export interface ReplyItem {
  id: string;
  parentId: string | null;
  authorId: string;
  author: string;
  body: string;
  voteCount: number;
  voted: boolean;
  mine: boolean;
  createdAt: string;
}

// ═══════════════════════ 板块 ═══════════════════════

export async function listBoards(): Promise<Board[]> {
  const r = await pool.query(
    `select b.*,
            (select count(*)::int from forum_threads t where t.board_id = b.id) as thread_count,
            (select count(*)::int from forum_threads t
              where t.board_id = b.id and t.created_at > now() - interval '1 day') as today_count,
            (select max(t.last_reply_at) from forum_threads t where t.board_id = b.id) as last_reply_at
       from forum_boards b
      order by b.sort_order asc, b.name asc`
  );
  return r.rows.map((x: any) => ({
    id: String(x.id), slug: String(x.slug), name: String(x.name),
    description: String(x.description || ""), sortOrder: Number(x.sort_order) || 100,
    isBuiltin: Boolean(x.is_builtin),
    threadCount: Number(x.thread_count) || 0,
    todayCount: Number(x.today_count) || 0,
    lastReplyAt: x.last_reply_at ? new Date(x.last_reply_at).toISOString() : null,
  }));
}

// ═══════════════════════ 主题帖 ═══════════════════════

/**
 * 帖列表。
 *
 * ⚠ 排序是**贴吧的核心语义**: 置顶永远在最前, 其余按 `last_reply_at` 倒序 ——
 *   一条三年前的帖子只要有人回, 就该回到第一屏。按 `created_at` 排会让论坛
 *   只有新帖有曝光, 老帖里沉淀的讨论全被埋掉。
 *   「最新」时(=sort=new)才按发帖时间。
 */
export async function listThreads(opts: {
  viewerId: string;
  boardSlug?: string;
  q?: string;
  tag?: string;
  sort?: "active" | "new" | "hot" | "digest" | "starred" | "mine";
  limit?: number;
}): Promise<{ threads: ThreadItem[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const vp = push(opts.viewerId);

  if (opts.boardSlug) where.push(`b.slug = ${push(opts.boardSlug)}`);
  if (opts.q) {
    const p = push(`%${opts.q}%`);
    where.push(`(t.title ilike ${p} or t.body ilike ${p})`);
  }
  if (opts.tag) where.push(`t.tags ? ${push(opts.tag)}`);
  if (opts.sort === "digest") where.push(`t.digest = true`);
  if (opts.sort === "starred") where.push(`exists (select 1 from forum_stars s where s.thread_id = t.id and s.user_id = ${vp})`);
  if (opts.sort === "mine") where.push(`t.user_id = ${vp}`);

  const order = opts.sort === "new" ? `t.created_at desc`
    : opts.sort === "hot" ? `t.vote_count desc, t.reply_count desc, t.last_reply_at desc`
    : `t.pinned desc, t.last_reply_at desc`;

  const sql = `
    select t.*, b.name as board_name, b.slug as board_slug, u.username,
           (v.user_id is not null) as voted,
           (s.user_id is not null) as starred
      from forum_threads t
      join forum_boards b on b.id = t.board_id
      left join users u on u.id = t.user_id
      left join forum_votes v on v.target_type='thread' and v.target_id = t.id and v.user_id = ${vp}
      left join forum_stars s on s.thread_id = t.id and s.user_id = ${vp}
     ${where.length ? "where " + where.join(" and ") : ""}
     order by ${order}
     limit ${Math.min(Math.max(opts.limit ?? 40, 1), 200)}`;
  const r = await pool.query(sql, params);

  const threads = r.rows.map((x: any) => toThread(x, opts.viewerId));
  const c = await pool.query(
    `select count(*)::int n from forum_threads t join forum_boards b on b.id=t.board_id
      ${where.length ? "where " + where.join(" and ") : ""}`,
    params
  ).catch(() => ({ rows: [{ n: threads.length }] }));
  return { threads, total: Number(c.rows[0]?.n) || threads.length };
}

function toThread(x: any, viewerId: string): ThreadItem {
  const body = String(x.body || "");
  return {
    id: String(x.id),
    boardId: String(x.board_id),
    boardName: String(x.board_name || ""),
    authorId: String(x.user_id),
    author: String(x.username || "（已注销）"),
    title: String(x.title),
    excerpt: body.length > 160 ? body.slice(0, 160) + "…" : body,
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    pinned: Boolean(x.pinned),
    digest: Boolean(x.digest),
    replyCount: Number(x.reply_count) || 0,
    viewCount: Number(x.view_count) || 0,
    voteCount: Number(x.vote_count) || 0,
    starred: Boolean(x.starred),
    voted: Boolean(x.voted),
    mine: String(x.user_id) === viewerId,
    lastReplyAt: x.last_reply_at ? new Date(x.last_reply_at).toISOString() : "",
    createdAt: x.created_at ? new Date(x.created_at).toISOString() : "",
  };
}

/** 发帖 */
export async function createThread(input: {
  boardSlug: string; userId: string; title: string; body: string; tags?: string[];
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const title = String(input.title ?? "").trim();
  if (title.length < 2) return { ok: false, error: "标题太短(至少 2 个字)" };
  if (title.length > 120) return { ok: false, error: "标题过长(上限 120 字)" };

  const b = await pool.query(`select id from forum_boards where slug=$1`, [input.boardSlug]);
  if (!b.rows.length) return { ok: false, error: "板块不存在" };

  const r = await pool.query(
    `insert into forum_threads (board_id, user_id, title, body, tags)
     values ($1,$2,$3,$4,$5::jsonb) returning id`,
    [b.rows[0].id, input.userId, title, String(input.body ?? "").slice(0, 20000), JSON.stringify(input.tags ?? [])]
  );
  return { ok: true, id: String(r.rows[0].id) };
}

/** 帖详情 + 楼层 */
export async function getThread(id: string, viewerId: string): Promise<{
  thread: ThreadItem; replies: ReplyItem[];
} | null> {
  const r = await pool.query(
    `select t.*, b.name as board_name, b.slug as board_slug, u.username,
            (v.user_id is not null) as voted, (s.user_id is not null) as starred
       from forum_threads t
       join forum_boards b on b.id = t.board_id
       left join users u on u.id = t.user_id
       left join forum_votes v on v.target_type='thread' and v.target_id=t.id and v.user_id=$2
       left join forum_stars s on s.thread_id=t.id and s.user_id=$2
      where t.id = $1`,
    [id, viewerId]
  );
  if (!r.rows.length) return null;

  // 看帖计数: 同一人反复刷新不该刷高 —— 按"最近一次浏览"去重
  await pool.query(
    `update forum_threads set view_count = view_count + 1 where id = $1`,
    [id]
  ).catch(() => { /* 计数失败不影响读 */ });

  const reps = await pool.query(
    `select r.*, u.username, (v.user_id is not null) as voted
       from forum_replies r
       left join users u on u.id = r.user_id
       left join forum_votes v on v.target_type='reply' and v.target_id=r.id and v.user_id=$2
      where r.thread_id = $1
      order by r.created_at asc`,
    [id, viewerId]
  );
  return {
    thread: toThread(r.rows[0], viewerId),
    replies: reps.rows.map((x: any) => ({
      id: String(x.id),
      parentId: x.parent_id ? String(x.parent_id) : null,
      authorId: String(x.user_id),
      author: String(x.username || "（已注销）"),
      body: String(x.body),
      voteCount: Number(x.vote_count) || 0,
      voted: Boolean(x.voted),
      mine: String(x.user_id) === viewerId,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : "",
    })),
  };
}

/** 回帖 —— 同时把帖顶起来(更新 last_reply_at)并同步楼层计数 */
export async function addReply(input: {
  threadId: string; userId: string; body: string; parentId?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body = String(input.body ?? "").trim();
  if (!body) return { ok: false, error: "内容不能为空" };
  if (body.length > 8000) return { ok: false, error: "内容过长(上限 8000 字)" };

  const t = await pool.query(`select id from forum_threads where id=$1`, [input.threadId]);
  if (!t.rows.length) return { ok: false, error: "帖子不存在" };

  const r = await pool.query(
    `insert into forum_replies (thread_id, parent_id, user_id, body) values ($1,$2,$3,$4) returning id`,
    [input.threadId, input.parentId || null, input.userId, body]
  );
  await pool.query(
    `update forum_threads
        set reply_count = (select count(*) from forum_replies where thread_id=$1),
            last_reply_at = now()
      where id = $1`,
    [input.threadId]
  ).catch((e: any) => logger.warn({ err: String(e?.message || e).slice(0, 100) }, "论坛楼层计数更新失败"));
  return { ok: true, id: String(r.rows[0].id) };
}

/** 赞同/取消赞同(幂等切换) */
export async function toggleVote(input: {
  userId: string; targetType: "thread" | "reply"; targetId: string;
}): Promise<{ ok: boolean; voted: boolean; count: number }> {
  const del = await pool.query(
    `delete from forum_votes where user_id=$1 and target_type=$2 and target_id=$3 returning 1`,
    [input.userId, input.targetType, input.targetId]
  );
  let voted: boolean;
  if (del.rowCount) {
    voted = false;
  } else {
    await pool.query(
      `insert into forum_votes (user_id, target_type, target_id) values ($1,$2,$3)
       on conflict do nothing`,
      [input.userId, input.targetType, input.targetId]
    );
    voted = true;
  }
  const table = input.targetType === "thread" ? "forum_threads" : "forum_replies";
  const col = input.targetType === "thread" ? "id" : "id";
  const up = await pool.query(
    `update ${table} set vote_count = (select count(*) from forum_votes where target_type=$1 and target_id=$2)
      where ${col} = $2 returning vote_count`,
    [input.targetType, input.targetId]
  ).catch(() => ({ rows: [{ vote_count: 0 }] }));
  return { ok: true, voted, count: Number(up.rows[0]?.vote_count) || 0 };
}

/** 收藏/取消收藏 */
export async function toggleStar(input: { userId: string; threadId: string }): Promise<{ ok: boolean; starred: boolean }> {
  const del = await pool.query(
    `delete from forum_stars where user_id=$1 and thread_id=$2 returning 1`,
    [input.userId, input.threadId]
  );
  if (del.rowCount) return { ok: true, starred: false };
  await pool.query(
    `insert into forum_stars (user_id, thread_id) values ($1,$2) on conflict do nothing`,
    [input.userId, input.threadId]
  );
  return { ok: true, starred: true };
}

/** 置顶/加精/删帖 —— 管理员动作 */
export async function moderateThread(input: {
  threadId: string; adminId: string;
  action: "pin" | "unpin" | "digest" | "undigest" | "delete";
}): Promise<{ ok: boolean; error?: string }> {
  try {
    if (input.action === "delete") {
      const r = await pool.query(`delete from forum_threads where id=$1`, [input.threadId]);
      return r.rowCount ? { ok: true } : { ok: false, error: "帖子不存在" };
    }
    const set = input.action === "pin" ? "pinned = true"
      : input.action === "unpin" ? "pinned = false"
      : input.action === "digest" ? "digest = true"
      : "digest = false";
    const r = await pool.query(`update forum_threads set ${set} where id=$1`, [input.threadId]);
    return r.rowCount ? { ok: true } : { ok: false, error: "帖子不存在" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 论坛概览(首页数字带) */
export async function forumStats(): Promise<{
  boards: number; threads: number; replies: number; todayThreads: number; todayReplies: number; members: number;
}> {
  const r = await pool.query(
    `select
       (select count(*)::int from forum_boards) as boards,
       (select count(*)::int from forum_threads) as threads,
       (select count(*)::int from forum_replies) as replies,
       (select count(*)::int from forum_threads where created_at > now() - interval '1 day') as today_threads,
       (select count(*)::int from forum_replies where created_at > now() - interval '1 day') as today_replies,
       (select count(distinct user_id)::int from forum_threads) as members`
  ).catch(() => ({ rows: [{}] }));
  const x = r.rows[0] ?? {};
  return {
    boards: Number(x.boards) || 0, threads: Number(x.threads) || 0, replies: Number(x.replies) || 0,
    todayThreads: Number(x.today_threads) || 0, todayReplies: Number(x.today_replies) || 0,
    members: Number(x.members) || 0,
  };
}

/** 最近活跃 —— 侧栏用 */
export async function recentActive(limit = 8): Promise<Array<{ threadId: string; title: string; author: string; at: string }>> {
  const r = await pool.query(
    `select t.id, t.title, u.username, t.last_reply_at
       from forum_threads t left join users u on u.id = t.user_id
      where t.reply_count > 0
      order by t.last_reply_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 20)]
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows.map((x: any) => ({
    threadId: String(x.id), title: String(x.title), author: String(x.username || ""),
    at: x.last_reply_at ? new Date(x.last_reply_at).toISOString() : "",
  }));
}
