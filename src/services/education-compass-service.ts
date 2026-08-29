// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-compass-service.ts — Compass 记忆治理(V390, 2026-08-30, 借鉴 TraitTutor Reflection/Compass)
// 对照 TraitTutor:
//   1. 偏好三态: explicit(永久) / inferred(90天TTL) / rejected(反偏好→约束)
//   2. 候选→确认门: 推断内容需用户确认或 ≥2 条独立证据才进 Compass
//   3. 边界声明随数据走: "Personalization cues adjust teaching strategy only; they do not diagnose or measure ability."
// 迁移: 099_memory_preferences.sql
import { pool } from "../db/pool.js";

/** 推断偏好 TTL(天) — TraitTutor: 显式永不失效, 推断 90 天过期 */
const INFERRED_TTL_DAYS = 90;
/** 激活证据门槛 — TraitTutor ACTIVATION_EVIDENCE_THRESHOLD = 2 */
const ACTIVATION_EVIDENCE_THRESHOLD = 2;

export interface Preference {
  id: string;
  studentId: string;
  scope: "global" | "subject";
  subject: string | null;
  key: string;
  value: string;
  state: "explicit" | "inferred" | "rejected";
  confidence: number;
  evidenceCount: number;
  source: string;
  expiresAt: string | null;
}

/** 记录/更新一条偏好(幂等: 同 key 合并) */
export async function recordPreference(input: {
  studentId?: string;
  scope?: "global" | "subject";
  subject?: string;
  key: string;
  value: string;
  state?: "explicit" | "inferred" | "rejected";
  confidence?: number;
  source?: string;
  evidenceRefs?: string[];
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const scope = input.scope || "global";
  const state = input.state || "inferred";
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));
  // 显式永不失效; 推断 90 天 TTL
  const expiresAt = state === "explicit" ? null : new Date(Date.now() + INFERRED_TTL_DAYS * 86_400_000).toISOString();

  const existing = await pool.query(
    `select id, state, evidence_count, evidence_refs from memory_preferences
     where student_id = $1 and scope = $2 and coalesce(subject, '') = coalesce($3, '') and key = $4`,
    [studentId, scope, input.subject ?? null, input.key]
  ).catch(() => ({ rows: [] }));

  if (existing.rows.length > 0) {
    const prev = existing.rows[0];
    const mergedState = state === "explicit" || prev.state === "explicit" ? "explicit"
      : state === "rejected" || prev.state === "rejected" ? "rejected" : "inferred";
    const mergedRefs = [...new Set([...(prev.evidence_refs || []), ...(input.evidenceRefs || [])])].slice(0, 12);
    await pool.query(
      `update memory_preferences set value = $1, state = $2, confidence = $3, evidence_count = $4,
         evidence_refs = $5::jsonb, source = $6, expires_at = $7, updated_at = now() where id = $8`,
      [input.value, mergedState, confidence, mergedRefs.length, JSON.stringify(mergedRefs), input.source || "inference", expiresAt, prev.id]
    );
    return { ok: true, id: prev.id, state: mergedState, evidenceCount: mergedRefs.length, merged: true };
  }

  const r = await pool.query(
    `insert into memory_preferences (student_id, scope, subject, key, value, state, confidence, evidence_count, evidence_refs, source, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning *`,
    [studentId, scope, input.subject ?? null, input.key, input.value, state, confidence,
     (input.evidenceRefs || []).length, JSON.stringify(input.evidenceRefs || []), input.source || "inference", expiresAt]
  );
  return { ok: true, id: r.rows[0].id, state, evidenceCount: (input.evidenceRefs || []).length, merged: false };
}

