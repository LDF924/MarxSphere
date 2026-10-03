// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// skill-plaza-service.ts — 技能广场: 提交 → 审核 → 上架 → 安装 → 讨论(2026-10-03)
//
// 由来(用户): 「不应该命名为技能货架, 应该是 skill 广场 —— 开放的、互动式的、交流的、
//   有讨论区的; 大家可以上传自己的 skill; 平台搜集所有科研学术相关的 skill 放进来;
//   加一个审核机制, 管理员审核通过才能上架; 用户这边有进度条可以查询」。
//
// ═══ 与既有技能体系的关系(动之前必须搞清的一件事) ═══
//   技能本体是磁盘上的 `data/skills/**/SKILL.md` —— 那是**唯一真源**, Agent 召回、
//   健康检查、self-check 全读它。这张表(`skill_submissions`)只存**平台侧元信息**:
//   谁提交的、审核到哪一步、审核意见、装了多少次。
//   **不把 SKILL.md 正文抄进库**: 抄进去就有两份正文, 改哪份生效说不清 ——
//   这个仓已经因为"派生副本比真源旧"吃过好几次亏(参考源码比截图旧那次)。
//
// ═══ 状态机(前端进度条就是它) ═══
//   pending ──approve──→ approved ──(作者可 withdraw)──→ withdrawn
//      └────reject────→ rejected ──(作者可改后重提)──→ pending
//   驳回与撤回都**允许重提** —— 所以"活跃唯一索引"只覆盖 pending/approved,
//   否则一旦被驳回, 这个技能名就永久占死了。
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

export type SubmissionStatus = "pending" | "approved" | "rejected" | "withdrawn";

/** 六步进度条 —— 前端按它渲染, 服务端按它算当前处于第几步 */
export const PLAZA_STEPS = ["提交", "审核中", "审核结论", "上架", "被使用", "讨论"] as const;

export interface PlazaItem {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  origin: string;
  version: string;
  status: SubmissionStatus;
  reviewNote: string;
  reviewerId: string | null;
  ownerId: string;
  ownerName: string;
  installCount: number;
  commentCount: number;
  submittedAt: string;
  reviewedAt: string | null;
  /** 当前用户装过没有 —— 决定按钮是"安装"还是"已安装" */
  installed: boolean;
  /** 作者是不是本人 / 当前用户是不是管理员 —— 前端据此显示"撤回""审核" */
  mine: boolean;
}

/**
 * 提交一个技能到广场。
 *
 * ⚠ **一人一技能一条记录, 永久复用**(2026-10-03 实测修正)。
 *   第一版用的是 `insert ... on conflict (owner_id, slug) where status in ('pending','approved')`,
 *   而那条部分唯一索引**只覆盖活跃态** —— 于是一旦被驳回(状态变 rejected), 再提交就不冲突了,
 *   直接**插入第二条**. 后果: 作者在"我的提交"里看到两条同名记录(一条已驳回、一条待审),
 *   而且任何握着旧 id 的界面(进度条、审核入口)都指向那条已经作废的记录。
 *   实测就是这么暴露的: 驳回后重提, 再用原 id 去审核 → "这条不在待审状态"。
 *
 *   现在先按 (owner, slug) 找那一条, 找到就**复用并重置回待审**, 找不到才新建。
 *   部分唯一索引仍然保留 —— 它挡的是并发下的重复活跃行, 是另一回事。
 */
