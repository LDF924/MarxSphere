// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-exec-service.ts — SocialSci P0-4: 科研绘图 Python 执行引擎(viz_runner.py)
// 参照 empirical-service.spawnPythonTask 范式(venv + 任务目录 + input/result.json)
// 产物: viz-files/{userId}/{hash}.png + .svg(svg 可再编辑), 经 blob-store 落盘/读取
import "dotenv/config";
import { getObject, putObject } from "./blob-store.js";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PYTHON = process.env.EMPIRICAL_PYTHON || process.env.PYTHON || "python";
const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "viz_runner.py");
const TASKS_DIR = path.join(os.tmpdir(), "viz-tasks");

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
/**
 * 列名准入: **只拒绝真正会改变代码语义的字符**。
 *
 * 由来(2026-09-11 实测): 原实现要求列名匹配 ^[A-Za-z_][A-Za-z0-9_]*$ ——
 *   `地区`/`GDP(亿元)`/`2020年产值`/`变量1` 全被拒, 而社科数据几乎必然中文表头,
 *   于是每次渲染都返回"列名不合法", 自审 3 轮全废、最终 CHART_FAILED。
 *   列名来自**用户上传的真实文件**, 不是 LLM 编的参数, 没有"注入列名"的攻击面;
 *   真正的注入防线在 runner 侧(模块白名单 + os/sys 残桩)。
 *
 * 现在只禁: 换行/回车(会破坏 CSV 结构)、NUL、以及恰好等于危险内建名的列名。
 * 中文、括号、空格、数字开头一律放行。
 */
