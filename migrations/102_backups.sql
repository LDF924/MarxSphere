-- 102_backups.sql — 知识库备份元数据表(2026-09-01, Zleap 评审 P1)
-- 记录 .sagbak 备份产物(目录在 BACKUP_DIR, 本表存清单与状态)
create table if not exists backups (
  id uuid primary key,
  name text not null,
  path text not null,
  manifest jsonb not null default '{}'::jsonb,
  size bigint not null default 0,
  status text not null default 'completed',   -- completed | restoring | failed
  created_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists backups_created_idx on backups (created_at desc);
