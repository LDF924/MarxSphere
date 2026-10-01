// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-workbench-service.ts — PPT 生成工作台的主服务(任务编排 + 状态机 + 恢复)
//
// 由来: 旧项目 AItoolman 的 M9 是全项目最大的模块(111 个函数), 做的事是
//   大纲 → 脚本 → 配图 → 导出, 外加单页重生、风格模仿、参考图、批注重绘、版本管理。
//   本项目此前只有 `paper-outline-service.exportOutlinePptx`(封面+每章一页, 没有
//   讲稿/配图/重生/版本), 独立完整的演示稿工作台**不存在**。
//
// 本文件是把那五块串起来的**编排层** —— 每一块的实现分别在:
//   ppt-outline-service(①) / ppt-script-service(②) / ppt-render-service(③④⑤) /
//   ppt-version-service(⑥)。这里只管四件事:
//     状态机(⑦ 持久化与进度)、任务目录、单页/整份的重生、导出编排。
//
// ⚠ 状态机的**可恢复**是怎么成立的:
//   ① 每个阶段一完成就落库(不是等整份跑完), 所以进程被杀时已完成的页留在库里;
//   ② 中间态(scripting/rendering)是**显式**列在 schema 里的可恢复状态 ——
//      服务启动时扫这两态的行 = 上次没跑完的任务;
//   ③ 恢复不是"从头再来": recoverJob 只补**还没脚本的页**, 已脚本的原样保留。
//   旧项目用 m9_save_job_state / m9_load_job_state_from_path / m9_recover_m9_page_result
//   三件套干这件事, 这里换成"库 + 磁盘任务目录"两条腿(见 ppt-render-service.taskDir 的注释)。
import { pool } from "../db/pool.js";
import {
  generateOutline, applyOutlineEdit, estimateOutlineShape, tocEntries,
  type PptOutline, type OutlineEdit, type PptPageKind,
} from "./ppt-outline-service.js";
import { generateScriptBatch, generatePageScript, type PptPageScript } from "./ppt-script-service.js";
import {
  probeCapability, ensureTaskDir, taskDir, generateImage, saveServiceImage, composePptx, themeFromReference,
  absFromRel, DEFAULT_THEME, tryServiceImage,
  type ComposePage, type ExportMode, type RenderTheme, type PptPythonCapability,
} from "./ppt-render-service.js";
import {
  snapshotPage, nextVersionNumber, listPageVersions, restorePageVersion, prunePageVersions,
  jobVersionSummary, diffVersions, readPageVersion,
} from "./ppt-version-service.js";

export type JobStatus = "created" | "outline_ready" | "scripting" | "scripted" | "rendering" | "done" | "failed";

/** 可恢复的中间态 —— schema 的 check 约束与本表必须一致(测试盯这条) */
export const RESUMABLE_STATUSES: JobStatus[] = ["scripting", "rendering"];

export interface PptJob {
  id: string;
  userId: string;
  title: string;
  topic: string;
  sourceKind: string;
  sourceRef: string;
  style: string;
  referenceImage: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string;
  slideCount: number;
  maxBullets: number;
  workDir: string;
  exportStatus: string;
  exportProgress: number;
  exportMode: string;
  exportRel: string;
  exportError: string;
  createdAt: string;
  updatedAt: string;
}

export interface PptPage {
  id: string;
  jobId: string;
  seq: number;
  kind: PptPageKind;
  title: string;
  bullets: string[];
  notes: string;
  imagePrompt: string;
  imageRel: string;
  imageLayout: "none" | "right" | "background";
  imageSource: "" | "service" | "placeholder";
  imageNote: string;
  locked: boolean;
  status: "draft" | "scripted" | "rendered" | "failed";
  error: string;
}

