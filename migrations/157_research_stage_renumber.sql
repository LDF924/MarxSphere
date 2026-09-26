-- 157_research_stage_renumber.sql
-- 阶段模型重编号：插入「研究实施」，并把「讨论/评审」相关的号位腾出来。
--
-- ## 为什么
--
-- 旧阶段表：1 选题界定 · 2 框架设计 · 3 文献与资料 · 4 章节写作 · 5 统稿定稿
-- 新阶段表：1 选题界定 · 2 框架设计 · 3 研究实施 · 4 文献与资料 · 5 章节写作 · 6 统稿定稿
--
-- 「研究实施」（数据准备 → 分析 → 结果）此前被压在「文献与资料」里，
-- 而第 2 步产出的研究设计没有任何一页承接它的执行 —— 从"设计"直接跳到"料场"。
--
-- 编号口径（2026-09-26 用户拍板）：**紧凑编号**，不留空号。
-- 「研究实施」只对定量/混合研究显示；定性研究看得到的是 1→2→4→5→6 的跳号，
-- 这是**有意接受**的 —— 阶段号表达的是"第几步"的显示顺序，不是数组下标。
--
-- ## 改什么
--
--   research_projects.phase   3→4, 4→5, 5→6   （1、2 不动，0 = 未开始不动）
--   research_tasks.phase      同上（**纯显示字段**，历史中心的卡片用它）
--   research_versions.label   phase3_materials → phase4_materials
--                             phase4_text      → phase5_text
--                             phase5_final     → phase6_final
--                             phase5_revision  → phase6_revision
--
--   ⚠ `phase_label`（中文名文本）**不动** —— "文献与资料"这个词在新表里还是"文献与资料"，
--     变的只是它对应的号。所以文本列无需迁移，这正是当初把它单列存的价值。
--   ⚠ `phase2_architecture` 不动（框架设计仍在第 2 位）。
--
-- ## 幂等（这条踩过坑，写清楚）
--
-- 第一版用「单条 UPDATE + CASE」并断言它幂等 —— **错的**。试跑实测：
--
--   第一次: research_projects  phase 3:25 → 4:25   ✅ 映射正确
--   第二次: phase 4:25 → 5:25                      ❌ 链式位移
--
-- 为什么：CASE 确实对**同一行只求值一次**、用的是更新前的值，所以**单条语句内**是对的；
-- 但 `where phase in (3,4,5)` 让整条语句**可重入** —— 跑完之后那些行正躺在
-- 新的 4、5 上，恰好又落在 where 的范围内。
--
-- **排列型迁移（新旧值域重叠）无法靠 WHERE 子句做到幂等** —— 旧 4 和新 4 是同一个数字，
-- 没有任何数据特征能把它们分开。仓库里既有的数据迁移（如 007）能幂等，是因为
-- 旧值 ≠ 新值（改的是 URL 文本），本情况不适用。
--
-- 所以用**一次性标记表**：迁移自己建、自己插、并让每条语句以 `not exists` 为前置。
-- 重跑时标记已在 → 全部空转。标记表本身也是"这次重编号发生过"的凭据（回退迁移要用）。
--
-- 迁移 runner（src/db/migrate.ts）另外按 `schema_migrations` 记名、同一事务内只跑一次。
-- 两重保护：runner 管"正常路径不重跑"，标记管"任何人手动跑也只生效一次"。
--
-- ## 迁移前的实测存量（2026-09-26，本机库）
--
--   research_projects: 共 1821 行；非 0 的只有 phase 1(98) / 2(42) / 3(25)，无 4、5
--   research_versions: 共 123 行；phase4_text(72) / phase5_final(47) / phase5_revision(1)
--   research_tasks:    phase 0~5 皆有，共 794 行（纯显示字段）
--   含 phase 键的 workbench_snapshot: 1521 行
--   快照存于 %TEMP%/phase-before.json 与 scripts/_migration-dryrun.ts 的输出
--
-- ## 回退
--
-- 写一条 158 做反向映射（6→5, 5→4, 4→3 + 四个标签反向），并删除本表的标记行。
-- **不要**直接删 schema_migrations 里的记录再跑一次 —— 那只会把新数据二次位移。

-- ① 一次性标记表
create table if not exists research_stage_renumber (
  id         int primary key default 1 check (id = 1),
  applied_at timestamptz not null default now()
);

-- ② 项目阶段号
update research_projects
set phase = case phase
  when 3 then 4
  when 4 then 5
  when 5 then 6
  else phase
end
where phase in (3, 4, 5)
  and not exists (select 1 from research_stage_renumber);

-- ③ 任务阶段号（纯显示）
update research_tasks
set phase = case phase
  when 3 then 4
  when 4 then 5
  when 5 then 6
  else phase
end
where phase in (3, 4, 5)
  and not exists (select 1 from research_stage_renumber);

-- ④ 版本标签
--    publishVersion 是把 label 直接写进 research_versions 的，所以历史行里是新旧混着的。
--    四个旧标全部覆盖，包括本机库里暂时没有的 phase3_materials
--    （代码里 SectionsView/MaterialsView 确实在发这两个标，别的环境/别的库可能有）。
--    标签是文本，旧新不重叠（phase4_text vs phase5_text 是不同字符串），
--    所以这一条即使没有标记表也是幂等的 —— 但保持一致，一并加前置。
update research_versions
set label = case label
  when 'phase3_materials' then 'phase4_materials'
  when 'phase4_text'      then 'phase5_text'
  when 'phase5_final'     then 'phase6_final'
  when 'phase5_revision'  then 'phase6_revision'
  else label
end
where label in ('phase3_materials', 'phase4_text', 'phase5_final', 'phase5_revision')
  and not exists (select 1 from research_stage_renumber);

-- ⑤ 项目快照里的 phase 副本
--    前端 saveProject 会把 phase 也写进 workbench_snapshot（stores/workflow.ts 的 payload）。
--    不迁它的话，用户打开旧项目时快照里的旧号会被回读，进度条当场跳回旧位置。
update research_projects
set workbench_snapshot = jsonb_set(
      workbench_snapshot,
      '{phase}',
      to_jsonb(case (workbench_snapshot->>'phase')::int
        when 3 then 4
        when 4 then 5
        when 5 then 6
        else (workbench_snapshot->>'phase')::int
      end)
    )
where workbench_snapshot is not null
  and workbench_snapshot ? 'phase'
  and (workbench_snapshot->>'phase') ~ '^[0-9]+$'
  and (workbench_snapshot->>'phase')::int in (3, 4, 5)
  and not exists (select 1 from research_stage_renumber);

-- ⑥ 落标记 —— 放在所有 UPDATE **之后**：万一中途失败，事务回滚，标记也不会留下
insert into research_stage_renumber (id) values (1) on conflict (id) do nothing;
