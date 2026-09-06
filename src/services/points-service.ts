// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// points-service.ts — SocialSci P0-8: 积分商业化(签到/兑换/冻结-实扣对账/管理员运营)
// 语义: 与 billing(balance_cents=真钱/token) 解耦, 积分只计 feature 级消费
//   - 消费: freezeCharge(冻结→frozen) → settleCharge(核销实扣) / rollbackFreeze(归还)
//   - 禁止透支: 冻结失败即拒绝(替代闭源产品"负余额挂账"设计)
//   - 对账: sum(type=freeze 的 freeze_amount) = sum(type=settle 的 settle_amount) + 当前 frozen
// 迁移120 points_accounts/points_ledger/daily_checkins/redeem_*/invite_codes/points_usage_daily
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

async function ensureAccount(userId: string) {
  await pool.query(
    `insert into points_accounts (user_id) values ($1) on conflict (user_id) do nothing`,
    [userId]);
}

async function getAccount(userId: string) {
  await ensureAccount(userId);
  const r = await pool.query(`select * from points_accounts where user_id=$1`, [userId]);
  return r.rows[0];
}

async function addLedger(input: {
  userId: string; type: string; amount: number;
  freezeAmount?: number; settleAmount?: number;
  refType?: string; refId?: string; note?: string;
}) {
  const acc = await getAccount(input.userId);
  // pg bigint 返回 string, 强制转 number 防"180-40"式串接
  const balAfter = Number(acc.balance ?? 0) + Number(input.amount);
  await pool.query(
    `insert into points_ledger
       (user_id, type, amount, freeze_amount, settle_amount, ref_type, ref_id, balance_after, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.userId, input.type, input.amount,
     input.freezeAmount ?? 0, input.settleAmount ?? 0,
     input.refType ?? "", input.refId ?? "", balAfter, input.note ?? ""]);
  return balAfter;
}

/** 变更余额(乐观锁自旋, 单条 update 保证原子) */
async function changeBalance(userId: string, delta: number) {
  await ensureAccount(userId);
  // 禁止透支: balance 不允许扣成负
  const r = await pool.query(
    `update points_accounts set balance=balance+$2, version=version+1, updated_at=now()
      where user_id=$1 and balance+$2 >= 0 returning balance`,
    [userId, delta]);
  if (!r.rows.length) throw new Error("INSUFFICIENT_POINTS");
  return r.rows[0].balance as number;
}

async function changeFrozen(userId: string, delta: number) {
  await ensureAccount(userId);
  const r = await pool.query(
    `update points_accounts set frozen=frozen+$2, version=version+1, updated_at=now()
      where user_id=$1 and frozen+$2 >= 0 returning frozen`,
    [userId, delta]);
  if (!r.rows.length) throw new Error("FROZEN_UNDERFLOW");
  return r.rows[0].frozen as number;
}

// ═══ 余额/流水查询 ═══
export async function getPoints(userId: string) {
  const acc = await getAccount(userId);
  const ledger = await pool.query(
    `select type, amount, freeze_amount, settle_amount, ref_type, ref_id, balance_after, note, created_at
       from points_ledger where user_id=$1 order by created_at desc limit 100`, [userId]);
  const today = new Date().toISOString().slice(0, 10);
  const checkin = await pool.query(
    `select points, streak, created_at from daily_checkins where user_id=$1 and date=$2`, [userId, today]);
  const usage = await pool.query(
    `select kind, count, cost from points_usage_daily where user_id=$1 and date=$2 order by cost desc`, [userId, today]);
  return {
    balance: acc.balance, frozen: acc.frozen,
    signedToday: !!checkin.rows.length,
    rewardPoints: 20,
    todayCheckin: checkin.rows[0] ?? null,
    dailyUsage: usage.rows,
    ledger: ledger.rows,
  };
}

// ═══ 签到(防重 + 连签) ═══
export async function checkin(userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const dup = await client.query(
      `select id from daily_checkins where user_id=$1 and date=$2 for update`, [userId, today]);
    if (dup.rows.length) { await client.query("rollback"); return { ok: false, error: "今日已签到" }; }
    // 连签: 昨天签过 → streak+1
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yStr = y.toISOString().slice(0, 10);
    const last = await client.query(
      `select streak from daily_checkins where user_id=$1 and date=$2`, [userId, yStr]);
    const streak = (last.rows[0]?.streak ?? 0) + 1;
    const reward = 20;
    await client.query(
      `insert into daily_checkins (user_id, date, points, streak) values ($1,$2,$3,$4)`,
      [userId, today, reward, streak]);
    const bal = await client.query(
      `update points_accounts set balance=balance+$2, version=version+1, updated_at=now()
        where user_id=$1 returning balance`, [userId, reward]);
    if (!bal.rows.length) {
      await client.query(`insert into points_accounts (user_id, balance) values ($1,$2)`, [userId, reward]);
    }
    await client.query(
      `insert into points_ledger (user_id, type, amount, note, balance_after)
       values ($1,'checkin',$2,'每日签到',$3)`, [userId, reward, bal.rows[0]?.balance ?? reward]);
    await client.query("commit");
    return { ok: true, points: reward, streak };
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
}

// ═══ 兑换码 ═══
export async function redeemCode(userId: string, code: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const c = await client.query(
      `select code, points, used_by from redeem_codes where code=$1 for update`, [code.trim()]);
    if (!c.rows.length) { await client.query("rollback"); return { ok: false, error: "兑换码不存在" }; }
    if (c.rows[0].used_by) { await client.query("rollback"); return { ok: false, error: "兑换码已被使用" }; }
    await client.query(`update redeem_codes set used_by=$1, used_at=now() where code=$2`, [userId, code.trim()]);
    const bal = await client.query(
      `update points_accounts set balance=balance+$2, version=version+1, updated_at=now()
        where user_id=$1 returning balance`, [userId, c.rows[0].points]);
    if (!bal.rows.length) {
      await client.query(`insert into points_accounts (user_id, balance) values ($1,$2)`, [userId, c.rows[0].points]);
    }
    await client.query(
      `insert into redemptions (code, user_id, points) values ($1,$2,$3)`, [code.trim(), userId, c.rows[0].points]);
    await client.query(
      `insert into points_ledger (user_id, type, amount, ref_type, ref_id, note, balance_after)
       values ($1,'redeem',$2,'redeem_code',$3,'兑换码入账',$4)`,
      [userId, c.rows[0].points, code.trim(), bal.rows[0]?.balance ?? c.rows[0].points]);
    await client.query("commit");
    return { ok: true, points: c.rows[0].points };
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
}

/** 生成兑换码批次(admin) */
export async function createRedeemBatch(adminId: string, prefix: string, count: number, pointsEach: number) {
  const batchId = randomUUID();
  const codes: string[] = [];
  for (let i = 0; i < Math.min(count, 500); i++) {
    codes.push(`${prefix.toUpperCase()}${randomUUID().slice(0, 8).toUpperCase()}`);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into redeem_batches (id, code_prefix, count, points_each, created_by) values ($1,$2,$3,$4,$5)`,
      [batchId, prefix, codes.length, pointsEach, adminId]);
    for (const c of codes) {
      await client.query(
        `insert into redeem_codes (code, batch_id, points) values ($1,$2,$3)`, [c, batchId, pointsEach]);
    }
    await client.query("commit");
    return { batchId, count: codes.length, sample: codes.slice(0, 3) };
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
}

