-- 037_upload_jobs.sql — 上传任务持久化（job 重启不丢）
-- 范式同 036: create table if not exists, 不手动登记 schema_migrations
-- 服务端内存 Map 的落盘副本：WebuiService 启动时恢复活跃 job，
-- 重启前 RUNNING/QUEUED 的 job 在恢复时标记 FAILED（原任务已随进程丢失）

create table if not exists upload_jobs (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  file_name text not null,
  title text not null,
  status text not null check (status in ('QUEUED','RUNNING','COMPLETED','FAILED')),
  stage text not null default 'QUEUED',
  message text not null default '',
  progress int not null default 0,
  chunk_count int,
  event_count int,
  current_chunk int,
  total_chunks int,
  document_id uuid,
  trace_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_upload_jobs_status on upload_jobs (status);
create index if not exists idx_upload_jobs_created on upload_jobs (created_at desc);
