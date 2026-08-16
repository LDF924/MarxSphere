// quota-service.ts — API 令牌配额治理（配额配置 + 用量流水）
// 配套迁移: migrations/036_token_quotas.sql (token_quotas / token_usage)
// 语义: 0 = 不限制; 无配额行 = 默认值(惰性插入); 仅外部持 token 请求记账(本机豁免)
// 成本口径: in/1e6*0.3 + out/1e6*1.2 (与 cost-service.ts 同价)
import { pool } from "../db/pool.js";

export type QuotaKind = "search" | "ingest" | "reason" | "other" | "p2o";

export interface QuotaConfig {
  dailySearchLimit: number;        // 每日搜索次数上限 (0=不限制)
  dailyIngestBytesLimit: number;   // 每日入库字节上限 (0=不限制)
  monthlyCostLimitUsd: number;     // 每月成本上限 USD (0=不限制)
  rateLimitPerMin: number;         // 令牌级限流 次/分钟 (0=用全局默认)
  dailyP2oLimit: number;           // V395-11: 每日 PDF2Obsidian 任务数上限 (0=不限制)
}

export interface QuotaStatus extends QuotaConfig {
  searchesToday: number;           // 今日已用(ok + blocked)
  blockedSearches: number;         // 被拒计数
  ingestBytesToday: number;        // 今日已入库字节
  p2oTasksToday: number;           // V395-11: 今日 P2O 任务数
  costThisMonth: number;           // 本月成本($)
  overSearchQuota: boolean;
  overIngestQuota: boolean;
  overCostQuota: boolean;
  overP2oQuota: boolean;           // V395-11
  retryAfterSec: number;           // 0 = 未超限
}

const COST_PER_M_IN = parseFloat(process.env.COST_PER_M_TOKEN_IN || "0.3");
const COST_PER_M_OUT = parseFloat(process.env.COST_PER_M_TOKEN_OUT || "1.2");

const DEFAULTS: QuotaConfig = {
  dailySearchLimit: 1000,
  dailyIngestBytesLimit: 104_857_600, // 100MB
  monthlyCostLimitUsd: 10,
  rateLimitPerMin: 60,
  dailyP2oLimit: 20,  // V395-11: 默认每日 20 个 P2O 任务
};

/** 成本折算: 真实 tokens → USD */
export function calcCostUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1e6) * COST_PER_M_IN + (tokensOut / 1e6) * COST_PER_M_OUT;
}

/** 读配额; 无行则惰性插入默认行后返回默认值 */
export async function getQuota(tokenId: string): Promise<QuotaConfig> {
  const r = await pool.query(
    `select daily_search_limit, daily_ingest_bytes_limit, monthly_cost_limit_usd, rate_limit_per_min, daily_p2o_limit
     from token_quotas where token_id = $1`,
    [tokenId]
  );
  if (r.rows[0]) {
    return {
      dailySearchLimit: Number(r.rows[0].daily_search_limit),
      dailyIngestBytesLimit: Number(r.rows[0].daily_ingest_bytes_limit),
      monthlyCostLimitUsd: Number(r.rows[0].monthly_cost_limit_usd),
      rateLimitPerMin: Number(r.rows[0].rate_limit_per_min),
      dailyP2oLimit: Number(r.rows[0].daily_p2o_limit ?? DEFAULTS.dailyP2oLimit),
    };
  }
  // 惰性插入默认行 (并发下重复插入由主键冲突吞掉)
  await pool.query(
    `insert into token_quotas (token_id) values ($1) on conflict (token_id) do nothing`,
    [tokenId]
  ).catch(() => {});
  return { ...DEFAULTS };
}

