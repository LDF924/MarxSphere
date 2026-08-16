-- 008_reasoning_schema: SAG 11005 推理层数据模型
-- 五种实体: query_tasks, outlines, retrieve_steps, infer_hypotheses, eval_records

begin;

create table if not exists query_tasks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  tenant_id text not null default 'default',
  query text not null,
  status text not null default 'pending' check (status in ('pending', 'outlining', 'retrieving', 'inferring', 'evaluating', 'completed', 'failed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  metadata jsonb default '{}',
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_query_tasks_source on query_tasks(source_id);
create index if not exists idx_query_tasks_status on query_tasks(status);

create table if not exists outlines (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references query_tasks(id) on delete cascade,
  parent_outline_id uuid references outlines(id) on delete set null,
  title text not null,
  description text,
  order_index int not null default 0,
  depth int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'retrieving', 'completed', 'failed')),
  metadata jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_outlines_task on outlines(task_id);

create table if not exists retrieve_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references query_tasks(id) on delete cascade,
  outline_id uuid references outlines(id) on delete set null,
  engine text not null check (engine in ('graphiti', 'cognee', 'sag', 'hybrid')),
  search_type text not null,
  query text not null,
  parameters jsonb default '{}',
  result_count int,
  result_preview jsonb,
  trace jsonb,
  duration_ms int,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  error text,
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_retrieve_steps_task on retrieve_steps(task_id);

create table if not exists infer_hypotheses (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references query_tasks(id) on delete cascade,
  content text not null,
  confidence real check (confidence >= 0 and confidence <= 1),
  supporting_step_ids uuid[] default '{}',
  refuting_step_ids uuid[] default '{}',
  citations jsonb default '[]',
  reasoning text,
  status text not null default 'draft' check (status in ('draft', 'verified', 'refuted', 'revised')),
  metadata jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_hypotheses_task on infer_hypotheses(task_id);

create table if not exists eval_records (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references query_tasks(id) on delete cascade,
  hypothesis_id uuid references infer_hypotheses(id) on delete set null,
  evaluator text not null default 'llm',
  dimensions jsonb not null default '{}',
  overall_score real check (overall_score >= 0 and overall_score <= 1),
  passed boolean,
  notes text,
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_eval_records_task on eval_records(task_id);

insert into schema_migrations (name) values ('008_reasoning_schema.sql');

commit;
