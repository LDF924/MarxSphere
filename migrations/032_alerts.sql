-- 032_alerts.sql — 系统告警记录（任务执行中的巡检/降级/熔断/失败事件）
-- 前端告警中心 + toast 轮询的数据源
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('info','warning','error','critical')),
  category text not null,               -- 类型: degradation/timeout/circuit_breaker/failure/retry/success
  message text not null,                -- 告警内容
  task_type text,                       -- 任务类型: reason/search/ingest/eval/jobs
  task_id text,                         -- 关联任务 ID（可选）
  detail jsonb,                         -- 详情（降级层级/重试次数等）
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_alerts_created on alerts (created_at desc);
create index if not exists idx_alerts_unread on alerts (read) where read = false;

-- V379: 自愈闭环需要 metadata 列（记录 heal 状态/动作/结果）
alter table alerts add column if not exists metadata jsonb;
