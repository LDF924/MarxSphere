// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-version-service.ts — PPT 生成工作台 ⑥ 页面版本(每页历史 / 切换 / 回滚)
//
// 由来: 旧项目 AItoolman M9 的"版本管理"是每页一份快照, 能切回去重发。
//   本项目此前没有任何页面级版本 —— 单页重生一跑, 上一版就没了, 用户想比对
//   "刚才那版更好" 时无据可查。
//
// 三条设计决定:
//   ① **按页留版本, 不按整份稿子留**。旧项目也有任务级备份, 但"只重生成第 3 页"
//      这个动作下, 整份快照既大又没用 —— 用户要回滚的是那一页。
//   ② **先存旧版, 再改**。所有写路径(snapshotPage)都发生在 update 之前 ——
//      改成"改完再记"的话, 中途失败就把未记录的那一版留在库里了。
//   ③ **空转不产生版本**。同内容再点一次"重生"不该多出一条历史(实测很常见),
//      判据是内容签名(见 contentSignature), 而不是"这次调用有没有发生"。
import { pool } from "../db/pool.js";
import { createHash } from "node:crypto";

export type VersionOrigin = "scripts" | "regen" | "annotate" | "manual" | "rollback";

export interface PageSnapshot {
  pageId: string;
  jobId: string;
  version: number;
  title: string;
  bullets: unknown;
  notes: string;
  imagePrompt: string;
  imageRel: string;
  imageLayout: string;
  imageSource: string;
  origin: VersionOrigin;
  annotation: Record<string, unknown>;
}

export interface PageVersionMeta {
  version: number;
  origin: VersionOrigin;
  title: string;
  bulletCount: number;
  hasImage: boolean;
  imageSource: string;
  annotation: Record<string, unknown>;
  createdAt: string;
  /** 与本页当前内容是否相同 —— 界面据此把"没什么变化的那几版"折叠起来 */
  sameAsCurrent: boolean;
}

const MAX_VERSIONS_PER_PAGE = 30;

/**
 * 内容签名 —— 判断"这一版和上一版是不是同一份东西"。
 *
 * 只对**会被渲染出来的字段**取签名: 标题/要点/备注/配图。故意不含 updated_at、
 *   也不含 bullet 顺序之外的东西 —— 否则"看起来没变的重复点击"每次都会产生新版本,
 *   历史里全是同一个样子的条目(用户就没法用它找"上一版"了)。
 */
