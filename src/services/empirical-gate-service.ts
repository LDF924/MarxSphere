// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-gate-service.ts — 人工闸门状态机（V380+）
// 4 节点: topic | variable_definition | identification | result_interpretation
// 状态: draft(可编辑) → locked → confirmed; 退回 = 回 draft + 级联回退后续节点
// 唯一解锁路径是 reopen; 所有写操作先读状态
import { pool } from "../db/pool.js";
import { GuardError } from "./empirical-guards.js";

export const GATE_NODES = ["topic", "variable_definition", "identification", "result_interpretation"] as const;
export type GateNode = (typeof GATE_NODES)[number];

// 节点顺序（级联回退用: 回退 index 之前的节点, 之后全部回 draft）
const NODE_ORDER = ["topic", "variable_definition", "identification", "result_interpretation"];

interface GateRow {
  id: string; project_id: string; node: string; status: string; content: Record<string, unknown>;
  reopens: number; updated_at: Date;
}

async function getRow(projectId: string, node: string): Promise<GateRow | null> {
  const r = await pool.query(`select * from empirical_gates where project_id = $1::uuid and node = $2`, [projectId, node]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { id: String(row.id), project_id: String(row.project_id), node: row.node, status: row.status, content: row.content ?? {}, reopens: Number(row.reopens), updated_at: row.updated_at };
}

async function audit(projectId: string, gateId: string | null, action: string, before: unknown, after: unknown, note = ""): Promise<void> {
  await pool.query(
    `insert into empirical_gate_audit (project_id, gate_id, action, content_before, content_after, note)
     values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [projectId, gateId, action, JSON.stringify(before ?? {}), JSON.stringify(after ?? {}), note]
  );
}

export function toGateObj(row: GateRow): Record<string, unknown> {
  return {
    id: row.id, projectId: row.project_id, node: row.node, status: row.status,
    content: row.content, reopens: row.reopens, updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** 写入/更新草稿: 仅 draft 状态可写, 否则 400 GATE_LOCKED */
export async function upsertDraft(projectId: string, node: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!NODE_ORDER.includes(node)) throw new GuardError("BAD_REQUEST", `未知闸门节点: ${node}`);
  const cur = await getRow(projectId, node);
  if (cur && cur.status !== "draft") {
    throw new GuardError("GATE_LOCKED", `闸门「${node}」当前状态 ${cur.status}, 需先解锁(reopen)才能编辑`);
  }
  if (cur) {
    const r = await pool.query(
      `update empirical_gates set content = $2::jsonb, updated_at = now() where id = $1 returning *`,
      [cur.id, JSON.stringify(content)]
    );
    await audit(projectId, cur.id, "edit", cur.content, content);
    return toGateObj(r.rows[0]);
  }
  const r = await pool.query(
    `insert into empirical_gates (project_id, node, content) values ($1::uuid, $2, $3::jsonb) returning *`,
    [projectId, node, JSON.stringify(content)]
  );
  await audit(projectId, String(r.rows[0].id), "create", {}, content);
  return toGateObj(r.rows[0]);
}

/** 锁定: draft → locked */
export async function lockGate(projectId: string, node: string): Promise<Record<string, unknown>> {
  const cur = await getRow(projectId, node);
  if (!cur) throw new GuardError("GATE_LOCKED", `闸门「${node}」不存在, 请先保存草稿`);
  if (cur.status !== "draft") throw new GuardError("GATE_LOCKED", `闸门「${node}」状态 ${cur.status}, 只能从 draft 锁定`);
  const r = await pool.query(`update empirical_gates set status = 'locked', updated_at = now() where id = $1 returning *`, [cur.id]);
  await audit(projectId, cur.id, "lock", cur.content, r.rows[0].content);
  return toGateObj(r.rows[0]);
}

/** 确认: locked → confirmed（通过, 进入下一阶段） */
export async function confirmGate(projectId: string, node: string): Promise<Record<string, unknown>> {
  const cur = await getRow(projectId, node);
  if (!cur) throw new GuardError("GATE_LOCKED", `闸门「${node}」不存在`);
  if (cur.status !== "locked") throw new GuardError("GATE_LOCKED", `闸门「${node}」状态 ${cur.status}, 需先锁定`);
  const r = await pool.query(`update empirical_gates set status = 'confirmed', updated_at = now() where id = $1 returning *`, [cur.id]);
  await audit(projectId, cur.id, "confirm", cur.content, r.rows[0].content);
  return toGateObj(r.rows[0]);
}

/** 退回: confirmed/locked → draft, 级联回退后续节点, reopens+1 */
export async function reopenGate(projectId: string, node: string, note = ""): Promise<Record<string, unknown>> {
  const cur = await getRow(projectId, node);
  if (!cur) throw new GuardError("GATE_LOCKED", `闸门「${node}」不存在`);
  const idx = NODE_ORDER.indexOf(node);
  // 级联回退: 该节点及之后所有节点回 draft
  const cascade = NODE_ORDER.slice(idx);
  for (const n of cascade) {
    const g = await getRow(projectId, n);
    if (!g) continue;
    if (g.status === "draft") continue;
    const rr = await pool.query(`update empirical_gates set status = 'draft', reopens = reopens + 1, updated_at = now() where id = $1 returning *`, [g.id]);
    await audit(projectId, g.id, "reopen", g.content, rr.rows[0].content, note || `退回 ${node}, 级联回退 ${n}`);
  }
  return toGateObj((await getRow(projectId, node))!);
}

/** 列出项目全部闸门 */
export async function listGates(projectId: string): Promise<Record<string, unknown>[]> {
  const r = await pool.query(`select * from empirical_gates where project_id = $1::uuid order by created_at`, [projectId]);
  return r.rows.map((row: any) => toGateObj({
    id: String(row.id), project_id: String(row.project_id), node: row.node, status: row.status,
    content: row.content ?? {}, reopens: Number(row.reopens), updated_at: row.updated_at,
  }));
}

export const gateService = {
  upsertDraft, lockGate, confirmGate, reopenGate, listGates, getRow, toGateObj,
};
