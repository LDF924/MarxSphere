// scripts/merge-duplicate-skills.ts — V417: 合并同名重复技能（一次性运维脚本）
//
// 背景: proposeSkill 早期是无条件 INSERT, 同一个技能被反复蒸馏就多一行 ——
//   实测 144 行只有 15 个不同名字, 两个技能占了 134 行。库里 93% 是同一个东西的改写。
//   修了写入端(同名即强化)之后, 历史冗余仍需清理, 否则召回排序会被噪声淹没。
//
// 策略（**只按名字精确分组, 不猜近名**）:
//   组内 43 条虽然"不同开头"全是 43 个, 但讲的是同一个方法(LLM 每次换句话重述),
//   所以是"选代表 + 合并来源", 不是逐字去重。
//   代表选择: (a) 有使用痕迹的优先 —— 那条被真实任务验证过, 内容更可信;
//             (b) 其次内容最全(长度); (c) 再其次 id 最小(最早提出, 稳定)。
//
//   为什么不合并近名(如 多跳归因推理 / 金融指标归因推理 / 多跳推理归因):
//   实测这三条内容高度重叠但边界微妙 —— LLM 判"相近"在本例里会出错, 而**错误合并比留着冗余更糟**
//   (会静默删掉一个可能是对的技能)。近名留给人判。
//
// 用法:
//   npx tsx scripts/merge-duplicate-skills.ts          # 试跑, 只打印计划
//   npx tsx scripts/merge-duplicate-skills.ts --apply  # 真正执行(事务内)
import { pool } from "../src/db/pool.js";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: number; name: string; when_to_apply: string; skill_md: string;
  source_tasks: string[] | null; consensus: number;
  use_count: number; success_count: number; created_at: string;
}

const { rows } = await pool.query<Row>(`select * from agent_skills order by id`);

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = String(r.name);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

/** 代表选择: 用过 > 内容全 > id 小 */
function pickKeeper(list: Row[]): Row {
  return [...list].sort((a, b) => {
    const ua = Number(a.use_count || 0), ub = Number(b.use_count || 0);
    if (ua !== ub) return ub - ua;
    const la = String(a.skill_md || "").length, lb = String(b.skill_md || "").length;
    if (la !== lb) return lb - la;
    return a.id - b.id;
  })[0];
}

let mergedGroups = 0, deletedRows = 0, touchedTasks = 0;
const plan: string[] = [];

for (const [name, list] of groups) {
  if (list.length <= 1) continue;
  const keeper = pickKeeper(list);
  const others = list.filter((r) => r.id !== keeper.id);

  // 合并来源任务: 组内所有行的 source_tasks 并集(去重、去空)
  const tasks = [...new Set(list.flatMap((r) => (Array.isArray(r.source_tasks) ? r.source_tasks : [])).filter(Boolean))];
  const useSum = list.reduce((s, r) => s + Number(r.use_count || 0), 0);
  const okSum = list.reduce((s, r) => s + Number(r.success_count || 0), 0);
  // 校验票数取最大值(不是求和 —— 那是"放行票数", 求和会造出票数超过校验者数量的假象)
  const consensus = Math.max(...list.map((r) => Number(r.consensus || 0)));

  mergedGroups++; deletedRows += others.length; touchedTasks += tasks.length;
  plan.push(
    `  ${name}: ${list.length} → 1 (保留 id=${keeper.id}, 合并 ${tasks.length} 个来源, 用/成 ${useSum}/${okSum})`
  );

  if (!APPLY) continue;

  const client = await pool.connect();
  try {
    await client.query("begin");
    // ① 使用流水改挂到代表上, 并保留原 id 便于回溯(写进 goal 前缀)
    const othersIds = others.map((r) => r.id);
    await client.query(
      `update skill_usage_events set skill_id = $1,
              goal = coalesce(left(goal, 240), '') || ' [由技能#' || skill_id || ' 合并]'
        where skill_id = any($2::int[])`,
      [keeper.id, othersIds]
    );
    // ② 更新代表
    await client.query(
      `update agent_skills
          set source_tasks = $2::text[], use_count = $3, success_count = $4, consensus = $5,
              last_used_at = (select max(last_used_at) from agent_skills where id = any($6::int[]))
        where id = $1`,
      [keeper.id, tasks, useSum, okSum, consensus, list.map((r) => r.id)]
    );
    // ③ 删除其余
    await client.query(`delete from agent_skills where id = any($1::int[])`, [othersIds]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    console.error(`  ✗ ${name} 合并失败: ${String((e as Error)?.message || e).slice(0, 100)}`);
  } finally {
    client.release();
  }
}

console.log(plan.join("\n"));
console.log(
  `\n${APPLY ? "已执行" : "试跑(未改动)"}: 合并 ${mergedGroups} 组, 删除 ${deletedRows} 行, ` +
  `合并后库内约 ${rows.length - deletedRows} 条`
);
if (!APPLY && deletedRows > 0) console.log(`\n确认无误后执行: npx tsx scripts/merge-duplicate-skills.ts --apply`);
await pool.end();
