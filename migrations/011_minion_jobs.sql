-- minion_jobs — Jobs 任务队列（GBrain Jobs 适配）
-- Deterministic Task（lint/backlinks/sync/synthesize/embed/orphans/purge）
-- + Dream Cycle 9-phase + Trace Waterfall
create table if not exists minion_jobs (
  id uuid primary key,
  job_type text not null,              -- lint / backlinks / sync / synthesize / embed / orphans / purge / dream_cycle / batch_ingest / hyperedge
  status text not null default 'waiting',  -- waiting / running / completed / failed / cancelled
  payload jsonb not null default '{}',
  result jsonb,
  error text,
  priority integer not null default 0,
  worker_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  schedule text,                        -- cron 表达式（定时任务）
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists minion_jobs_status_idx on minion_jobs (status, priority, created_at);
create index if not exists minion_jobs_type_idx on minion_jobs (job_type, status);
