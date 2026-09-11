// scripts/reconcile-accounts.ts — 账目全量对账(不截断, 不做抽样)
//
// 由来(2026-09-11): 本会话我多次看 `limit N` 截断的结果就下结论, 误判过
//   "有孤立冻结行"(实际全有配对)、"额度已耗尽"(实际 18.5%)、"统计归属齐全"。
// 与其承诺"以后跑全表", 不如把对的查法固化成脚本 —— 每次都跑这个, 不看截断样本。
//
// 用法: npx tsx --env-file=.env scripts/reconcile-accounts.ts
// 退出码: 0=全部通过; 1=有不平项(可接 CI)
import { pool } from "../src/db/pool.js";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

// ═══ 1. 积分: 冻结账本 vs 核销/归还(全量配对, 无 limit) ═══
const orphan = await pool.query(`
  select f.ref_id, f.ref_type, f.freeze_amount,
         coalesce((select sum(s.settle_amount) from points_ledger s
                    where s.ref_id = f.ref_id and s.type = 'settle'), 0) as settled,
         coalesce((select sum(-r.freeze_amount) from points_ledger r
                    where r.ref_id = f.ref_id and r.type = 'refund'), 0) as refunded
    from points_ledger f
   where f.type = 'freeze'`);
const orphans = orphan.rows.filter((r) => Number(r.settled) + Number(r.refunded) === 0);
add("积分冻结全部有配对(核销或归还)", orphans.length === 0,
  `冻结 ${orphan.rows.length} 笔, 未配对 ${orphans.length} 笔${orphans.length ? ": " + orphans.map((o) => o.ref_id).join(",") : ""}`);

// 冻结不得同时被 settle 和 refund(违反"二选一"不变量)
const doubleEnded = orphan.rows.filter((r) => Number(r.settled) > 0 && Number(r.refunded) > 0);
add("冻结未同时被核销与归还", doubleEnded.length === 0,
  doubleEnded.length ? `违规: ${doubleEnded.map((r) => r.ref_id).join(",")}` : "无");

// ═══ 2. 积分: 账户冻结总额 vs 账本净冻结 ═══
const acc = await pool.query(`select coalesce(sum(frozen),0) as frozen from points_accounts`);
const led = await pool.query(`
  select (select coalesce(sum(freeze_amount),0) from points_ledger where type='freeze')
       - (select coalesce(sum(settle_amount),0) from points_ledger where type='settle')
       - (select coalesce(sum(-freeze_amount),0) from points_ledger where type='refund') as net`);
add("账户冻结总额 = 账本净冻结", Number(acc.rows[0].frozen) === Number(led.rows[0].net),
  `账户 ${acc.rows[0].frozen} vs 账本 ${led.rows[0].net}`);

// ═══ 3. 积分: 账户余额 vs 账本流水累计(逐用户) ═══
// 口径(2026-09-11): ledger.amount = **可用余额的变化量**。
//   balance(可用) 在 freeze 时减少; settle 时**不变**(钱只从 frozen 划走) → settle 的 amount 必须为 0。
//   ⚠ 账户可能有"期初本金"(账户建好时直接给余额、不落流水), 也允许余额为负(欠费)。
//   故规则是: 累计流水 <= 余额(本金只增不减), 而非"必须相等"。
//   曾用"必须相等"导致误解 —— 实际上 settle 记 -cost 才是真 bug(同一笔钱在
//   freeze 与 settle 各记一次余额减少, 任何按 amount 汇总的报表都双倍计费), 已修。
const balMismatch = await pool.query(`
  select a.user_id, a.balance,
         coalesce((select sum(l.amount) from points_ledger l where l.user_id = a.user_id), 0) as ledger_sum
    from points_accounts a`);
const badBal = balMismatch.rows.filter((r) => Number(r.ledger_sum) > Number(r.balance));
add("积分流水累计 ≤ 账户余额(超支即不平)", badBal.length === 0,
  badBal.length
    ? badBal.map((r) => `${String(r.user_id).slice(0, 8)}: 账户${r.balance} vs 流水${r.ledger_sum}`).join(" | ")
    : `${balMismatch.rows.length} 个账户全部相符`);

// 3b. settle 行的 amount 必须为 0(核销不改变可用余额)
const settleNonZero = await pool.query(`select count(*)::int n from points_ledger where type='settle' and amount <> 0`);
add("settle 行 amount 为 0(核销不动可用余额)", Number(settleNonZero.rows[0].n) === 0,
  Number(settleNonZero.rows[0].n) === 0 ? "全部为 0" : `${settleNonZero.rows[0].n} 行为非 0, 会双倍计费`);

// ═══ 4. 成本账本: 归属完整性(按端点全量统计) ═══
const attr = await pool.query(`
  select endpoint, count(*)::int as total, count(user_id)::int as with_user
    from llm_usage_ledger group by endpoint order by total desc`);
const noUser = attr.rows.filter((r) => Number(r.total) !== Number(r.with_user));
add("成本账本全部带用户归属", noUser.length === 0,
  noUser.length
    ? noUser.map((r) => `${r.endpoint}: ${r.with_user}/${r.total}`).join(" | ") + " (注: 后台任务无归属属预期)"
    : `${attr.rows.length} 个端点全部带归属`);

// ═══ 5. 成本账本 vs 计费账: 差额应等于"系统调用(无归属)"成本 ═══
const diff = await pool.query(`
  select
    (select coalesce(sum(tokens_in + tokens_out),0) from llm_usage_ledger where user_id is not null) as ledger_user_tokens,
    (select coalesce(sum(tokens_input + tokens_output),0) from user_usage_log) as billed_tokens`);
const lu = Number(diff.rows[0].ledger_user_tokens);
const bt = Number(diff.rows[0].billed_tokens);
// 计费账应 <= 有归属的成本账(计费由 chargeUser 写, 某些链可能未接计费)
add("计费 token ≤ 有归属的成本 token", bt <= lu, `有归属成本 ${lu} vs 已计费 ${bt} (差 ${lu - bt})`);

// ═══ 6. 定价卖价必须高于成本(防亏本卖) ═══
const { pricingTable } = await import("../src/services/pricing.js");
const underpriced = pricingTable().filter((r) => r.priceCny <= r.cogsCny);
add("所有功能售价 > 成本", underpriced.length === 0,
  underpriced.length ? underpriced.map((r) => r.feature).join(",") : `${pricingTable().length} 项全部有利润`);

// ═══ 输出 ═══
console.log("══════════ 账目全量对账(无截断) ══════════\n");
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} 通过 ===`);
if (failed.length) console.log("有不平项, 需人工核对上方明细");
process.exit(failed.length ? 1 : 0);
