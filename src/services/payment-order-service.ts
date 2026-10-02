// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// payment-order-service.ts — 订单生命周期: 下单 → 待付 → 收款入账 → 退款(2026-10-01)
//
// 由来: 本项目原先**没有订单这一层**。`billing-service.ts:151` 的 recharge 一进来就
//   `insert ... status='success'` —— 也就是说"充值"这个接口**根本不管你付没付钱**,
//   调一次就加一次余额。旧项目 AItoolman 反而有完整链路(`创建支付订单` /
//   `启动订单状态监控` / `查询订单状态` / `支付超时` / `失败退款`), 这次补的就是它。
//
// 本文件只做状态机与账务, 不碰 HTTP(路由在 server.ts), 不碰渠道协议
//   (在 wechat-pay-service.ts)。这样三者可以各自测。
//
// ══ 三条不变量(整个支付系统的正确性都压在这上面) ══
//   ① **只有 paid 才加钱**, 且加钱与置 paid 在**同一个事务**里 —— 否则会出现
//      "标记了已付但钱没加"或反过来, 两者都是资损。
//   ② **入账幂等**: 同一笔渠道流水(transaction_id)只能入账一次。微信会重推回调
//      (5s/10s/30s/1m...), 不幂等就会加 N 次钱。靠 `uq_payment_orders_txn` 兜底。
//   ③ **退款不超过已收**: 退款额累加不得越过订单实收额, 且一单一退靠 idem_key 去重。
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { PLANS } from "./billing-service.js";
import {
  createNativeOrder, queryOrder, createRefund, isPayMockMode,
} from "./wechat-pay-service.js";

/** 事务内可用的最小 query 接口。入账/扣账要能同时接 pool 与 client(事务) */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type OrderStatus =
  | "created" | "pending" | "paid" | "closed" | "failed" | "refunding" | "refunded";

export interface PaymentOrder {
  id: string;
  outTradeNo: string;
  userId: string;
  amountCents: number;
  currency: string;
  subject: string;
  kind: string;
  targetRef: string | null;
  status: OrderStatus;
  provider: string;
  transactionId: string | null;
  codeUrl: string | null;
  paidAt: string | null;
  expireAt: string;
  createdAt: string;
}

