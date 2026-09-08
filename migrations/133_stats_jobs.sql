-- 133_stats_jobs.sql — SocialSci Vue M3: 统计分析 17 法任务持久化(闭源 statistics-jobs 契约)
-- 形态: 一次分析 = 一个 job(tool=17 方法之一, input=完整参数, result={tables,charts,warnings,metadata})
--   result_version_id: 产物版本号(闭源图表素材导入引用); source_task_id: 任务体系归属
create table if not exists stats_jobs (
  id uuid primary key,
  user_id uuid not null,
  tool text not null default 'descriptive',
  input jsonb not null default '{}',
  status text not null default 'queued',          -- queued/running/completed/failed/cancelled
  result jsonb not null default '{}',
  result_version_id uuid,
  error jsonb,
  source_task_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_stats_jobs_user_time on stats_jobs (user_id, created_at desc);
create index if not exists idx_stats_jobs_status on stats_jobs (status) where status in ('queued','running');