const DANGEROUS_COLUMNS = new Set([
  "__import__", "eval", "exec", "compile", "globals", "locals", "open", "system", "popen",
  "subprocess", "os", "sys", "import", "lambda", "class", "def", "return",
]);
export function validateColumns(columnOrder: string[]): string | null {
  for (const c of columnOrder) {
    const name = String(c ?? "");
    const bad = new RegExp("[\r\n\u0000]").test(name);
    if (bad) {
      return `列名含非法字符(换行/NUL): ${name.slice(0, 40)}`;
    }
    // 仅当列名被当作**代码标识符**直接书写时才危险; 这里只拦与内建同名的情况,
    //   且提示信息说明改成 df["列名"] 访问即可
    if (DANGEROUS_COLUMNS.has(name.trim())) {
      return `列名与代码关键字同名: ${name.slice(0, 40)} (请改用 df["${name}"] 形式访问)`;
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

/** 把任务目录产物落到持久存储(本地盘/共享卷/对象存储, 由 blob-store 决定) */
async function persistArtifacts(userId: string, taskDir: string): Promise<{ pngRel: string; svgRel: string }> {
  const pngHash = hashOf(`png:${userId}:${randomUUID()}`);
  const svgHash = hashOf(`svg:${userId}:${randomUUID()}`);
  const pngKey = `viz-files/${userId}/${pngHash}.png`;
  const svgKey = `viz-files/${userId}/${svgHash}.svg`;
  await putObject(pngKey, readFileSync(path.join(taskDir, "output.png")));
  if (existsSync(path.join(taskDir, "output.svg"))) {
    await putObject(svgKey, readFileSync(path.join(taskDir, "output.svg")));
  }
  // 返回**相对数据根的 key**(不再带 `data/` 前缀) —— 读取侧统一用 blob-store,
  // 它按同一规则归一化, 所以历史行(带 data/)与新行指向同一个对象。
  return { pngRel: pngKey, svgRel: svgKey };
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
  if (!r.ok) {
    // 失败也要清: 否则用户 CSV 永久留在临时目录(实测残留过 2026-09-06 的任务目录)
    rmSync(taskDir, { recursive: true, force: true });
    return r;
  }
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
    const arts = await persistArtifacts(userId, taskDir);
    rmSync(taskDir, { recursive: true, force: true });
    return { ok: true, ...arts };
  } catch (e) {
    rmSync(taskDir, { recursive: true, force: true });
    return { ok: false, error: `产物落盘失败: ${String(e).slice(0, 120)}` };
  }
}

export interface ResolvedJobData {
  csv: string;
  columnOrder: string[];
  fileName: string;
  rowCount: number;
  colCount: number;
}

const MAX_DATA_ROWS = 20_000;

/**
 * 数据来源统一入口(2026-09-11): fileId → 真实数据。
 * 前端上传走的 /files/upload 落 user_files, viz 侧此前只认 csv 字段 → fileId 被静默丢弃,
 * 绘图全程无数据(实测 11/11 job csv=null, analyze_data 恒 skipped, 图是 LLM 编的示意数据)。
 * 行数/字符数设上限: LLM 只看概要, 但表要真, 超限宁可截断也不退回示意。
 */
/**
 * 单行 CSV 按分隔符切分(支持引号包裹与 "" 转义) —— rowsToCsv 写出的格式必须能原样读回。
 * 与 viz-job-service.ts 的 parseCsvLine 同语义; 区别是这里的分隔符可能是制表符。
 */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export async function resolveJobData(userId: string, fileId: string): Promise<ResolvedJobData | null> {
  const { pool } = await import("../db/pool.js");
  const rawId = String(fileId).replace(/^file_/, "");
  try {
    const r = await pool.query(
      `select storage_rel, filename from user_files where id=$1 and user_id=$2`,
      [rawId, userId]);
    if (!r.rows.length) return null;
    const buf = await getObject(String(r.rows[0].storage_rel ?? ""));
    if (!buf) return null;
    // 先按行读齐再截断行数 —— 不能先按字符切:
    //   slice(字符数) 会把最后一条记录切在半路, 引号字段被撕成两半 →
    //   pandas 报 "EOF inside string"(实测), 甚至把半个表头当成列名。
    //   中文 CSV 下 200 万字符 ≈ 800 万字节, 原来的"字符上限"也拦不住内存。
    const all = buf.toString("utf-8").split(/\r?\n/);
    const lines: string[] = [];
    for (const l of all) {
      if (!l.trim()) continue;
      lines.push(l);
      if (lines.length > MAX_DATA_ROWS) break;   // 只要表头 + MAX_DATA_ROWS 行, 多的不读
    }
    if (lines.length < 2) return null;
    const delim = lines[0].includes("\t") ? "\t" : lines[0].includes(",") ? "," : "\t";
    // CSV 要按引号语义切分: Excel 导出的 `"北京, 直辖市"` 用裸 split 会被剁成两列,
    //   而界面上仍标着"真实数据"(实测: gdp 列变成 '"首都' / '直辖市"')
    const split = (l: string) => splitCsvLine(l, delim);
    const columnOrder = split(lines[0]).map((c) => c.replace(/^﻿/, ""));
    const rows = lines.slice(1, MAX_DATA_ROWS + 1).map(split);
    return {
      csv: rowsToCsv(columnOrder, rows),
      columnOrder,
      fileName: String(r.rows[0].filename ?? ""),
      rowCount: rows.length,
      colCount: columnOrder.length,
    };
  } catch (e) {
    console.error("[viz-exec] 数据文件读取失败", String(e).slice(0, 160));
    return null;
  }
}

/**
 * 用户可选作绘图数据源的已上传文件(数据源选择器用)
 */
export async function listDataFiles(userId: string): Promise<Array<{ fileId: string; fileName: string; rowCount: number; colCount: number }>> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query(
    `select id, filename, profile from user_files where user_id=$1 order by created_at desc limit 50`, [userId]);
  return r.rows
    .map((row: Record<string, unknown>) => {
      const p = (row.profile ?? {}) as Record<string, unknown>;
      const cols = Array.isArray(p.columns) ? p.columns.length : Number(p.colCount ?? p.columnCount ?? 0);
      return {
        fileId: String(row.id),
        fileName: String(row.filename ?? ""),
        rowCount: Number(p.rowCount ?? p.lines ?? 0),
        colCount: Number.isFinite(cols) ? cols : 0,
      };
    })
    .filter((f) => f.colCount > 0); // 只有表格类文件能当绘图数据源
}

/** 静态文件读取(鉴权后由路由调用): 只允许读本用户 viz 产物目录下的对象
 *  原来仅凭路由那边的 `rel.includes('/'+uid+'/')` 字符串校验, 且不限根目录 ——
 *  任一方将来改动就会变成任意对象读取。这里把"只在 viz-files/<userId>/ 下"钉死。
 *  经 blob-store 读取 → 本地盘 / 共享卷 / 对象存储三种部署形态同一套代码。 */
export async function readVizFile(relPath: string, userId?: string): Promise<Buffer | null> {
  if (!userId) return null;
  const clean = relPath.replace(/^\/+/, "").replace(/\.\./g, "").replace(/\\/g, "/");
  // 兼容两种存法: 历史行带 `data/viz-files/...`, 新行是 `viz-files/...`
  const marker = `/viz-files/${userId}/`;
  const idx = clean.indexOf(marker);
  if (idx < 0) return null;
  const name = clean.slice(idx + marker.length);
  // 只接受单层文件名, 不允许再带路径分隔或盘符
  if (!name || name.includes("/") || name.includes(":")) return null;
  return getObject(`viz-files/${userId}/${name}`);
}

/** 产物目录的数据根相对 key(诊断用; 实际读写走 blob-store) */
export function vizFilesRoot(): string {
  return "viz-files";
}
