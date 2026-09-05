// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// cost-ledger-service.ts — V405 OpenSquilla 移植 P0: 成本可审计账本
// 平台成本口径(估算): llm_usage_ledger 轮级明细 + llm_model_prices 按模型 in/out 单价
//   cost_source 三态: provider_billed(厂商实扣,预留) | estimate(默认) | byok(用户自付 key)
// 与 billing-service 的职责边界:
//   billing-service = 用户侧计费(订阅额度→超额扣余额, 含利润定价, 走 user_usage_log/billing_records)
//   本服务         = 平台侧成本审计(真实消耗 → 估算成本, 走 llm_usage_ledger) — 两者独立, 互不替代
// 兼容: 单价表无行 → 内置默认(USD0.3/1.2 × 7.2 汇率 → ¥2.16/8.64 每 1M); seed 不覆盖已有单价(admin 可调)
import { pool } from "../db/pool.js";

export type CostSource = "provider_billed" | "estimate" | "byok";

export interface LedgerEntry {
  kind?: string;
  endpoint: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  costSource?: CostSource;
  userId?: string | null;
  taskId?: string | null;
  context?: string | null;
}

const USD_CNY = parseFloat(process.env.USD_CNY_RATE || "7.2");
const DEFAULT_PRICE_IN = 0.3 * USD_CNY;   // ¥2.16 / 1M in (DeepSeek 近似)
const DEFAULT_PRICE_OUT = 1.2 * USD_CNY;  // ¥8.64 / 1M out

/** 读模型单价(元/1M); 无行返回内置默认 */
export async function getModelPrice(model: string): Promise<{ in: number; out: number }> {
  try {
    const r = await pool.query(
      "select price_cny_per_m_in, price_cny_per_m_out from llm_model_prices where model = $1",
      [model]
    );
    if (r.rows[0]) {
      return {
        in: Number(r.rows[0].price_cny_per_m_in),
        out: Number(r.rows[0].price_cny_per_m_out),
      };
    }
  } catch { /* 表不存在(迁移未跑)时用默认 */ }
  return { in: DEFAULT_PRICE_IN, out: DEFAULT_PRICE_OUT };
}

/** 首次启动 seed 平台默认单价(仅插缺省行, 不覆盖已有) */
export async function seedDefaultPrices(): Promise<void> {
  const defaults: Array<[string, number, number]> = [
    ["deepseek-v4-flash", 0.27, 1.1],       // USD×7.2 近似: 0.3/1.2 为别家; flash 官方价更低
    ["deepseek-v4-pro", 2.16, 8.64],
    ["deepseek-chat", 2.16, 8.64],
    ["deepseek-reasoner", 2.16, 8.64],
    ["qwen-plus", 3.6, 12.6],
    ["qwen3.7-max", 10.8, 36.0],
    ["text-embedding-v4", 0.5, 0.5],
    ["qwen3-rerank", 0.5, 0.5],
  ];
  try {
    for (const [m, pIn, pOut] of defaults) {
      await pool.query(
        `insert into llm_model_prices (model, price_cny_per_m_in, price_cny_per_m_out)
         values ($1, $2, $3) on conflict (model) do nothing`,
        [m, pIn, pOut]
      );
    }
  } catch { /* 迁移未跑时静默 */ }
}

/** 估算一次调用成本(元) */
export function calcLedgerCostCny(model: string, tokensIn: number, tokensOut: number, price?: { in: number; out: number }): number {
  const p = price ?? { in: DEFAULT_PRICE_IN, out: DEFAULT_PRICE_OUT };
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}

/** 落账一条(轮级明细)。失败只 log 不阻塞主流程(与 quota recordUsage 同款容错) */
export function recordLedger(entry: LedgerEntry): void {
  const tokensIn = Math.max(0, Math.round(entry.tokensIn ?? 0));
  const tokensOut = Math.max(0, Math.round(entry.tokensOut ?? 0));
  const cacheRead = Math.max(0, Math.round(entry.tokensCacheRead ?? 0));
  const costSource: CostSource = entry.costSource ?? "estimate";
  const price = costSource === "byok" ? { in: 0, out: 0 } : undefined; // byok: 平台零成本
  const cost = calcLedgerCostCny(entry.model, tokensIn, tokensOut, price);
  pool.query(
    `insert into llm_usage_ledger
       (kind, endpoint, model, tokens_in, tokens_out, tokens_cache_read, cost_cny, cost_source, user_id, task_id, context)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.kind ?? "llm", entry.endpoint, entry.model, tokensIn, tokensOut, cacheRead,
      cost, costSource, entry.userId ?? null, entry.taskId ?? null, entry.context ?? null,
    ]
  ).catch((e) => console.error("[ledger] recordLedger failed:", e?.message?.substring(0, 120)));
}

/** 同步落账(供需立即读回的调用方) */
export async function recordLedgerAwait(entry: LedgerEntry): Promise<void> {
  const tokensIn = Math.max(0, Math.round(entry.tokensIn ?? 0));
  const tokensOut = Math.max(0, Math.round(entry.tokensOut ?? 0));
  const cacheRead = Math.max(0, Math.round(entry.tokensCacheRead ?? 0));
  const costSource: CostSource = entry.costSource ?? "estimate";
  const price = costSource === "byok" ? { in: 0, out: 0 } : undefined;
  const cost = calcLedgerCostCny(entry.model, tokensIn, tokensOut, price);
  try {
    await pool.query(
      `insert into llm_usage_ledger
         (kind, endpoint, model, tokens_in, tokens_out, tokens_cache_read, cost_cny, cost_source, user_id, task_id, context)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.kind ?? "llm", entry.endpoint, entry.model, tokensIn, tokensOut, cacheRead,
        cost, costSource, entry.userId ?? null, entry.taskId ?? null, entry.context ?? null,
      ]
    );
  } catch (e: any) {
    console.error("[ledger] recordLedgerAwait failed:", e?.message?.substring(0, 120));
  }
}