/** 用户确认/拒绝偏好(确认本身即一条可审计证据) */
export async function decidePreference(input: { id?: string; studentId?: string; key?: string; decision: "confirm" | "reject"; note?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = input.id
    ? await pool.query("select * from memory_preferences where id = $1", [input.id]).catch(() => ({ rows: [] }))
    : await pool.query("select * from memory_preferences where student_id = $1 and key = $2 order by updated_at desc limit 1", [studentId, input.key]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { ok: false, error: "偏好不存在" };
  const pref = r.rows[0];
  if (input.decision === "confirm") {
    await pool.query(
      `update memory_preferences set state = 'explicit', confidence = 1, source = 'user_confirmed',
         evidence_count = greatest(evidence_count, 1), expires_at = null,
         evidence_refs = evidence_refs || $2::jsonb, updated_at = now() where id = $1`,
      [pref.id, JSON.stringify([`user:confirm:${input.note || ""}`])]
    );
  } else {
    await pool.query(
      `update memory_preferences set state = 'rejected', source = 'user_rejected', confidence = 1,
         evidence_refs = evidence_refs || $2::jsonb, updated_at = now() where id = $1`,
      [pref.id, JSON.stringify([`user:reject:${input.note || ""}`])]
    );
  }
  return { ok: true, id: pref.id, state: input.decision === "confirm" ? "explicit" : "rejected" };
}

/** 追加独立证据(≥2 条 → 可激活) */
export async function addPreferenceEvidence(input: { id?: string; studentId?: string; key?: string; evidenceRef: string }): Promise<Record<string, unknown>> {
  const r = input.id
    ? await pool.query("select * from memory_preferences where id = $1", [input.id]).catch(() => ({ rows: [] }))
    : await pool.query("select * from memory_preferences where student_id = $1 and key = $2 order by updated_at desc limit 1", [input.studentId || "default", input.key]).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { ok: false, error: "偏好不存在" };
  const pref = r.rows[0];
  const refs = [...new Set([...(pref.evidence_refs || []), input.evidenceRef])].slice(0, 12);
  await pool.query(
    `update memory_preferences set evidence_count = $2, evidence_refs = $3::jsonb, updated_at = now() where id = $1`,
    [pref.id, refs.length, JSON.stringify(refs)]
  );
  return { ok: true, evidenceCount: refs.length, activatable: refs.length >= ACTIVATION_EVIDENCE_THRESHOLD && pref.state !== "rejected" };
}

/**
 * 编译 Compass(任务级最小个性化输入, TraitTutor Hermes.apply)
 * - 只编译 confirmed(explicit) 且未过期的偏好
 * - rejected 作为约束(反偏好)进入
 * - 返回带版本号与证据引用的结构化输入, 自带边界声明
 */
export async function buildCompass(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const r = await pool.query(
    `select * from memory_preferences
     where student_id = $1 and (expires_at is null or expires_at > now())
     order by scope desc, updated_at desc limit 30`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  const preferences: Array<{ key: string; value: string; state: string; confidence: number; evidenceRefs: string[] }> = [];
  const constraints: string[] = [];
  for (const row of r.rows) {
    if (row.subject && input.subject && row.subject !== input.subject) continue;  // subject 隔离
    if (row.state === "rejected") { constraints.push(`${row.key}: ${row.value}`); continue; }
    // 候选→确认门: explicit 直接进; inferred 需证据数 ≥2
    if (row.state === "inferred" && row.evidence_count < ACTIVATION_EVIDENCE_THRESHOLD) continue;
    preferences.push({ key: row.key, value: row.value, state: row.state, confidence: Number(row.confidence), evidenceRefs: row.evidence_refs || [] });
  }

  return {
    ok: true,
    compass: {
      version: 1,
      purpose: "teaching_strategy",
      preferences,
      constraints,
      evidenceCount: preferences.reduce((a, p) => a + p.evidenceRefs.length, 0),
      boundary: "Personalization cues adjust teaching strategy only; they do not diagnose or measure ability.",
    },
  };
}

/** 偏好列表(前端展示/管理) */
export async function listPreferences(input: { studentId?: string }): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `select * from memory_preferences where student_id = $1 order by updated_at desc limit 50`,
    [input.studentId || "default"]
  ).catch(() => ({ rows: [] }));
  return { ok: true, preferences: r.rows };
}

// ═══ V392: 删除与重建(源码移植 personalization/service.py delete_evidence + _rebuild_profiles_locked) ═══
// 删除语义: 从审计表移除信号(含级联: payload 引用它的派生), 然后清空偏好表按剩余记录从头重放重建
// 不提供"编辑", 只提供删除 + 确定性重建 — 派生状态永远可重放
export async function deletePreference(input: { id?: string; studentId?: string; key?: string }): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // 1. 定位目标(id 优先, 否则按 key)
    let target: any = null;
    if (input.id) {
      const r = await client.query("select * from memory_preferences where id = $1", [input.id]);
      target = r.rows[0] || null;
    } else if (input.key) {
      const r = await client.query("select * from memory_preferences where student_id = $1 and key = $2 order by updated_at desc limit 1", [input.studentId || "default", input.key]);
      target = r.rows[0] || null;
    }
    if (!target) return { ok: false, error: "偏好不存在" };

    // 2. 删除目标(级联: 无派生表, memory_preferences 即事实)
    await client.query("delete from memory_preferences where id = $1", [target.id]);

    // 3. 从头重放重建(源码 _rebuild_profiles_locked: 清空后按存储序重放)
    //    memory_preferences 本身即"信号+档案"合一, 删除后无需重放(无派生视图),
    //    但保留语义: 返回剩余偏好供前端同步
    const remaining = await client.query(
      "select * from memory_preferences where student_id = $1 order by updated_at, id",
      [target.student_id]
    );
    await client.query("commit");
    return { ok: true, deleted: target.id, remaining: remaining.rows.length, cascade: false };
  } catch (e: any) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally {
    client.release();
  }
}

export const educationCompassService = { recordPreference, decidePreference, addPreferenceEvidence, buildCompass, listPreferences, deletePreference, ACTIVATION_EVIDENCE_THRESHOLD };
