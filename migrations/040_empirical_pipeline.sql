-- 040_empirical_pipeline.sql — 实证工作台管线（闸门/审计/管道记录）
-- 范式同 038: 纯 create table if not exists + create index if not exists

-- 人工闸门 4 节点状态机: draft(可编辑) → locked → confirmed; 退回=回 draft + 级联回退后续节点
create table if not exists empirical_gates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  node text not null,                    -- topic|variable_definition|identification|result_interpretation
  status text not null default 'draft',  -- draft|locked|confirmed
  content jsonb not null default '{}',
  reopens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, node)
);
create index if not exists idx_egate_project on empirical_gates (project_id, node);

-- 闸门操作审计（每次保存/锁定/确认/退回记录 before/after）
create table if not exists empirical_gate_audit (
  id bigserial primary key,
  project_id uuid not null references empirical_projects(id) on delete cascade,
  gate_id uuid references empirical_gates(id) on delete set null,
  action text not null,                  -- create|edit|lock|confirm|reopen
  content_before jsonb not null default '{}',
  content_after jsonb not null default '{}',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_egate_audit on empirical_gate_audit (project_id, gate_id, created_at desc);

-- 管道运行记录（信效度/诊断/插补/数据管道/回归）
create table if not exists empirical_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  stage text not null,                   -- reliability|diagnosis|imputation|data_pipeline|regression
  input_snapshot jsonb not null default '{}',   -- 输入摘要(变量/样本量/参数, 不含数据本体)
  python_result jsonb not null default '{}',
  llm_interpretation text not null default '',
  stata_code text not null default '',
  warnings text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_eprun_project on empirical_pipeline_runs (project_id, created_at desc);
