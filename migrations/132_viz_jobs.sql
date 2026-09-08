-- 132_viz_jobs.sql — D4(闭源 VizView job 体系对齐): 中长绘图任务持久化
-- 形态: 一轮绘图 = 一个 job(plan→analyze→code→critique→fix→落盘 全服务端后台执行,
--   不依赖 SSE 连接存活); 事件流落 viz_job_events(断线重连按 seq 重放/增量)
--   cancel: 置 cancelled, RecordingSse 在发送时感知并中断本轮
create table if not exists viz_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null,
  prompt text not null,
  csv text,                          -- 数据快照(会话 CSV)
  column_order text[] not null default '{}',
  spec jsonb not null default '{}',  -- 期刊规范(尺寸/DPI/字号)
  status text not null default 'queued',  -- queued/running/done/failed/cancelled
  current_step text not null default '',
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_viz_jobs_session on viz_jobs(session_id, created_at desc);
create index if not exists idx_viz_jobs_active on viz_jobs(user_id, status) where status in ('queued','running');

-- 事件流(SSE 重放源; seq 全局递增供 after=N 增量)
create table if not exists viz_job_events (
  id bigserial primary key,
  job_id uuid not null references viz_jobs(id) on delete cascade,
  seq bigint not null,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);
create index if not exists idx_viz_job_events_job on viz_job_events(job_id, seq);
