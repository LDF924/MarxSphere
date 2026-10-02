// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// notification-service.ts — 用户级站内通知
//
// 与 alert-service 的分工(见 migrations/175 的头注释):
//   alerts         = 运维事实, 全站一份, 无 user_id, 本机豁免
//   notifications  = 给某个人的消息, 按 user_id 隔离, 支持未读/已读
//
// ⚠ 与 alerts 最容易被搞混的一点: **本表的 info 会弹 toast**, alerts 的不会。
//   AlertToast.tsx 里 `filter(a => a.level !== "info")` 是有意的(运维 info 是噪音),
//   但"你的任务完成了"恰好就是 info 级 —— 写错表就永远弹不出来。
//   所以 `notifyTaskDone` 这类函数**必须**走本表, 不能走 recordAlert。
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";

/** 事件类别 —— 前端图标/分组/跳转都按它分派。
 *  新增取值时必须同步 web/src/components/NotificationsPanel.tsx 的 CATEGORY 表,
 *  否则界面会显示裸英文键名(AlertsPanel 漏登 `agent` 就是这个后果)。 */
export type NotificationCategory =
  | "task"      // Agent 任务完成/失败
  | "points"    // 积分变动/签到
  | "payment"   // 支付到账/退款
  | "digest"    // 研究速递有新内容
  | "system";   // 系统公告

export interface NotificationRow {
  id: string;
  category: string;
  level: string;
  title: string;
  body: string;
  link: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  level?: NotificationLevel;
  title: string;
  body?: string;
  /** 点击跳转: { view: "tasks", id?: "..." } */
  link?: Record<string, unknown>;
  /** 幂等键 `<事件类型>:<对象id>` —— 同用户同键只落一条 */
  dedupeKey?: string;
}

/** 全部类别 —— 设置界面与校验都用它, 不接受前端传任意串 */
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = ["task", "points", "payment", "digest", "system"];

/** 读取用户静音了哪些分类(空数组 = 全部接收) */
export async function getMutedCategories(userId: string): Promise<string[]> {
  const r = await pool.query(`select notification_muted from users where id=$1`, [userId]);
  const v = r.rows[0]?.notification_muted;
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * 设置静音分类。
 *
 * ⚠ 校验在服务端做: 只接受 NOTIFICATION_CATEGORIES 里的值。
 *   不校验的话, 前端一个拼错的分类名("digests")会被原样存下 ——
 *   既静音不了任何东西, 界面上又显示"已静音", 是个查不出来的假状态。
 */
export async function setMutedCategories(userId: string, muted: unknown): Promise<string[]> {
  const clean = (Array.isArray(muted) ? muted : [])
    .map(String)
    .filter((c) => (NOTIFICATION_CATEGORIES as string[]).includes(c));
  const deduped = [...new Set(clean)];
  await pool.query(`update users set notification_muted=$2::jsonb where id=$1`, [userId, JSON.stringify(deduped)]);
  return deduped;
}

/**
 * 写一条通知。**失败不抛** —— 通知属于副作用, 不该让它把主流程(任务完成/支付到账)带崩。
 *
 * 静音判断在这里做(而不是前端过滤): 通知是服务端写的, 只有这里能"根本不写库"。
 * 前端过滤只能做到"写了但不显示", 用户换个设备就会看到一堆自己关过的通知。
 * 查询失败时**按不静音处理**(宁可多写一条, 也不要因为偏好表读不到就把真通知吞了)。
 */
export async function notify(input: NotifyInput): Promise<void> {
  if (!input.userId) return;
  const dedupeKey = input.dedupeKey || null;
  try {
    try {
      const muted = await getMutedCategories(input.userId);
      if (muted.includes(input.category)) return;
    } catch { /* 见上: 读不到偏好不阻断通知 */ }
    // ⚠ ON CONFLICT 必须**带上索引的 WHERE 子句**。
    //   175 迁移建的是**部分唯一索引** `(user_id, dedupe_key) where dedupe_key is not null`;
    //   而 `on conflict (user_id, dedupe_key)` 只按列匹配, 找不到一个"不含 where 的"唯一约束,
    //   Postgres 直接报 `42P10: there is no unique or exclusion constraint matching the
    //   ON CONFLICT specification` —— 而本函数**吞异常**, 于是表现为"通知写了一条都没有,
    //   日志里什么都没有"。实测踩到过(同型: 哈希版本化那次的"部分索引不能作 arbiter")。
    //   写法: 冲突目标后跟 `where` + 索引谓词, 且**只在该键非空时才带** ——
    //   dedupe_key 为空的行本就不该被去重(索引也不收它们)。
    const sql = dedupeKey
      ? `insert into notifications (user_id, category, level, title, body, link, dedupe_key)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`
      : `insert into notifications (user_id, category, level, title, body, link, dedupe_key)
         values ($1, $2, $3, $4, $5, $6::jsonb, null)`;
    const params: unknown[] = [
      input.userId,
      input.category,
      input.level || "info",
      String(input.title || "").slice(0, 200),
      String(input.body || "").slice(0, 2000),
      JSON.stringify(input.link ?? {})
    ];
    // 只在有 dedupeKey 时补第 7 个参数 —— 无键那条分支的 SQL 里 dedupe_key 是字面 null,
    // 多传一个参数会报 "supplies 7 parameters, but prepared statement requires 6"
    if (dedupeKey) params.push(dedupeKey);
    await pool.query(sql, params);
  } catch (e: any) {
    // 仍然不抛(通知是副作用), 但**必须留痕** —— 静默吞掉正是上面那个 bug 藏了一整轮的原因
    logger.warn({ err: String(e?.message || e).slice(0, 160), category: input.category }, "通知写入失败");
  }
}

export async function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean; category?: string } = {}
): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (opts.unreadOnly) conds.push("read_at is null");
  if (opts.category) { params.push(opts.category); conds.push(`category = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(
    `select id, category, level, title, body, link, read_at, created_at
       from notifications where ${conds.join(" and ")}
      order by created_at desc limit $${params.length}`,
    params
  );
  return r.rows.map((row: any) => ({
    id: String(row.id),
    category: String(row.category || "system"),
    level: String(row.level || "info"),
    title: String(row.title || ""),
    body: String(row.body || ""),
    link: (row.link && typeof row.link === "object") ? row.link : {},
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : ""
  }));
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from notifications where user_id = $1 and read_at is null`,
    [userId]
  );
  return Number(r.rows[0]?.n) || 0;
}

