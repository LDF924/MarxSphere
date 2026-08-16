-- 041_empirical_imputation.sql — LLM 民调插补（论文: 杨锋等, 国际政治科学 2025-4）
-- 范式同 038: 纯 create table if not exists + create index if not exists

-- 插补任务
create table if not exists empirical_imputation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  target_col text not null,
  context_cols text[] not null default '{}',
  field_info text not null default '',
  missing_analysis jsonb not null default '{}',   -- 机制诊断输出(empty/junk/masked 三类)
  llm_config jsonb not null default '{}',         -- 模型/温度/批大小
  stats jsonb not null default '{}',              -- 保真+精度评估(python 产出)
  baseline_compare jsonb not null default '[]',
  status text not null default 'running',         -- running|confirming|done|failed
  n_imputed integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_eimp_run_project on empirical_imputation_runs (project_id, created_at desc);

-- 插补逐条确认(人工审核池)
create table if not exists empirical_imputation_cells (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references empirical_imputation_runs(id) on delete cascade,
  row_idx integer not null,
  col text not null,
  original_value text,
  missing_type text not null,             -- empty|junk|masked
  llm_value text not null,
  llm_reason text not null default '',
  status text not null default 'pending', -- pending|confirmed|rejected|edited
  edited_value text,
  created_at timestamptz not null default now()
);
create index if not exists idx_eimp_cell_run on empirical_imputation_cells (run_id, status);
