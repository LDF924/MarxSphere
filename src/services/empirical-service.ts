// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-service.ts — 实证研究执行服务（V348+）
// 数据上传 → spawn Python 沙箱(独立 venv, 不依赖 MCP 池) → 结果回传 + 持久化
// 安全: 复用 sag_execute_code 的防护思路(独立 venv 隔离 + 参数白名单方法 + 大小守卫)
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pool } from "../db/pool.js";

// 独立实证 venv（与 cognee 沙箱完全隔离, 不动生产环境）
const PYTHON = process.env.EMPIRICAL_PYTHON || "";
const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "empirical_runner.py");
const TASKS_DIR = path.join(os.tmpdir(), "empirical-tasks");
const TASK_TTL_MS = 30 * 60_000; // 30 分钟清理

interface TaskRecord {
  status: "running" | "done" | "error";
  createdAt: number;
  result?: unknown;
  error?: string;
}

const tasks = new Map<string, TaskRecord>();

// 定期清理过期任务（V4xx: 跳过 status==="running" 的任务 — 运行中任务未过期不清理, 防执行中结果丢失）
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.status === "running") continue;
    if (now - t.createdAt > TASK_TTL_MS) tasks.delete(id);
  }
}, 5 * 60_000).unref?.();

/** 提交实证分析任务: 同步 spawn 执行, 结果落内存 */
export async function runEmpirical(
  input: { data: { columnOrder: string[]; rows: unknown[][] }; method: string; params: Record<string, unknown> }
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  return spawnPythonTask("empirical_runner.py", input as any);
}

/** V380: 泛化 python 任务 spawn（reliability/imputation/datapipeline 等脚本共用骨架）
 *  input: { script?, data, params } → 写 input.json → execFile(PYTHON, [RUNNER, taskDir]) → 轮询 result.json
 */
export async function spawnPythonTask(
  scriptName: string,
  input: { script?: string; data?: { columnOrder: string[]; rows: unknown[][] }; method?: string; params?: Record<string, unknown>; [k: string]: unknown },
  ttlMs = TASK_TTL_MS
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // V381 安全加固: 列名白名单(防 patsy/pandas eval 注入 → RCE), TS 层前置拦截
  const colRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const DANGEROUS = new Set(["__import__", "eval", "exec", "system", "open", "compile", "globals", "locals"]);
  const cols = input.data?.columnOrder ?? [];
  for (const c of cols) {
    if (!colRe.test(c) || DANGEROUS.has(c)) {
      return { ok: false, error: `列名不合法: ${String(c).slice(0, 40)} (仅允许字母/下划线/数字)` };
    }
  }
  // params 列引用校验
  const strParams = ["y", "treat", "time", "id", "cluster", "unit", "endog", "treat_time", "rv", "dep", "row", "col"];
  for (const k of strParams) {
    const v = input.params?.[k];
    if (typeof v === "string" && v && (!colRe.test(v) || DANGEROUS.has(v))) {
      return { ok: false, error: `参数 ${k} 不合法: ${String(v).slice(0, 40)}` };
    }
  }
  for (const k of ["xs", "instruments", "fe", "controls"]) {
    const arr = input.params?.[k];
    if (Array.isArray(arr)) {
      for (const v of arr) {
        if (typeof v === "string" && v && (!colRe.test(v) || DANGEROUS.has(v))) {
          return { ok: false, error: `参数 ${k} 元素不合法: ${String(v).slice(0, 40)}` };
        }
      }
    }
  }
  const taskId = randomUUID();
  const taskDir = path.join(TASKS_DIR, taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "input.json"), JSON.stringify(input), "utf-8");
  } catch (e) {
    return { ok: false, error: `任务目录创建失败: ${String(e).slice(0, 120)}` };
  }

  tasks.set(taskId, { status: "running", createdAt: Date.now() });

  // 异步 spawn（不阻塞主线程; 结果由轮询读取; stderr 完整保留供诊断）
  execFile(
    PYTHON,
    [RUNNER, taskDir],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: process.env.SAG_ROOT || process.cwd() },
    (error, _stdout, stderr) => {
      const rec = tasks.get(taskId);
      if (!rec) return;  // V4xx: 回调兜底 — 任务已被 TTL 清理时 rec 为 undefined, 直接返回防崩溃
      const resultPath = path.join(taskDir, "result.json");
      // 竞态防护: 脚本用 os.replace 原子写, 但 Windows 文件系统可能延迟可见;
      // 进程退出后若 result.json 尚未可见, 等待 1s 再查一次, 避免误判失败
      const checkResult = (attempt: number) => {
        if (fs.existsSync(resultPath)) {
          try {
            rec.status = "done";
            rec.result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
            // 持久化到 DB（历史记录; 失败不影响主流程）
            const method = String(input.method ?? input.script ?? scriptName);
            void saveEmpiricalResult(taskId, { method, data: input.data ?? { columnOrder: [], rows: [] }, params: input.params ?? {} }, rec.result).catch(() => {});
          } catch {
            rec.status = "error";
            rec.error = "结果解析失败";
          }
          cleanup();
          return;
        }
        if (attempt < 3) {
          setTimeout(() => checkResult(attempt + 1), 500);
          return;
        }
        // 失败: 组合完整错误信息(含 Python traceback)
        const stderrTail = String(stderr ?? "").slice(-1500);
        rec.status = "error";
        rec.error = error
          ? `${String(error.message).slice(0, 300)}${stderrTail ? `\n${stderrTail}` : ""}`
          : "执行失败(无结果文件)";
        cleanup();
      };
      const cleanup = () => {
        try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
      };
      checkResult(0);
    }
  );

  return { ok: true, taskId };
}

