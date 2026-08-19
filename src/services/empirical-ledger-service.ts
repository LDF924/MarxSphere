// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-ledger-service.ts — 证据账本(econ-paper-studio evidence ledger 模式)（V380+）
// 防编造机制:
// 1. add-from-result 只接收坐标{runId, tableIndex, rowIndex, colIndex}, 服务端从真实结果读数值, 不提供手填接口
// 2. 写入前置条件: 结果解释闸门 confirmed, 否则 400 GATE_LOCKED
// 3. 绑定真实性: code_snippet 只读来源, raw_data_ref 下拉 data-versions, literature 从 citations 表选
import { pool } from "../db/pool.js";
import { GuardError, assertGateConfirmed } from "./empirical-guards.js";

/** 从 run 结果按坐标读系数(前端只传坐标, 数值由服务端从真实运行结果取) */
async function readCoeffFromResult(runId: string, tableIndex: number, rowIndex: number, colIndex: number): Promise<{
  coefficient: string; coefValue: string; sePvalue: string; spec: string; codeSnippet: string; dataTable: string;
} | null> {
  const r = await pool.query(`select input_snapshot, python_result, stata_code from empirical_pipeline_runs where id = $1::uuid`, [runId]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const snapshot = row.input_snapshot ?? {};
  // 系数表来源: python_result.tables 或 stata_code(回归 run 的 python 结果)
  const pyRes = row.python_result ?? {};
  const tables = Array.isArray(pyRes.tables) ? pyRes.tables : [];
  const table = tables[tableIndex];
  if (!table) return null;
  const tRows = Array.isArray(table.rows) ? table.rows : [];
  const tRow = tRows[rowIndex];
  if (!tRow) return null;
  const cols = Array.isArray(table.cols) ? table.cols : [];
  const coefficient = String(cols[colIndex] ?? `col${colIndex}`);
  const coefValue = String(tRow[colIndex] ?? "");
  return {
    coefficient,
    coefValue,
    sePvalue: "",
    spec: JSON.stringify(snapshot.spec ?? {}),
    codeSnippet: String(row.stata_code ?? "").slice(0, 2000),
    dataTable: String(table.title ?? ""),
  };
}

export async function addFromResult(input: {
  projectId: string;
  runId: string;
  tableIndex: number;
  rowIndex: number;
  colIndex: number;
  dataVersionId?: string | null;
  citeKeys?: string[];
}): Promise<{ ok: boolean; entry?: any; error?: string }> {
  // 前置条件: 结果解释闸门 confirmed
  await assertGateConfirmed(input.projectId, "result_interpretation", "证据账本写入");
  const coeff = await readCoeffFromResult(input.runId, input.tableIndex, input.rowIndex, input.colIndex);
  if (!coeff) return { ok: false, error: "系数读取失败(运行结果不存在或坐标越界)" };

  // 原始数据引用: 从 data-versions 下拉(不手输)
  let rawDataRef = "";
  if (input.dataVersionId) {
    const dv = await pool.query(`select name from empirical_data_versions where id = $1::uuid`, [input.dataVersionId]);
    if (dv.rows.length > 0) rawDataRef = String(dv.rows[0].name);
  }
  // 文献: 从 citations 表选(不手输)
  let literature: any[] = [];
  if (input.citeKeys && input.citeKeys.length > 0) {
    const r = await pool.query(
      `select cite_key, title, authors, source from empirical_ledger_citations where project_id = $1::uuid and cite_key = any($2)`,
      [input.projectId, input.citeKeys]
    );
    literature = r.rows.map((row: any) => ({ cite_key: row.cite_key, title: row.title, authors: row.authors, source: row.source }));
  }

  const rr = await pool.query(
    `insert into empirical_ledger_entries (project_id, run_id, coefficient, coef_value, se_pvalue, spec, code_snippet, data_table, raw_data_ref, literature_ref)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning *`,
    [input.projectId, input.runId, coeff.coefficient, coeff.coefValue, coeff.sePvalue, coeff.spec,
     coeff.codeSnippet, coeff.dataTable, rawDataRef, JSON.stringify(literature)]
  );
  return { ok: true, entry: toEntryObj(rr.rows[0]) };
}

export function toEntryObj(row: any): Record<string, unknown> {
  return {
    id: String(row.id), projectId: String(row.project_id),
    runId: row.run_id ? String(row.run_id) : null,
    coefficient: row.coefficient, coefValue: row.coef_value, sePvalue: row.se_pvalue,
    spec: row.spec, codeSnippet: row.code_snippet, dataTable: row.data_table,
    rawDataRef: row.raw_data_ref, literatureRef: row.literature_ref ?? [],
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listEntries(projectId: string): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `select * from empirical_ledger_entries where project_id = $1::uuid order by created_at desc limit 200`,
    [projectId]
  );
  return r.rows.map(toEntryObj);
}

/** 更新绑定(仅改绑定不改数值) */
export async function updateRefs(id: string, input: {
  codeSnippet?: string; dataVersionId?: string | null; citeKeys?: string[];
}): Promise<{ ok: boolean; entry?: any; error?: string }> {
  const cur = await pool.query(`select * from empirical_ledger_entries where id = $1::uuid`, [id]);
  if (cur.rows.length === 0) return { ok: false, error: "条目不存在" };
  const row = cur.rows[0];
  const codeSnippet = input.codeSnippet ?? row.code_snippet;
  let rawDataRef = row.raw_data_ref;
  if (input.dataVersionId) {
    const dv = await pool.query(`select name from empirical_data_versions where id = $1::uuid`, [input.dataVersionId]);
    if (dv.rows.length > 0) rawDataRef = String(dv.rows[0].name);
  }
  let literature = row.literature_ref ?? [];
  if (input.citeKeys) {
    const r = await pool.query(
      `select cite_key, title, authors, source from empirical_ledger_citations where project_id = $1::uuid and cite_key = any($2)`,
      [String(row.project_id), input.citeKeys]
    );
    literature = r.rows.map((rr: any) => ({ cite_key: rr.cite_key, title: rr.title, authors: rr.authors, source: rr.source }));
  }
  const u = await pool.query(
    `update empirical_ledger_entries set code_snippet = $2, raw_data_ref = $3, literature_ref = $4::jsonb, updated_at = now() where id = $1::uuid returning *`,
    [id, codeSnippet, rawDataRef, JSON.stringify(literature)]
  );
  return { ok: true, entry: toEntryObj(u.rows[0]) };
}

export async function deleteEntry(id: string): Promise<boolean> {
  const r = await pool.query(`delete from empirical_ledger_entries where id = $1::uuid`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ─── 文献库 ───
export async function addCitation(input: {
  projectId: string; citeKey: string; title: string; authors?: string; source?: string; url?: string;
}): Promise<{ ok: boolean; citation?: any; error?: string }> {
  try {
    const r = await pool.query(
      `insert into empirical_ledger_citations (project_id, cite_key, title, authors, source, url)
       values ($1::uuid, $2, $3, $4, $5, $6) on conflict (project_id, cite_key) do update set title = excluded.title returning *`,
      [input.projectId, input.citeKey, input.title, input.authors ?? "", input.source ?? "", input.url ?? ""]
    );
    const row = r.rows[0];
    return { ok: true, citation: { id: String(row.id), citeKey: row.cite_key, title: row.title, authors: row.authors, source: row.source, url: row.url } };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function listCitations(projectId: string): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `select id, cite_key, title, authors, source, url from empirical_ledger_citations where project_id = $1::uuid order by created_at desc`,
    [projectId]
  );
  return r.rows.map((row: any) => ({ id: String(row.id), citeKey: row.cite_key, title: row.title, authors: row.authors, source: row.source, url: row.url }));
}

export const ledgerService = { addFromResult, listEntries, updateRefs, deleteEntry, addCitation, listCitations };
