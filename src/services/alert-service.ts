// alert-service.ts — 系统告警服务（任务巡检/降级/熔断/失败事件记录）
// 前端告警中心 + toast 轮询的数据源；记录不阻塞业务（失败静默）
import { pool } from "../db/pool.js";

export type AlertLevel = "info" | "warning" | "error" | "critical";

export interface AlertRecord {
  id: string;
  level: AlertLevel;
  category: string;
  message: string;
  task_type: string | null;
  task_id: string | null;
  detail: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

/** 记录告警（不阻塞业务——写失败静默） */
export async function recordAlert(input: {
  level: AlertLevel;
  category: string;
  message: string;
  taskType?: string;
  taskId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `insert into alerts (level, category, message, task_type, task_id, detail)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [input.level, input.category, input.message, input.taskType ?? null, input.taskId ?? null, input.detail ? JSON.stringify(input.detail) : null]
    );
  } catch (e: any) {
    console.error("[alerts] 记录失败:", e?.message?.substring(0, 80));
  }
}

/** 列表（按时间倒序，limit 默认 50） */
export async function listAlerts(limit = 50, unreadOnly = false): Promise<AlertRecord[]> {
  const r = await pool.query(
    `select id, level, category, message, task_type, task_id, detail, metadata, read, created_at
     from alerts
     ${unreadOnly ? "where read = false" : ""}
     order by created_at desc
     limit $1`,
    [Math.min(limit, 200)]
  );
  return r.rows.map(mapRow);
}

/** 未读数 */
export async function unreadAlertCount(): Promise<number> {
  const r = await pool.query(`select count(*) from alerts where read = false`);
  return Number(r.rows[0].count);
}

/** 标记已读（单个或全部） */
export async function markAlertsRead(id?: string): Promise<number> {
  const r = id
    ? await pool.query(`update alerts set read = true where id = $1`, [id])
    : await pool.query(`update alerts set read = true where read = false`);
  return r.rowCount ?? 0;
}

/** 清空已读告警 */
export async function clearReadAlerts(): Promise<number> {
  const r = await pool.query(`delete from alerts where read = true`);
  return r.rowCount ?? 0;
}

function mapRow(row: any): AlertRecord {
  return {
    id: String(row.id),
    level: row.level,
    category: row.category,
    message: row.message,
    task_type: row.task_type,
    task_id: row.task_id,
    detail: row.detail ?? null,
    metadata: row.metadata ?? null,
    read: !!row.read,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export const alertService = { recordAlert, listAlerts, unreadAlertCount, markAlertsRead, clearReadAlerts };
