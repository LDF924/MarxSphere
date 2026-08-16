// billing-service.ts — 商业化阶段2: 计费系统（订阅 + 按量）
// V389+ 混合计费
// 逻辑: 平台 key 用户 — 订阅含月额度(免费token), 超额按单价扣 balance
//       BYOK 用户 — LLM 自付, 平台只收订阅费
// 单价: 按模型定价 (每 1M token 成本, 平台加价率)
import { pool } from "../db/pool.js";

// 价格表: 模型 → 每 1M token 成本(人民币, 平台定价含利润)
const PRICE_PER_MTOKEN: Record<string, number> = {
  "deepseek-v4-flash": 4.0,   // 输入+输出混合估算
  "deepseek-v4-pro": 16.0,
  "deepseek-chat": 2.0,
  "qwen-plus": 8.0,
  "qwen3.7-max": 60.0,
  "text-embedding-v4": 0.5,
  "qwen3-rerank": 0.5,
};
const DEFAULT_PRICE = 8.0; // 未收录模型默认单价

// 订阅计划: plan → 月费(分) + 月额度token
export const PLANS: Record<string, { priceCents: number; quotaTokens: number }> = {
  free: { priceCents: 0, quotaTokens: 50_000 },        // 免费: 5万token/月
  pro: { priceCents: 3900, quotaTokens: 2_000_000 },   // Pro: 39元/月 200万token
  enterprise: { priceCents: 19900, quotaTokens: 20_000_000 }, // 企业: 199元/月 2000万token
};

export function priceFor(model: string): number {
  return PRICE_PER_MTOKEN[model] ?? DEFAULT_PRICE;
}

/** 计算一次 LLM 调用的成本(分) */
export function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const perM = priceFor(model);
  const totalTokens = tokensIn + tokensOut;
  return Math.ceil((totalTokens * perM) / 1_000_000 * 100); // 元→分, 向上取整
}

/** 查询用户订阅剩余额度(tokens) */
export async function getSubscriptionQuota(userId: string): Promise<{ plan: string; quotaTokens: number; usedTokens: number; remaining: number }> {
  const u = await pool.query("select plan from users where id = $1", [userId]);
  const plan = u.rows[0]?.plan || "free";
  const quota = PLANS[plan]?.quotaTokens ?? 0;
  // 本月已用 token（V389修复: 查 user_usage_log, 原 token_usage 无用户记录恒0）
  const used = await pool.query(
    `select coalesce(sum(tokens_input + tokens_output), 0)::int as used
     from user_usage_log where user_id = $1 and created_at > date_trunc('month', now())`,
    [userId]
  );
  const usedTokens = Number(used.rows[0]?.used || 0);
  return { plan, quotaTokens: quota, usedTokens, remaining: Math.max(0, quota - usedTokens) };
}