// ─── 审计聚合查询 ───────────────────────────────────────────────

export interface LedgerSummary {
  totalCostCny: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  calls: number;
  byModel: Array<{ model: string; calls: number; tokensIn: number; tokensOut: number; cacheRead: number; costCny: number }>;
  byEndpoint: Array<{ endpoint: string; calls: number; costCny: number }>;
  bySource: Array<{ costSource: string; calls: number; costCny: number }>;
}

/** 按日聚合(前端"按模型/端点/来源"成本明细) */
export async function getLedgerSummary(days = 7): Promise<LedgerSummary> {
  const empty = (): LedgerSummary => ({
    totalCostCny: 0, totalTokensIn: 0, totalTokensOut: 0, totalCacheRead: 0, calls: 0,
    byModel: [], byEndpoint: [], bySource: [],
  });
  try {
    const r = await pool.query(
      `select model, count(*)::int as calls,
              sum(tokens_in)::bigint as tin, sum(tokens_out)::bigint as tout,
              sum(tokens_cache_read)::bigint as cache,
              coalesce(sum(cost_cny), 0)::numeric as cost
       from llm_usage_ledger
       where created_at > now() - make_interval(days => $1)
       group by model order by cost desc limit 50`,
      [days]
    );
    const byModel = r.rows.map((row: any) => ({
      model: String(row.model), calls: Number(row.calls),
      tokensIn: Number(row.tin), tokensOut: Number(row.tout), cacheRead: Number(row.cache),
      costCny: Number(row.cost),
    }));
    const [ep, src, tot] = await Promise.all([
      pool.query(
        `select endpoint, count(*)::int as calls, coalesce(sum(cost_cny), 0)::numeric as cost
         from llm_usage_ledger where created_at > now() - make_interval(days => $1)
         group by endpoint order by cost desc limit 30`, [days]
      ),
      pool.query(
        `select cost_source, count(*)::int as calls, coalesce(sum(cost_cny), 0)::numeric as cost
         from llm_usage_ledger where created_at > now() - make_interval(days => $1)
         group by cost_source`, [days]
      ),
      pool.query(
        `select coalesce(sum(tokens_in), 0)::bigint as tin, coalesce(sum(tokens_out), 0)::bigint as tout,
                coalesce(sum(tokens_cache_read), 0)::bigint as cache, count(*)::int as calls,
                coalesce(sum(cost_cny), 0)::numeric as cost
         from llm_usage_ledger where created_at > now() - make_interval(days => $1)`,
        [days]
      ),
    ]);
    const t = tot.rows[0];
    return {
      totalCostCny: Number(t?.cost || 0),
      totalTokensIn: Number(t?.tin || 0),
      totalTokensOut: Number(t?.tout || 0),
      totalCacheRead: Number(t?.cache || 0),
      calls: Number(t?.calls || 0),
      byModel,
      byEndpoint: ep.rows.map((row: any) => ({
        endpoint: String(row.endpoint), calls: Number(row.calls), costCny: Number(row.cost),
      })),
      bySource: src.rows.map((row: any) => ({
        costSource: String(row.cost_source), calls: Number(row.calls), costCny: Number(row.cost),
      })),
    };
  } catch {
    return empty();
  }
}

/** 每日成本曲线(审计用) */
export async function getLedgerDaily(days = 14): Promise<Array<{ date: string; costCny: number; calls: number; tokensIn: number; tokensOut: number }>> {
  try {
    const r = await pool.query(
      `select to_char(created_at, 'YYYY-MM-DD') as day,
              count(*)::int as calls,
              coalesce(sum(tokens_in), 0)::bigint as tin,
              coalesce(sum(tokens_out), 0)::bigint as tout,
              coalesce(sum(cost_cny), 0)::numeric as cost
       from llm_usage_ledger
       where created_at > current_date - $1::int
       group by day order by day`,
      [Math.min(days, 90)]
    );
    return r.rows.map((row: any) => ({
      date: String(row.day), costCny: Number(row.cost), calls: Number(row.calls),
      tokensIn: Number(row.tin), tokensOut: Number(row.tout),
    }));
  } catch {
    return [];
  }
}

export const costLedgerService = {
  recordLedger,
  recordLedgerAwait,
  getLedgerSummary,
  getLedgerDaily,
  getModelPrice,
  seedDefaultPrices,
};