/** 标记已读。ids 为空 = 全部已读(与 alert-service.markAlertsRead 同约定) */
export async function markNotificationsRead(userId: string, ids: string[] = []): Promise<number> {
  if (!ids.length) {
    const r = await pool.query(
      `update notifications set read_at = now() where user_id = $1 and read_at is null`,
      [userId]
    );
    return r.rowCount ?? 0;
  }
  const r = await pool.query(
    `update notifications set read_at = now()
      where user_id = $1 and read_at is null and id = any($2::uuid[])`,
    [userId, ids]
  );
  return r.rowCount ?? 0;
}

/** 清掉已读(只删自己的; 与全局 alerts 的 clearReadAlerts 不同, 这里按 user 限定) */
export async function clearReadNotifications(userId: string): Promise<number> {
  const r = await pool.query(
    `delete from notifications where user_id = $1 and read_at is not null`,
    [userId]
  );
  return r.rowCount ?? 0;
}

// ═══════════════ 具体事件的通知封装 ═══════════════
// 把这些放在 service 里而不是散在调用点, 是为了让"什么事件该通知、语气如何、链到哪"
// 只有一处定义。调用点只管传 id。

/** Agent 任务完成。
 *
 *  取代原先写 `alerts(level=info) + category=agent` 的做法 —— 那条通知**永远弹不出来**
 *  (AlertToast 过滤 info), 且告警中心因 CATEGORY_LABELS 缺 agent 键而显示英文。
 */
export async function notifyTaskDone(input: {
  userId: string; taskId: string; goal: string; reflectScore?: number;
}): Promise<void> {
  if (!input.userId) return;
  await notify({
    userId: input.userId,
    category: "task",
    // success 而不是 info: 任务是用户主动发起并等待的, 完成值得一次正向反馈
    level: "success",
    title: `任务完成: ${String(input.goal || "").slice(0, 40)}`,
    body: input.reflectScore !== undefined ? `自评得分 ${input.reflectScore}` : "",
    link: { view: "tasks", id: input.taskId },
    dedupeKey: `task_done:${input.taskId}`
  });
}

/** Agent 任务失败 —— 这个必须让用户知道(比成功更需要) */
export async function notifyTaskFailed(input: {
  userId: string; taskId: string; goal: string; reason?: string;
}): Promise<void> {
  if (!input.userId) return;
  await notify({
    userId: input.userId,
    category: "task",
    level: "error",
    title: `任务失败: ${String(input.goal || "").slice(0, 40)}`,
    body: String(input.reason || "").slice(0, 300),
    link: { view: "tasks", id: input.taskId },
    dedupeKey: `task_failed:${input.taskId}`
  });
}

/** 积分变动(签到/兑换/邀请奖励) —— 按天幂等, 同一天签到两次只留一条 */
export async function notifyPoints(input: {
  userId: string; delta: number; reason: string; balance?: number; dayKey: string;
}): Promise<void> {
  if (!input.userId) return;
  const sign = input.delta >= 0 ? "+" : "";
  await notify({
    userId: input.userId,
    category: "points",
    level: "info",
    title: `${sign}${input.delta} 积分 · ${input.reason}`,
    body: input.balance !== undefined ? `当前余额 ${input.balance}` : "",
    link: { view: "billing" },
    dedupeKey: `points:${input.dayKey}:${input.reason}`
  });
}

/** 研究速递有新内容 —— 按天幂等 */
export async function notifyDigestReady(input: {
  userId: string; dayKey: string; count: number;
}): Promise<void> {
  if (!input.userId || input.count <= 0) return;
  await notify({
    userId: input.userId,
    category: "digest",
    level: "info",
    title: `研究速递: ${input.count} 篇新文献`,
    body: "在你的订阅主题下发现新内容",
    link: { view: "digest" },
    dedupeKey: `digest:${input.dayKey}`
  });
}

export const notificationService = {
  notify, listNotifications, unreadNotificationCount,
  markNotificationsRead, clearReadNotifications,
  notifyTaskDone, notifyTaskFailed, notifyPoints, notifyDigestReady
};