/** 扣费: LLM 调用后从用户余额扣(超额部分); 返回是否成功 */
export async function chargeUser(userId: string, model: string, tokensIn: number, tokensOut: number, endpoint: string): Promise<{ ok: boolean; chargedCents: number; reason: string }> {
  const cost = calcCost(model, tokensIn, tokensOut);
  if (cost <= 0) return { ok: true, chargedCents: 0, reason: "cost-zero" };

  // 记录用量
  await pool.query(
    `insert into user_usage_log (user_id, endpoint, tokens_input, tokens_output, cost_cents) values ($1,$2,$3,$4,$5)`,
    [userId, endpoint, tokensIn, tokensOut, cost]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 查用户状态
    const u = await client.query("select plan, balance_cents, llm_provider from users where id = $1 for update", [userId]);
    if (u.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, chargedCents: 0, reason: "user-not-found" }; }
    const { plan, balance_cents, llm_provider } = u.rows[0];

    // BYOK 用户: 不扣平台余额（LLM 自付）
    if (llm_provider === "byok") {
      await client.query("COMMIT");
      return { ok: true, chargedCents: 0, reason: "byok-self-pay" };
    }

    // 平台用户: 先用订阅额度, 超额扣余额
    const quota = PLANS[plan]?.quotaTokens ?? 0;
    // V389修复: used 应查 user_usage_log（chargeUser 自己的记账表）— 原查 token_usage 恒0导致额度形同虚设
    const used = await client.query(
      `select coalesce(sum(tokens_input + tokens_output), 0)::int as used
       from user_usage_log where user_id = $1 and created_at > date_trunc('month', now())`,
      [userId]
    );
    const usedTokens = Number(used.rows[0]?.used || 0);
    const remaining = Math.max(0, quota - usedTokens);
    const excessTokens = Math.max(0, tokensIn + tokensOut - remaining);
    let chargedCents = 0;
    if (excessTokens > 0) {
      chargedCents = Math.ceil((excessTokens * priceFor(model)) / 1_000_000 * 100);
      const newBalance = Number(balance_cents) - chargedCents;
      if (newBalance < 0) {
        await client.query("ROLLBACK");
        return { ok: false, chargedCents, reason: "insufficient-balance" };
      }
      await client.query("update users set balance_cents = $2 where id = $1", [userId, newBalance]);
      await client.query(
        `insert into billing_records (user_id, type, amount_cents, tokens_used, description)
         values ($1, 'usage', $2, $3, $4)`,
        [userId, chargedCents, excessTokens, `LLM超额扣费(${model}) ${excessTokens} tokens`]
      );
    }
    await client.query("COMMIT");
    return { ok: true, chargedCents, reason: excessTokens > 0 ? "charged" : "within-quota" };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, chargedCents: 0, reason: "error:" + String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** 充值入账（手动/支付回调） */
export async function recharge(userId: string, amountCents: number, provider = "manual"): Promise<{ ok: boolean; balanceCents: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("insert into recharges (user_id, amount_cents, status, provider) values ($1,$2,'success',$3)", [userId, amountCents, provider]);
    await client.query("update users set balance_cents = balance_cents + $2 where id = $1", [userId, amountCents]);
    // 负=入账（充值增加余额）
    await client.query(
      `insert into billing_records (user_id, type, amount_cents, description) values ($1, 'recharge', $2, $3)`,
      [userId, -amountCents, `充值 ${(amountCents / 100).toFixed(2)} 元`]
    );
    const r = await client.query("select balance_cents from users where id = $1", [userId]);
    await client.query("COMMIT");
    return { ok: true, balanceCents: Number(r.rows[0]?.balance_cents || 0) };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, balanceCents: 0 };
  } finally { client.release(); }
}

/** 订阅升级/续费 */
export async function subscribe(userId: string, plan: string): Promise<{ ok: boolean; error?: string }> {
  const p = PLANS[plan];
  if (!p) return { ok: false, error: "未知计划" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("select balance_cents from users where id = $1 for update", [userId]);
    if (u.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "用户不存在" }; }
    const balance = Number(u.rows[0].balance_cents);
    if (balance < p.priceCents) { await client.query("ROLLBACK"); return { ok: false, error: "余额不足, 请先充值" }; }
    await client.query("update users set balance_cents = balance_cents - $2, plan = $3 where id = $1", [userId, p.priceCents, plan]);
    await client.query(
      `insert into subscriptions (user_id, plan, status, quota_tokens, expires_at)
       values ($1,$2,'active',$3, now() + interval '30 day')`, [userId, plan, p.quotaTokens]
    );
    await client.query(
      `insert into billing_records (user_id, type, amount_cents, description) values ($1, 'subscription', $2, $3)`,
      [userId, p.priceCents, `订阅 ${plan} 月费`]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** 账单查询 */
export async function getBillingRecords(userId: string, limit = 50): Promise<any[]> {
  const r = await pool.query(
    "select id, type, amount_cents, tokens_used, description, created_at from billing_records where user_id = $1 order by created_at desc limit $2",
    [userId, Math.min(limit, 200)]
  );
  return r.rows;
}

/** V390: 删除账单记录（仅本人; 用量扣费记录保留追溯） */
export async function deleteBillingRecord(userId: string, recordId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await pool.query(
    "select type from billing_records where id = $1 and user_id = $2",
    [recordId, userId]
  );
  if (r.rows.length === 0) return { ok: false, error: "记录不存在" };
  if (r.rows[0].type === "usage") return { ok: false, error: "用量扣费记录不可删除" };
  await pool.query("delete from billing_records where id = $1 and user_id = $2", [recordId, userId]);
  return { ok: true };
}

/** 用量查询 */
export async function getUsage(userId: string, days = 7): Promise<any[]> {
  const r = await pool.query(
    `select endpoint, sum(tokens_input) as tin, sum(tokens_output) as tout, sum(cost_cents) as cost,
            to_char(created_at, 'MM-DD') as day
     from user_usage_log where user_id = $1 and created_at > now() - ($2 || ' days')::interval
     group by endpoint, day order by day desc limit 100`,
    [userId, String(Math.min(days, 90))]
  );
  return r.rows;
}
