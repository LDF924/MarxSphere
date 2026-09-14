// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-scheduler.ts — V395-9: Agent 定时任务
// agent_scheduled_tasks 表（迁移 059）: goal/cron/next_run/enabled
// 每分钟检查: 到期(cron 匹配当前分钟) → 创建 agent 任务 → 更新 next_run/last_run
// cron 格式: "分 时 日 月 周"（5 字段, 本地时区, 分钟级精度）; 支持 * 和逗号列表
import { pool } from "../db/pool.js";
import { agentTaskService } from "./agent-task-service.js";

export interface ScheduledAgentTask {
  id: string;
  goal: string;
  cron: string;
  nextRun?: Date;
  lastRunAt?: Date;
  lastTaskId?: string;
  enabled: boolean;
  createdAt: Date;
}

function mapRow(row: any): ScheduledAgentTask {
  return {
    id: row.id,
    goal: row.goal,
    cron: row.cron,
    nextRun: row.next_run || undefined,
    lastRunAt: row.last_run_at || undefined,
    lastTaskId: row.last_task_id || undefined,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

/** 校验 cron 表达式（5 字段; 每字段 * 或 数字/逗号列表; 值域: 分0-59 时0-23 日1-31 月1-12 周0-6） */
export function validateCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.every((p, i) => {
    if (p === "*") return true;
    if (!/^(\d+)(,\d+)*$/.test(p)) return false;
    return p.split(",").every((n) => {
      const v = parseInt(n, 10);
      const [min, max] = ranges[i];
      return !isNaN(v) && v >= min && v <= max;
    });
  });
}

/** cron 字段是否匹配当前值（* 或包含该值; 周字段: 0/7 都视为周日） */
function cronMatchesField(field: string, value: number): boolean {
  if (field === "*") return true;
  const vals = field.split(",").map((n) => parseInt(n, 10));
  if (field === "0" || field === "7") return vals.includes(0) || vals.includes(7);  // 周字段 0/7 = 周日
  return vals.includes(value);
}

/** 计算下次执行时间（严格在当前时间之后）— 分钟级扫描, 上限 366 天 */
export function nextCronRun(cron: string, from = new Date()): Date | null {
  if (!validateCron(cron)) return null;
  const [minF, hourF, domF, monF, dowF] = cron.trim().split(/\s+/);
  for (let i = 1; i < 366 * 24 * 60; i++) {  // i 从 1 开始: 下次执行严格 > now（避免 next_run 即时过期重复触发）
    const t = new Date(from.getTime() + i * 60_000);
    if (
      cronMatchesField(minF, t.getMinutes()) &&
      cronMatchesField(hourF, t.getHours()) &&
      cronMatchesField(domF, t.getDate()) &&
      cronMatchesField(monF, t.getMonth() + 1) &&
      cronMatchesField(dowF, t.getDay())
    ) return t;
  }
  return null;
}

/** 创建定时任务 */
export async function createScheduledAgentTask(input: { goal: string; cron: string }): Promise<ScheduledAgentTask> {
  if (!input.goal?.trim()) throw new Error("goal 必填");
  if (!validateCron(input.cron)) throw new Error("cron 格式无效（5 字段: 分 时 日 月 周, 如 '0 9 * * *'）");
  const next = nextCronRun(input.cron);
  const r = await pool.query(
    `insert into agent_scheduled_tasks (goal, cron, next_run, enabled)
     values ($1, $2, $3, true) returning *`,
    [input.goal.trim(), input.cron.trim(), next]
  );
  return mapRow(r.rows[0]);
}

/** 列表 */
export async function listScheduledAgentTasks(): Promise<ScheduledAgentTask[]> {
  const r = await pool.query("select * from agent_scheduled_tasks order by enabled desc, next_run asc");
  return r.rows.map(mapRow);
}

/** 删除 */
export async function deleteScheduledAgentTask(id: string): Promise<boolean> {
  const r = await pool.query("delete from agent_scheduled_tasks where id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 启用/禁用 */
export async function setScheduledAgentTaskEnabled(id: string, enabled: boolean): Promise<ScheduledAgentTask | null> {
  const r = await pool.query(
    "update agent_scheduled_tasks set enabled = $2, next_run = case when $2 then next_run else null end, updated_at = now() where id = $1 returning *",
    [id, enabled]
  );
  return r.rows.length > 0 ? mapRow(r.rows[0]) : null;
}

/** 调度器一次 tick: 找出到期(enabled + next_run <= now)的定时任务 → 创建 agent 任务
 *
 *  多副本原子性(V417): 原先"select 到期 → 逐个 createAgentTask → update next_run"三步非原子,
 *  两个副本同时 tick 会把同一个定时任务**创建两次**(若 goal 是每日研究类, 就是双倍 LLM 消耗)。
 *  现在先用 `for update skip locked` 在事务里把到期的行锁住, 再创建 —— 同一行只有一个副本能碰到。
 *  跨副本只跑一次这件事**不能**交给进程内标志位。
 */
async function tickOnce(): Promise<Array<{ scheduledId: string; taskId: string; goal: string }>> {
  const client = await pool.connect();
  let rows: any[] = [];
  try {
    await client.query("begin");
    const r = await client.query(
      `select * from agent_scheduled_tasks
       where enabled = true and (next_run is null or next_run <= now())
       order by next_run asc nulls first limit 10
       for update skip locked`
    );
    rows = r.rows;
    // 立刻把 next_run 推进到下一轮并提交 —— 锁在事务结束即释放, 但 next_run 已不再是"到期",
    //   别的副本即使随后读到也看不到它了。创建任务放在提交之后(创建可能慢/可能抛, 不该占着锁)。
    for (const row of r.rows) {
      const sched = mapRow(row);
      const next = nextCronRun(sched.cron);
      await client.query(`update agent_scheduled_tasks set next_run = $2 where id = $1`, [sched.id, next]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const triggered: Array<{ scheduledId: string; taskId: string; goal: string }> = [];
  for (const row of rows) {
    const sched = mapRow(row);
    try {
      // 触发 → 创建 agent 任务（状态 planning, 不自动 run — 由用户从任务面板启动, 避免后台消耗）
      const task = await agentTaskService.createAgentTask({ goal: sched.goal });
      await pool.query(
        `update agent_scheduled_tasks set last_run_at = now(), last_task_id = $2 where id = $1`,
        [sched.id, task.id]
      );
      triggered.push({ scheduledId: sched.id, taskId: task.id, goal: sched.goal });
      console.log(`[agent-scheduler] 触发定时任务 ${sched.id} → agent 任务 ${task.id.slice(0, 8)}（${sched.goal.slice(0, 40)}）`);
    } catch (e: any) {
      // next_run 已在上面的原子段推进过, 这里不再重复推进(原先失败分支再推一次, 反而会双重跳跃)
      console.warn(`[agent-scheduler] 定时任务 ${sched.id} 触发失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return triggered;
}

/** 启动调度器（每分钟 tick; 服务启动时调用） */
export function startScheduler(intervalMs = 60_000): NodeJS.Timeout {
  // 启动先跑一次（恢复错过的到期任务）
  void tickOnce().catch((e: any) => console.warn("[agent-scheduler] 启动 tick 失败:", e?.message?.slice(0, 100)));
  const timer = setInterval(() => {
    void tickOnce().catch((e: any) => console.warn("[agent-scheduler] tick 失败:", e?.message?.slice(0, 100)));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export const agentScheduler = {
  createScheduledAgentTask,
  listScheduledAgentTasks,
  deleteScheduledAgentTask,
  setScheduledAgentTaskEnabled,
  validateCron,
  nextCronRun,
  startScheduler,
};
