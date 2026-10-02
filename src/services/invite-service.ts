// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// invite-service.ts — 邀请码(闭环: 生成 → 注册时认领 → 双方得积分)
//
// ═══ 为什么会有这个文件 ═══
//
// 2026-10-02 实测: `invite_codes` 表(迁移120) 与 `users.invited_by`/`can_invite` 两列
//   **全仓零读写** —— `grep -rn invite_codes src/ web/src/` 只命中 `points-service.ts:7`
//   的一行注释。也就是说这些 schema 建好之后，邀请功能**从来没有被实现过**：
//   没有生成入口、没有认领逻辑、没有归因、没有奖励发放。
//   `points_ledger.type` 里的 `invite_bonus` 也只在注释与前端颜色表里出现。
//
// 这是"表建了就算做完了"的典型 —— 从 schema 看不出任何异常，只有顺着读写点查才会发现。
//
// ═══ 与"兑换码"的区别(两者容易混) ═══
//   `redeem_codes`:  运营批量生成 → 发给任何人 → 先到先得 → 只奖励兑换者。
//   `invite_codes`:  **每个用户一条专属码** → 只在注册时可用 → **双向奖励**，
//                    且要记归因(`users.invited_by`)供后续(如首充奖励)使用。
//   所以不合并成一套 —— 生命周期与归属都不同。
//
// ═══ 为什么奖励值做成可配置 ═══
//   竞品 Respal 用的是"邀请各得 2000、好友首充再得 10000"。那是**它的商业参数**，
//   直接照搬既不合理也没依据。这里只提供机制，默认值保守(200)，由运营调 env。
import { pool } from "../db/pool.js";
import { randomBytes } from "node:crypto";

/** 奖励额度 —— 可用 env 覆盖，不改代码就能调增长策略 */
const INVITE_BONUS_OWNER = Number(process.env.INVITE_BONUS_OWNER || 200);
const INVITE_BONUS_INVITEE = Number(process.env.INVITE_BONUS_INVITEE || 200);
const FIRST_PAY_BONUS_OWNER = Number(process.env.INVITE_FIRST_PAY_BONUS || 1000);

/** 生成一个短码：8 位 base32 风格，避开易混字符(0/O/1/I/l) */
function newCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** 取(或首次生成)某用户的专属邀请码。幂等 —— 一个用户一条常驻码，
 *  不每次调用都新建(否则用户会散出去多个码，归因也会散)。 */
export async function getOrCreateInviteCode(userId: string): Promise<{ code: string; created: boolean }> {
  const existing = await pool.query(
    `select code from invite_codes where owner_user_id = $1 order by created_at asc limit 1`,
    [userId]
  );
  if (existing.rows.length) return { code: String(existing.rows[0].code), created: false };

  // 唯一冲突重试：8 位 31 字符表 ≈ 4e11 组合，冲突概率极低，但 code 是主键，
  // 真撞上要能自愈而不是把 500 抛给用户
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      await pool.query(
        `insert into invite_codes (code, owner_user_id, bonus_points) values ($1, $2, $3)`,
        [code, userId, INVITE_BONUS_OWNER]
      );
      return { code, created: true };
    } catch (e: any) {
      if (!String(e?.message || "").includes("duplicate")) throw e;
    }
  }
  throw new Error("邀请码生成失败（连续冲突）");
}

/** 邀请概况 —— 前端展示"我邀请了几个人 / 累计奖励多少" */
export async function getInviteSummary(userId: string): Promise<{
  code: string;
  invitedCount: number;
  rewardedPoints: number;
  bonus: { owner: number; invitee: number; firstPayOwner: number };
  invitees: Array<{ username: string; joinedAt: string }>;
}> {
  const { code } = await getOrCreateInviteCode(userId);
  // 归因靠 users.invited_by —— 这是 120 迁移就加好但一直没写入的列
  const list = await pool.query(
    `select username, created_at from users where invited_by = $1 order by created_at desc limit 50`,
    [userId]
  );
  // 累计奖励从账本算，不另存计数(单一真源: points_ledger)
  const sum = await pool.query(
    `select coalesce(sum(amount),0)::int as total from points_ledger
      where user_id = $1 and type = 'invite_bonus'`,
    [userId]
  );
  return {
    code,
    invitedCount: list.rows.length,
    rewardedPoints: Number(sum.rows[0]?.total) || 0,
    bonus: { owner: INVITE_BONUS_OWNER, invitee: INVITE_BONUS_INVITEE, firstPayOwner: FIRST_PAY_BONUS_OWNER },
    invitees: list.rows.map((r: any) => ({
      username: String(r.username || ""),
      joinedAt: r.created_at ? new Date(r.created_at).toISOString() : ""
    }))
  };
}

/** 注册时认领邀请码。
 *
 *  ⚠ 在**注册事务内**调用，失败**不阻断注册** —— 邀请码填错不该让用户注册不了。
 *    所以返回 { ok:false, error } 由调用方决定是提示还是忽略。
 *
 *  防自邀: 码的 owner 不能是新用户自己(理论上新用户还没有码，但防御性拦住)。
 *  防重复认领: 一个用户只能被邀请一次(users.invited_by 非空即已认领)。
 */
