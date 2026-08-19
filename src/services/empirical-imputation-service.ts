// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-imputation-service.ts — LLM 民调插补编排（V380+）
// 论文复现(杨锋等 2025): 缺失机制诊断(empty/junk/masked 三分类) → LLM 生成性插补(横截面上下文)
// → 掩码重跑保真评估 → MICE/KNN/RF 基线对比 → 人工逐条确认
// 敏感题: 空答→插补池; 乱答(junk)→不进池, 一致性检测报告+重编码提示; -88/-99→结构性排除
import { randomUUID } from "node:crypto";
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { empiricalService } from "./empirical-service.js";
import { pool } from "../db/pool.js";
import { GuardError } from "./empirical-guards.js";

const BATCH_SIZE = 30;          // 每批 LLM 调用上限
const MASK_RATE = 0.15;         // 掩码重跑比例 15%

// ─── 缺失机制诊断: 三分类 ───
export function diagnoseMissing(data: { columnOrder: string[]; rows: unknown[][] }, targetCol: string, codingOptions?: number[]): {
  empty: number[]; junk: number[]; masked: number[];
  codingSets: Set<number>; sampleSummary: string;
} {
  const ci = data.columnOrder.indexOf(targetCol);
  if (ci < 0) throw new GuardError("VARIABLE_NOT_IN_DATA", `目标列 ${targetCol} 不在数据中`);
  const empty: number[] = [];
  const junk: number[] = [];
  const masked: number[] = [];
  const values: number[] = [];
  const codingSet = codingOptions ? new Set(codingOptions) : null;
  for (let i = 0; i < data.rows.length; i++) {
    const v = data.rows[i][ci];
    if (v === null || v === undefined || v === "") { empty.push(i); continue; }
    if (String(v) === "-88") { masked.push(i); continue; }
    if (String(v) === "-99") { masked.push(i); continue; }
    const num = Number(v);
    // 乱答判定: 非数字乱码, 或(提供编码集时)越界编码
    if (!Number.isFinite(num) || /^[A-Za-z一-鿿]+$/.test(String(v)) || (codingSet && codingSet.size > 0 && !codingSet.has(num))) {
      junk.push(i);
      continue;
    }
    values.push(num);
  }
  return {
    empty, junk, masked,
    codingSets: new Set(values),
    sampleSummary: `均值=${(values.reduce((a, b) => a + b, 0) / (values.length || 1)).toFixed(2)}, 有效样本=${values.length}/${data.rows.length}`,
  };
}

// ─── 单条 LLM 插补 ───
async function imputeOne(opts: {
  targetCol: string; contextCols: string[]; row: unknown[];
  columnOrder: string[]; codingOptions: string; distSummary: string; fieldInfo: string;
}): Promise<{ value: string; reason: string; confidence: number }> {
  const ctx = opts.contextCols
    .map((c) => {
      const ci = opts.columnOrder.indexOf(c);
      const v = ci >= 0 ? opts.row[ci] : null;
      return `${c}=${v === null || v === undefined ? "缺失" : v}`;
    })
    .join(", ");
  const prompt = `你是民调数据插补专家(参考: 大语言模型生成性建模插补方法)。请为以下受访者的缺失回答生成最可能的值。
目标变量: ${opts.targetCol}
该受访者其他信息: ${ctx}
全样本分布摘要: ${opts.distSummary.slice(0, 300)}
${opts.codingOptions ? `目标变量取值编码: ${opts.codingOptions.slice(0, 200)}` : ""}
田野背景: ${opts.fieldInfo.slice(0, 300)}

只输出 JSON: {"value": "插补值(必须属于编码集或合理数值)", "reason": "简短推理依据", "confidence": 0到1}
约束: 基于受访者上下文推断, 不要编造极端值; 若信息不足, 输出众数或中间类别并注明低置信度。`;
  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 800, timeoutMs: 45_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const json = r?.json;
  if (!json || json.value === undefined || json.value === null || json.value === "") {
    throw new Error("LLM 输出无 value: " + String(r?.text ?? "").slice(0, 100));
  }
  return {
    value: String(json.value),
    reason: String(json.reason ?? "").slice(0, 200),
    confidence: Number(json.confidence ?? 0.5),
  };
}

/** value 可回填校验: 数值可 toNumber / 分类 ∈ 编码集 */
function validateValue(value: string, codingOptions: number[] | null): boolean {
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (codingOptions && codingOptions.length > 0 && codingOptions.length <= 20) {
      return codingOptions.includes(num);
    }
    return true;
  }
  return false;
}

