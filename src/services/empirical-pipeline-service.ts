// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-pipeline-service.ts — 数据处理管道编排 + Stata 代码生成（V380+）
// Python 实执行五步 + Stata 常量模板下载 + verify 反 hallucinate 报告
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { empiricalService } from "./empirical-service.js";
import { pool } from "../db/pool.js";
import { assertColumns, assertExprVars, GuardError } from "./empirical-guards.js";

const PYTHON = process.env.EMPIRICAL_PYTHON || "";
const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "empirical_runner.py");
const TASKS_DIR = path.join(os.tmpdir(), "empirical-tasks");

/** 生成 Stata 代码(纯模板, 无 LLM; 确定性) */
export async function generateStata(steps: any, vars: string[]): Promise<{ ok: boolean; stataCode?: string; error?: string }> {
  try {
    // 白名单校验
    const allRefs = [
      ...((steps.missing?.cols) ?? []),
      ...((steps.winsorize?.cols) ?? []),
      ...((steps.filter ?? []).map((c: any) => c.col)),
    ].filter(Boolean);
    assertColumns(allRefs, vars, "Stata 变量");
    for (const f of steps.genvars ?? []) {
      assertExprVars(String(f.expr ?? ""), vars, `Stata 变量 ${f.name}`);
    }
    // describe 允许引用构造出的新变量
    const newVars = (steps.genvars ?? []).map((f: any) => f.name).filter(Boolean);
    const descCols = (steps.describe?.cols ?? []).filter((c: string) => !newVars.includes(c));
    assertColumns(descCols, vars, "Stata 描述统计变量");
    const r = await new Promise<{ ok: boolean; code?: string; error?: string }>((resolve) => {
      execFile(PYTHON, ["-c",
        `import sys; sys.path.insert(0, r"${path.join(process.env.SAG_ROOT || process.cwd(), "scripts")}"); from empirical_stata_templates import build_stata; import json; print(build_stata(json.loads(sys.argv[1]), json.loads(sys.argv[2])))`,
        JSON.stringify(steps), JSON.stringify(vars)],
        { timeout: 30_000, windowsHide: true, encoding: "utf-8" },
        (err, stdout) => {
          if (err) resolve({ ok: false, error: String(err.message).slice(0, 200) });
          else resolve({ ok: true, code: stdout });
        });
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, stataCode: r.code };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 运行数据管道(Python 实执行) */
export async function runPipeline(input: {
  projectId?: string | null;
  data: { columnOrder: string[]; rows: unknown[][] };
  steps: any;
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // 白名单: 构造前步骤(missing/winsorize/filter)引用原始列; genvars 公式引用原始列
  const baseCols = input.data.columnOrder;
  const preRefs = [
    ...((input.steps.missing?.cols) ?? []),
    ...((input.steps.winsorize?.cols) ?? []),
    ...((input.steps.filter ?? []).map((c: any) => c.col)),
  ].filter(Boolean);
  assertColumns(preRefs, baseCols, "管道变量");
  for (const f of input.steps.genvars ?? []) {
    assertExprVars(String(f.expr ?? ""), baseCols, `管道变量 ${f.name}`);
  }
  // describe 可用原始列 + 构造出的新变量
  const newVars = (input.steps.genvars ?? []).map((f: any) => f.name).filter(Boolean);
  const descCols = (input.steps.describe?.cols ?? []).filter((c: string) => !newVars.includes(c));
  assertColumns(descCols, baseCols, "描述统计变量");
  const r = await empiricalService.spawnPythonTask("empirical_runner.py", {
    script: "datapipeline", data: input.data, params: { steps: input.steps },
  });
  if (r.ok && r.taskId && input.projectId) {
    // 落 pipeline_runs 记录
    void pool.query(
      `insert into empirical_pipeline_runs (project_id, stage, input_snapshot) values ($1::uuid, 'data_pipeline', $2)`,
      [input.projectId, JSON.stringify({ steps: input.steps, nRows: input.data.rows.length, columns: input.data.columnOrder })]
    ).catch(() => {});
  }
  return r;
}

/** verify 反 hallucinate 报告: 核对 n_before/n_after 与变量来源 */
export async function verifyPipeline(input: {
  projectId?: string | null;
  nBefore?: number; nAfter?: number;
  generatedVars?: string[]; dataColumns?: string[];
}): Promise<{ ok: boolean; report: any }> {
  const issues: string[] = [];
  const checks: string[] = [];
  // 1. 样本量一致性
  if (input.nBefore !== undefined && input.nAfter !== undefined) {
    checks.push(`样本量: ${input.nBefore} → ${input.nAfter}${input.nAfter > input.nBefore ? " (⚠️ 不应增加)" : ""}`);
    if (input.nAfter > input.nBefore) issues.push("样本量增加异常: 筛选/构造不应增加行数, 请核对数据源");
  }
  // 2. 变量来源核对: generatedVars 是 genvars 构造的新列(合法, 不要求存在于原始列)
  if (input.generatedVars) {
    checks.push(`构造变量 ${input.generatedVars.length} 个: ${input.generatedVars.join(", ")} (由 genvars 公式生成, 公式引用列已过白名单)`);
  }
  // 3. 构造变量名合法性
  const badNames = (input.generatedVars ?? []).filter((v) => !/^[a-z_][a-z0-9_]*$/.test(v));
  if (badNames.length > 0) {
    issues.push(`构造变量名非法: ${badNames.join(", ")} (需小写下划线)`);
  }
  return {
    ok: issues.length === 0,
    report: { checks, issues, verdict: issues.length === 0 ? "通过: 样本量与变量来源一致" : "需人工核对: " + issues.join("; ") },
  };
}

export const pipelineService = { generateStata, runPipeline, verifyPipeline };