/** 生成商户订单号: 前缀 + 时间 + 随机。长度与字符集满足微信要求(6~32位, 字母数字_-|*) */
function newOutTradeNo(): string {
  const ts = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
  return `SS${stamp}${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

function rowToOrder(r: Record<string, unknown>): PaymentOrder {
  return {
    id: String(r.id),
    outTradeNo: String(r.out_trade_no),
    userId: String(r.user_id),
    amountCents: Number(r.amount_cents),
    currency: String(r.currency ?? "CNY"),
    subject: String(r.subject ?? ""),
    kind: String(r.kind ?? "recharge"),
    targetRef: r.target_ref == null ? null : String(r.target_ref),
    status: String(r.status) as OrderStatus,
    provider: String(r.provider ?? "wechat"),
    transactionId: r.transaction_id == null ? null : String(r.transaction_id),
    codeUrl: r.code_url == null ? null : String(r.code_url),
    paidAt: r.paid_at ? new Date(String(r.paid_at)).toISOString() : null,
    expireAt: new Date(String(r.expire_at)).toISOString(),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

const ORDER_COLS = `id, out_trade_no, user_id, amount_cents, currency, subject, kind,
  target_ref, status, provider, transaction_id, code_url, paid_at, expire_at, created_at`;

// ════════════════════ 下单 ════════════════════

export interface CreateOrderInput {
  userId: string;
  amountCents: number;
  subject?: string;
  kind?: "recharge" | "subscription" | "points";
  targetRef?: string;
  /** 幂等键: 同一用户带同一 key 重复提交 → 返回既有订单, 不新建(防重复点击) */
  idemKey?: string;
}

export async function createOrder(input: CreateOrderInput): Promise<{
  ok: boolean; error?: string; order?: PaymentOrder; mock?: boolean; reused?: boolean;
}> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: "金额必须是正整数(分)" };
  }
  // 上限护栏: 防止被改价或手滑输入天文数字。可按业务调整
  if (input.amountCents > 10_000_00) {
    return { ok: false, error: "单笔金额超过上限(10000 元)" };
  }

  // ① 幂等: 先查有没有同键的订单
  if (input.idemKey) {
    const ex = await pool.query(
      `select ${ORDER_COLS} from payment_orders where user_id=$1 and idem_key=$2`,
      [input.userId, input.idemKey]);
    if (ex.rows[0]) {
      const order = rowToOrder(ex.rows[0]);
      // 已关/已失败的旧单不该被复用, 让它过期后重新下单
      if (order.status === "created" || order.status === "pending" || order.status === "paid") {
        return { ok: true, order, reused: true, mock: await isPayMockMode() };
      }
    }
  }

  const outTradeNo = newOutTradeNo();
  const subject = (input.subject ?? "账户充值").slice(0, 120);

  const ins = await pool.query(
    `insert into payment_orders
       (out_trade_no, user_id, amount_cents, subject, kind, target_ref, status, provider, idem_key)
     values ($1,$2,$3,$4,$5,$6,'created','wechat',$7)
     returning ${ORDER_COLS}`,
    [outTradeNo, input.userId, input.amountCents, subject,
     input.kind ?? "recharge", input.targetRef ?? null, input.idemKey ?? null]);

  const order = rowToOrder(ins.rows[0]);

  // ② 向渠道下单, 拿二维码
  const native = await createNativeOrder({
    outTradeNo,
    description: subject,
    amountCents: input.amountCents,
    attach: input.userId,
  });

  if (!native.ok) {
    await pool.query(
      `update payment_orders set status='failed', updated_at=now() where id=$1`, [order.id]);
    return { ok: false, error: native.error ?? "渠道下单失败" };
  }

  const upd = await pool.query(
    `update payment_orders
        set status='pending', code_url=$2, prepay_id=$3, updated_at=now()
      where id=$1
      returning ${ORDER_COLS}`,
    [order.id, native.codeUrl ?? null, native.prepayId ?? null]);

  return {
    ok: true,
    order: rowToOrder(upd.rows[0]),
    mock: !!native.mock,
    reused: false,
  };
}

// ════════════════════ 查询 ════════════════════

export async function getOrder(outTradeNo: string): Promise<PaymentOrder | null> {
  const r = await pool.query(
    `select ${ORDER_COLS} from payment_orders where out_trade_no=$1`, [outTradeNo]);
  return r.rows[0] ? rowToOrder(r.rows[0]) : null;
}

export async function listOrders(userId: string, limit = 50): Promise<PaymentOrder[]> {
  const r = await pool.query(
    `select ${ORDER_COLS} from payment_orders
      where user_id=$1 order by created_at desc limit $2`,
    [userId, Math.min(Math.max(1, limit), 200)]);
  return r.rows.map(rowToOrder);
}

// ════════════════════ 入账(核心) ════════════════════

/**
 * 把订单标记为已付并给用户加钱 —— **整个支付链路唯一的入账点**。
 *
 * 三层保护, 缺一层就是资损:
 *   ① **金额核对**: 渠道回调里的金额必须与订单金额一致。不一致直接拒绝且不入账
 *      —— 这是防"改价攻击"(构造一笔 1 分钱的支付去确认一张 100 元的订单)。
 *   ② **状态机**: 只有 pending/created 能转 paid。已经是 paid 的直接返回 ok+duplicate,
 *      调用方据此返回 200 给微信(否则微信会一直重推)。
 *   ③ **流水号唯一**: transaction_id 有唯一索引, 并发重推时数据库会挡住第二条。
 *
 * 事务边界: 置 paid 与加余额在**同一个事务**里。任一步失败整体回滚 ——
 *   绝不出现"标记已付但没加钱"或"加了钱但订单还是待付"。
 */
export async function settleOrder(input: {
  outTradeNo: string;
  transactionId: string;
  /** 渠道回报的金额(分)。可选: 主动查单路径一定给, 回调路径也应当给 */
  paidAmountCents?: number;
  rawCallback?: unknown;
}): Promise<{
  ok: boolean; error?: string; duplicate?: boolean; order?: PaymentOrder; creditedCents?: number;
}> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // 行锁: 同一订单的并发回调串行化, 后面的会看到前面已改的状态
    const cur = await client.query(
      `select ${ORDER_COLS} from payment_orders where out_trade_no=$1 for update`,
      [input.outTradeNo]);

    if (!cur.rows[0]) {
      await client.query("rollback");
      return { ok: false, error: `订单不存在: ${input.outTradeNo}` };
    }
    const order = rowToOrder(cur.rows[0]);

    // ② 幂等: 已付过就直接返回, 不重复加钱
    if (order.status === "paid" || order.status === "refunding" || order.status === "refunded") {
      await client.query("rollback");
      return { ok: true, duplicate: true, order };
    }
    if (order.status === "closed" || order.status === "failed") {
      await client.query("rollback");
      return { ok: false, error: `订单状态为 ${order.status}, 不接受入账` };
    }

    // ① 金额核对 —— 不一致绝不入账
    if (input.paidAmountCents !== undefined && input.paidAmountCents !== order.amountCents) {
      await client.query("rollback");
      return {
        ok: false,
        error: `金额不符: 渠道 ${input.paidAmountCents} 分, 订单 ${order.amountCents} 分 —— 已拒绝入账`,
      };
    }

    // ③ 流水号冲突(并发重推的兜底): 先查一次, 冲突当作重复
    const dup = await client.query(
      `select id from payment_orders
        where provider=$1 and transaction_id=$2 and id<>$3`,
      [order.provider, input.transactionId, order.id]);
    if (dup.rows.length) {
      await client.query("rollback");
      return { ok: false, error: `该渠道流水号已用于其他订单: ${input.transactionId}` };
    }

    const upd = await client.query(
      `update payment_orders
          set status='paid', transaction_id=$2, paid_at=now(),
              raw_callback=$3, updated_at=now()
        where id=$1
        returning ${ORDER_COLS}`,
      [order.id, input.transactionId,
       input.rawCallback === undefined ? null : JSON.stringify(input.rawCallback)]);

    // 入账: kind 决定加到哪里
    await creditUser(client, order);

    await client.query("commit");

    // 邀请"好友首充"奖励（2026-10-02）—— 挂在这里而不是两条调用路径上:
    // `settleOrder` 被**支付回调**与**主动查单**共用(syncOrderWithChannel:363),
    // 挂在调用方会让两条路各发一次。挂在本函数的事务提交后 = 每条成功订单恰好一次。
    // `duplicate`(重复回调)在上面就 return 了, 到不了这里, 所以天然不重发。
    // 幂等另有一道: grantFirstPayBonus 自己查账本 marker, 双保险。
    // **不 await** —— 奖励发放失败不该让支付入账的响应变慢或失败(钱已经加对了)。
    void (async () => {
      try {
        const { grantFirstPayBonus } = await import("./invite-service.js");
        const r = await grantFirstPayBonus({ inviteeId: order.userId, amountCents: order.amountCents });
        if (r.granted > 0) {
          const { notify } = await import("./notification-service.js");
          await notify({
            userId: r.ownerId!, category: "points", level: "success",
            title: `好友首充奖励 +${r.granted} 积分`,
            body: "你邀请的好友完成了首次付费",
            link: { view: "billing" },
            dedupeKey: `invite_first_pay:${order.userId}`,
          });
        }
      } catch (e: any) {
        // 不能静默 —— 这是"该给的钱没给", 必须能在日志里查到
        console.warn(`[payment] 邀请首充奖励发放失败 order=${order.outTradeNo}: ${String(e?.message || e).slice(0, 100)}`);
      }
    })();

    return { ok: true, order: rowToOrder(upd.rows[0]), creditedCents: order.amountCents };
  } catch (e: unknown) {
    try { await client.query("rollback"); } catch { /* 已回滚 */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

/**
 * 按订单类别入账。**必须在调用方的事务里执行**(传 client 而不是用 pool)。
 *
 * ⚠ 表名以 billing-service.ts 的实际读法为准(我第一版按直觉写了 `user_balances`
 *   和 `user_subscriptions`, 而本项目的真实位置是 `users.balance_cents` 与
 *   `subscriptions` —— 猜表名在支付代码里是最贵的一类错误)。
 *
 * 三种 kind:
 *   · recharge     → users.balance_cents 加钱 + recharges 记账 + billing_records(负数=入账)
 *   · subscription → subscriptions 续期 + 扣余额 + billing_records(正数=消费)
 *   · points       → points_accounts 加积分 + points_ledger
 */
async function creditUser(
  client: Queryable,
  order: PaymentOrder,
): Promise<void> {
  if (order.kind === "points") {
    const n = Number(order.targetRef ?? 0);
    if (!Number.isFinite(n) || n <= 0) throw new Error("积分订单的 targetRef 非法");
    await client.query(
      `insert into points_accounts (user_id, balance) values ($1, $2)
       on conflict (user_id) do update set balance = points_accounts.balance + $2, updated_at = now()`,
      [order.userId, n]);
    await client.query(
      `insert into points_ledger (user_id, type, amount, ref_type, ref_id, balance_after, note)
       values ($1, 'recharge', $2, 'payment_order', $3,
               (select balance from points_accounts where user_id=$1), $4)`,
      [order.userId, n, order.id, `微信支付入账 ${order.outTradeNo}`]);
    return;
  }

  if (order.kind === "subscription") {
    const plan = order.targetRef ?? "";
    if (!plan) throw new Error("订阅订单缺 targetRef(套餐名)");
    // 续期语义对齐 billing-service.subscribe: 先扣余额, 再写 subscriptions 一行(30 天)
    const u = await client.query(
      `update users set balance_cents = balance_cents - $2 where id=$1 and balance_cents >= $2
       returning balance_cents`, [order.userId, order.amountCents]);
    if (!u.rows.length) {
      // 余额不足以支付这笔订阅 —— 但钱**已经收了**, 不能静默吞掉, 直接抛出让事务回滚,
      // 由上层走退款。这正是"先收款后核销"必须处理的分支。
      throw new Error("订阅核销时余额不足 —— 需退款, 请勿手工改单");
    }
    await client.query(
      `insert into subscriptions (user_id, plan, status, quota_tokens, expires_at)
       values ($1, $2, 'active', $3, now() + interval '30 day')`,
      [order.userId, plan, PLANS[plan]?.quotaTokens ?? 0]);
    await client.query(
      `insert into billing_records (user_id, type, amount_cents, description)
       values ($1, 'subscription', $2, $3)`,
      [order.userId, order.amountCents, `订阅 ${plan} 月费(微信支付)`]);
    return;
  }

  // 默认 recharge: 加余额
  await client.query(
    `update users set balance_cents = balance_cents + $2 where id = $1`,
    [order.userId, order.amountCents]);
  // recharges 到这里才是真 'success'(此前 billing-service.recharge 是一进来就写死 success)
  await client.query(
    `insert into recharges (user_id, amount_cents, status, provider)
     values ($1, $2, 'success', 'wechat')`,
    [order.userId, order.amountCents]);
  // billing_records 里 **负数=入账**, 与 billing-service.recharge 的约定一致
  await client.query(
    `insert into billing_records (user_id, type, amount_cents, description)
     values ($1, 'recharge', $2, $3)`,
    [order.userId, -order.amountCents,
     `充值 ${(order.amountCents / 100).toFixed(2)} 元(微信支付)`]);
}

// ════════════════════ 主动同步(回调丢了也能补) ════════════════════

/**
 * 主动向渠道查一次并落账 —— 前端轮询订单状态时调用。
 *
 * 为什么必须有: 回调是"最好情况"。网络抖动、服务重启、防火墙都可能让回调永远不到,
 *   那笔钱收了但用户余额没加。用户看到"我付了但没到账"是必然会来投诉的。
 *   主动查单是最省事又最可靠的兜底。
 */
export async function syncOrderWithChannel(outTradeNo: string): Promise<{
  ok: boolean; error?: string; order?: PaymentOrder; settled?: boolean;
}> {
  const order = await getOrder(outTradeNo);
  if (!order) return { ok: false, error: "订单不存在" };
  if (order.status === "paid") return { ok: true, order, settled: false };

  if (order.status !== "pending" && order.status !== "created") {
    return { ok: true, order, settled: false };
  }

  const q = await queryOrder(outTradeNo);
  if (!q.ok) {
    // mock 模式或未配置时不报错, 只是"查不了"
    return { ok: true, order, settled: false };
  }

  if (q.tradeState === "SUCCESS" && q.transactionId) {
    const s = await settleOrder({
      outTradeNo,
      transactionId: q.transactionId,
      paidAmountCents: q.amountCents,
      rawCallback: { source: "query", ...q },
    });
    if (!s.ok) return { ok: false, error: s.error, order };
    return { ok: true, order: s.order, settled: !s.duplicate };
  }

  // 渠道明确关单/支付失败 → 同步本地状态
  if (q.tradeState === "CLOSED" || q.tradeState === "PAYERROR") {
    await pool.query(
      `update payment_orders set status='closed', closed_at=now(), updated_at=now()
        where id=$1 and status in ('pending','created')`, [order.id]);
    return { ok: true, order: (await getOrder(outTradeNo)) ?? order, settled: false };
  }

  return { ok: true, order, settled: false };
}

// ════════════════════ 超时关单 ════════════════════

/**
 * 关掉过期未支付的订单。
 *
 * 与旧项目的"支付超时"对位。定时调用(见 server.ts 的调度)或请求时顺手扫。
 * **只关 pending/created** —— 已付的绝不能关。
 */
export async function closeExpiredOrders(limit = 100): Promise<{ closed: number }> {
  const r = await pool.query(
    `update payment_orders
        set status='closed', closed_at=now(), updated_at=now()
      where id in (
        select id from payment_orders
         where status in ('created','pending') and expire_at < now()
         order by expire_at limit $1)
      returning id`, [limit]);
  return { closed: r.rows.length };
}

// ════════════════════ 退款 ════════════════════

/**
 * 退款。
 *
 * 约束(对位旧项目的"按页退款且同一页最多退款一次"那种语义, 这里是订单级):
 *   · 只有 paid 的订单能退
 *   · **累计退款额不得超过实收额** —— 否则是"退了两次钱"
 *   · 同一 idemKey 只退一次
 *   · 退回的余额若已被消费, 这里不追缴(由运营策略决定), 但**余额可为负**
 *     —— 这与 points-service 的"禁止透支"是不同场景: 那是消费时禁止, 这是退款后追溯
 */
export async function refundOrder(input: {
  outTradeNo: string;
  amountCents?: number;   // 缺省=全额退
  reason?: string;
  idemKey?: string;
}): Promise<{ ok: boolean; error?: string; refundedCents?: number; duplicate?: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      `select ${ORDER_COLS} from payment_orders where out_trade_no=$1 for update`,
      [input.outTradeNo]);
    if (!cur.rows[0]) {
      await client.query("rollback");
      return { ok: false, error: "订单不存在" };
    }
    const order = rowToOrder(cur.rows[0]);
    if (order.status !== "paid" && order.status !== "refunding") {
      await client.query("rollback");
      return { ok: false, error: `订单状态为 ${order.status}, 不可退款` };
    }

    // 已退了多少
    const done = await client.query(
      `select coalesce(sum(amount_cents),0) as s from payment_refunds
        where order_id=$1 and status in ('pending','success')`,
      [order.id]);
    const already = Number(done.rows[0]?.s ?? 0);

    const want = input.amountCents ?? (order.amountCents - already);
    if (want <= 0) {
      await client.query("rollback");
      return { ok: false, error: "可退金额为 0" };
    }
    if (already + want > order.amountCents) {
      await client.query("rollback");
      return {
        ok: false,
        error: `退款超额: 已退 ${already} + 本次 ${want} > 实收 ${order.amountCents}`,
      };
    }

    // 幂等键去重
    if (input.idemKey) {
      const ex = await client.query(
        `select id, amount_cents, status from payment_refunds where order_id=$1 and idem_key=$2`,
        [order.id, input.idemKey]);
      if (ex.rows[0]) {
        await client.query("rollback");
        return { ok: true, duplicate: true, refundedCents: Number(ex.rows[0].amount_cents) };
      }
    }

    const outRefundNo = `SR${order.outTradeNo.slice(2, 20)}${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const ins = await client.query(
      `insert into payment_refunds (order_id, out_refund_no, amount_cents, reason, status, idem_key)
       values ($1,$2,$3,$4,'pending',$5) returning id`,
      [order.id, outRefundNo, want, input.reason ?? "", input.idemKey ?? null]);

    await client.query(
      `update payment_orders set status='refunding', updated_at=now() where id=$1`, [order.id]);

    // 调渠道(在事务外做更合理, 但这里先占位 pending; 渠道结果由 confirmRefund 落)
    const ch = await createRefund({
      outTradeNo: order.outTradeNo,
      outRefundNo,
      refundCents: want,
      totalCents: order.amountCents,
      reason: input.reason,
    });

    if (!ch.ok) {
      await client.query(
        `update payment_refunds set status='failed', updated_at=now() where id=$1`, [ins.rows[0].id]);
      await client.query(
        `update payment_orders set status='paid', updated_at=now() where id=$1`, [order.id]);
      await client.query("rollback");
      return { ok: false, error: ch.error ?? "渠道退款失败" };
    }

    // 渠道受理成功 → 记为成功并扣回余额(这里的语义: 退款=把已入账的钱扣回去)
    await client.query(
      `update payment_refunds
          set status='success', channel_refund_id=$2, updated_at=now() where id=$1`,
      [ins.rows[0].id, ch.refundId ?? null]);

    await debitForRefund(client, order, want);

    await client.query(
      `update payment_orders
          set status = case when (select coalesce(sum(amount_cents),0) from payment_refunds
                                 where order_id=$1 and status='success') >= amount_cents
                            then 'refunded' else 'refunding' end,
              updated_at = now()
        where id=$1`, [order.id]);

    await client.query("commit");
    return { ok: true, refundedCents: want };
  } catch (e: unknown) {
    try { await client.query("rollback"); } catch { /* 已回滚 */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

/** 退款时把对应账目扣回。与 creditUser **严格对称** —— 加什么就减什么 */
async function debitForRefund(
  client: Queryable,
  order: PaymentOrder,
  amountCents: number,
): Promise<void> {
  if (order.kind === "points") {
    const n = Number(order.targetRef ?? 0);
    // 按退款比例扣回积分。**下界 0**(不允许扣成负): 积分是赠送性质,
    //   已消费的部分不追缴 —— 这与余额退款的成负语义不同, 见下面的注释
    const ratio = amountCents / order.amountCents;
    const back = Math.round(n * ratio);
    await client.query(
      `update points_accounts set balance = greatest(balance - $2, 0), updated_at = now()
        where user_id=$1`, [order.userId, back]);
    await client.query(
      `insert into points_ledger (user_id, type, amount, ref_type, ref_id, balance_after, note)
       values ($1, 'refund', $2, 'payment_refund', $3,
               (select balance from points_accounts where user_id=$1), $4)`,
      [order.userId, -back, order.id, `退款扣回 ${order.outTradeNo}`]);
    return;
  }

  if (order.kind === "subscription") {
    // 订阅退款: 关掉当前 active 的订阅行(不做按天折算 —— 那会让"退了多少天"变成
    //   一笔算不清的账, 运营上宁可整单失效后人工处理)。
    //   status 用 'cancelled' —— 取值域以迁移 043 的注释为准(active|expired|cancelled),
    //   我第一版自作主张写了 'refunded', 那不在值域里, 读订阅的地方会当它不存在。
    await client.query(
      `update subscriptions set status='cancelled'
        where user_id=$1 and plan=$2 and status='active'`,
      [order.userId, order.targetRef ?? ""]);
    await client.query(
      `insert into billing_records (user_id, type, amount_cents, description)
       values ($1, 'refund', $2, $3)`,
      [order.userId, amountCents, `订阅退款 ${order.targetRef ?? ""}(微信支付)`]);
    return;
  }

  // 余额退款: **允许扣成负数**。钱已经退给用户了, 账上必须如实反映;
  //   若余额已被消费, 这里不追缴(由运营策略决定), 但账不能装作没发生。
  //   与 points-service 的"消费时禁止透支"是不同场景, 两者不矛盾。
  await client.query(
    `update users set balance_cents = balance_cents - $2 where id = $1`,
    [order.userId, amountCents]);
  await client.query(
    `insert into recharges (user_id, amount_cents, status, provider)
     values ($1, $2, 'refunded', 'wechat')`,
    [order.userId, -amountCents]);
  await client.query(
    `insert into billing_records (user_id, type, amount_cents, description)
     values ($1, 'refund', $2, $3)`,
    [order.userId, amountCents,
     `退款 ${(amountCents / 100).toFixed(2)} 元(微信支付)`]);
}