function rowToJob(row: Record<string, any>): PptJob {
  return {
    id: String(row.id), userId: String(row.user_id), title: String(row.title ?? ""),
    topic: String(row.topic ?? ""), sourceKind: String(row.source_kind ?? "topic"),
    sourceRef: String(row.source_ref ?? ""), style: String(row.style ?? ""),
    referenceImage: String(row.reference_image ?? ""),
    status: row.status as JobStatus, stage: String(row.stage ?? ""),
    progress: Number(row.progress ?? 0), error: String(row.error ?? ""),
    slideCount: Number(row.slide_count ?? 0), maxBullets: Number(row.max_bullets ?? 5),
    workDir: String(row.work_dir ?? ""),
    exportStatus: String(row.export_status ?? ""), exportProgress: Number(row.export_progress ?? 0),
    exportMode: String(row.export_mode ?? ""), exportRel: String(row.export_rel ?? ""),
    exportError: String(row.export_error ?? ""),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rowToPage(row: Record<string, any>): PptPage {
  return {
    id: String(row.id), jobId: String(row.job_id), seq: Number(row.seq),
    kind: row.kind as PptPageKind, title: String(row.title ?? ""),
    bullets: Array.isArray(row.bullets) ? row.bullets.map((b: unknown) => String(b)) : [],
    notes: String(row.notes ?? ""), imagePrompt: String(row.image_prompt ?? ""),
    imageRel: String(row.image_rel ?? ""),
    imageLayout: (row.image_layout ?? "none") as PptPage["imageLayout"],
    imageSource: (row.image_source ?? "") as PptPage["imageSource"],
    imageNote: String(row.image_note ?? ""),
    locked: Boolean(row.locked),
    status: (row.status ?? "draft") as PptPage["status"],
    error: String(row.error ?? ""),
  };
}

// ════════════════════ 任务生命周期 ════════════════════

export async function createJob(input: {
  userId: string;
  topic: string;
  title?: string;
  sourceKind?: "topic" | "paper" | "outline";
  sourceRef?: string;
  style?: string;
  referenceImage?: string;
  maxBullets?: number;
}): Promise<{ ok: boolean; job?: PptJob; error?: string }> {
  try {
    const r = await pool.query(
      `insert into ppt_jobs (user_id, title, topic, source_kind, source_ref, style, reference_image, max_bullets)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.userId, String(input.title ?? input.topic ?? "").slice(0, 200),
       String(input.topic ?? "").slice(0, 500), input.sourceKind ?? "topic",
       String(input.sourceRef ?? "").slice(0, 200), String(input.style ?? "").slice(0, 300),
       String(input.referenceImage ?? "").slice(0, 400),
       Math.min(12, Math.max(1, Math.round(input.maxBullets ?? 5) || 5))]);
    const job = rowToJob(r.rows[0]);
    await pool.query(`update ppt_jobs set work_dir=$2, updated_at=now() where id=$1`,
      [job.id, `ppt-tasks/${input.userId}/${job.id}`]);
    ensureTaskDir(input.userId, job.id);   // 目录先建出来: 后面每一步都可能往里写, 别每处都 mkdir
    return { ok: true, job: { ...job, workDir: `ppt-tasks/${input.userId}/${job.id}` } };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export async function getJob(userId: string, jobId: string): Promise<PptJob | null> {
  const r = await pool.query(`select * from ppt_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  return r.rows.length ? rowToJob(r.rows[0]) : null;
}

export async function listJobs(userId: string, limit = 30): Promise<PptJob[]> {
  const r = await pool.query(
    `select * from ppt_jobs where user_id=$1 order by updated_at desc limit $2`,
    [userId, Math.min(100, Math.max(1, limit))]);
  return r.rows.map(rowToJob);
}

export async function listPages(userId: string, jobId: string): Promise<PptPage[]> {
  const r = await pool.query(
    `select p.* from ppt_pages p join ppt_jobs j on j.id=p.job_id
      where p.job_id=$1 and j.user_id=$2 order by p.seq`, [jobId, userId]);
  return r.rows.map(rowToPage);
}

/** 任务状态视图 —— 前端轮询这一个接口就够了(进度/阶段/导出/每页状态全在里面) */
export async function jobProgress(userId: string, jobId: string): Promise<{
  ok: boolean; job: PptJob | null; pages: PptPage[]; error: string;
}> {
  const job = await getJob(userId, jobId);
  if (!job) return { ok: false, job: null, pages: [], error: "任务不存在" };
  return { ok: true, job, pages: await listPages(userId, jobId), error: "" };
}

async function setStatus(jobId: string, status: JobStatus, patch: {
  stage?: string; progress?: number; error?: string; slideCount?: number;
  exportStatus?: string; exportProgress?: number; exportMode?: string; exportRel?: string; exportError?: string;
} = {}): Promise<void> {
  const sets: string[] = ["status=$2", "updated_at=now()"];
  const vals: unknown[] = [jobId, status];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.stage !== undefined) add("stage", patch.stage);
  if (patch.progress !== undefined) add("progress", Math.max(0, Math.min(100, Math.round(patch.progress))));
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.slideCount !== undefined) add("slide_count", patch.slideCount);
  if (patch.exportStatus !== undefined) add("export_status", patch.exportStatus);
  if (patch.exportProgress !== undefined) add("export_progress", Math.max(0, Math.min(100, Math.round(patch.exportProgress))));
  if (patch.exportMode !== undefined) add("export_mode", patch.exportMode);
  if (patch.exportRel !== undefined) add("export_rel", patch.exportRel);
  if (patch.exportError !== undefined) add("export_error", patch.exportError);
  await pool.query(`update ppt_jobs set ${sets.join(", ")} where id=$1`, vals);
}

// ════════════════════ ① 大纲 ════════════════════

export async function generateJobOutline(input: {
  userId: string; jobId: string; wantPages?: number; sourceText?: string;
  callJson?: Parameters<typeof generateOutline>[0]["callJson"];
}): Promise<{ ok: boolean; outline?: PptOutline; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  await setStatus(job.id, "created", { stage: "大纲生成中", progress: 5, error: "" });

  const outline = await generateOutline({
    topic: job.topic || job.title,
    wantPages: input.wantPages,
    maxBullets: job.maxBullets,
    sourceText: input.sourceText,
    callJson: input.callJson,
  });

  // 重出大纲时把旧页清掉 —— 保留的话页序会与新大纲交错, 单页重生会改错页
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from ppt_pages where job_id=$1`, [job.id]);
    for (const p of outline.pages) {
      await client.query(
        `insert into ppt_pages (job_id, seq, kind, title, bullets, notes) values ($1,$2,$3,$4,$5::jsonb,$6)`,
        [job.id, p.seq, p.kind, p.title, JSON.stringify(p.bullets), p.notes]);
    }
    await client.query(
      `update ppt_jobs set title=$2, slide_count=$3, status='outline_ready', stage=$4, progress=20, error='', updated_at=now()
        where id=$1`,
      [job.id, outline.title || job.title, outline.pages.length,
       outline.degraded ? `大纲已出(降级: ${outline.degradeReason})` : "大纲已就绪"]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => null);
    await setStatus(job.id, "failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
  return { ok: true, outline };
}

/** 把库里的页读成大纲形状(编辑与渲染都吃这个, 免得两处各写一遍拼装) */
export async function loadOutline(userId: string, jobId: string): Promise<PptOutline | null> {
  const job = await getJob(userId, jobId);
  if (!job) return null;
  const pages = await listPages(userId, jobId);
  return {
    title: job.title, subtitle: "",
    pages: pages.map((p) => ({ seq: p.seq, kind: p.kind, title: p.title, bullets: p.bullets, notes: p.notes })),
    pageCountNote: `共 ${pages.length} 页`, degraded: false, degradeReason: "",
  };
}

/**
 * 大纲编辑(增删页 / 改标题 / 调顺序 / 改页数)。
 *
 * 编辑落在 **ppt_pages 的行上**(不是整份 JSON 重写): 旧项目把状态整份存一个文件,
 *   同时编辑两页时后写的会盖掉先写的; 一页一行就没有这个面。
 */
export async function editOutline(input: {
  userId: string; jobId: string; edit: OutlineEdit;
}): Promise<{ ok: boolean; outline?: PptOutline; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const cur = await loadOutline(input.userId, input.jobId);
  if (!cur || !cur.pages.length) return { ok: false, error: "还没有大纲, 先生成" };

  const res = applyOutlineEdit(cur, { ...input.edit, maxBullets: job.maxBullets });
  if (!res.ok) return { ok: false, error: res.error };

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 编辑是**全量对账**: 按 seq 更新/插入, 库里有而新大纲没有的删掉。
    //   不这么做的话"删了一页"只能靠别处记一笔删除, 久了必飘。
    const keep: number[] = [];
    for (const p of res.outline.pages) {
      keep.push(p.seq);
      await client.query(
        `insert into ppt_pages (job_id, seq, kind, title, bullets, notes) values ($1,$2,$3,$4,$5::jsonb,$6)
         on conflict (job_id, seq) do update set kind=excluded.kind, title=excluded.title,
           bullets=excluded.bullets, notes=excluded.notes, updated_at=now()`,
        [job.id, p.seq, p.kind, p.title, JSON.stringify(p.bullets), p.notes]);
    }
    await client.query(`delete from ppt_pages where job_id=$1 and seq <> all($2::int[])`, [job.id, keep]);
    await client.query(
      `update ppt_jobs set slide_count=$2, title=coalesce(nullif($3,''), title), status='outline_ready', stage=$4, updated_at=now()
        where id=$1`,
      [job.id, res.outline.pages.length, res.outline.title, `大纲已改: ${res.outline.pageCountNote}`]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
  return { ok: true, outline: { ...res.outline, pageCountNote: res.outline.pageCountNote } };
}

/** 目录页的条目(界面上展示/校对用) —— 从正文页现算, 与渲染时同一份逻辑 */
export async function outlineToc(userId: string, jobId: string): Promise<string[]> {
  const o = await loadOutline(userId, jobId);
  return o ? tocEntries(o) : [];
}

export function shapeEstimate(input: { wantPages?: number; maxBullets?: number; sections?: number }) {
  return estimateOutlineShape(input);
}

// ════════════════════ ② 脚本(整份 / 单页) ════════════════════

/**
 * 整份脚本生成。
 *
 * 边跑边落库: 每完成一页立刻写 ppt_pages。**不是**跑完再写 —— 那份稿子 30 页
 *   要几分钟, 中途进程死掉的话"跑完再写"意味着这一轮全白干(m9_save_job_state
 *   要解决的问题就是这个)。
 */
export async function generateScripts(input: {
  userId: string; jobId: string; concurrency?: number;
  callJson?: Parameters<typeof generateScriptBatch>[0]["callJson"];
  shouldStop?: () => boolean | Promise<boolean>;
}): Promise<{ ok: boolean; done: number; total: number; stopped: boolean; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, done: 0, total: 0, stopped: false, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  if (!pages.length) return { ok: false, done: 0, total: 0, stopped: false, error: "没有页面, 先生成大纲" };

  await setStatus(job.id, "scripting", { stage: "脚本生成中", progress: 25, error: "" });
  let done = 0;
  const r = await generateScriptBatch({
    pages: pages.map((p) => ({ seq: p.seq, kind: p.kind, title: p.title, bullets: p.bullets, notes: p.notes })),
    topic: job.topic || job.title,
    maxBullets: job.maxBullets,
    concurrency: input.concurrency,
    shouldStop: input.shouldStop,
    callJson: input.callJson,
    onPage: async (s) => {
      await writePageScript(job.id, s);
      done++;
      await setStatus(job.id, "scripting", {
        stage: `脚本生成中 ${done}/${pages.length}`,
        progress: 25 + Math.round((done / pages.length) * 45),
      });
    },
  });

  await setStatus(job.id, r.stopped ? "scripting" : "scripted", {
    stage: r.stopped ? `脚本已中断(${done}/${pages.length}), 可恢复` : `脚本已就绪(${r.scripts.length} 页)`,
    progress: r.stopped ? 25 + Math.round((done / pages.length) * 45) : 70,
  });
  return { ok: true, done, total: pages.length, stopped: r.stopped };
}

async function writePageScript(jobId: string, s: PptPageScript): Promise<void> {
  await pool.query(
    `update ppt_pages set title=$3, bullets=$4::jsonb, notes=$5, image_prompt=$6,
            status='scripted', error='', updated_at=now()
      where job_id=$1 and seq=$2`,
    [jobId, s.seq, s.title, JSON.stringify(s.bullets), s.notes, s.imagePrompt]);
}

/**
 * ⑤ 单页重生 —— **只动这一页**。
 *
 * 这是"单页重生"与"重跑整份"的全部区别所在: 只 update (job_id, seq) 那一行,
 *   其它页的 title/bullets/notes/image_* 一个字节都不碰。
 *   代价是 6 次库往返(取页 → 快照 → 生成 → 写回), 换来的是"改第 3 页不会顺手改坏第 7 页"。
 *
 * 覆盖保护: `locked` 为真的页默认拒绝重生 —— 用户手动锁过的页多半是自己改过的,
 *   一次批量的"全部重生"把它冲掉会让人当场失去信任。要重生就显式 force。
 */
export async function regenPage(input: {
  userId: string; jobId: string; seq: number; force?: boolean;
  callJson?: Parameters<typeof generatePageScript>[0]["callJson"];
}): Promise<{ ok: boolean; page?: PptPage; stopped?: boolean; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  const page = pages.find((p) => p.seq === input.seq);
  if (!page) return { ok: false, error: `找不到第 ${input.seq} 页` };
  if (page.locked && !input.force) return { ok: false, error: "这一页已锁定(改完请先解锁再重生)", };

  // 先留版本再改 —— 反过来的话中途失败就把未记录的那一版留在库里了
  const v = await nextVersionNumber(page.id);
  await snapshotPage({
    pageId: page.id, jobId: job.id, version: v,
    title: page.title, bullets: page.bullets, notes: page.notes,
    imagePrompt: page.imagePrompt, imageRel: page.imageRel,
    imageLayout: page.imageLayout, imageSource: page.imageSource,
    origin: "regen", annotation: {},
  });

  const script = await generatePageScript({
    page: { seq: page.seq, kind: page.kind, title: page.title, bullets: page.bullets, notes: page.notes },
    topic: job.topic || job.title,
    maxBullets: job.maxBullets,
    neighborTitles: pages.filter((p) => p.seq !== page.seq).map((p) => p.title),
    callJson: input.callJson,
  });
  await writePageScript(job.id, script);
  await prunePageVersions(page.id);
  await pool.query(`update ppt_jobs set stage=$2, updated_at=now() where id=$1`,
    [job.id, `第 ${page.seq} 页已重生`]);
  const all = await listPages(input.userId, input.jobId);
  return { ok: true, page: all.find((p) => p.seq === input.seq) };
}

/** 批量重生(**跳过锁定页**) —— 用户改过的页面不该被一轮批处理冲掉 */
export async function regenAll(input: {
  userId: string; jobId: string; callJson?: Parameters<typeof generateScriptBatch>[0]["callJson"];
}): Promise<{ ok: boolean; done: number; skipped: number; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, done: 0, skipped: 0, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  const targets = pages.filter((p) => !p.locked);
  const skipped = pages.length - targets.length;
  if (!targets.length) return { ok: false, done: 0, skipped, error: "所有页都已锁定, 没有可重生的页" };

  await setStatus(job.id, "scripting", { stage: "批量重生中", progress: 30, error: "" });
  let done = 0;
  for (const p of targets) {
    const r = await regenPage({ userId: input.userId, jobId: input.jobId, seq: p.seq, callJson: input.callJson });
    if (r.ok) {
      done++;
      await setStatus(job.id, "scripting", {
        stage: `批量重生 ${done}/${targets.length}`, progress: 30 + Math.round((done / targets.length) * 40),
      });
    }
  }
  await setStatus(job.id, "scripted", { stage: `批量重生完成(${done} 页, 跳过 ${skipped} 页锁定)`, progress: 70 });
  return { ok: true, done, skipped };
}

// ════════════════════ ③ 配图 ════════════════════

/**
 * 给一页配图。
 *
 * 两条路, 结果都**必须**标清来源:
 *   ① 配了 PPT_IMAGE_ENDPOINT 且调用成功 → imageSource="service"(真生图);
 *   ② 否则本地生成示意图 → imageSource="placeholder", 并把"这是本地示意"写进 image_note。
 * 决不允许出现"有图但说不清哪来的" —— 那正是用户被误导的入口(会以为是 AI 插画)。
 */
export async function illustratePage(input: {
  userId: string; jobId: string; seq: number;
  layout?: "right" | "background";
  kind?: "diagram" | "backdrop";
  theme?: RenderTheme;
}): Promise<{ ok: boolean; page?: PptPage; source?: string; note?: string; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  const page = pages.find((p) => p.seq === input.seq);
  if (!page) return { ok: false, error: `找不到第 ${input.seq} 页` };

  const theme = input.theme ?? await jobTheme(input.userId, input.jobId);
  const kind = input.kind ?? (page.kind === "cover" || page.kind === "section" ? "backdrop" : "diagram");
  const layout = input.layout ?? "right";

  const v = await nextVersionNumber(page.id);
  await snapshotPage({
    pageId: page.id, jobId: job.id, version: v,
    title: page.title, bullets: page.bullets, notes: page.notes,
    imagePrompt: page.imagePrompt, imageRel: page.imageRel,
    imageLayout: page.imageLayout, imageSource: page.imageSource,
    origin: "regen", annotation: {},
  });

  const prompt = page.imagePrompt || `${page.title}: ${kind === "backdrop" ? "整页视觉底图" : "要点示意图"}`;
  const pageNo = pages.findIndex((p) => p.seq === page.seq) + 1;
  const svc = await tryServiceImage(prompt, theme);
  let source: "service" | "placeholder" = "placeholder";
  let note = "";
  let rel = "";
  let absPath = "";

  if (svc.ok && svc.buf) {
    // 真生图: 用的是服务返回的**那些字节**。先前写成"拿到图之后又本地画一张、标成
    //   service" —— 那比降级更糟: 降级至少说了实话, 那种写法是拿模板图冒充 AI 插画。
    const saved = await saveServiceImage({
      userId: input.userId, jobId: job.id, seq: page.seq, version: v, bytes: svc.buf, provider: svc.provider ?? "外部服务",
    });
    if (saved.ok) {
      rel = saved.rel; absPath = saved.absPath; source = "service"; note = saved.note;
    } else {
      // 服务给了图但落不了盘 → 退回本地并**据实**标 placeholder
      const local = await generateImage({
        userId: input.userId, jobId: job.id, seq: page.seq, version: v,
        kind, title: page.title, bullets: page.bullets, theme, pageNo,
      });
      if (!local.ok) return { ok: false, error: `生图结果无法落盘(${saved.error}), 本地兜底也失败: ${local.error}` };
      rel = local.rel; absPath = local.absPath;
      note = `${local.note}(生图结果落盘失败: ${saved.error})`;
    }
  } else {
    const local = await generateImage({
      userId: input.userId, jobId: job.id, seq: page.seq, version: v,
      kind, title: page.title, bullets: page.bullets, theme, pageNo,
    });
    if (!local.ok) return { ok: false, error: local.error };
    rel = local.rel; absPath = local.absPath;
    note = `${local.note}(原因: ${svc.error})`;
  }

  await pool.query(
    `update ppt_pages set image_prompt=$3, image_rel=$4, image_layout=$5, image_source=$6, image_note=$7,
            status=case when status='draft' then 'scripted' else status end, updated_at=now()
      where job_id=$1 and seq=$2`,
    [job.id, page.seq, prompt, rel, layout, source, note.slice(0, 400)]);
  await prunePageVersions(page.id);
  const all = await listPages(input.userId, input.jobId);
  return { ok: true, page: all.find((p) => p.seq === page.seq), source, note };
}

/** 整份配图(跳过已锁定的页) */
export async function illustrateAll(input: {
  userId: string; jobId: string; theme?: RenderTheme;
}): Promise<{ ok: boolean; done: number; failed: number; skipped: number; sources: Record<string, number>; error?: string }> {
  const pages = await listPages(input.userId, input.jobId);
  if (!pages.length) return { ok: false, done: 0, failed: 0, skipped: 0, sources: {}, error: "没有页面" };
  const theme = input.theme ?? await jobTheme(input.userId, input.jobId);
  let done = 0, failed = 0;
  const sources: Record<string, number> = { service: 0, placeholder: 0 };
  const targets = pages.filter((p) => !p.locked && p.kind === "content");
  for (const p of targets) {
    const r = await illustratePage({ userId: input.userId, jobId: input.jobId, seq: p.seq, theme });
    if (r.ok) { done++; sources[r.source ?? "placeholder"] = (sources[r.source ?? "placeholder"] ?? 0) + 1; }
    else failed++;
    await setStatus(input.jobId, "scripting", {
      stage: `配图 ${done + failed}/${targets.length}`, progress: 70 + Math.round(((done + failed) / Math.max(1, targets.length)) * 15),
    });
  }
  await setStatus(input.jobId, "scripted", { stage: `配图完成(${done} 页, ${failed} 页失败)`, progress: 85 });
  return { ok: true, done, failed, skipped: pages.length - targets.length, sources };
}

/** 取消某页的配图(改回无图) */
export async function clearPageImage(userId: string, jobId: string, seq: number): Promise<{ ok: boolean; error?: string }> {
  const job = await getJob(userId, jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const pages = await listPages(userId, jobId);
  const page = pages.find((p) => p.seq === seq);
  if (!page) return { ok: false, error: `找不到第 ${seq} 页` };
  const v = await nextVersionNumber(page.id);
  await snapshotPage({
    pageId: page.id, jobId: job.id, version: v,
    title: page.title, bullets: page.bullets, notes: page.notes,
    imagePrompt: page.imagePrompt, imageRel: page.imageRel,
    imageLayout: page.imageLayout, imageSource: page.imageSource, origin: "manual", annotation: {},
  });
  await pool.query(
    `update ppt_pages set image_rel='', image_source='', image_note='', image_layout='none', updated_at=now()
      where job_id=$1 and seq=$2`, [jobId, seq]);
  return { ok: true };
}

/**
 * 任务的当前视觉规范。
 *
 * 三级优先: 参考图提取 > 任务 style 文本(自由描述) > 缺省主题。
 * 参考图只在**第一次**用到时解析, 结果缓存进 style 列 —— 每次出图都重新解析
 * 一张 4000x3000 的图要几百毫秒, 而它的配色在任务生命周期里不会变。
 */
export async function jobTheme(userId: string, jobId: string): Promise<RenderTheme> {
  const job = await getJob(userId, jobId);
  if (!job) return { ...DEFAULT_THEME };
  const cap = await probeCapability();
  const base = { ...cap.theme };
  if (job.referenceImage) {
    const cached = /^THEME_JSON:/.test(job.style) ? safeJson(job.style.slice("THEME_JSON:".length)) : null;
    if (cached) return { ...base, ...cached } as RenderTheme;
    const r = await themeFromReference(absFromRel(job.referenceImage), base);
    if (r.ok) {
      // 缓存写回: 下次不必再解析参考图。写失败不影响本次出图
      await pool.query(`update ppt_jobs set style=$2, updated_at=now() where id=$1`,
        [jobId, `THEME_JSON:${JSON.stringify(r.theme)}`]).catch(() => null);
      return r.theme;
    }
  }
  return base;
}

function safeJson(s: string): Record<string, unknown> | null {
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; }
}

// ════════════════════ ⑤ 批注重绘(单页) ════════════════════

/**
 * 批注重绘: 用户在某页上框一块 + 写一句"想改成什么" → 只改那一块。
 *
 * 现在**没有生成式修补服务**, 所以框内是本地重绘(掩膜 + 补丁 + 高亮), 框外像素
 *   逐字节保留。返回里 `generativeInpaint` 恒为 false, 明说这不是生成式修补。
 * 但**批注本身一定存下来**(进版本 annotation): prompt 与框选坐标是下一次接上
 *   真 inpaint 时的输入, 丢掉的话用户这次的意图就没了。
 */
export async function annotateAndRegen(input: {
  userId: string; jobId: string; seq: number;
  rects: Array<{ x: number; y: number; w: number; h: number; label?: string }>;
  prompt: string;
}): Promise<{ ok: boolean; page?: PptPage; maskRel?: string; note?: string; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  const page = pages.find((p) => p.seq === input.seq);
  if (!page) return { ok: false, error: `找不到第 ${input.seq} 页` };
  if (page.kind !== "content") return { ok: false, error: "只能对正文页做批注重绘" };

  const { annotatePage, validateRects, buildAnnotationPayload } = await import("./ppt-render-service.js");
  const v0 = validateRects(input.rects);
  if (!v0.ok) return { ok: false, error: v0.error };
  const theme = await jobTheme(input.userId, input.jobId);

  // 底图: 优先用当前配图; 没有配图就先按当前版式渲染一张整页图当底
  let baseAbs = page.imageRel ? absFromRel(page.imageRel) : "";
  if (!baseAbs || !(await fileExists(baseAbs))) {
    const pre = await generateImage({
      userId: input.userId, jobId: job.id, seq: page.seq, version: 0,
      kind: "slide", title: page.title, bullets: page.bullets, theme,
      pageKind: page.kind, pageNo: pages.findIndex((p) => p.seq === page.seq) + 1, tag: "base",
    });
    if (!pre.ok) return { ok: false, error: `先生成底图失败: ${pre.error}` };
    baseAbs = pre.absPath;
  }

  const v = await nextVersionNumber(page.id);
  await snapshotPage({
    pageId: page.id, jobId: job.id, version: v,
    title: page.title, bullets: page.bullets, notes: page.notes,
    imagePrompt: page.imagePrompt, imageRel: page.imageRel,
    imageLayout: page.imageLayout, imageSource: page.imageSource, origin: "annotate",
    annotation: { rects: v0.rects, prompt: input.prompt },
  });

  const r = await annotatePage({
    userId: input.userId, jobId: job.id, seq: page.seq, version: v,
    baseImageAbs: baseAbs, rects: v0.rects, prompt: input.prompt, theme,
  });
  if (!r.ok) return { ok: false, error: r.error };

  const payload = buildAnnotationPayload({
    pageSeq: page.seq, rects: v0.rects, prompt: input.prompt,
    baseImageRel: page.imageRel || absFromRel(baseAbs),
    maskRel: r.maskRel, generatedRel: r.rel,
  });
  // 批注进 notes 的**追加**形式(不覆盖讲稿): 用户框选时多半心里已经有一句要记的
  const notes = input.prompt
    ? `${page.notes ? `${page.notes}\n` : ""}[批注重绘] ${input.prompt}`.slice(0, 900)
    : page.notes;
  await pool.query(
    `update ppt_pages set image_rel=$3, image_layout=case when image_layout='none' then 'right' else image_layout end,
            image_source='placeholder', image_note=$4, notes=$5, updated_at=now()
      where job_id=$1 and seq=$2`,
    [job.id, page.seq, r.rel, r.note.slice(0, 400), notes]);
  await pool.query(
    `update ppt_page_versions set annotation=$3::jsonb
      where page_id=$1 and version=$2 and origin='annotate'`,
    [page.id, v, JSON.stringify(payload)]).catch(() => null);
  await prunePageVersions(page.id);
  const all = await listPages(input.userId, input.jobId);
  return { ok: true, page: all.find((p) => p.seq === page.seq), maskRel: r.maskRel, note: r.note };
}

// ════════════════════ ⑥ 版本 ════════════════════

export async function pageVersions(userId: string, jobId: string, seq: number) {
  const pages = await listPages(userId, jobId);
  const page = pages.find((p) => p.seq === seq);
  if (!page) return { ok: false, versions: [], error: `找不到第 ${seq} 页` };
  return { ok: true, versions: await listPageVersions(userId, jobId, page.id), pageId: page.id, error: "" };
}

export async function rollbackPage(userId: string, jobId: string, seq: number, version: number) {
  const pages = await listPages(userId, jobId);
  const page = pages.find((p) => p.seq === seq);
  if (!page) return { ok: false, error: `找不到第 ${seq} 页` };
  const r = await restorePageVersion({ userId, jobId, pageId: page.id, version, reason: `用户回滚第 ${seq} 页` });
  return r.ok ? { ok: true, restored: r.restored, snapshotVersion: r.snapshotVersion } : { ok: false, error: r.error };
}

/** 两版对比(单页重生后"哪版更好"的依据) */
export async function compareVersions(userId: string, jobId: string, seq: number, a: number, b: number) {
  const pages = await listPages(userId, jobId);
  const page = pages.find((p) => p.seq === seq);
  if (!page) return { ok: false, error: `找不到第 ${seq} 页` };
  const [va, vb] = await Promise.all([
    readPageVersion(userId, jobId, page.id, a),
    readPageVersion(userId, jobId, page.id, b),
  ]);
  if (!va || !vb) return { ok: false, error: "版本不存在" };
  return { ok: true, diff: diffVersions(va, vb), from: va, to: vb };
}

export async function jobVersions(userId: string, jobId: string) {
  return jobVersionSummary(userId, jobId);
}

// ════════════════════ ④ 导出 ════════════════════

/**
 * 导出 pptx。两种模式: editable(可编辑) / image(整页位图, 不可编辑)。
 *
 * 进度可查询: export_status/export_progress 落在 ppt_jobs 上, 前端轮询 jobProgress 即可。
 * 导出与脚本生成是**两条独立进度** —— 共用一列的话"导出到 60%"会把"脚本已完成"
 * 这个事实抹掉(m9_save_job_state 那套把状态全塞一个对象, 就有这个问题)。
 */
export async function exportPptx(input: {
  userId: string; jobId: string; mode: ExportMode; theme?: RenderTheme; nameSuffix?: string;
}): Promise<{ ok: boolean; rel?: string; absPath?: string; slides?: number; warnings?: string[]; overflows?: Array<{ seq: number; overBy: number }>; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  if (!pages.length) return { ok: false, error: "没有页面可导出" };

  const cap = await probeCapability();
  if (!cap.pptx) return { ok: false, error: `导出需要 python-pptx: ${cap.error}` };

  await setStatus(job.id, job.status === "done" ? "done" : "rendering", {
    stage: "导出中", exportStatus: "running", exportProgress: 5, exportMode: input.mode, exportError: "",
  });

  const theme = input.theme ?? await jobTheme(input.userId, input.jobId);
  const toc = tocEntries({ title: job.title, subtitle: "", pages: pages.map((p) => ({ seq: p.seq, kind: p.kind, title: p.title, bullets: p.bullets, notes: p.notes })), pageCountNote: "", degraded: false, degradeReason: "" });
  const composePages: ComposePage[] = pages.map((p) => {
    let title = p.title;
    const bullets = [...p.bullets];
    if (p.kind === "toc") {
      // 目录条目**现算**, 不用模型写的那份(模型写的常与正文标题对不上)
      title = p.title || "目录";
      bullets.length = 0;
      bullets.push(...toc);
    }
    return {
      seq: p.seq, kind: p.kind, title, bullets, notes: p.notes,
      // 只有 content 页带配图: 封面/章节页的配图在 python 侧走 band 版式, 不占正文列
      imagePath: p.imageRel ? absFromRel(p.imageRel) : "",
      imageLayout: p.imageLayout,
    };
  });

  const r = await composePptx({
    userId: input.userId, jobId: job.id, mode: input.mode, title: job.title || job.topic,
    pages: composePages, theme, nameSuffix: input.nameSuffix,
    onProgress: async (done, total, stage) => {
      await setStatus(job.id, job.status === "done" ? "done" : "rendering", {
        exportProgress: Math.min(98, Math.round((done / Math.max(1, total)) * 90) + 5),
        stage: `导出: ${stage} ${done}/${total}`,
      }).catch(() => null);
    },
  });

  if (!r.ok) {
    await setStatus(job.id, job.status === "done" ? "done" : "rendering", {
      exportStatus: "failed", exportError: r.error, stage: "导出失败",
    });
    return { ok: false, error: r.error };
  }

  const notes = [...r.warnings];
  if (r.overflows.length) {
    // 溢出**不阻断导出** —— 但必须告诉用户哪几页字太多, 否则他在 PPT 里才发现
    notes.push(`版面可能溢出: ${r.overflows.map((o) => `第 ${o.seq} 页(超 ${o.overBy.toFixed(1)} 英寸)`).join(", ")}`);
  }
  if (r.missingImages.length) notes.push(`以下页的配图文件缺失: ${r.missingImages.join(", ")}`);
  const degraded = pages.filter((p) => p.imageSource === "placeholder").length;
  if (degraded) notes.push(`${degraded} 页的配图是本地生成的示意图(非 AI 生图)`);

  await setStatus(job.id, "done", {
    stage: "导出完成", progress: 100,
    exportStatus: "done", exportProgress: 100, exportRel: r.rel, exportError: "",
  });
  return { ok: true, rel: r.rel, absPath: r.absPath, slides: r.slides, warnings: notes, overflows: r.overflows };
}

// ════════════════════ ⑦ 中断后恢复 ════════════════════

/**
 * 扫出"上次没跑完"的任务。
 *
 * 判据是 status ∈ (scripting, rendering) —— 这两个中间态只在**执行期间**存在,
 * 服务正常收尾时一定会被改成 scripted/done/failed。所以启动时还在这两态的行,
 * 就是进程被杀留下的。不能用 updated_at 超时来猜(长跑的正常任务也会超时)。
 */
export async function listInterruptedJobs(limit = 50): Promise<Array<{ jobId: string; userId: string; status: JobStatus; stage: string; updatedAt: string }>> {
  const r = await pool.query(
    `select id, user_id, status, stage, updated_at from ppt_jobs
      where status = any($1::text[]) order by updated_at desc limit $2`,
    [RESUMABLE_STATUSES, Math.min(200, Math.max(1, limit))]);
  return r.rows.map((row: Record<string, any>) => ({
    jobId: String(row.id), userId: String(row.user_id), status: row.status as JobStatus,
    stage: String(row.stage ?? ""), updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/**
 * 恢复一个任务: 只补**还没脚本的页**, 已脚本的原样保留。
 *
 * 为什么不是"整份重跑": 用户可能已经手工改过前面几页了, 重跑会把这些改掉 ——
 *   那比"没有恢复功能"更糟(用户以为丢了工作)。
 * 恢复后任务回到 scripted, 用户可以继续配图/导出。
 */
export async function recoverJob(input: {
  userId: string; jobId: string;
  callJson?: Parameters<typeof generateScriptBatch>[0]["callJson"];
  shouldStop?: () => boolean | Promise<boolean>;
}): Promise<{ ok: boolean; recovered: number; skipped: number; total: number; error?: string }> {
  const job = await getJob(input.userId, input.jobId);
  if (!job) return { ok: false, recovered: 0, skipped: 0, total: 0, error: "任务不存在" };
  const pages = await listPages(input.userId, input.jobId);
  if (!pages.length) return { ok: false, recovered: 0, skipped: 0, total: 0, error: "没有页面可恢复" };

  // "还没脚本"的判据是 status='draft' 且 notes 为空 —— 只看 status 会漏掉
  //   "脚本写了一半就被杀"的页(notes 有值但 status 还停在 draft 的那种写路径)
  const pending = pages.filter((p) => p.status === "draft" && !p.notes.trim());
  const skipped = pages.length - pending.length;
  if (!pending.length) {
    await setStatus(job.id, "scripted", { stage: "无需恢复(所有页已有脚本)", progress: 70 });
    return { ok: true, recovered: 0, skipped, total: pages.length };
  }

  await setStatus(job.id, "scripting", { stage: `恢复中 0/${pending.length}`, progress: 30, error: "" });
  let done = 0;
  const r = await generateScriptBatch({
    pages: pending.map((p) => ({ seq: p.seq, kind: p.kind, title: p.title, bullets: p.bullets, notes: p.notes })),
    topic: job.topic || job.title,
    maxBullets: job.maxBullets,
    shouldStop: input.shouldStop,
    callJson: input.callJson,
    onPage: async (s) => {
      await writePageScript(job.id, s);
      done++;
      await setStatus(job.id, "scripting", { stage: `恢复中 ${done}/${pending.length}`, progress: 30 + Math.round((done / pending.length) * 40) });
    },
  });
  await setStatus(job.id, "scripted", {
    stage: `已恢复(${done} 页补齐, ${skipped} 页原有)`, progress: 70,
  });
  return { ok: true, recovered: r.scripts.length, skipped, total: pages.length };
}

/** 全量恢复(服务启动时调): 扫所有僵尸任务并逐个恢复 */
export async function recoverAllInterrupted(input: {
  callJson?: Parameters<typeof generateScriptBatch>[0]["callJson"];
  limit?: number;
} = {}): Promise<{ scanned: number; recovered: number; failed: number }> {
  const jobs = await listInterruptedJobs(input.limit);
  let recovered = 0, failed = 0;
  for (const j of jobs) {
    const r = await recoverJob({ userId: j.userId, jobId: j.jobId, callJson: input.callJson }).catch(() => ({ ok: false }));
    if (r.ok) recovered++; else failed++;
  }
  return { scanned: jobs.length, recovered, failed };
}

// ════════════════════ 删除 ════════════════════

/**
 * 删除任务。
 *
 * 只删**库里的行**(页面/版本/任务靠外键级联) —— 磁盘任务目录留着。
 * 为什么: 任务目录里可能有用户还没导出的中间产物, 而删除是不可逆的;
 *   目录由运维按 <DATA_DIR>/ppt-tasks 清理(与 viz/empirical 的任务目录同一口径)。
 */
export async function deleteJob(userId: string, jobId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await pool.query(`delete from ppt_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  return r.rowCount ? { ok: true } : { ok: false, error: "任务不存在" };
}

/** 诊断信息(界面上"这个工作台在这台机器上能用吗") */
export async function diagnose(): Promise<{
  python: PptPythonCapability; taskRoot: string; interrupted: number;
}> {
  const python = await probeCapability(true);
  const jobs = await listInterruptedJobs(200).catch(() => []);
  return { python, taskRoot: taskDir("<userId>", "<jobId>").replace(/[^\\/]*[\\/][^\\/]*$/, ""), interrupted: jobs.length };
}

async function fileExists(p: string): Promise<boolean> {
  try { const fs = await import("node:fs/promises"); await fs.access(p); return true; } catch { return false; }
}
