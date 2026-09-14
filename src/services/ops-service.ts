// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ops-service.ts — 商业化阶段5: 运营（审计日志 + 差异化限流 + 管理端）
// V389+
import { pool } from "../db/pool.js";

// ─── 审计日志 ───
export async function recordAudit(entry: {
  userId?: string | null; username?: string | null; method: string; path: string;
  statusCode: number; durationMs: number; tokensUsed?: number; ip?: string;
  /** V417: 操作对象(用户 id / 令牌 id / 资源 id)。POST 的目标通常只在 body 里, 只记 path 等于没线索 */
  targetId?: string | null;
  /** V417: 操作详情(变更前后/原因等自由文本, 调用方给, 已脱敏) */
  detail?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `insert into audit_logs (user_id, username, method, path, status_code, duration_ms, tokens_used, ip, target_id, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.userId || null, entry.username || null, entry.method, entry.path, entry.statusCode, entry.durationMs, entry.tokensUsed || 0, entry.ip || null, entry.targetId || null, entry.detail || null]
    );
  } catch { /* 审计失败不阻塞 */ }
}

/**
 * V417: admin 高危操作的审计 —— 与 recordAudit 分开因为语义不同:
 *   · recordAudit 是"请求级"的(每个响应记一条, 记的是 HTTP 事实)
 *   · 本函数是"操作级"的(记的是"谁对谁做了什么"), 失败也**不吞**: 返回 false
 *     让调用方能决定是否回滚/报错 —— 改余额、重置密码这类操作"没记上"本身就是事故。
 */
export async function recordAdminAction(input: {
  adminUserId: string; adminUsername?: string | null; action: string;
  targetId: string; detail?: string; ip?: string;
}): Promise<boolean> {
  try {
    await pool.query(
      `insert into audit_logs (user_id, username, method, path, status_code, duration_ms, ip, target_id, detail)
       values ($1,$2,'ADMIN',$3,200,0,$4,$5,$6)`,
      [input.adminUserId, input.adminUsername ?? null, `/admin/${input.action}`,
       input.ip ?? null, input.targetId, input.detail ?? null]
    );
    return true;
  } catch (e) {
    console.error("[audit] admin 操作审计写入失败(操作已执行, 需人工补记):", String(e).slice(0, 140));
    return false;
  }
}

// ─── 差异化限流（按 plan） ───
// 计划 → 每分钟请求上限（free 严格, pro/enterprise 宽松）
export const PLAN_LIMITS: Record<string, { perMin: number; dailyTokens: number }> = {
  free: { perMin: 5, dailyTokens: 20_000 },
  pro: { perMin: 30, dailyTokens: 200_000 },
  enterprise: { perMin: 100, dailyTokens: 2_000_000 },
};

export async function getPlanLimit(userId: string): Promise<{ perMin: number; dailyTokens: number }> {
  try {
    const r = await pool.query("select plan from users where id = $1", [userId]);
    const plan = r.rows[0]?.plan || "free";
    return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  } catch { return PLAN_LIMITS.free; }
}

// ─── 管理端: 用户列表/用量汇总 ───
export async function adminUserStats(): Promise<any[]> {
  const r = await pool.query(
    `select u.id, u.username, u.email, u.role, u.plan, u.status, u.balance_cents, u.llm_provider, u.created_at,
            coalesce((select count(*) from billing_records b where b.user_id = u.id), 0) as bill_count,
            coalesce((select sum(cost_cents) from user_usage_log ul where ul.user_id = u.id), 0) as total_cost_cents
     from users u order by u.created_at desc limit 100`
  );
  return r.rows;
}

export async function adminUsageSummary(days = 7): Promise<any> {
  const r = await pool.query(
    `select to_char(created_at, 'MM-DD') as day, count(*) as requests,
            sum(tokens_input + tokens_output) as tokens, sum(cost_cents) as cost_cents
     from user_usage_log where created_at > now() - ($1 || ' days')::interval
     group by day order by day`,
    [String(Math.min(days, 90))]
  );
  return r.rows;
}

export async function adminAuditLogs(limit = 100): Promise<any[]> {
  const r = await pool.query(
    "select username, method, path, status_code, duration_ms, tokens_used, ip, created_at from audit_logs order by id desc limit $1",
    [Math.min(limit, 500)]
  );
  return r.rows;
}
