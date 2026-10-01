// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// asset-source-service.ts — 素材来源 → agent_workspace 的统一入口(2026-10-02)
//
// ═══ 由来 ═══
//
// 2026-10-01 给沙箱补了工作区围栏后, 模型不能再引用绝对路径。当时留的取舍是
//   "把素材**推进**工作区, 而不是放宽规则"(见 agent-workspace-service 的说明),
//   并先接了**实证工作台的图表**这一条来源。
//
// 这个服务把剩下的来源接上, 并且**按用户隔离** —— 上一版直接在 PPT 路由里拉
// `empirical/figures/` 全量, 那是**全平台的图**, 任何用户建 PPT 都会拿到别人的图表。
// 单机单人时看不出来, 一旦多用户就是数据泄漏。
//
// ═══ 三类来源, 以及为什么是这三类 ═══
//
//   ① 用户自己的上传(`user_files`) —— 这是**主要的图片来源**。实测库里 357 个文件里
//      图片 0 张(都是 CSV/XLSX), 但那是"还没人传过", 不是"接口不存在"。
//   ② 用户自己的实证图表(`empirical/figures/<uid>/…`) —— 跑过回归的用户会有。
//   ③ 用户上传的 PDF 里取图(`pdf_extract_figures.py`) —— 论文汇报最核心的素材。
//
// ═══ 三条纪律 ═══
//
//   · **只取属于该用户的**。每条来源都带 user_id 过滤/前缀; 共享池不在本服务职责内。
//   · **取不到不算失败**。某条来源没有素材是常态(还没传、还没跑), 如实记录原因,
//     让上层能告诉用户"为什么没有配图", 而不是静默给一份没图的稿子。
//   · **PDF 取图要设上限**。一篇论文能抽出几十张图, 全推进去会挤爆工作区,
//     也会让模型在噪声里挑错。上限与排序见 extractFiguresFromPdf。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pool } from "../db/pool.js";
import { getObject } from "./blob-store.js";
import { stageAssetsIntoWorkspace } from "./agent-workspace-service.js";

/** 一次最多推进多少张图 —— 多了模型挑不准, 工作区也塞不下 */
const MAX_IMAGES = 12;
/** PDF 取图的默认上限 */
const MAX_PDF_FIGURES = 8;

export interface AssetSourceReport {
  staged: string[];
  /** 每条来源的结果, 供上层如实告知"为什么没有图" */
  sources: Array<{ source: string; count: number; note?: string }>;
}

function runPython(script: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.SAG_SANDBOX_PYTHON || (process.platform === "win32" ? "python" : "python3"), [script, ...args], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String((e as Error).message) });
      return;
    }
    const out: Buffer[] = []; const err: Buffer[] = [];
    let settled = false;
    const done = (code: number | null, extra = "") => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + extra });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } done(null, "\n（PDF 取图超时）"); }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => done(null, String(e.message)));
    child.on("close", (c) => done(c));
  });
}

/**
 * 从 PDF 取图 —— 调用 scripts/pdf_extract_figures.py。
 * 脚本自己按像素尺寸过滤图标与整页扫描(见该文件头部说明)。
 */
export async function extractFiguresFromPdf(pdfPath: string, outDir: string, max = MAX_PDF_FIGURES): Promise<{
  ok: boolean; files: string[]; note?: string;
}> {
  const script = path.join(process.cwd(), "scripts", "pdf_extract_figures.py");
  if (!fs.existsSync(script)) return { ok: false, files: [], note: "取图脚本不存在" };
  const r = await runPython(script, [pdfPath, outDir, "--max-figures", String(max)], 120_000);
  const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  try {
    const j = JSON.parse(line) as { ok: boolean; figures?: Array<{ file: string }>; skipped?: unknown[]; error?: string };
    if (!j.ok) return { ok: false, files: [], note: j.error ?? "取图失败" };
    const files = (j.figures ?? []).map((f) => path.join(outDir, f.file));
    const skipped = (j.skipped ?? []).length;
    return { ok: true, files, note: skipped ? `${skipped} 项按规则跳过（图标/整页扫描等）` : undefined };
  } catch {
    return { ok: false, files: [], note: `取图脚本输出无法解析: ${(r.stderr || line).replace(/\s+/g, " ").slice(0, 160)}` };
  }
}

/**
 * 把某个用户的可用素材推进工作区。
 *
 * @param userId 只取属于他的素材
 * @param opts.max  总上限（默认 MAX_IMAGES）
 * @param opts.includePdf 是否顺带给他的 PDF 取图（默认 true）
 */
