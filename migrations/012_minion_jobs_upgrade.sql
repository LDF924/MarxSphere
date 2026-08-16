-- 012_minion_jobs_upgrade.sql — minion_jobs 升级对齐 GBrain（v0.43）
-- 新增：queue/backoff/stalled/lock/delay/parent/tokens/progress/timeout/idempotency/remove_on/depth/stacktrace
alter table minion_jobs add column if not exists queue text not null default 'default';
alter table minion_jobs add column if not exists backoff_type text not null default 'exponential';
alter table minion_jobs add column if not exists backoff_delay integer not null default 1000;
alter table minion_jobs add column if not exists backoff_jitter real not null default 0.2;
alter table minion_jobs add column if not exists stalled_counter integer not null default 0;
alter table minion_jobs add column if not exists max_stalled integer not null default 5;
alter table minion_jobs add column if not exists lock_token text;
alter table minion_jobs add column if not exists lock_until timestamptz;
alter table minion_jobs add column if not exists delay_until timestamptz;
alter table minion_jobs add column if not exists parent_job_id uuid references minion_jobs(id) on delete set null;
alter table minion_jobs add column if not exists on_child_fail text not null default 'fail_parent';
alter table minion_jobs add column if not exists tokens_input integer not null default 0;
alter table minion_jobs add column if not exists tokens_output integer not null default 0;
alter table minion_jobs add column if not exists tokens_cache_read integer not null default 0;
alter table minion_jobs add column if not exists progress jsonb;
alter table minion_jobs add column if not exists timeout_ms integer;
alter table minion_jobs add column if not exists timeout_at timestamptz;
alter table minion_jobs add column if not exists idempotency_key text;
alter table minion_jobs add column if not exists remove_on_complete boolean not null default false;
alter table minion_jobs add column if not exists remove_on_fail boolean not null default false;
alter table minion_jobs add column if not exists stacktrace jsonb default '[]';
alter table minion_jobs add column if not exists depth integer not null default 0;
alter table minion_jobs add column if not exists max_children integer;
alter table minion_jobs add column if not exists attempts_started integer not null default 0;

-- 状态约束升级（8 种状态对齐 GBrain）
alter table minion_jobs drop constraint if exists minion_jobs_status_check;
alter table minion_jobs add constraint minion_jobs_status_check check (
  status in ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused')
);

-- 索引对齐
create index if not exists idx_minion_jobs_claim on minion_jobs (queue, priority asc, created_at asc) where status = 'waiting';
create index if not exists idx_minion_jobs_stalled on minion_jobs (lock_until) where status = 'active';
create index if not exists idx_minion_jobs_delayed on minion_jobs (delay_until) where status = 'delayed';
create index if not exists idx_minion_jobs_parent on minion_jobs (parent_job_id);
create index if not exists idx_minion_jobs_timeout on minion_jobs (timeout_at) where status = 'active' and timeout_at is not null;
