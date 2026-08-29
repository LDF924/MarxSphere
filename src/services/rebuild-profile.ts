// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// rebuild-profile.ts — 画像重建（2026-08-29, 移植自 Inno Agent rebuild-profile.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 行为对齐, 存储适配 MarxSphere learner_events 表
// 升级 L1 规则后, 从事件日志重放重建画像(使既有事件开始贡献上下文)
import { pool } from "../db/pool.js";
import { applyLearningEventToProfile, type LearnerProfile } from "./auto-profile.js";

/** 从 learner_events 表重放事件重建画像快照(与源码 rebuildProfileFromEvents 对齐) */
export async function rebuildProfileFromEvents(studentId = "default"): Promise<{ ok: boolean; applied: number; events: number }> {
  try {
    // 当前画像快照
    const snap = await pool.query(
      "select profile from learner_profile_snapshots where student_id=$1 order by created_at desc limit 1",
      [studentId]
    ).catch(() => ({ rows: [] }));
    const profile: LearnerProfile = snap.rows[0]?.profile || { goals: [], knowledge: [], misconceptions: [], preferences: {} };

    // 事件日志(按时间序)
    const events = await pool.query(
      "select event_type, payload, created_at from learner_events where student_id=$1 order by created_at",
      [studentId]
    ).catch(() => ({ rows: [] }));

    let applied = 0;
    for (const row of events.rows as Array<{ event_type: string; payload: unknown; created_at: Date }>) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const evt = {
        eventType: row.event_type,
        timestamp: new Date(row.created_at).toISOString(),
        conceptIds: Array.isArray(payload.concept_ids) ? payload.concept_ids as string[] : [],
        payload,
        derivedSignals: payload.derived_signals as any,
        eventId: `evt:${row.created_at.toISOString()}`,
      };
      if (applyLearningEventToProfile(profile, evt)) applied += 1;
    }

    // 保存重建快照
    if (applied > 0) {
      await pool.query(
        "insert into learner_profile_snapshots (student_id, profile) values ($1, $2::jsonb)",
        [studentId, JSON.stringify(profile)]
      ).catch(() => {});
    }
    return { ok: true, applied, events: events.rows.length };
  } catch (e: any) {
    return { ok: false, applied: 0, events: 0 };
  }
}

export const rebuildProfileService = { rebuildProfileFromEvents };
