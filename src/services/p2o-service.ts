// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// p2o-service.ts — V395-10: PDF2Obsidian 任务服务（持久化 + 异步管线）
// 任务落库 agent_p2o_tasks（重启不丢）; 上传 PDF 落盘 / URL 下载 / base64 解码
// 管线后台异步执行（onStep 回调实时更新步骤进度）; 产物路径落 result 供前端读取
import { pool } from "../db/pool.js";
import path from "node:path";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** 服务端受控目录（临时目录）— pdfPath 用户直传仅允许落在此处 */
export function isControlledPdfPath(pdfPath: string): boolean {
  const target = path.resolve(pdfPath);
  const tmp = path.resolve(tmpdir());
  // Windows 路径大小写不敏感 → 统一小写比较
  return target.toLowerCase().startsWith(tmp.toLowerCase() + path.sep);
}

/** 6 阶段管线（vendor importPdf 事件序列） */
export const P2O_STEPS = ["upload", "mineru", "normalize", "translate", "obsidian_export", "quality_check"];

export interface P2oTaskRecord {
  id: string;
  fileName: string;
  pdfPath: string;
  source: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  steps: Array<{ step: string; status: string; message?: string }>;
  error?: string;
  result?: {
    slug: string;
    originalNotePath?: string;
    translatedNotePath?: string;
    indexNotePath?: string;
    databaseNotePath?: string;
    reading?: { summaryPath?: string; termsPath?: string; qaPath?: string };
    configSummary?: {
      mineruMode?: string;
      mineruBackend?: string;
      translationEnabled?: boolean;
      translationSkipped?: boolean;
      translationProvider?: string;
      translationModel?: string;
      readingAssetsEnabled?: boolean;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

const STEP_WEIGHTS: Record<string, number> = { upload: 5, mineru: 35, normalize: 15, translate: 20, obsidian_export: 15, quality_check: 10 };

function mapRow(row: any): P2oTaskRecord {
  return {
    id: row.id,
    fileName: row.file_name,
    pdfPath: row.pdf_path,
    source: row.source,
    status: row.status,
    progress: Number(row.progress || 0),
    steps: Array.isArray(row.steps) ? row.steps : [],
    error: row.error || undefined,
    result: row.result || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 任务列表（最新在前） */
export async function listP2oTasks(limit = 50): Promise<P2oTaskRecord[]> {
  const r = await pool.query("select * from agent_p2o_tasks order by created_at desc limit $1", [limit]);
  return r.rows.map(mapRow);
}

/** 单任务 */
export async function getP2oTask(id: string): Promise<P2oTaskRecord | null> {
  const r = await pool.query("select * from agent_p2o_tasks where id = $1::uuid", [id]);
  return r.rows.length > 0 ? mapRow(r.rows[0]) : null;
}

/** 删除任务（仅删记录 + 本地 PDF; 不删 vault 笔记产物） */
export async function deleteP2oTask(id: string): Promise<boolean> {
  const task = await getP2oTask(id);
  if (!task) return false;
  await pool.query("delete from agent_p2o_tasks where id = $1", [id]);
  // 清理本地 PDF（临时目录文件, 失败忽略）
  void fs.unlink(task.pdfPath).catch(() => {});
  return true;
}

/** 创建任务并落库（立即返回; 管线后台执行）
 * 安全: pdfPath 仅接受服务端受控目录（临时目录）内的文件 —— 拒绝用户直传任意路径（防任意文件读取） */
export async function createP2oTask(input: {
  fileName: string;
  pdfPath: string;
  source?: string;
  runAsync?: boolean;
}): Promise<P2oTaskRecord> {
  if (input.source !== "upload" && !isControlledPdfPath(input.pdfPath)) {
    throw new Error("pdfPath 仅允许服务端临时目录内的文件（请用 base64 上传或 URL 导入）");
  }
  const r = await pool.query(
    `insert into agent_p2o_tasks (file_name, pdf_path, source, status, progress, steps, updated_at)
     values ($1, $2, $3, 'queued', 0, $4::jsonb, now()) returning *`,
    [input.fileName, input.pdfPath, input.source || "upload", JSON.stringify(P2O_STEPS.map((s) => ({ step: s, status: "pending" })))]
  );
  const task = mapRow(r.rows[0]);
  // 默认后台执行（不阻塞创建响应）
  if (input.runAsync !== false) {
    void runP2oPipeline(task.id).catch((e: any) => console.error(`[p2o] 任务 ${task.id} 管线异常: ${e?.message?.slice(0, 100)}`));
  }
  return task;
}

/** 更新任务字段 */
async function updateTask(id: string, patch: Partial<P2oTaskRecord>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.progress !== undefined) add("progress", patch.progress);
  if (patch.steps !== undefined) add("steps", JSON.stringify(patch.steps));
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.result !== undefined) add("result", JSON.stringify(patch.result));
  if (sets.length === 0) return;
  params.push(id);
  await pool.query(`update agent_p2o_tasks set ${sets.join(", ")}, updated_at = now() where id = $${params.length}`, params);
}

/**
 * 后台执行完整管线
 * 步骤进度经 onStep 实时落库（前端轮询/SSE 可见）
 */
export async function runP2oPipeline(taskId: string): Promise<P2oTaskRecord> {
  const task = await getP2oTask(taskId);
  if (!task) throw new Error("任务不存在");
  const { importPdfWithP2O } = await import("./pdf2obsidian-adapter.js");
  // 初始: 步骤全 running 前先标记 upload running
  const steps = P2O_STEPS.map((s) => ({ step: s, status: s === "upload" ? "running" : "pending" }));
  await updateTask(taskId, { status: "running", steps, progress: 1, error: undefined });
  const seen = new Set<string>();
  const onStep = async (ev: { step: string; status: string; message?: string }) => {
    // vendor 事件可能重复/乱序 — 幂等合并
    if (seen.has(`${ev.step}:${ev.status}`)) return;
    seen.add(`${ev.step}:${ev.status}`);
    const latest = await getP2oTask(taskId);
    // 任务已终态（completed/failed）→ 不再覆盖（防管线返回后残留 onStep 事件把步骤改回旧态）
    if (!latest || latest.status === "completed" || latest.status === "failed") return;
    const merged = latest.steps.map((s) => {
      if (s.step !== ev.step) return s;
      return { step: ev.step, status: ev.status, message: ev.message };
    });
    // 进度 = 已完成步骤权重累加（含 skipped）
    const doneWeight = merged.reduce((acc, s) => acc + (["completed", "skipped", "failed"].includes(s.status) ? (STEP_WEIGHTS[s.step] || 0) : 0), 0);
    await updateTask(taskId, { steps: merged, progress: Math.min(99, Math.max(1, doneWeight)) });
  };
  const r = await importPdfWithP2O(task.pdfPath, { onStep: onStep as any });
  if (!r.ok) {
    const failedSteps = (await getP2oTask(taskId))?.steps || [];
    await updateTask(taskId, { status: "failed", progress: 99, error: r.error, steps: failedSteps.map((s) => s.status === "running" ? { ...s, status: "failed" } : s) });
    return getP2oTask(taskId) as Promise<P2oTaskRecord>;
  }
  // 成功: 补充阅读材料路径（摘要/术语表/问答 — 从 documentRoot 推导）
  const result = r.result as any;
  const readingAssetsEnabled = result?.configSummary?.readingAssetsEnabled === true;
  let reading: { summaryPath?: string; termsPath?: string; qaPath?: string } | undefined = undefined;
  if (readingAssetsEnabled && result?.slug) {
    const documentRoot = path.join("D:/Desktop/ov_import", "资本规范与引导、资本治理", result.slug);
    reading = {
      summaryPath: path.join(documentRoot, "摘要.md"),
      termsPath: path.join(documentRoot, "术语表.md"),
      qaPath: path.join(documentRoot, "问答.md"),
    };
    // V395-12: skill 领域引擎 — 用自研 pdf2obsidian skill 的领域 prompt 重生成三产物
    // （vendor 通用 prompt → 领域深度 prompt: 资本下乡 FIELD_CONTEXT/引用编号/四维问答）
    if (process.env.P2O_DOMAIN_ENGINE !== "0") {
      try {
        const { p2oDomainEngine } = await import("./p2o-domain-engine.js");
        const originalPath = result.originalNotePath || path.join(documentRoot, `${result.slug}.original.md`);
        const regenerated = await p2oDomainEngine.regenerateDomainAssets({
          slug: result.slug,
          originalMarkdownPath: originalPath,
          documentRoot,
        });
        if (regenerated.summaryPath) reading.summaryPath = regenerated.summaryPath;
        if (regenerated.termsPath) reading.termsPath = regenerated.termsPath;
        if (regenerated.qaPath) reading.qaPath = regenerated.qaPath;
        console.log(`[p2o] V395-12 领域引擎重生成: ${result.slug}${regenerated.skipped?.length ? ` (跳过: ${regenerated.skipped.join("; ")})` : ""}`);
      } catch (e: any) {
        console.warn(`[p2o] 领域引擎失败(保留vendor产物): ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  const finalResult = { ...result, reading };
  // 完成: 所有步骤统一置 completed（含 skipped 保持, 未收到事件的步骤也覆盖 — 防 onStep 乱序/缺事件）
  const finalSteps = P2O_STEPS.map((s) => ({ step: s, status: "completed" as const }));
  await updateTask(taskId, {
    status: "completed", progress: 100, error: undefined,
    result: finalResult,
    steps: finalSteps,
  });
  return getP2oTask(taskId) as Promise<P2oTaskRecord>;
}

/** 重试失败任务（重新跑管线; 旧 PDF 仍在） */
export async function retryP2oTask(id: string): Promise<P2oTaskRecord | null> {
  const task = await getP2oTask(id);
  if (!task) return null;
  if (task.status !== "failed") throw new Error("仅失败任务可重试");
  void runP2oPipeline(id).catch((e: any) => console.error(`[p2o] 重试任务 ${id} 管线异常: ${e?.message?.slice(0, 100)}`));
  return { ...task, status: "running" };
}

/** 保存上传 PDF 到临时目录（返回落盘路径） */
export async function saveUploadedPdf(buffer: Buffer, fileName: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "p2o-up-"));
  const safeName = fileName.replace(/[^\w.\-一-龥]/g, "_").slice(-80);
  const pdfPath = path.join(dir, safeName.endsWith(".pdf") ? safeName : safeName + ".pdf");
  await fs.writeFile(pdfPath, buffer);
  return pdfPath;
}

/** 从 URL 下载 PDF（arXiv/DOI/直链 → 落盘; SSRF 防护: 仅允许公网地址） */
export async function downloadPdfFromUrl(url: string, maxBytes = 50 * 1024 * 1024): Promise<{ pdfPath: string; fileName: string }> {
  const { assertPublicUrl } = await import("./url-guard.js");
  await assertPublicUrl(url.trim());
  const res = await fetch(url.trim());
  if (!res.ok) throw new Error(`URL 下载失败 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  const dir = await fs.mkdtemp(path.join(tmpdir(), "p2o-dl-"));
  const urlName = decodeURIComponent(url.split("/").pop() || "source.pdf").replace(/[^\w.\-一-龥]/g, "_");
  const fileName = urlName.endsWith(".pdf") ? urlName : "source.pdf";
  const pdfPath = path.join(dir, fileName);
  await fs.writeFile(pdfPath, buf);
  return { pdfPath, fileName };
}

/** 读取 PDF 内容（返回流数据供 /pdf 预览; 缺失返回 null） */
export async function readPdfBytes(id: string): Promise<{ data: Buffer; fileName: string } | null> {
  const task = await getP2oTask(id);
  if (!task) return null;
  try {
    const data = await fs.readFile(task.pdfPath);
    return { data, fileName: task.fileName || "paper.pdf" };
  } catch { return null; }
}

/** 读取产物文件内容（原文/译文/论文信息/阅读材料/Bases） */
export async function readP2oArtifact(id: string, kind: string): Promise<{ content: string; path?: string } | { error: string }> {
  const task = await getP2oTask(id);
  if (!task || !task.result) return { error: "任务无产物" };
  const r = task.result;
  const paths: Record<string, string | undefined> = {
    original: r.originalNotePath,
    translated: r.translatedNotePath,
    index: r.indexNotePath,
    database: r.databaseNotePath,
    summary: r.reading?.summaryPath,
    terms: r.reading?.termsPath,
    qa: r.reading?.qaPath,
  };
  const p = paths[kind];
  if (!p) return { error: "该产物未生成（配置中可能已关闭）" };
  try {
    const content = await fs.readFile(p, "utf8");
    return { content, path: p };
  } catch (e: any) {
    return { error: `读取失败: ${String(e?.message || e).slice(0, 100)}` };
  }
}

/** 配置读取（当前适配层配置快照） */
export async function getP2oConfig(): Promise<any> {
  const { buildP2OConfig } = await import("./pdf2obsidian-adapter.js");
  const data = buildP2OConfig();
  return { data, path: "", exists: true, valid: true, raw: JSON.stringify(data, null, 2) };
}

export const p2oService = {
  listP2oTasks,
  getP2oTask,
  createP2oTask,
  deleteP2oTask,
  retryP2oTask,
  runP2oPipeline,
  saveUploadedPdf,
  downloadPdfFromUrl,
  readPdfBytes,
  readP2oArtifact,
  getP2oConfig,
};
