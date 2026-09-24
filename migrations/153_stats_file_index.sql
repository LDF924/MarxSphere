-- 153_stats_file_index.sql
--
-- 由来(2026-09-24): 写作舱第 3 步可以跳去「数据分析」跑回归, 但结果**回不来** ——
--   两边不在一个 id 空间: 写作舱用 research_projects.id, 统计结果按 user_id 存在 stats_jobs,
--   中间没有任何一列把它们连起来(全仓查 `research_project_id` 零命中)。
--   唯一可用的连接点是: 写作舱快照里的 statisticsFileId → stats_jobs.input->>'fileId'。
--   可那个 `input` 是 jsonb 且无索引, 按它过滤等于全表扫 —— 每点一次"取回分析结果"扫一遍。
--
-- 这条索引把那个连接点变成 O(log n): 等值表达式索引(jsonb ->> 是 immutable, 可入索引)。
-- 顺带解决"这个数据文件被哪些分析用过"—— 同一个 fileId 可以对应多个 job(描述统计/回归/…)。
--
-- 幂等: if not exists。不加 FK —— user_files 删了以后历史结果仍应可读(它们自带表格内容)。
--
-- 注: 不加 project_id 列。加列意味着要给每一次建 job 补写它, 而那些调用点分布在
--   统计台/编辑器/实证台三处, 漏一处就会出现"有的结果回得来有的回不来"这种最难查的半截状态。
--   保持"按 fileId 连接"这一条规则, 只在写作舱这一侧做, 不需要任何调用点配合。

create index if not exists idx_stats_jobs_input_file_id
  on stats_jobs (user_id, (input ->> 'fileId'))
  where input ? 'fileId';
