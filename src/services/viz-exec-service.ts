// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-exec-service.ts — SocialSci P0-4: 科研绘图 Python 执行引擎(viz_runner.py)
// 参照 empirical-service.spawnPythonTask 范式(venv + 任务目录 + input/result.json)
// 产物: data/viz-files/{userId}/{hash}.png + .svg(svg 可再编辑)
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PYTHON = process.env.EMPIRICAL_PYTHON || process.env.PYTHON || "python";
const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "viz_runner.py");
const TASKS_DIR = path.join(os.tmpdir(), "viz-tasks");
const VIZ_FILES_DIR = path.join(process.env.SAG_ROOT || process.cwd(), "data", "viz-files");

export interface VizExecResult {
  ok: boolean;
  error?: string;
  summary?: string;
  columns?: Array<{ name: string; type: string; [k: string]: unknown }>;
}

/** 数据行 → CSV(内存构造, 防注入: 字段一律 CSV 转义) */
export function rowsToCsv(columnOrder: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columnOrder.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  return lines.join("\n");
}

/** 数据摘要(结构安全校验同 empirical: 列名白名单) */
export function validateColumns(columnOrder: string[]): string | null {
  const colRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const DANGEROUS = new Set(["__import__", "eval", "exec", "system", "open", "compile", "globals", "locals", "subprocess", "os"]);
  for (const c of columnOrder) {
    if (!colRe.test(c) || DANGEROUS.has(c)) {
      return `列名不合法: ${String(c).slice(0, 40)} (仅允许字母/下划线/数字且非危险名)`;
    }
  }
  return null;
}

/** 危险代码黑名单(LLM 生成的绘图代码执行前拦截 → RCE 防线) */
const DANGER_CODE = /\b(__import__|subprocess|os\.system|os\.popen|os\.remove|os\.unlink|shutil\.rmtree|eval\s*\(|exec\s*\(|open\s*\(\s*['"]|pickle\.load|yaml\.load\s*\([^)]*Loader\s*=\s*[^)]*Full)/;
export function validateChartCode(code: string): string | null {
  if (code.length > 30_000) return "绘图代码过长(>30K)";
  if (DANGER_CODE.test(code)) return "代码含被禁用的危险调用(文件/进程/执行类)";
  return null;
}

function hashOf(s: string): string { return createHash("sha256").update(s).digest("hex").slice(0, 12); }

/** 把任务目录产物落到持久目录 data/viz-files/{userId}/ */
function persistArtifacts(userId: string, taskDir: string): { pngRel: string; svgRel: string } {
  const userDir = path.join(VIZ_FILES_DIR, userId);
  mkdirSync(userDir, { recursive: true });
  const pngHash = hashOf(`png:${userId}:${randomUUID()}`);
  const svgHash = hashOf(`svg:${userId}:${randomUUID()}`);
  const pngName = `${pngHash}.png`;
  const svgName = `${svgHash}.svg`;
  copyFileSync(path.join(taskDir, "output.png"), path.join(userDir, pngName));
  if (existsSync(path.join(taskDir, "output.svg"))) {
    copyFileSync(path.join(taskDir, "output.svg"), path.join(userDir, svgName));
  }
  return {
    pngRel: `data/viz-files/${userId}/${pngName}`,
    svgRel: `data/viz-files/${userId}/${svgName}`,
  };
}

function run(taskDir: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(PYTHON, [RUNNER, taskDir], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      cwd: process.env.SAG_ROOT || process.cwd(),
    }, (_error) => {
      const resultPath = path.join(taskDir, "result.json");
      if (existsSync(resultPath)) {
        try {
          const r = JSON.parse(readFileSync(resultPath, "utf-8"));
          resolve(r.ok ? { ok: true } : { ok: false, error: r.error ?? "执行失败" });
          return;
        } catch { /* 解析失败走下方 */ }
      }
      resolve({ ok: false, error: "Python 执行无结果(超时/崩溃)" });
    });
  });
}

/** 数据分析: 上传 CSV → 概要(供 Agent 决定图表) */
export async function analyzeData(userId: string, csv: string, columnOrder: string[]): Promise<{ ok: boolean; error?: string; summary?: string; columns?: unknown[] }> {
  const colErr = validateColumns(columnOrder);
  if (colErr) return { ok: false, error: colErr };
  const taskId = randomUUID();
  const taskDir = path.join(TASKS_DIR, taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "data.csv"), csv, "utf-8");
  writeFileSync(path.join(taskDir, "input.json"), JSON.stringify({ kind: "analyze" }), "utf-8");
  const r = await run(taskDir);
  if (!r.ok) return r;
  const res = JSON.parse(readFileSync(path.join(taskDir, "result.json"), "utf-8")) as VizExecResult;
  rmSync(taskDir, { recursive: true, force: true });
  return { ok: true, summary: res.summary, columns: res.columns };
}

/** 执行绘图代码 → png+svg 落盘, 返回相对路径; spec=期刊规范(尺寸mm/dpi/字号/线宽, 闭源 VizView 对齐) */
export async function renderChart(userId: string, code: string, csv?: string, columnOrder: string[] = [], spec: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; pngRel?: string; svgRel?: string }> {
  const codeErr = validateChartCode(code);
  if (codeErr) return { ok: false, error: codeErr };
  const taskId = randomUUID();
  const taskDir = path.join(TASKS_DIR, taskId);
  mkdirSync(taskDir, { recursive: true });
  if (csv) {
    writeFileSync(path.join(taskDir, "data.csv"), csv, "utf-8");
    const colErr = validateColumns(columnOrder);
    if (colErr) { rmSync(taskDir, { recursive: true, force: true }); return { ok: false, error: colErr }; }
  }
  writeFileSync(path.join(taskDir, "input.json"), JSON.stringify({ kind: "chart", code, spec }), "utf-8");
  const r = await run(taskDir);
  if (!r.ok) {
    const resPath = path.join(taskDir, "result.json");
    const detail = existsSync(resPath) ? (JSON.parse(readFileSync(resPath, "utf-8")).error ?? "") : "";
    rmSync(taskDir, { recursive: true, force: true });
    return { ok: false, error: detail || r.error };
  }
  try {
    const arts = persistArtifacts(userId, taskDir);
    rmSync(taskDir, { recursive: true, force: true });
    return { ok: true, ...arts };
  } catch (e) {
    rmSync(taskDir, { recursive: true, force: true });
    return { ok: false, error: `产物落盘失败: ${String(e).slice(0, 120)}` };
  }
}

/** 静态文件读取(鉴权后由路由调用): 相对路径(viz-files/... 或 data/viz-files/...) → buffer */
export function readVizFile(relPath: string): Buffer | null {
  const clean = relPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const abs = path.join(process.env.SAG_ROOT || process.cwd(), clean);
  if (!existsSync(abs)) return null;
  return readFileSync(abs);
}

export function vizFilesRoot(): string { return VIZ_FILES_DIR; }
