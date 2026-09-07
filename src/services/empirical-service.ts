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

// 定期清理过期任务
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TASK_TTL_MS) tasks.delete(id);
  }
}, 5 * 60_000).unref?.();

/** 提交实证分析任务: 同步 spawn 执行, 结果落内存 */
export async function runEmpirical(
  input: { data: { columnOrder: string[]; rows: unknown[][] }; method: string; params: Record<string, unknown>; projectId?: string | null }
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // V399: meta_analysis 走独立脚本（easymeta 方法论: 证据综合）
  if (input.method === "meta_analysis") {
    return spawnPythonTask("empirical_metaanalysis.py", { script: "metaanalysis", method: "meta_analysis", data: input.data, params: input.params });
  }
  const task = await spawnPythonTask("empirical_runner.py", { ...input, projectId: undefined });
  // V413: 带课题归属 → 完成后落 pipeline_runs(回归类自动补森林图)
  if (task.ok && task.taskId && input.projectId) {
    void trackRunToPipeline(input.projectId, input.method, input.data, input.params, task.taskId);
  }
  return task;
}

/** V413: 追踪 empirical/run 任务 → 完成后写 pipeline_runs + 回归自动出森林图 */
async function trackRunToPipeline(
  projectId: string,
  method: string,
  data: { columnOrder: string[]; rows: unknown[][] },
  params: Record<string, unknown>,
  taskId: string
): Promise<void> {
  try {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const t = await getEmpiricalResult(taskId);
      if (t.status !== "done" && t.status !== "error") continue;
      if (t.status === "done") {
        let enriched = t.result as any;
        // 回归类方法(有系数表) → 自动森林图
        const regMethods = new Set(["ols", "logit", "ologit", "mnl", "did", "did_twfe", "event_study", "panel_fe", "iv", "rdd"]);
        if (regMethods.has(method)) {
          try {
            const resAny = t.result as any;
            const regTbl = (resAny?.tables ?? []).find((tb: any) => /回归|Logit|OLS|系数/.test(String(tb.title ?? "")));
            if (regTbl?.rows?.length) {
              const fr = await generateEmpiricalFigures({
                spec: {
                  kind: "forest", id: `run_${method}_${Date.now()}`,
                  title: `${String(params.y ?? "")} — ${method.toUpperCase()} 系数图`,
                  tables: [{ rows: regTbl.rows, cols: regTbl.cols ?? [] }],
                },
              });
              if (fr.ok && fr.taskId) {
                for (let fi = 0; fi < 25; fi++) {
                  await new Promise((res) => setTimeout(res, 1300));
                  const ft = await getEmpiricalResult(fr.taskId);
                  if (ft.status === "done") {
                    const charts = ((ft.result as any)?.meta?.charts ?? []) as any[];
                    enriched = { ...enriched, meta: { ...(enriched?.meta ?? {}), figures: charts.map((c: any) => ({ id: c.id, file: c.file, title: c.title, sizeKB: c.sizeKB })) } };
                    break;
                  }
                  if (ft.status === "error") break;
                }
              }
            }
          } catch { /* 图失败不影响落库 */ }
        }
        const { pool: dbPool } = await import("../db/pool.js");
        await dbPool.query(
          `insert into empirical_pipeline_runs (project_id, stage, input_snapshot, python_result)
           values ($1, $2, $3, $4)`,
          [projectId, method === "descriptive" ? "data_pipeline" : method,
           JSON.stringify({ method, params, nRows: data.rows.length, columns: data.columnOrder, runTaskId: taskId }),
           JSON.stringify(enriched)]
        ).catch(() => {});
      }
      return;
    }
  } catch { /* 追踪失败忽略 */ }
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
  // V413: 独立脚本按 scriptName 通用分发（empirical_runner.py 委托模式 + metaanalysis/simulate/figures）
  const runnerPath = ["empirical_metaanalysis.py", "empirical_simulate.py", "empirical_figures.py", "empirical_report_export.py"].includes(scriptName)
    ? path.join(process.env.SAG_ROOT || process.cwd(), "scripts", scriptName)
    : RUNNER;
  execFile(
    PYTHON,
    [runnerPath, taskDir],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: process.env.SAG_ROOT || process.cwd() },
    (error, _stdout, stderr) => {
      const rec = tasks.get(taskId);
      if (!rec) return;
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

/** 保存结果到 DB（历史记录 + 持久化; R6: 计费字段 + artifactIds 落库） */
export async function saveEmpiricalResult(
  taskId: string,
  input: { method: string; data: { columnOrder: string[]; rows: unknown[][] }; params: Record<string, unknown> },
  result: unknown,
  opts: { userId?: string; sourceTaskId?: string; chargePoints?: number; fileId?: string } = {}
): Promise<string | null> {
  try {
    const res = result as any;
    const meta = res?.meta ?? {};
    const title = meta?.method ? `实证分析 ${meta.method} (N=${meta.n ?? "?"})` : "实证分析";
    // R6: 图表产物 → artifactIds(stats_artifacts 若已生成图)
    const artifactIds = Array.isArray(res?.artifactIds) ? res.artifactIds : [];
    const r = await pool.query(
      `insert into empirical_results
         (method, title, data_summary, params, result, meta,
          user_id, source_task_id, file_id, charge_points, billing_status, billing_policy,
          artifact_ids, completed_at, progress_message)
       values ($1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, now(), 'completed') returning id`,
      [
        input.method,
        title,
        JSON.stringify({ columns: input.data.columnOrder, rows: input.data.rows.length, taskId }),
        JSON.stringify(input.params ?? {}),
        JSON.stringify(result),
        JSON.stringify(meta),
        opts.userId ?? null,
        opts.sourceTaskId ?? taskId,
        opts.fileId ?? "",
        opts.chargePoints ?? 0,
        opts.chargePoints && opts.chargePoints > 0 ? "settled" : "unbilled",
        "per_run",
        JSON.stringify(artifactIds),
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
    `select id, method, title, data_summary, params, result, meta, created_at,
            charge_points, billing_status, artifact_ids, source_task_id, completed_at
       from empirical_results where id = $1`,
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
    charge_points: Number(row.charge_points ?? 0),
    billing_status: row.billing_status ?? "unbilled",
    artifact_ids: row.artifact_ids ?? [],
    source_task_id: row.source_task_id ?? "",
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
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

/** 数据源: 列出 PG 中可导入的表（排除系统表, 最多前 50 行预览） */
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
      try {
        const info = await pool.query(
          `select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position limit 12`,
          [name]
        );
        const cnt = await pool.query(`select count(*)::int as n from "${name}"`);
        const prev = await pool.query(`select * from "${name}" limit 5`);
        const columns = info.rows.map((r: any) => String(r.column_name));
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
    // 白名单校验: 只允许字母数字下划线
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return null;
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

/** V413: 问卷仿真数据生成 — 按已识别问卷结构(Question[])生成 N 份带内在结构的模拟作答 */
export async function simulateQuestionnaireData(input: {
  questionnaire: unknown[];
  params?: Record<string, unknown>;
  projectId?: string | null;   // V413: 落 pipeline_runs(课题流水线可见)
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  if (!Array.isArray(input.questionnaire) || input.questionnaire.length === 0) {
    return { ok: false, error: "问卷结构为空" };
  }
  const n = Number(input.params?.n ?? 100);
  if (!Number.isFinite(n) || n < 10 || n > 5000) {
    return { ok: false, error: "样本量 n 需在 10~5000" };
  }
  // 校验列名白名单（注入防护，沿用 spawnPythonTask 同规则）
  const colRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const DANGEROUS = new Set(["__import__", "eval", "exec", "system", "open", "compile", "globals", "locals"]);
  const seen = new Set<string>();
  const flatten = (q: any): string[] => {
    if (q?.type === "multi") {
      return (q.options ?? []).map((o: any) => `${q.varName}_r${o.code}`);
    }
    return q?.varName ? [String(q.varName)] : [];
  };
  for (const q of input.questionnaire) {
    for (const c of flatten(q)) {
      if (!colRe.test(c) || DANGEROUS.has(c)) return { ok: false, error: `列名不合法: ${c}` };
      if (seen.has(c)) return { ok: false, error: `变量名重复: ${c}` };
      seen.add(c);
    }
  }
  const task = await spawnPythonTask("empirical_simulate.py", {
    script: "simulate", questionnaire: input.questionnaire, params: input.params,
  });
  if (!task.ok || !task.taskId) return task;
  // V413: 生成完成后落 pipeline_runs(课题流水线可见) — 轮询结果后写入
  if (input.projectId) {
    void (async () => {
      try {
        for (let i = 0; i < 60; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          const t = await getEmpiricalResult(task.taskId!);
          if (t.status === "done") {
            const meta = ((t.result as any)?.meta ?? {}) as any;
            const { pool: dbPool } = await import("../db/pool.js");
            await dbPool.query(
              `insert into empirical_pipeline_runs (project_id, stage, input_snapshot, python_result, llm_interpretation)
               values ($1, 'simulate', $2, $3, $4)`,
              [input.projectId, JSON.stringify({ n: meta.n, cols: meta.cols, seed: meta.seed, skipEntries: meta.skipEntries }),
               JSON.stringify(t.result),
               `仿真数据生成: ${meta.n} 行 × ${meta.cols} 列(seed=${meta.seed}, 跳答组=${meta.skipEntries ?? 0}); 结构缺失=-99, 挖缺失=None`]
            );
            return;
          }
          if (t.status === "error") return;
        }
      } catch { /* 落库失败不影响生成 */ }
    })();
  }
  return task;
}

/** V413: 论文级图表生成 — 实证结果 → matplotlib PNG/PDF(alpha对比/箱线/热力/森林/方法对比) */
export async function generateEmpiricalFigures(input: {
  spec: Record<string, unknown>;
  outDir?: string;
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  if (!input.spec || typeof input.spec !== "object") {
    return { ok: false, error: "spec 不能为空" };
  }
  const kind = String((input.spec as any).kind ?? "");
  const ALLOWED_KINDS = ["alpha_bar", "boxplot", "heatmap", "forest", "compare"];
  if (!ALLOWED_KINDS.includes(kind)) {
    return { ok: false, error: `图表类型必须为: ${ALLOWED_KINDS.join("/")}` };
  }
  return spawnPythonTask("empirical_figures.py", {
    script: "figures", spec: input.spec,
    outDir: input.outDir ?? path.join(process.env.SAG_ROOT || process.cwd(), "data", "agent_workspace", "figures"),
  });
}

/** V413: 课题全套报告导出(流水线 → LaTeX/Word) — 脚本写文件到 outDir 并返回清单 */
export async function exportProjectReport(input: {
  overview: Record<string, unknown>;
  outDir?: string;
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  if (!input.overview || typeof input.overview !== "object") {
    return { ok: false, error: "overview 不能为空" };
  }
  const figDir = path.join(process.env.SAG_ROOT || process.cwd(), "data", "agent_workspace", "figures");
  const outDir = path.join(process.env.SAG_ROOT || process.cwd(), "data", "agent_workspace", "reports");
  return spawnPythonTask("empirical_report_export.py", {
    script: "report_export", overview: input.overview, figuresDir: figDir, outDir,
  });
}

export const empiricalService = { runEmpirical, spawnPythonTask, getEmpiricalResult, getEmpiricalMeta, saveEmpiricalResult, listEmpiricalHistory, getEmpiricalHistory, deleteEmpiricalHistory, latexTable, csvTable, saveAsKnowledgePage, listEmpiricalDatasets, fetchEmpiricalDataset, simulateQuestionnaireData, generateEmpiricalFigures, exportProjectReport };