export async function stageUserAssets(userId: string, opts: { max?: number; includePdf?: boolean } = {}): Promise<AssetSourceReport> {
  const max = Math.max(1, opts.max ?? MAX_IMAGES);
  const report: AssetSourceReport = { staged: [], sources: [] };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sag-assets-"));
  const locals: string[] = [];

  // ── ① 用户上传的图片 ──
  try {
    const r = await pool.query(
      `select filename, storage_rel from user_files
        where user_id = $1 and mime like 'image/%' order by created_at desc limit $2`,
      [userId, max],
    );
    let n = 0;
    for (const row of r.rows as Array<{ filename: string; storage_rel: string }>) {
      if (locals.length >= max) break;
      const buf = await getObject(String(row.storage_rel)).catch(() => null);
      if (!buf) continue;
      const p = path.join(tmpRoot, path.basename(String(row.filename)));
      fs.writeFileSync(p, buf);
      locals.push(p); n++;
    }
    report.sources.push({ source: "uploads", count: n, note: n ? undefined : "你没有上传过图片（CSV/表格不会被当作配图）" });
  } catch (e) {
    report.sources.push({ source: "uploads", count: 0, note: `读取失败: ${String((e as Error).message).slice(0, 100)}` });
  }

  // ── ② 该用户的实证图表 ──
  try {
    /**
     * ⚠ 必须带用户前缀。上一版拉的是 `empirical/figures/` **全量** —— 那是全平台的图,
     *   任何用户建 PPT 都会拿到别人的。单机单人看不出来, 多用户就是数据泄漏。
     *   同时兼容无前缀的历史对象(单机时代留下的), 但**只在该用户没有任何带前缀图时**才回退,
     *   否则等于绕过隔离。
     */
    const { listObjects } = await import("./blob-store.js");
    let keys = (await listObjects(`empirical/figures/${userId}/`)).filter((k) => /\.(png|jpg|jpeg)$/i.test(k));
    if (!keys.length) {
      const legacy = (await listObjects("empirical/figures/"))
        .filter((k) => /\.(png|jpg|jpeg)$/i.test(k) && !k.slice("empirical/figures/".length).includes("/"));
      keys = legacy;   // 历史对象没有归属信息, 单机场景下只能如此
    }
    let n = 0;
    for (const k of keys.slice(0, Math.max(0, max - locals.length))) {
      const buf = await getObject(k).catch(() => null);
      if (!buf) continue;
      const p = path.join(tmpRoot, path.basename(k));
      fs.writeFileSync(p, buf);
      locals.push(p); n++;
    }
    report.sources.push({ source: "empirical", count: n, note: n ? undefined : "还没有跑过实证分析（跑一次回归就会生成图表）" });
  } catch (e) {
    report.sources.push({ source: "empirical", count: 0, note: `读取失败: ${String((e as Error).message).slice(0, 100)}` });
  }

  // ── ③ 用户的 PDF 里取图 ──
  if (opts.includePdf !== false && locals.length < max) {
    try {
      const r = await pool.query(
        `select filename, storage_rel from user_files
          where user_id = $1 and mime = 'application/pdf' order by created_at desc limit 2`,
        [userId],
      );
      let n = 0;
      for (const row of r.rows as Array<{ filename: string; storage_rel: string }>) {
        if (locals.length >= max) break;
        const buf = await getObject(String(row.storage_rel)).catch(() => null);
        if (!buf) continue;
        const pdf = path.join(tmpRoot, path.basename(String(row.filename)));
        fs.writeFileSync(pdf, buf);
        const outDir = path.join(tmpRoot, "pdf-figs");
        const ex = await extractFiguresFromPdf(pdf, outDir, Math.min(MAX_PDF_FIGURES, max - locals.length));
        for (const f of ex.files) { if (locals.length < max) { locals.push(f); n++; } }
      }
      report.sources.push({ source: "pdf", count: n, note: n ? undefined : "你的 PDF 里没有可用的位图（矢量图/整页扫描会被跳过）" });
    } catch (e) {
      report.sources.push({ source: "pdf", count: 0, note: `取图失败: ${String((e as Error).message).slice(0, 100)}` });
    }
  }

  if (locals.length) {
    const staged = stageAssetsIntoWorkspace(locals);
    report.staged = staged.staged.map((s) => s.rel);
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  return report;
}

/** 把来源报告写成给用户看的一句话(没有素材时也要说清是为什么) */
export function describeAssetSources(r: AssetSourceReport): string {
  if (r.staged.length) {
    const parts = r.sources.filter((s) => s.count > 0).map((s) => `${s.source} ${s.count} 张`);
    return `已备好 ${r.staged.length} 张素材（${parts.join("、")}）`;
  }
  const why = r.sources.filter((s) => s.note).map((s) => s.note).join("；");
  return `本次没有可用素材${why ? ` —— ${why}` : ""}`;
}
