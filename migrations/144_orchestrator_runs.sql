-- 144_orchestrator_runs.sql — V415: 编排运行落库(画布 DAG 真执行)
--
-- 由来(2026-09-12 用户指出「课题流程编排」不完善): 旧实现把运行状态全放在前端
--   (quick_graph 节点 + 800ms 轮询 job.status), 后端没有一条"这次编排跑到哪了"的记录。
--   后果: ① 刷新/换设备就丢; ② "暂停"只停前端轮询, 后端照跑; ③ 失败原因查不到。
--
-- 语义:
--   graph_json   本次运行用的图(节点+边; 模板起点 + 用户改动后的最终形态), 供复现
--   step_log_json 每步状态/输出/耗时/错误(前端进度卡直接渲染它)
--   status       running | waiting_input | paused | done | failed | cancelled
--      paused 与 waiting_input 不同: 前者是我们主动停下的, 后者在等用户填表单
--   parent_run_id 子编排(DAG 套 DAG)时指向父运行
--
-- 幂等: create table if not exists; 不写 backfill(历史运行本就没记录)

create table if not exists orchestrator_runs (
  id text primary key,
  graph_id text,
  graph_name text,
  input text not null default '',
  status text not null default 'running',
  graph_json jsonb,
  step_log_json jsonb not null default '[]'::jsonb,
  outputs_json jsonb not null default '{}'::jsonb,
  final_text text,
  error text,
  parent_run_id text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists orchestrator_runs_created_idx on orchestrator_runs (created_at desc);
create index if not exists orchestrator_runs_status_idx on orchestrator_runs (status);

-- 画布图(用户保存的自定义编排; 模板在代码里, 这里只存用户改过的)
create table if not exists orchestrator_graphs (
  id text primary key,
  name text not null,
  description text,
  graph_json jsonb not null,
  /** 基于哪个模板改的(供「恢复模板原样」) */
  based_on text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table orchestrator_runs is 'V415 编排运行记录(画布 DAG 执行; 步骤状态/产物/失败原因)';
comment on table orchestrator_graphs is 'V415 用户保存的自定义编排图(模板在代码 builtin-templates.ts)';