/** upsert 更新; undefined 字段不改 (PATCH 语义) */
export async function updateQuota(tokenId: string, patch: Partial<QuotaConfig>): Promise<QuotaConfig> {
  const fields: string[] = [];
  const values: unknown[] = [tokenId];
  const set: Record<string, number | undefined> = {
    daily_search_limit: patch.dailySearchLimit,
    daily_ingest_bytes_limit: patch.dailyIngestBytesLimit,
    monthly_cost_limit_usd: patch.monthlyCostLimitUsd,
    rate_limit_per_min: patch.rateLimitPerMin,
    daily_p2o_limit: patch.dailyP2oLimit,  // V395-11
  };
  for (const [col, v] of Object.entries(set)) {
    if (v !== undefined) {
      values.push(v);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (fields.length > 0) {
    await pool.query(
      `insert into token_quotas (token_id) values ($1) on conflict (token_id) do nothing`,
      [tokenId]
    ).catch(() => {});
    await pool.query(
      `update token_quotas set ${fields.join(", ")}, updated_at = now() where token_id = $1`,
      values
    );
  }
  return getQuota(tokenId);
}

/** 配额预检。超限返回 blocked=true + retryAfterSec + 完整状态 */
export async function ensureWithinQuota(
  tokenId: string,
  kind: QuotaKind,
  opts: { estimatedBytes?: number } = {}
): Promise<{ blocked: boolean; retryAfterSec?: number; quotaStatus?: QuotaStatus }> {
  const quota = await getQuota(tokenId);
  const r = await pool.query(
    `select
       (select count(*)::int from token_usage where token_id = $1 and usage_date = current_date and status = 'ok' and endpoint = 'search') as searches_today,
       (select coalesce(sum(estimated_bytes), 0)::bigint from token_usage where token_id = $1 and usage_date = current_date and endpoint = 'ingest') as ingest_bytes_today,
       (select count(*)::int from token_usage where token_id = $1 and usage_date = current_date and status = 'ok' and endpoint = 'p2o') as p2o_tasks_today,
       (select coalesce(sum(estimated_cost_usd), 0)::numeric from token_usage where token_id = $1 and usage_month = to_char(current_date, 'YYYY-MM')) as cost_month
     `,
    [tokenId]
  );
  const row = r.rows[0];
  const searchesToday = Number(row.searches_today);
  const ingestBytesToday = Number(row.ingest_bytes_today);
  const p2oTasksToday = Number(row.p2o_tasks_today);  // V395-11
  const costThisMonth = Number(row.cost_month);

  // 本次调用尚未记账, 预检需把即将发生的一并算上
  const projectedBytes = kind === "ingest" ? ingestBytesToday + (opts.estimatedBytes ?? 0) : ingestBytesToday;

  let blocked = false;
  let retryAfterSec = 0;
  const overSearchQuota = quota.dailySearchLimit > 0 && searchesToday >= quota.dailySearchLimit && kind === "search";
  const overIngestQuota = quota.dailyIngestBytesLimit > 0 && projectedBytes > quota.dailyIngestBytesLimit;
  const overP2oQuota = quota.dailyP2oLimit > 0 && p2oTasksToday >= quota.dailyP2oLimit && kind === "p2o";  // V395-11
  // V381 fix: cost 超限用 > (严格超过才拦, 避免刚好等于限额被误拦)
  const overCostQuota = quota.monthlyCostLimitUsd > 0 && costThisMonth > quota.monthlyCostLimitUsd;

  if (overSearchQuota) {
    blocked = true;
    retryAfterSec = secsUntilTomorrow();
  } else if (overIngestQuota) {
    blocked = true;
    retryAfterSec = secsUntilTomorrow();
  } else if (overP2oQuota) {  // V395-11
    blocked = true;
    retryAfterSec = secsUntilTomorrow();
  } else if (overCostQuota) {
    blocked = true;
    retryAfterSec = secsUntilNextMonth();
  }

  // V381 fix: blockedSearches 应为被拒计数(独立统计 status='blocked'), 而非全部 searchesToday
  const blockedCount = await pool.query(
    `select count(*)::int as n from token_usage where token_id = $1 and usage_date = current_date and status = 'blocked'`,
    [tokenId]
  );

  const quotaStatus: QuotaStatus = {
    ...quota,
    searchesToday,
    blockedSearches: Number(blockedCount.rows[0]?.n ?? 0),
    ingestBytesToday,
    p2oTasksToday,  // V395-11
    costThisMonth,
    overSearchQuota,
    overIngestQuota,
    overP2oQuota,  // V395-11
    overCostQuota,
    retryAfterSec,
  };
  return { blocked, retryAfterSec: blocked ? retryAfterSec : undefined, quotaStatus };
}

/** 用量落库 (fire-and-forget; 失败只 log 不阻塞主流程) */
export function recordUsage(
  tokenId: string,
  kind: QuotaKind,
  u: {
    tokensInput?: number; tokensOutput?: number; tokensCacheRead?: number;
    estimatedBytes?: number; status?: "ok" | "blocked";
  }
): void {
  const tokensInput = Math.max(0, Math.round(u.tokensInput ?? 0));
  const tokensOutput = Math.max(0, Math.round(u.tokensOutput ?? 0));
  const tokensCacheRead = Math.max(0, Math.round(u.tokensCacheRead ?? 0));
  const estimatedBytes = Math.max(0, Math.round(u.estimatedBytes ?? 0));
  const cost = calcCostUsd(tokensInput, tokensOutput);
  pool.query(
    `insert into token_usage
       (token_id, endpoint, status, tokens_input, tokens_output, tokens_cache_read, estimated_bytes, estimated_cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tokenId, kind, u.status ?? "ok", tokensInput, tokensOutput, tokensCacheRead, estimatedBytes, cost]
  ).catch((e) => console.error("[quota] recordUsage failed:", e));
}

/** 仪表盘: 完整配额状态 */
export async function getQuotaStatus(tokenId: string): Promise<QuotaStatus> {
  const r = await ensureWithinQuota(tokenId, "other");
  return r.quotaStatus!;
}

/** 近 N 天曲线: 每日搜索次数/入库字节/成本/调用数 */
export async function getUsageDaily(
  tokenId: string,
  days: number
): Promise<Array<{ date: string; searches: number; ingestBytes: number; cost: number; calls: number }>> {
  const r = await pool.query(
    `select usage_date::text as date,
       count(*) filter (where endpoint = 'search')::int as searches,
       coalesce(sum(estimated_bytes) filter (where endpoint = 'ingest'), 0)::bigint as ingest_bytes,
       coalesce(sum(estimated_cost_usd), 0)::numeric as cost,
       count(*)::int as calls
     from token_usage
     where token_id = $1 and usage_date > current_date - $2::int
     group by usage_date order by usage_date`,
    [tokenId, days]
  );
  return r.rows.map((row: any) => ({
    date: String(row.date),
    searches: Number(row.searches),
    ingestBytes: Number(row.ingest_bytes),
    cost: Number(row.cost),
    calls: Number(row.calls),
  }));
}

function secsUntilTomorrow(): number {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}

function secsUntilNextMonth(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export const quotaService = {
  getQuota, updateQuota, ensureWithinQuota, recordUsage, getQuotaStatus, getUsageDaily, calcCostUsd,
};
