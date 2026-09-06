-- 115_research_tasks_nodes.sql — SocialSci P0-1: 科研执行任务 + 节点快照(UI断点持久化)
-- 形态对齐: 任务容器(task+module) + 节点快照(node_key 全量 JSON 原子覆盖+历史行回滚)
--   与 agent_tasks(52步推理/通用Agent编排)并列不动, 本表为「科研项目级执行任务」层
--   dag_node_id: 画布节点挂执行任务; depends_on: 画布入边→前置任务就绪判定(DAG依赖编排)
-- 原创实现, 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-03/S-04/S-10

create table if not exists research_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,                 -- 归属项目
  user_id uuid not null,
  dag_node_id text not null default '',     -- 画布节点 id(canvas.nodes[].id); '' = 非画布任务(线性)
  module text not null default 'workflow',  -- workflow / review / statistics / viz / knowledge(跨模块任务容器)
  job_kind text not null default 'analyze', -- clarify / analyze / materials / chapter_gen / review / finalize / humanize / custom
  phase int not null default 0,             -- 0..5 线性模板相位(辅助)
  phase_label text not null default '',
  goal text not null default '',            -- 任务目标(自然语言)
  status text not null default 'queued',    -- queued / running / paused / waiting_user / cancelled / failed / done
  plan jsonb not null default '[]'::jsonb,  -- 子步骤计划(主控Agent产物)
  current_step int not null default 0,
  progress jsonb not null default '{}'::jsonb, -- SSE续传断点: {lastEventSeq, currentStep, nodeStatus}
  input_snapshot jsonb,                     -- 输入快照(启动参数, 供重试/恢复)
  depends_on jsonb not null default '[]'::jsonb, -- 前置任务id[] (画布入边映射, DAG就绪判定)
  retry_of uuid,                            -- 重试追链: 本任务是哪个任务的重试
  error jsonb,                              -- {code, userMessage, canRetry, hint}
  cost jsonb not null default '{}'::jsonb,  -- {points, tokens} 计点记账
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_research_tasks_project on research_tasks(project_id, created_at desc);
create index if not exists idx_research_tasks_user on research_tasks(user_id, status);
create index if not exists idx_research_tasks_dag on research_tasks(project_id, dag_node_id);
create index if not exists idx_research_tasks_retry on research_tasks(retry_of) where retry_of is not null;

-- ═══ 节点快照(每 UI 阶段/产物一 key, 全量 JSON) ═══
create table if not exists research_nodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  task_id uuid,                             -- 产出任务(可空: 用户手编)
  node_key text not null,                   -- input / clarify / analysis / sections / materials / workspace / finalize / custom
  payload jsonb not null default '{}'::jsonb, -- 全量快照
  version int not null default 1,           -- 当前版本(每次覆盖+1)
  source_role text not null default 'user', -- user / agent / main_agent / system
  state_version bigint not null default 1,  -- 乐观锁
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, node_key)
);

create index if not exists idx_research_nodes_task on research_nodes(task_id);

-- ═══ 节点历史(append-only, 回滚数据源) ═══
create table if not exists research_node_history (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null,                    -- research_nodes.id
  version int not null,                     -- 该历史对应版本
  payload jsonb not null default '{}'::jsonb,
  parent_version int,                       -- 被谁覆盖(回滚链)
  by_role text not null default 'user',
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_research_node_history_node on research_node_history(node_id, version desc);

-- ═══ 版本发布(指针快照: 记录各节点 history 引用, 不复制 payload) ═══
create table if not exists research_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  version int not null,                     -- 项目内递增
  label text not null default '',           -- 如 "初稿" / "终稿v2"
  snapshot jsonb not null default '{}'::jsonb, -- {nodeKey: {nodeId, historyId, version}}
  status text not null default 'published', -- published / superseded / rolled_back
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create index if not exists idx_research_versions_project on research_versions(project_id, version desc);
