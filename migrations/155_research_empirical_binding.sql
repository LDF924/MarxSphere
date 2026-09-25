-- 155_research_empirical_binding.sql
--
-- 由来(2026-09-25): 实证台的因果推断方法(DiD / IV / RDD / PSM / 合成控制 / 事件研究)跑出来的结果
--   **回不到写作舱**。
--
-- 实测(逐处核对过):
--   · 写作舱的证据服务只读 `stats_jobs`(统计台 17 法), 而实证台的 19 法落的是
--     `empirical_pipeline_runs.python_result` —— 两边唯一的连接点是"数据文件 id",
--     而实证台走 `/api/empirical/run` 时**根本不写 stats_jobs**, 所以那条连接点也不成立。
--   · `empirical_ledger_entries`(证据账本)本来就是为"每个系数绑定数据/代码/文献"而建的,
--     但它的读方只有它自己的 CRUD —— 写作舱一处都没读过。
--   ⇒ 一个做因果推断的研究者, 在实证台跑完 DiD, 只能手动抄进正文。
--
-- ⚠⚠ 一条必须写在最前面的**安全事实**(不是设计选择, 是现状):
--   `empirical_projects` **没有 user_id 列**(全仓核对: 只有 `empirical_results` 在迁移 127
--   被补过 user_id), 且实证台的 63 个路由**没有一处调 requireUser**。
--   也就是说 **实证台的数据是"实例级"的, 本来就没有用户隔离** —— 这是既有的架构事实。
--
--   本迁移**不假装**能补上用户隔离(那需要给 empirical_projects 加 user_id + 回填历史数据 +
--   改三个模块的创建路径, 是另一件事)。它做的是: 把"写作舱引用实证结果"限制成
--   **用户显式绑定 + 同实例内** —— 越权面与实证台自身的暴露面**完全一致, 没有扩大**。
--   界面上也必须如实说明这一点(见 ChapterEvidencePanel 的提示文案), 否则用户会以为
--   "我能在写作舱看到它"等于"它是我的私有数据"。
--
-- 幂等: add column if not exists / 索引 if not exists。
--   on delete set null: 实证课题被删时, 写作课题不该跟着坏掉 —— 只是"绑定没了"。

alter table research_projects
  add column if not exists empirical_project_id uuid references empirical_projects(id) on delete set null;

comment on column research_projects.empirical_project_id is
  'V426: 绑定的实证课题(empirical_projects.id); null=未绑定。'
  '写作舱据此列出该实证课题下的运行结果作为证据候选。'
  '⚠ 实证台数据是实例级的(empirical_projects 无 user_id), 本绑定不构成用户级隔离。';

-- 反查用: "这个实证课题被哪些写作课题绑着"
create index if not exists idx_research_projects_empirical
  on research_projects (empirical_project_id)
  where empirical_project_id is not null;