export function contentSignature(s: Pick<PageSnapshot, "title" | "bullets" | "notes" | "imageRel" | "imagePrompt" | "imageLayout">): string {
  const bullets = Array.isArray(s.bullets) ? s.bullets.map((b) => String(b).trim()) : [];
  const payload = JSON.stringify([
    String(s.title ?? "").trim(),
    bullets,
    String(s.notes ?? "").trim(),
    String(s.imageRel ?? ""),
    String(s.imagePrompt ?? ""),
    String(s.imageLayout ?? ""),
  ]);
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/** 下一个版本号。并发安全靠唯一约束 (page_id, version) —— 撞了由调用方重试 */
export async function nextVersionNumber(pageId: string): Promise<number> {
  const r = await pool.query(`select coalesce(max(version), 0) + 1 as v from ppt_page_versions where page_id=$1`, [pageId]);
  return Number(r.rows[0]?.v ?? 1);
}

/**
 * 记录一份版本(**必须在改动 ppt_pages 之前调用**)。
 *
 * `skipIfUnchanged` 缺省为 true: 与库里最新一版内容相同时不新建。
 * 显式传 false 表示"这一版一定要留" —— 例如用户手动点"存一版"。
 */
export async function snapshotPage(
  snap: PageSnapshot,
  opts: { skipIfUnchanged?: boolean } = {},
): Promise<{ created: boolean; version: number; error: string }> {
  const skip = opts.skipIfUnchanged !== false;
  try {
    if (skip) {
      const last = await pool.query(
        `select version, title, bullets, notes, image_rel, image_prompt, image_layout from ppt_page_versions
          where page_id=$1 order by version desc limit 1`, [snap.pageId]);
      if (last.rows.length) {
        const l = last.rows[0];
        const same = contentSignature({
          title: l.title, bullets: l.bullets, notes: l.notes,
          imageRel: l.image_rel, imagePrompt: l.image_prompt, imageLayout: l.image_layout,
        }) === contentSignature(snap);
        // 内容没变就不新建版本, 返回**已有的那一版号** —— 调用方据此告知"没有新版本产生",
        //   而不是让它以为刚存的是一个新号
        if (same) return { created: false, version: Number(l.version), error: "" };
      }
    }
    await pool.query(
      `insert into ppt_page_versions
         (page_id, job_id, version, title, bullets, notes, image_prompt, image_rel, image_layout, image_source, origin, annotation)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb)
       on conflict (page_id, version) do nothing`,
      [
        snap.pageId, snap.jobId, snap.version, String(snap.title ?? ""),
        JSON.stringify(Array.isArray(snap.bullets) ? snap.bullets : []),
        String(snap.notes ?? ""), String(snap.imagePrompt ?? ""), String(snap.imageRel ?? ""),
        String(snap.imageLayout ?? "none"), String(snap.imageSource ?? ""),
        snap.origin, JSON.stringify(snap.annotation ?? {}),
      ]);
    return { created: true, version: snap.version, error: "" };
  } catch (e) {
    return { created: false, version: snap.version, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** 某一页的全部版本(新→旧), 带"是否与当前相同"的标记 */
export async function listPageVersions(userId: string, jobId: string, pageId: string): Promise<PageVersionMeta[]> {
  const cur = await pool.query(
    `select p.title, p.bullets, p.notes, p.image_rel, p.image_prompt, p.image_layout
       from ppt_pages p join ppt_jobs j on j.id = p.job_id
      where p.id=$1 and p.job_id=$2 and j.user_id=$3`, [pageId, jobId, userId]);
  if (!cur.rows.length) return [];
  const curSig = contentSignature({
    title: cur.rows[0].title, bullets: cur.rows[0].bullets, notes: cur.rows[0].notes,
    imageRel: cur.rows[0].image_rel, imagePrompt: cur.rows[0].image_prompt, imageLayout: cur.rows[0].image_layout,
  });
  const r = await pool.query(
    `select version, origin, title, bullets, notes, image_rel, image_source, image_prompt, image_layout, annotation, created_at
       from ppt_page_versions where page_id=$1 order by version desc limit $2`,
    [pageId, MAX_VERSIONS_PER_PAGE]);
  return r.rows.map((row: Record<string, any>) => ({
    version: Number(row.version),
    origin: row.origin as VersionOrigin,
    title: String(row.title ?? ""),
    bulletCount: Array.isArray(row.bullets) ? row.bullets.length : 0,
    hasImage: Boolean(row.image_rel),
    imageSource: String(row.image_source ?? ""),
    annotation: (row.annotation ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString(),
    sameAsCurrent: contentSignature({
      title: row.title, bullets: row.bullets, notes: row.notes,
      imageRel: row.image_rel, imagePrompt: row.image_prompt, imageLayout: row.image_layout,
    }) === curSig,
  }));
}

/** 读一版的完整内容 */
export async function readPageVersion(userId: string, jobId: string, pageId: string, version: number): Promise<PageSnapshot | null> {
  const r = await pool.query(
    `select v.* from ppt_page_versions v
       join ppt_jobs j on j.id = v.job_id
      where v.page_id=$1 and v.job_id=$2 and v.version=$3 and j.user_id=$4`,
    [pageId, jobId, version, userId]);
  if (!r.rows.length) return null;
  const row = r.rows[0] as Record<string, any>;
  return {
    pageId: String(row.page_id), jobId: String(row.job_id), version: Number(row.version),
    title: String(row.title ?? ""), bullets: row.bullets ?? [],
    notes: String(row.notes ?? ""), imagePrompt: String(row.image_prompt ?? ""),
    imageRel: String(row.image_rel ?? ""), imageLayout: String(row.image_layout ?? "none"),
    imageSource: String(row.image_source ?? ""),
    origin: row.origin as VersionOrigin,
    annotation: (row.annotation ?? {}) as Record<string, unknown>,
  };
}

export interface RestoreResult {
  ok: boolean;
  /** 回滚**之前**当前内容被存成了哪一版(用户回滚错了还能再回来) */
  snapshotVersion: number | null;
  restored: PageSnapshot | null;
  error: string;
}

/**
 * 回滚到某一版。
 *
 * 关键: 回滚**本身也要留一版**(origin='rollback')。否则"回滚错了"就无路可退,
 *   而回滚恰恰是最容易点错的操作(历史列表里挨着的两条长得一样)。
 */
export async function restorePageVersion(input: {
  userId: string;
  jobId: string;
  pageId: string;
  version: number;
  reason?: string;
}): Promise<RestoreResult> {
  const target = await readPageVersion(input.userId, input.jobId, input.pageId, input.version);
  if (!target) return { ok: false, snapshotVersion: null, restored: null, error: `找不到第 ${input.version} 版` };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      `select p.* from ppt_pages p join ppt_jobs j on j.id=p.job_id
        where p.id=$1 and p.job_id=$2 and j.user_id=$3 for update`,
      [input.pageId, input.jobId, input.userId]);
    if (!cur.rows.length) {
      await client.query("rollback");
      return { ok: false, snapshotVersion: null, restored: null, error: "页面不存在或不属于你" };
    }
    const row = cur.rows[0] as Record<string, any>;
    const nextV = Number(await (async () => {
      const q = await client.query(`select coalesce(max(version),0)+1 v from ppt_page_versions where page_id=$1`, [input.pageId]);
      return q.rows[0].v;
    })());
    // 先把"当前"存下来 —— 事务内, 与下面的 update 一起成功或一起失败
    await client.query(
      `insert into ppt_page_versions
         (page_id, job_id, version, title, bullets, notes, image_prompt, image_rel, image_layout, image_source, origin, annotation)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'rollback',$11::jsonb)
       on conflict (page_id, version) do nothing`,
      [input.pageId, input.jobId, nextV, String(row.title ?? ""), JSON.stringify(row.bullets ?? []),
       String(row.notes ?? ""), String(row.image_prompt ?? ""), String(row.image_rel ?? ""),
       String(row.image_layout ?? "none"), String(row.image_source ?? ""),
       JSON.stringify({ reason: input.reason ?? "", toVersion: input.version })]);
    await client.query(
      `update ppt_pages set title=$2, bullets=$3::jsonb, notes=$4, image_prompt=$5, image_rel=$6,
              image_layout=$7, image_source=$8, updated_at=now()
        where id=$1`,
      [input.pageId, target.title, JSON.stringify(target.bullets), target.notes,
       target.imagePrompt, target.imageRel, target.imageLayout, target.imageSource]);
    await client.query("commit");
    return { ok: true, snapshotVersion: nextV, restored: target, error: "" };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, snapshotVersion: null, restored: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

/** 只保留最近 keep 版(其余删掉)。超过 MAX_VERSIONS_PER_PAGE 的页在写入后被清理一次 */
export async function prunePageVersions(pageId: string, keep = MAX_VERSIONS_PER_PAGE): Promise<number> {
  const r = await pool.query(
    `delete from ppt_page_versions
      where page_id=$1
        and version < (select coalesce(min(version), 0) from (
              select version from ppt_page_versions where page_id=$1 order by version desc limit $2
            ) t)
      returning version`, [pageId, Math.max(1, keep)]);
  return r.rowCount ?? 0;
}

export interface VersionDiff {
  titleChanged: boolean;
  fromTitle: string;
  toTitle: string;
  bulletsAdded: string[];
  bulletsRemoved: string[];
  bulletsKept: number;
  notesChanged: boolean;
  imageChanged: boolean;
}

/**
 * 两版之间的差异。
 *
 * 为什么要有它: 单页重生之后, 用户面对的是两个长得差不多的版本列表 ——
 *   "哪一版更好"要能当场看出来。只报"变了/没变"不够, 要点级的增删才是决策依据。
 */
export function diffVersions(from: PageSnapshot, to: PageSnapshot): VersionDiff {
  const norm = (a: unknown) => (Array.isArray(a) ? a.map((x) => String(x).trim()) : []);
  const fa = norm(from.bullets), fb = norm(to.bullets);
  const setB = new Set(fb);
  const setA = new Set(fa);
  return {
    titleChanged: String(from.title).trim() !== String(to.title).trim(),
    fromTitle: from.title,
    toTitle: to.title,
    bulletsAdded: fb.filter((b) => !setA.has(b)),
    bulletsRemoved: fa.filter((b) => !setB.has(b)),
    bulletsKept: fa.filter((b) => setB.has(b)).length,
    notesChanged: String(from.notes).trim() !== String(to.notes).trim(),
    imageChanged: String(from.imageRel) !== String(to.imageRel),
  };
}

/** 任务级版本概览(界面上"这份稿子改过几轮"用) */
export async function jobVersionSummary(userId: string, jobId: string): Promise<Array<{ pageId: string; seq: number; versions: number; lastOrigin: string }>> {
  const r = await pool.query(
    `select p.id as page_id, p.seq,
            count(v.id)::int as versions,
            coalesce((select v2.origin from ppt_page_versions v2
                       where v2.page_id = p.id order by v2.version desc limit 1), '') as last_origin
       from ppt_pages p
       join ppt_jobs j on j.id = p.job_id
       left join ppt_page_versions v on v.page_id = p.id
      where p.job_id=$1 and j.user_id=$2
      group by p.id, p.seq
      order by p.seq`, [jobId, userId]);
  return r.rows.map((row: Record<string, any>) => ({
    pageId: String(row.page_id), seq: Number(row.seq),
    versions: Number(row.versions), lastOrigin: String(row.last_origin ?? ""),
  }));
}