export async function listRedeemBatches() {
  const r = await pool.query(
    `select b.*, (select count(*) from redeem_codes c where c.batch_id=b.id) as total,
            (select count(*) from redeem_codes c where c.batch_id=b.id and c.used_by is not null) as used
       from redeem_batches b order by b.created_at desc limit 50`);
  return r.rows;
}

// ═══ 消费: 冻结 → 实扣 / 归还(双 amount 对账) ═══
/** 冻结(消费前): 余额转 frozen; 余额不足拒绝(禁止透支) */
export async function freezeCharge(userId: string, cost: number, refType: string, refId: string) {
  if (cost <= 0) return { ok: true };
  try {
    // 余额够 → balance-cost, frozen+cost 同事务
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureAccount(userId);
      const r = await client.query(
        `update points_accounts set balance=balance-$1, frozen=frozen+$1, version=version+1, updated_at=now()
          where user_id=$2 and balance >= $1 returning balance, frozen`, [cost, userId]);
      if (!r.rows.length) { await client.query("rollback"); return { ok: false, error: "INSUFFICIENT_POINTS", needPoints: cost }; }
      const balAfter = r.rows[0].balance;
      await client.query(
        `insert into points_ledger (user_id, type, amount, freeze_amount, ref_type, ref_id, balance_after, note)
         values ($1,'freeze',$2,$3,$4,$5,$6,'消费冻结')`,
        // amount 记账口径: -cost(余额变化), freeze_amount: +cost(冻结总额口径)
        [userId, -cost, cost, refType, refId, balAfter]);
      await client.query("commit");
      return { ok: true };
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  } catch {
    return { ok: false, error: "INSUFFICIENT_POINTS", needPoints: cost };
  }
}

