// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// task-monitor-service.ts — 任务巡检监控（评测/分析/检索等任务的卡死检测 + 慢查询告警）
// 启动定时巡检: query_tasks 非终态任务超过阈值无更新 → 标记失败 + 告警
// 推理完成时: 慢查询(>30s) → 告警
import { pool } from "../db/pool.js";
import { recordAlert } from "./alert-service.js";

/** 非终态状态（任务还在跑） */
const ACTIVE_STATUSES = ["pending", "outlining", "running", "processing", "queued", "retrieving", "generating"];

/** 卡死阈值：超过 N 秒无更新视为卡死（默认 5 分钟） */
const STUCK_THRESHOLD_MS = parseInt(process.env.TASK_STUCK_MS || "300000", 10);

/** 慢查询阈值（推理/检索超过此时间告警） */
const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || "30000", 10);

/** 巡检一次：找卡死的活跃任务 → 标记失败 + 告警 */
export async function patrolOnce(): Promise<{ checked: number; stuck: number; alerted: string[] }> {
  const result = { checked: 0, stuck: 0, alerted: [] as string[] };
  try {
    const r = await pool.query(
      `select id, query, status, started_at, updated_at
       from query_tasks
       where status = any($1::text[])
         and updated_at < now() - make_interval(secs => $2)
       order by updated_at
       limit 20`,
      [ACTIVE_STATUSES, STUCK_THRESHOLD_MS / 1000]
    );
    result.checked = r.rows.length;
    for (const task of r.rows) {
      // 标记失败（不物理删除，保留现场）
      await pool.query(
        `update query_tasks set status = 'failed', error = $2, completed_at = now(), updated_at = now() where id = $1`,
        [task.id, `任务卡死自动标记（${Math.round(STUCK_THRESHOLD_MS / 60000)} 分钟无更新）`]
      );
      result.stuck++;
      result.alerted.push(String(task.id));
      await recordAlert({
        level: "error",
        category: "failure",
        message: `任务卡死已标记失败：${(task.query ?? "").substring(0, 50)}（${Math.round(STUCK_THRESHOLD_MS / 60000)} 分钟无更新）`,
        taskType: "reason",
        taskId: String(task.id),
        detail: { status: task.status, startedAt: task.started_at },
      });
    }
  } catch (e: any) {
    console.error("[task-monitor] 巡检失败:", e?.message?.substring(0, 80));
  }
  return result;
}

/** 推理完成时调用：慢查询告警 */
export async function reportQueryTiming(taskId: string, query: string, durationMs: number): Promise<void> {
  if (durationMs < SLOW_QUERY_MS) return;
  await recordAlert({
    level: "warning",
    category: "timeout",
    message: `慢查询：${(query ?? "").substring(0, 50)} 耗时 ${(durationMs / 1000).toFixed(1)}s（>${SLOW_QUERY_MS / 1000}s）`,
    taskType: "reason",
    taskId,
    detail: { durationMs, thresholdMs: SLOW_QUERY_MS },
  });
}

/** 评测/批量任务完成时：记录完成事件（info） */
export async function reportTaskCompletion(taskType: string, message: string, taskId?: string, detail?: Record<string, unknown>): Promise<void> {
  await recordAlert({
    level: "info",
    category: "success",
    message,
    taskType,
    taskId,
    detail,
  });
}

let patrolTimer: NodeJS.Timeout | null = null;

/** V393-3: 服务启动恢复 — 扫描中断的 Agent 任务（running/awaiting_approval）标记 interrupted
 * 说明: 服务重启后无法续跑原进程内的执行循环, 但保留任务现场供用户查看/手动重跑
 */
export async function recoverInterruptedAgentTasks(): Promise<{ recovered: number }> {
  try {
    const r = await pool.query(
      `update agent_tasks set status = 'failed', progress = '服务重启导致中断（可重新运行）', updated_at = now()
       where status in ('running', 'planning')`
    );
    // awaiting_approval 的任务保留挂起状态（审批请求仍有效, 用户批准后重新 run 从挂起步继续）
    if ((r.rowCount ?? 0) > 0) {
      console.log(`[task-monitor] V393-3 启动恢复: ${r.rowCount} 个中断任务已标记`);
    }
    return { recovered: r.rowCount ?? 0 };
  } catch {
    return { recovered: 0 };
  }
}

/** 启动定时巡检（每 2 分钟一次）+ V393-3 启动时恢复中断任务 */
export function startTaskPatrol(intervalMs = 120_000): void {
  // V393-3: 启动时先恢复中断任务
  void recoverInterruptedAgentTasks().then((r) => {
    if (r.recovered > 0) console.log(`[task-monitor] 启动恢复完成: ${r.recovered} 个任务标记中断`);
  });
  if (patrolTimer) return;
  patrolTimer = setInterval(() => {
    void patrolOnce().then((r) => {
      if (r.stuck > 0) console.log(`[task-monitor] 巡检: ${r.stuck} 个卡死任务已标记失败`);
    });
  }, intervalMs);
  patrolTimer.unref?.();
  console.log(`[task-monitor] 巡检已启动（每 ${intervalMs / 1000}s，卡死阈值 ${STUCK_THRESHOLD_MS / 60000} 分钟）`);
}

export const taskMonitorService = { patrolOnce, reportQueryTiming, reportTaskCompletion, startTaskPatrol, recoverInterruptedAgentTasks };
