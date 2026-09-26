// scripts/lib/cleanup-run-projects.mjs — 清掉"本轮门禁"新建的测试项目
//
// 由来(2026-09-26): 30 套门禁里只有 3 套声明了清理, 其余探针建的种子项目**不收尾**,
//   于是逐轮累积(audit 名下涨到 176, 逼近哨兵 400 的阻断线 —— 到线会挡住整轮门禁)。
//   治根有两条路:
//     a. 逐个探针补清理 —— 脆弱: 要改 18 个文件, 而且**下一个新探针照样会忘**;
//     b. **由门禁统一兜底** —— 跑完把"本轮新建的"清掉。新探针不用做任何事。
//   这里走 b。它同时也是 a 的安全网: 探针自己清是好事, 忘了也不会累积。
//
// ## 判据(关键): `created_at > 本轮开始时刻`
//
// 只用时间, **不看标题**。理由:
//   · 标题匹配会被"换个命名"绕过, 而时间不会;
//   · 更要紧的是**误删方向**: 按时间只会碰到"这一小时里新建的",
//     而用户自己的项目不会在你跑门禁的这一小时内冒出来;
//   · 反过来按标题匹配则可能命中真实项目(我本轮就差点把用户建的
//     "数字经济背景下中小企业融资约束的实证研究"当成测试数据)。
//
// ## 软删
//
// 用 `status='deleted'` 而不是 DELETE —— 可逆。真删错了没有回头路,
//   而软删的后果只是"从列表里消失", 还能从库里捞回来。这个差别在**兜底清理**上尤其重要:
//   它是批量动作, 一旦判据有偏差, 可逆与否决定代价量级。
//
// 用法: DATABASE_URL=... node scripts/lib/cleanup-run-projects.mjs <ISO时刻> [--apply]
//   不带 --apply 只报告。username 可用 CLEANUP_USER 覆盖(默认 audit)。
import pg from "pg";

const url = process.env.DATABASE_URL || "";
const since = process.argv[2] || "";
const APPLY = process.argv.includes("--apply");
const username = process.env.CLEANUP_USER || "audit";

if (!url) { console.log("skip"); process.exit(0); }
if (!since || Number.isNaN(Date.parse(since))) { console.log("skip: 需要 ISO 时刻参数"); process.exit(0); }

const c = new pg.Client({ connectionString: url });
try {
  await c.connect();
  const args = [username, since];
  const sel = await c.query(
    `select p.id, p.title from research_projects p join users u on u.id = p.user_id
      where u.username = $1 and p.status not in ('deleted','archived') and p.created_at >= $2::timestamptz`,
    args);

  if (!sel.rows.length) { console.log("clean:0"); await c.end(); process.exit(0); }

  if (!APPLY) {
    console.log(`would-clean:${sel.rows.length}（预演）`);
    sel.rows.slice(0, 10).forEach((x) => console.log("   " + String(x.title).slice(0, 50)));
    await c.end();
    process.exit(0);
  }

  const res = await c.query(
    `update research_projects p set status='deleted', updated_at=now()
      from users u
      where u.id = p.user_id and u.username = $1
        and p.status not in ('deleted','archived') and p.created_at >= $2::timestamptz`,
    args);
  console.log(`clean:${res.rowCount}`);
  await c.end();
} catch (e) {
  // 连不上/出错都不该让门禁失败 —— 这是收尾动作, 不是验证动作
  console.log("skip: " + String(e?.message ?? e).slice(0, 120));
  try { await c.end(); } catch { /* 忽略 */ }
}