export async function submitSkill(input: {
  ownerId: string;
  slug: string;
  title: string;
  summary?: string;
  category?: string;
  tags?: string[];
  origin?: string;
  version?: string;
}): Promise<{ ok: true; id: string; status: SubmissionStatus } | { ok: false; error: string }> {
  const slug = String(input.slug || "").trim();
  if (!slug) return { ok: false, error: "缺少技能标识(与 SKILL.md 的 name 一致)" };
  const title = String(input.title || "").trim();
  if (!title) return { ok: false, error: "缺少技能标题" };
  const fields = [
    title, String(input.summary ?? "").slice(0, 500), String(input.category ?? ""),
    JSON.stringify(input.tags ?? []), String(input.origin ?? "self-made"), String(input.version ?? "1.0.0"),
  ];

  try {
    const cur = await pool.query(
      `select id from skill_submissions where owner_id=$1 and slug=$2 order by updated_at desc limit 1`,
      [input.ownerId, slug]
    );
    if (cur.rows.length) {
      // 复用: 字段覆盖 + 重置为待审(清掉上一轮的意见与审核人 —— 那是对**上一版**说的)
      const r = await pool.query(
        `update skill_submissions
            set title=$3, summary=$4, category=$5, tags=$6::jsonb, origin=$7, version=$8,
                status='pending', review_note='', reviewer_id=null, reviewed_at=null, updated_at=now()
          where id=$1 and owner_id=$2
          returning id, status`,
        [cur.rows[0].id, input.ownerId, ...fields]
      );
      return { ok: true, id: String(r.rows[0].id), status: String(r.rows[0].status) as SubmissionStatus };
    }
    const r = await pool.query(
      `insert into skill_submissions (owner_id, slug, title, summary, category, tags, origin, version)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       returning id, status`,
      [input.ownerId, slug, ...fields]
    );
    return { ok: true, id: String(r.rows[0].id), status: String(r.rows[0].status) as SubmissionStatus };
  } catch (e: any) {
    logger.warn({ err: String(e?.message || e).slice(0, 160) }, "技能提交失败");
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 广场列表 —— 三种视角合成的入口(公开 / 我的 / 待审) */
export async function listPlaza(opts: {
  viewerId: string;
  isAdmin?: boolean;
  /** mine=只看自己提交的; pending=待审队列(管理员); 空=全部已上架 */
  scope?: "mine" | "pending" | "";
  q?: string;
  category?: string;
  sort?: "hot" | "new" | "name";
}): Promise<{ items: PlazaItem[]; total: number; counts: { approved: number; pending: number; mine: number } }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (opts.scope === "mine") {
    where.push(`s.owner_id = ${push(opts.viewerId)}`);
  } else if (opts.scope === "pending") {
    // 待审队列只给管理员 —— 非管理员传了也退化成公开列表, 而不是报错(前端按钮本来就该藏起来)
    if (opts.isAdmin) where.push(`s.status = 'pending'`);
    else where.push(`s.status = 'approved'`);
  } else {
    where.push(`s.status = 'approved'`);
  }
  if (opts.q) {
    const p = push(`%${opts.q}%`);
    where.push(`(s.title ilike ${p} or s.summary ilike ${p} or s.slug ilike ${p})`);
  }
  if (opts.category) where.push(`s.category = ${push(opts.category)}`);
  const vp = push(opts.viewerId);

  const order = opts.sort === "hot" ? `s.install_count desc, s.submitted_at desc`
    : opts.sort === "name" ? `s.title asc`
    : `s.submitted_at desc`;

  const sql = `
    select s.*, u.username as owner_name,
           (select count(*)::int from skill_comments c where c.submission_id = s.id) as comment_count,
           (i.id is not null) as installed
      from skill_submissions s
      left join users u on u.id = s.owner_id
      left join skill_installs i on i.submission_id = s.id and i.user_id = ${vp}
     where ${where.join(" and ")}
     order by ${order}
     limit 300`;
  const r = await pool.query(sql, params);

  const items: PlazaItem[] = r.rows.map((row: any) => toItem(row, opts.viewerId, Boolean(opts.isAdmin)));

  // 三个角标数 —— 一次查询算完, 免得前端为每个 tab 各打一次
  const c = await pool.query(
    `select
       (select count(*)::int from skill_submissions where status='approved') as approved,
       (select count(*)::int from skill_submissions where status='pending') as pending,
       (select count(*)::int from skill_submissions where owner_id=$1) as mine`,
    [opts.viewerId]
  ).catch(() => ({ rows: [{ approved: 0, pending: 0, mine: 0 }] }));
  const counts = {
    approved: Number(c.rows[0]?.approved) || 0,
    pending: Number(c.rows[0]?.pending) || 0,
    mine: Number(c.rows[0]?.mine) || 0,
  };

  return { items, total: items.length, counts };
}

function toItem(row: any, viewerId: string, isAdmin: boolean): PlazaItem {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    summary: String(row.summary || ""),
    category: String(row.category || ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    origin: String(row.origin || ""),
    version: String(row.version || ""),
    status: String(row.status) as SubmissionStatus,
    reviewNote: String(row.review_note || ""),
    reviewerId: row.reviewer_id ? String(row.reviewer_id) : null,
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name || "（已注销）"),
    installCount: Number(row.install_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : "",
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    installed: Boolean(row.installed),
    mine: String(row.owner_id) === viewerId,
  };
}

/** 单条(详情/进度查询用)。非本人非管理员只看得到已上架的 */
export async function getSubmission(id: string, viewerId: string, isAdmin: boolean) {
  const r = await pool.query(
    `select s.*, u.username as owner_name from skill_submissions s
       left join users u on u.id = s.owner_id where s.id = $1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const mine = String(row.owner_id) === viewerId;
  if (row.status !== "approved" && !mine && !isAdmin) return null;
  return toItem(row, viewerId, isAdmin);
}

/**
 * 审核 —— 通过 / 驳回。
 *
 * ⚠ 两个副作用都必须做, 缺一个就出问题:
 *   ① 驳回时 `review_note` **不能为空**: 只说"不通过"而不说为什么, 作者无从修改,
 *      重提的还是同一份 —— 这是审核队列最容易变成死循环的地方。
 *   ② 结论要**通知作者**(站内信), 否则他只能反复回来看进度条。
 */
export async function reviewSubmission(input: {
  id: string;
  reviewerId: string;
  approve: boolean;
  note?: string;
}): Promise<{ ok: boolean; error?: string; status?: SubmissionStatus }> {
  const note = String(input.note ?? "").trim();
  if (!input.approve && !note) {
    return { ok: false, error: "驳回必须写审核意见 —— 否则作者不知道要改什么" };
  }
  const status: SubmissionStatus = input.approve ? "approved" : "rejected";
  const r = await pool.query(
    `update skill_submissions
        set status = $2, review_note = $3, reviewer_id = $4, reviewed_at = now(), updated_at = now()
      where id = $1 and status = 'pending'
      returning owner_id, title, slug`,
    [input.id, status, note, input.reviewerId]
  );
  if (!r.rows.length) return { ok: false, error: "这条不在待审状态(可能已被处理)" };

  const { owner_id: ownerId, title, slug } = r.rows[0];
  try {
    const { notify } = await import("./notification-service.js");
    await notify({
      userId: String(ownerId),
      category: "system",
      level: input.approve ? "success" : "warning",
      title: input.approve ? `技能已上架：${title}` : `技能未通过审核：${title}`,
      body: input.approve
        ? "已出现在技能广场，其他学友可以安装使用了。"
        : `审核意见：${note}`,
      // 点通知直接回到那条提交 —— 作者要看的就是它的进度
      link: { view: "skills", id: String(input.id), slug: String(slug) },
      dedupeKey: `skill-review:${input.id}:${status}`,
    });
  } catch (e: any) {
    // 通知失败不该让审核动作算失败 —— 结论已经落库了
    logger.warn({ err: String(e?.message || e).slice(0, 120) }, "技能审核通知发送失败");
  }
  return { ok: true, status };
}

/** 作者撤回 —— 已上架的也能撤回(下架), 撤下后不再出现在广场 */
export async function withdrawSubmission(id: string, ownerId: string): Promise<boolean> {
  const r = await pool.query(
    `update skill_submissions set status='withdrawn', updated_at=now()
      where id=$1 and owner_id=$2 and status in ('pending','approved')`,
    [id, ownerId]
  );
  return Boolean(r.rowCount);
}

/**
 * 安装 —— 记录 + 计数。
 *
 * ⚠ 技能本体不在这里落盘: 广场上的技能本来就来自本仓 `data/skills`(作者的提交也是),
 *   所以"安装"对本平台用户是**建立引用**(装过、可讨论、作者能看到谁在用),
 *   不是复制文件。复制会产生第二份正文 —— 与文件头那段说明同一个理由。
 */
export async function installSkill(input: {
  id: string;
  userId: string;
  version?: string;
}): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  const sub = await pool.query(`select status, version from skill_submissions where id=$1`, [input.id]);
  if (!sub.rows.length) return { ok: false, error: "技能不存在" };
  if (sub.rows[0].status !== "approved") return { ok: false, error: "这条还没有上架" };

  const ins = await pool.query(
    `insert into skill_installs (submission_id, user_id, version)
     values ($1,$2,$3)
     on conflict (submission_id, user_id) do update set version = excluded.version
     returning (xmax = 0) as is_new`,
    [input.id, input.userId, String(input.version ?? sub.rows[0].version ?? "")]
  );
  // xmax=0 表示这次是真插入(不是冲突更新) —— 只有真新增才 +1, 否则反复点会刷高计数
  const isNew = Boolean(ins.rows[0]?.is_new);
  if (isNew) {
    await pool.query(`update skill_submissions set install_count = install_count + 1 where id=$1`, [input.id]);
  }
  return { ok: true, already: !isNew };
}

/** 技能讨论区: 读 */
export async function listComments(submissionId: string, limit = 200) {
  const r = await pool.query(
    `select c.id, c.parent_id, c.user_id, c.body, c.created_at, u.username
       from skill_comments c left join users u on u.id = c.user_id
      where c.submission_id = $1
      order by c.created_at asc limit $2`,
    [submissionId, Math.min(Math.max(limit, 1), 500)]
  );
  return r.rows.map((x: any) => ({
    id: String(x.id),
    parentId: x.parent_id ? String(x.parent_id) : null,
    userId: String(x.user_id),
    author: String(x.username || "（已注销）"),
    body: String(x.body),
    createdAt: x.created_at ? new Date(x.created_at).toISOString() : "",
  }));
}

/** 技能讨论区: 写 */
export async function addComment(input: {
  submissionId: string;
  userId: string;
  body: string;
  parentId?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body = String(input.body ?? "").trim();
  if (!body) return { ok: false, error: "内容不能为空" };
  if (body.length > 4000) return { ok: false, error: "内容过长(上限 4000 字)" };
  const r = await pool.query(
    `insert into skill_comments (submission_id, parent_id, user_id, body)
     values ($1,$2,$3,$4) returning id`,
    [input.submissionId, input.parentId || null, input.userId, body]
  );
  return { ok: true, id: String(r.rows[0].id) };
}

/**
 * 管理员批量收录 —— 「平台搜集所有科研学术相关的 skill 放进来」这句的实现。
 *
 * 做法: 把本仓 `data/skills` 里**还没有提交记录**的技能, 以管理员的身份补一条
 * `approved` 记录(来源标 official), 让它们出现在广场上。
 * ⚠ 只收录**已上架态**, 不走 pending —— 这些是平台自带的技能, 没有"作者"可审核;
 *   走 pending 会让审核队列里塞满自己的东西, 真正需要人看的提交反而被淹。
 */
export async function curateOfficialSkills(input: {
  adminId: string;
  skills: Array<{ name: string; title?: string; summary?: string; category?: string; tags?: string[]; version?: string; origin?: string }>;
}): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const s of input.skills) {
    const slug = String(s.name || "").trim();
    if (!slug) { skipped++; continue; }
    try {
      const r = await pool.query(
        `insert into skill_submissions
           (owner_id, slug, title, summary, category, tags, origin, version, status, reviewer_id, reviewed_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'approved',$1, now())
         on conflict (owner_id, slug) where status in ('pending','approved') do nothing
         returning id`,
        [
          input.adminId, slug, String(s.title || slug), String(s.summary ?? "").slice(0, 500),
          String(s.category ?? ""), JSON.stringify(s.tags ?? []),
          String(s.origin ?? "official"), String(s.version ?? "1.0.0"),
        ]
      );
      if (r.rowCount) added++; else skipped++;
    } catch {
      skipped++;
    }
  }
  return { added, skipped };
}

/** 广场概览(顶部的数字带) */
export async function plazaStats(): Promise<{
  approved: number; pending: number; installs: number; contributors: number; comments: number;
}> {
  const r = await pool.query(
    `select
       (select count(*)::int from skill_submissions where status='approved') as approved,
       (select count(*)::int from skill_submissions where status='pending') as pending,
       (select count(*)::int from skill_installs) as installs,
       (select count(distinct owner_id)::int from skill_submissions where status='approved') as contributors,
       (select count(*)::int from skill_comments) as comments`
  ).catch(() => ({ rows: [{}] }));
  const x = r.rows[0] ?? {};
  return {
    approved: Number(x.approved) || 0,
    pending: Number(x.pending) || 0,
    installs: Number(x.installs) || 0,
    contributors: Number(x.contributors) || 0,
    comments: Number(x.comments) || 0,
  };
}
