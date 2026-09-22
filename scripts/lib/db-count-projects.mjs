// scripts/lib/db-count-projects.mjs — 数测试账号名下还有多少未删项目
//
// 单独成文件而不是在哨兵里拼一段 `node -e "..."`: 拼字符串要经 shell 与多层引号,
//   实测在 Python 改写时直接被转义搞坏(写出来的文件语法都不对)。
//   独立文件没有引号层数问题, 也便于单独跑来看数。
//
// 用法: DATABASE_URL=... node scripts/lib/db-count-projects.mjs [username]
//   输出一行数字; 连不上输出 -1(调用方据此跳过, 不当作失败)
import pg from "pg";

const url = process.env.DATABASE_URL || "";
const username = process.argv[2] || "audit";
if (!url) { console.log("-1"); process.exit(0); }
const c = new pg.Client({ connectionString: url });
try {
  await c.connect();
  /**
   * 只数**活跃**的。
   *
   * ⚠ 第一版写的是 `status<>'deleted'`, 把已归档的也算了进去 —— 于是清理完之后这个数
   *   仍然停在 768(765 条已归档), 告警照旧。而归档的语义正是"收起来":
   *   它不再占用项目栏、不再影响可用性, 就不该再触发这条告警。数错了对象,
   *   结果就是"修好了还一直在报"。
   */
  const r = await c.query(
    `select count(*)::int n from research_projects
      where user_id=(select id from users where username=$1)
        and status<>'deleted' and status<>'archived'`, [username]);
  console.log(r.rows[0].n);
} catch {
  console.log("-1");
} finally {
  try { await c.end(); } catch { /* 忽略 */ }
}