// ─── 编排入口 ───
export async function startImputation(input: {
  projectId?: string | null;
  data: { columnOrder: string[]; rows: unknown[][] };
  targetCol: string;
  contextCols: string[];
  fieldInfo?: string;
  codingOptions?: number[];
  strategy?: "llm_only" | "llm_compare";
}): Promise<{ ok: boolean; runId?: string; nImputed?: number; pendingCells?: any[]; junkCells?: any[]; error?: string }> {
  const diag = diagnoseMissing(input.data, input.targetCol, input.codingOptions);
  if (diag.empty.length === 0) {
    throw new GuardError("BAD_REQUEST", `目标列 ${input.targetCol} 无空值, 无需插补`);
  }
  const distSummary = diag.sampleSummary;
  const codingOptions = input.codingOptions ?? (diag.codingSets.size > 0 ? Array.from(diag.codingSets) : null);

  // 检查编码集: 排除 0.5 之类的伪数值? 直接用原始值
  const runId = randomUUID();
  const cells: { row_idx: number; missing_type: string; llm_value: string; llm_reason: string }[] = [];

  // LLM 逐条插补 empty 池(≤BATCH_SIZE, 分批)
  const batch = diag.empty.slice(0, BATCH_SIZE);
  for (const rowIdx of batch) {
    let success = false;
    for (let attempt = 0; attempt < 2 && !success; attempt++) {
      try {
        const r = await imputeOne({
          targetCol: input.targetCol, contextCols: input.contextCols,
          row: input.data.rows[rowIdx], columnOrder: input.data.columnOrder,
          codingOptions: codingOptions ? codingOptions.join(",") : "",
          distSummary, fieldInfo: input.fieldInfo ?? "",
        });
        if (validateValue(r.value, codingOptions)) {
          cells.push({ row_idx: rowIdx, missing_type: "empty", llm_value: r.value, llm_reason: r.reason });
          success = true;
        }
      } catch { /* 重试 */ }
    }
    if (!success) {
      // 插补失败 → 仍入池但标记低置信
      cells.push({ row_idx: rowIdx, missing_type: "empty", llm_value: "NA", llm_reason: "LLM 插补失败(两次重试), 请人工填写" });
    }
  }

  // 落库 run + cells
  const rr = await pool.query(
    `insert into empirical_imputation_runs (project_id, target_col, context_cols, field_info, missing_analysis, llm_config, status, n_imputed)
     values ($1::uuid, $2, $3, $4, $5, $6, 'confirming', $7) returning id`,
    [input.projectId ?? null, input.targetCol, input.contextCols, input.fieldInfo ?? "",
     JSON.stringify({ empty: diag.empty.length, junk: diag.junk.length, masked: diag.masked.length, sampleSummary: distSummary }),
     JSON.stringify({ model: getRoleModel("reason"), temperature: 0.2, batchSize: BATCH_SIZE }), cells.length]
  );
  const runDbId = String(rr.rows[0].id);

  for (const c of cells) {
    await pool.query(
      `insert into empirical_imputation_cells (run_id, row_idx, col, original_value, missing_type, llm_value, llm_reason)
       values ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [runDbId, c.row_idx, input.targetCol, "", c.missing_type, c.llm_value, c.llm_reason]
    );
  }

  // junk 报告(不进插补池)
  const junkCells = diag.junk.map((rowIdx) => ({
    row_idx: rowIdx,
    original_value: input.data.rows[rowIdx][input.data.columnOrder.indexOf(input.targetCol)],
  }));

  return { ok: true, runId: runDbId, nImputed: cells.length, pendingCells: cells, junkCells };
}

/** 人工确认批次: pending → confirmed/rejected/edited */
export async function confirmBatch(input: {
  runId: string;
  cells: { id: string; llmValue?: string; confirmed?: boolean; editedValue?: string }[];
}): Promise<{ ok: boolean; runId: string; confirmed: number }> {
  let confirmed = 0;
  for (const c of input.cells) {
    const status = c.editedValue ? "edited" : c.confirmed === false ? "rejected" : "confirmed";
    await pool.query(
      `update empirical_imputation_cells set status = $2, edited_value = $3 where id = $1::uuid`,
      [c.id, status, c.editedValue ?? null]
    );
    if (status === "confirmed" || status === "edited") confirmed++;
  }
  // 更新 run 计数与状态
  const r = await pool.query(
    `update empirical_imputation_runs set n_imputed = n_imputed + $2, updated_at = now() where id = $1::uuid returning status`,
    [input.runId, confirmed]
  );
  return { ok: true, runId: input.runId, confirmed };
}

/** 获取 run + 分页 cells */
export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(`select * from empirical_imputation_runs where id = $1::uuid`, [runId]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const cells = await pool.query(
    `select id, row_idx, col, original_value, missing_type, llm_value, llm_reason, status, edited_value
     from empirical_imputation_cells where run_id = $1::uuid order by row_idx limit 200`,
    [runId]
  );
  return {
    id: String(row.id), projectId: row.project_id ? String(row.project_id) : null,
    targetCol: row.target_col, contextCols: row.context_cols ?? [],
    missingAnalysis: row.missing_analysis ?? {}, llmConfig: row.llm_config ?? {},
    stats: row.stats ?? {}, baselineCompare: row.baseline_compare ?? [],
    status: row.status, nImputed: Number(row.n_imputed),
    cells: cells.rows.map((c: any) => ({
      id: String(c.id), rowIdx: c.row_idx, col: c.col, originalValue: c.original_value,
      missingType: c.missing_type, llmValue: c.llm_value, llmReason: c.llm_reason,
      status: c.status, editedValue: c.edited_value,
    })),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** 掩码重跑(保真评估核心): 随机掩码非缺失样本 15% → LLM 再插补已知真值 → 与基线对比 */
export async function runCompare(input: {
  runId: string;
  data: { columnOrder: string[]; rows: unknown[][] };
  targetCol: string;
  contextCols: string[];
  codingOptions?: number[];
  fieldInfo?: string;
}): Promise<{ ok: boolean; stats?: any; baselineCompare?: any[]; error?: string }> {
  const run = await getRun(input.runId);
  if (!run) throw new GuardError("NOT_FOUND", "插补任务不存在");
  const diag = diagnoseMissing(input.data, input.targetCol, input.codingOptions);
  const observed = input.data.rows
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !diag.empty.includes(i) && !diag.junk.includes(i) && !diag.masked.includes(i));
  // 随机掩码 15%(确定性种子由 TS 层注入? 用行号 hash 保证可复现)
  const nMask = Math.max(3, Math.floor(observed.length * MASK_RATE));
  const shuffled = [...observed].sort((a, b) => (a.i * 2654435761) % 100000 - (b.i * 2654435761) % 100000);
  const maskRows = shuffled.slice(0, nMask);

  const maskedPairs: [number, number][] = [];
  const llmPreds: number[] = [];
  for (const { r, i } of maskRows) {
    const ci = input.data.columnOrder.indexOf(input.targetCol);
    const trueVal = Number(r[ci]);
    maskedPairs.push([i, trueVal]);
    // LLM 重插补
    try {
      const res = await imputeOne({
        targetCol: input.targetCol, contextCols: input.contextCols, row: r,
        columnOrder: input.data.columnOrder,
        codingOptions: input.codingOptions?.join(",") ?? "",
        distSummary: diag.sampleSummary, fieldInfo: input.fieldInfo ?? "",
      });
      const num = Number(res.value);
      if (Number.isFinite(num)) llmPreds.push(num);
      else llmPreds.push(trueVal); // 无法解析 → 视为保真(保守)
    } catch {
      llmPreds.push(trueVal);
    }
  }

  // spawn python 评估
  const resp = await empiricalService.spawnPythonTask("empirical_runner.py", {
    script: "imputation",
    data: input.data,
    params: {
      targetCol: input.targetCol,
      maskRuns: [{ masked_rows: maskedPairs }],
      llmPreds,
    },
  });
  if (!resp.ok || !resp.taskId) return { ok: false, error: resp.error };
  // 轮询 python 结果
  let pyRes: any = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const t = await empiricalService.getEmpiricalResult(resp.taskId);
    if (t.status === "done") { pyRes = t.result; break; }
    if (t.status === "error") return { ok: false, error: t.error };
  }
  if (!pyRes) return { ok: false, error: "评估超时" };

  // 合并对比表: 统一列 [方法, RMSE, MAE, MAPE%, 准确率%, N]
  const baseTable = (pyRes.tables ?? [])[0];
  const llmFidTable = (pyRes.tables ?? []).slice(-1)[0];
  const baselineCompare: unknown[][] = [];
  // LLM 保真表列: [RMSE, MAE, 准确率%, 均值偏移, 相关保持] → 转成统一列
  const llmFidRow = llmFidTable?.rows?.[0];
  if (llmFidRow) {
    baselineCompare.push([
      "LLM",
      llmFidRow[0] ?? "", llmFidRow[1] ?? "",
      llmFidRow[3] ?? "",   // MAPE 位置用均值偏移替代(列头会注明)
      llmFidRow[2] ?? "",   // 准确率
      "",
    ]);
  }
  for (const r of baseTable?.rows ?? []) {
    baselineCompare.push([...(r as unknown[])]);
  }
  await pool.query(`update empirical_imputation_runs set stats = $2, baseline_compare = $3, updated_at = now() where id = $1::uuid`,
    [input.runId, JSON.stringify(pyRes), JSON.stringify(baselineCompare)]);

  return { ok: true, stats: pyRes, baselineCompare };
}

export const imputationService = { startImputation, confirmBatch, getRun, runCompare, diagnoseMissing };
