-- 038_empirical_results.sql — 实证研究结果持久化（V348+）
-- 范式同 030: 纯 create table if not exists + create index if not exists

create table if not exists empirical_results (
  id uuid primary key default gen_random_uuid(),
  method text not null,
  title text not null default '',
  data_summary jsonb not null default '{}',        -- 列名/行数等元信息
  params jsonb not null default '{}',              -- 分析方法参数
  result jsonb not null default '{}',              -- 完整结果(tables/figures/diagnostics/warnings)
  meta jsonb not null default '{}',                -- 方法meta(n/durationMs等)
  created_at timestamptz not null default now()
);
create index if not exists idx_empirical_results_created on empirical_results (created_at desc);