export async function claimInvite(input: {
  code: string;
  newUserId: string;
  client: { query: (sql: string, params?: unknown[]) => Promise<any> };
}): Promise<{ ok: boolean; error?: string; invitedBy?: string; bonus?: number }> {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "邀请码为空" };
  const cur = await input.client.query(
    `select code, owner_user_id, bonus_points, claimed_by from invite_codes where code = $1 for update`,
    [code]
  );
  if (!cur.rows.length) return { ok: false, error: "邀请码不存在" };
  const row = cur.rows[0];
  const ownerId = String(row.owner_user_id || "");
  if (!ownerId) return { ok: false, error: "该邀请码没有归属用户" };
  if (ownerId === input.newUserId) return { ok: false, error: "不能邀请自己" };
  // 一码一人: claimed_by 一旦写入就不能再被别人用
  if (row.claimed_by) return { ok: false, error: "该邀请码已被使用" };

  const bonus = Number(row.bonus_points) || INVITE_BONUS_OWNER;
  await input.client.query(
    `update invite_codes set claimed_by = $2 where code = $1`,
    [code, input.newUserId]
  );
  // 归因 —— 120 迁移加的列，这里是它的第一个写入点
  await input.client.query(`update users set invited_by = $2 where id = $1`, [input.newUserId, ownerId]);
  return { ok: true, invitedBy: ownerId, bonus };
}

/** 发放邀请奖励(双向)。**在注册事务提交后单独调用** —— 因为它要写 points_ledger 与
 *  points_accounts，与注册事务耦合会让"注册成功但积分没发"变成回滚整个注册。
 *  单独调用的代价是"注册成功、奖励失败"，这时靠 ledger 可追、可补，比丢注册好。
 */
export async function grantInviteBonus(input: {
  ownerId: string; inviteeId: string; inviteeName: string; ownerBonus: number; inviteeBonus: number;
}): Promise<{ ownerGranted: number; inviteeGranted: number }> {
  const grant = async (userId: string, amount: number, note: string) => {
    if (amount <= 0) return 0;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const bal = await client.query(
        `update points_accounts set balance = balance + $2, version = version + 1, updated_at = now()
          where user_id = $1 returning balance`,
        [userId, amount]
      );
      const after = bal.rows.length
        ? Number(bal.rows[0].balance)
        : (await client.query(
            `insert into points_accounts (user_id, balance) values ($1,$2) returning balance`,
            [userId, amount]
          )).rows[0].balance;
      await client.query(
        `insert into points_ledger (user_id, type, amount, note, balance_after)
         values ($1,'invite_bonus',$2,$3,$4)`,
        [userId, amount, note, after]
      );
      await client.query("commit");
      return amount;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  };
  const ownerGranted = await grant(input.ownerId, input.ownerBonus, `邀请奖励（${input.inviteeName} 通过你的邀请码注册）`);
  const inviteeGranted = await grant(input.inviteeId, input.inviteeBonus, "新用户邀请奖励");
  return { ownerGranted, inviteeGranted };
}

/** 被邀请人首次付费 → 邀请人再得一笔。
 *
 *  ⚠ 幂等靠账本查重，不靠额外标记列: `points_ledger` 里同 owner 同 invitee 的
 *    first_pay 奖励只应有一条，写之前先查。这样**重复回调也不会重复发**(支付回调本身
 *    就可能重投)。note 里的 inviteeId 是判重依据，所以格式必须固定。
 */
export async function grantFirstPayBonus(input: {
  inviteeId: string; amountCents: number;
}): Promise<{ granted: number; ownerId?: string }> {
  // 找到这个被邀请人的邀请人
  const u = await pool.query(`select invited_by, username from users where id = $1`, [input.inviteeId]);
  const ownerId = u.rows[0]?.invited_by ? String(u.rows[0].invited_by) : "";
  if (!ownerId) return { granted: 0 };   // 不是被邀请来的用户 —— 正常情况，不是错误

  const marker = `[first_pay:${input.inviteeId}]`;
  const dup = await pool.query(
    `select id from points_ledger where user_id = $1 and type = 'invite_bonus' and note like $2 limit 1`,
    [ownerId, `%${marker}%`]
  );
  if (dup.rows.length) return { granted: 0, ownerId };   // 已发过

  const client = await pool.connect();
  try {
    await client.query("begin");
    const bal = await client.query(
      `update points_accounts set balance = balance + $2, version = version + 1, updated_at = now()
        where user_id = $1 returning balance`,
      [ownerId, FIRST_PAY_BONUS_OWNER]
    );
    const after = bal.rows.length
      ? Number(bal.rows[0].balance)
      : (await client.query(
          `insert into points_accounts (user_id, balance) values ($1,$2) returning balance`,
          [ownerId, FIRST_PAY_BONUS_OWNER]
        )).rows[0].balance;
    await client.query(
      `insert into points_ledger (user_id, type, amount, note, balance_after)
       values ($1,'invite_bonus',$2,$3,$4)`,
      [ownerId, FIRST_PAY_BONUS_OWNER, `好友首充奖励 ${marker}`, after]
    );
    await client.query("commit");
    return { granted: FIRST_PAY_BONUS_OWNER, ownerId };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

export const inviteService = {
  getOrCreateInviteCode, getInviteSummary, claimInvite, grantInviteBonus, grantFirstPayBonus,
};