/** 查询任务结果 */
export async function getEmpiricalResult(taskId: string): Promise<{ status: string; result?: unknown; error?: string }> {
  const t = tasks.get(taskId);
  if (!t) return { status: "not_found" };
  return { status: t.status, result: t.result, error: t.error };
}

/** venv 安装状态自检（前端徽标） */
export async function getEmpiricalMeta(): Promise<{ venvReady: boolean; statsModels: boolean; statspai: boolean; python: string }> {
  // V412: PYTHON 未配置时直接返回未安装，避免 execFile("") 报错（Maximum call stack / file cannot be empty）
  if (!PYTHON) {
    return { venvReady: false, statsModels: false, statspai: false, python: "未配置" };
  }
  const probe = (mod: string) =>
    new Promise<boolean>((resolve) => {
      execFile(PYTHON, ["-c", `import ${mod}`], { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
    });
  const [venv, stats, sp] = await Promise.all([
    probe("pandas"),
    probe("statsmodels"),
    probe("statspai"),
  ]);
  return {
    venvReady: venv,
    statsModels: stats,
    statspai: sp,
    python: fs.existsSync(PYTHON) ? "3.12" : "未安装",
  };
}

/** 保存结果到 DB（历史记录 + 持久化） */
export async function saveEmpiricalResult(
  taskId: string,
  input: { method: string; data: { columnOrder: string[]; rows: unknown[][] }; params: Record<string, unknown> },
  result: unknown
): Promise<string | null> {
  try {
    const res = result as any;
    const meta = res?.meta ?? {};
    const title = meta?.method ? `实证分析 ${meta.method} (N=${meta.n ?? "?"})` : "实证分析";
    const r = await pool.query(
      `insert into empirical_results (method, title, data_summary, params, result, meta)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.method,
        title,
        JSON.stringify({ columns: input.data.columnOrder, rows: input.data.rows.length, taskId }),
        JSON.stringify(input.params ?? {}),
        JSON.stringify(result),
        JSON.stringify(meta),
      ]
    );
    return String(r.rows[0].id);
  } catch (e) {
    console.error("[empirical] save failed:", e);
    return null;
  }
}

/** 历史记录列表 */
export async function listEmpiricalHistory(limit = 20): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `select id, method, title, meta, created_at from empirical_results order by created_at desc limit $1`,
    [limit]
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    method: row.method,
    title: row.title,
    meta: row.meta ?? {},
    created_at: new Date(row.created_at).toISOString(),
  }));
}

/** 历史详情 */
export async function getEmpiricalHistory(id: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(
    `select id, method, title, data_summary, params, result, meta, created_at from empirical_results where id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    method: row.method,
    title: row.title,
    dataSummary: row.data_summary ?? {},
    params: row.params ?? {},
    result: row.result ?? {},
    meta: row.meta ?? {},
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** 删除历史记录 */
export async function deleteEmpiricalHistory(id: string): Promise<boolean> {
  const r = await pool.query(`delete from empirical_results where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 导出 LaTeX 表格（booktabs 风格） */
export function latexTable(t: any): string {
  const cols = t.cols ?? [];
  const rows = t.rows ?? [];
  const lines: string[] = [];
  lines.push("\\begin{table}[htbp]");
  lines.push("\\centering");
  lines.push("\\caption{" + (t.title ?? "Regression").replace(/[&%$#_{}]/g, "\\$&") + "}");
  lines.push("\\begin{tabular}{l" + cols.slice(1).map(() => "c").join("") + "}");
  lines.push("\\toprule");
  lines.push(cols.join(" & ") + " \\\\");
  lines.push("\\midrule");
  for (const row of rows) {
    lines.push(row.map((v: unknown) => String(v).replace(/%/g, "\\%")).join(" & ") + " \\\\");
  }
  lines.push("\\bottomrule");
  if (t.notes) lines.push("\\multicolumn{" + cols.length + "}{l}{\\scriptsize " + String(t.notes).replace(/[&%$#_{}]/g, "\\$&") + "}");
  lines.push("\\end{tabular}");
  lines.push("\\end{table}");
  return lines.join("\n");
}

/** 导出 CSV */
export function csvTable(t: any): string {
  const cols = t.cols ?? [];
  const rows = t.rows ?? [];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(","), ...rows.map((r: unknown[]) => r.map(esc).join(","))].join("\n");
}

/** 存为知识页（联动 SAG 知识库） */
export async function saveAsKnowledgePage(id: string): Promise<{ ok: boolean; pageId?: string; error?: string }> {
  try {
    const rec = await getEmpiricalHistory(id);
    if (!rec) return { ok: false, error: "记录不存在" };
    const result = (rec.result ?? {}) as any;
    const meta = (rec.meta ?? {}) as any;
    // 组装 markdown 内容
    const lines: string[] = [];
    lines.push(`# ${rec.title}`);
    lines.push("");
    lines.push(`> 实证分析结果 · 方法: ${rec.method} · N=${meta.n ?? "?"} · ${meta.durationMs ?? "?"}ms`);
    lines.push("");
    for (const t of result.tables ?? []) {
      lines.push(`## ${t.title}`);
      lines.push("");
      lines.push(`| ${t.cols.join(" | ")} |`);
      lines.push(`| ${t.cols.map(() => "---").join(" | ")} |`);
      for (const row of t.rows) lines.push(`| ${row.join(" | ")} |`);
      if (t.notes) lines.push("");
      lines.push(`*${t.notes ?? ""}*`);
      lines.push("");
    }
    for (const d of result.diagnostics ?? []) {
      lines.push(`- **${d.name}**: ${d.verdict ?? ""} (${d.stat ?? ""})`);
    }
    for (const w of result.warnings ?? []) lines.push(`> ⚠️ ${w}`);
    const { truthService } = await import("./truth-service.js");
    const page = await truthService.createOrGetPage({
      title: rec.title as string,
      compiledTruth: lines.join("\n"),
      sourceHint: "empirical",
      tags: ["实证研究", rec.method as string],
    });
    return { ok: true, pageId: page.id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 数据源: 列出 PG 中可导入的表（前缀白名单 data_ / user_ 开头, 排除系统表; 排除含凭据/密钥列的表, 最多前 50 行预览） */
export async function listEmpiricalDatasets(): Promise<Array<{ table: string; columns: string[]; rows: number; preview: string[][] }>> {
  try {
    const tables = await pool.query(
      `select tablename from pg_tables
       where schemaname = 'public'
         and tablename not in ('schema_migrations','api_tokens','token_quotas','token_usage','empirical_results','ai_provider_settings','agent_tasks','alerts','eval_failures','eval_records','context_compressions','conversation_context')
         and tablename not like '\\_%'
       order by tablename limit 20`
    );
    const out: Array<{ table: string; columns: string[]; rows: number; preview: string[][] }> = [];
    for (const t of tables.rows) {
      const name = String(t.tablename);
      // V4xx: 前缀白名单 — 仅允许 data_*/user_* 前缀的表可导入（从宽正则改为显式前缀, 防误开放系统/业务表）
      if (!/^(?:data_|user_)/i.test(name)) continue;
      try {
        const info = await pool.query(
          `select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position limit 12`,
          [name]
        );
        const columns = info.rows.map((r: any) => String(r.column_name));
        // V4xx: 排除含凭据/密钥类列的表（credentials/secrets/hash 列名 → 不暴露为可导入数据源）
        if (columns.some((c) => /credentials?|secrets?|(?:password|passwd)_?hash|api[_-]?key|token/i.test(c))) continue;
        const cnt = await pool.query(`select count(*)::int as n from "${name}"`);
        const prev = await pool.query(`select * from "${name}" limit 5`);
        const preview = prev.rows.map((r: any) => columns.map((c) => {
          const v = r[c];
          return v === null || v === undefined ? "" : String(v).slice(0, 30);
        }));
        out.push({ table: name, columns, rows: Number(cnt.rows[0].n), preview });
      } catch { /* 跳过异常表 */ }
    }
    return out;
  } catch (e) {
    console.error("[empirical] list datasets failed:", e);
    return [];
  }
}

/** 数据源: 拉取表数据转 CSV 行（最多 5000 行, 数值/字符串） */
export async function fetchEmpiricalDataset(
  table: string,
  limit = 2000
): Promise<{ columnOrder: string[]; rows: (string | number | null)[][] } | null> {
  try {
    // V4xx: 前缀白名单校验 — 仅允许 data_*/user_* 前缀表（替代宽松的字母数字正则, 防读取系统/业务表）
    if (!/^(?:data_|user_)[a-z0-9_]*$/i.test(table)) return null;
    const cnt = await pool.query(`select count(*)::int as n from "${table}"`);
    const n = Math.min(Number(cnt.rows[0].n), limit);
    const r = await pool.query(`select * from "${table}" limit $1`, [n]);
    if (r.rows.length === 0) return null;
    const columns = Object.keys(r.rows[0]).slice(0, 20);
    const rows = r.rows.map((row: any) => columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return v;
      if (v instanceof Date) return v.toISOString();
      const s = String(v);
      const num = Number(s);
      return Number.isFinite(num) ? num : s.slice(0, 200);
    }));
    return { columnOrder: columns, rows };
  } catch (e) {
    console.error("[empirical] fetch dataset failed:", e);
    return null;
  }
}

export const empiricalService = { runEmpirical, spawnPythonTask, getEmpiricalResult, getEmpiricalMeta, saveEmpiricalResult, listEmpiricalHistory, getEmpiricalHistory, deleteEmpiricalHistory, latexTable, csvTable, saveAsKnowledgePage, listEmpiricalDatasets, fetchEmpiricalDataset };