/** 核销实扣(完成): 冻结转出, settle_amount 落账 — 单事务原子 */
export async function settleCharge(userId: string, cost: number, refType: string, refId: string) {
  if (cost <= 0) return { ok: true };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureAccount(userId);
    const f = await client.query(
      `update points_accounts set frozen=frozen-$1, version=version+1, updated_at=now()
        where user_id=$2 and frozen >= $1 returning balance, frozen`, [cost, userId]);
    if (!f.rows.length) { await client.query("rollback"); return { ok: false, error: "FROZEN_UNDERFLOW" }; }
    await client.query(
      `insert into points_ledger (user_id, type, amount, settle_amount, ref_type, ref_id, balance_after, note)
       values ($1,'settle',$2,$3,$4,$5,$6,'消费实扣(核销)')`,
      // amount 记账口径: -cost(余额变化), settle_amount: +cost(核销总额口径)
      [userId, -cost, cost, refType, refId, f.rows[0].balance]);
    await client.query(
      `insert into points_usage_daily (user_id, date, kind, count, cost)
       values ($1, current_date, $2, 1, $3)
       on conflict (user_id, date, kind)
       do update set count=points_usage_daily.count+1, cost=points_usage_daily.cost+$3`,
      [userId, refType || "misc", cost]);
    await client.query("commit");
    return { ok: true, balance: f.rows[0].balance };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[points] settleCharge failed (user=${userId}, cost=${cost}, ref=${refType}/${refId}):`, msg);
    return { ok: false, error: `SETTLE_FAILED: ${msg.slice(0, 120)}` };
  } finally {
    client.release();
  }
}

/** 归还冻结(失败/取消): frozen → balance — 单事务原子 */
export async function rollbackFreeze(userId: string, cost: number, refType: string, refId: string) {
  if (cost <= 0) return { ok: true };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureAccount(userId);
    const f = await client.query(
      `update points_accounts set frozen=frozen-$1, version=version+1, updated_at=now()
        where user_id=$2 and frozen >= $1 returning balance, frozen`, [cost, userId]);
    if (!f.rows.length) { await client.query("rollback"); return { ok: false, error: "FROZEN_UNDERFLOW" }; }
    await client.query(
      `update points_accounts set balance=balance+$1, version=version+1 where user_id=$2`, [cost, userId]);
    await client.query(
      `insert into points_ledger (user_id, type, amount, freeze_amount, ref_type, ref_id, balance_after, note)
       values ($1,'refund',$2,$3,$4,$5,$6,'冻结归还')`,
      // refund 同时以 freeze_amount 负值对冲原冻结行(解冻口径)
      [userId, cost, -cost, refType, refId, f.rows[0].balance + cost]);
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error: "ROLLBACK_FAILED" };
  } finally {
    client.release();
  }
}

/** 对账(admin): 冻结总额 vs 实扣+在冻 */
export async function reconcile(userId?: string) {
  const where = userId ? "where user_id=$1" : "";
  const vals: unknown[] = userId ? [userId] : [];
  const r = await pool.query(
    `select
       (select coalesce(sum(freeze_amount),0) from points_ledger where type='freeze' ${userId ? "and user_id=$1" : ""}) as total_frozen,
       (select coalesce(sum(settle_amount),0) from points_ledger where type='settle' ${userId ? "and user_id=$1" : ""}) as total_settled,
       (select coalesce(sum(freeze_amount),0) from points_ledger where type in ('freeze','refund') ${userId ? "and user_id=$1" : ""})
         - (select coalesce(sum(settle_amount),0) from points_ledger where type='settle' ${userId ? "and user_id=$1" : ""}) as frozen_remaining`,
    vals);
  const acc = userId ? await getAccount(userId) : null;
  const frozenInAcc = acc?.frozen ?? 0;
  return {
    totalFrozen: Number(r.rows[0]?.total_frozen ?? 0),
    totalSettled: Number(r.rows[0]?.total_settled ?? 0),
    frozenRemainingLedger: Number(r.rows[0]?.frozen_remaining ?? 0),
    frozenInAccount: Number(frozenInAcc),
    balanced: Number(r.rows[0]?.frozen_remaining ?? 0) === Number(frozenInAcc),
  };
}

// ═══ 管理员 ═══
export async function adminAdjust(userId: string, targetUserId: string, delta: number, note: string) {
  if (delta === 0) return { ok: true };
  const bal = await changeBalance(targetUserId, delta);
  await addLedger({ userId: targetUserId, type: "admin_adjust", amount: delta, note: note || `管理员调整(${userId})` });
  return { ok: true, balance: bal };
}

export async function listTransactions(limit = 100) {
  const r = await pool.query(
    `select l.*, u.username from points_ledger l
       left join users u on u.id=l.user_id
      order by l.created_at desc limit $1`, [limit]);
  return r.rows;
}
