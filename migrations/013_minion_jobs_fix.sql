-- 013_minion_jobs_fix.sql — V181 验收修复
-- 补：attempts_made / error_text 列（V180 SQL 引用但 012 没建 → worker 崩溃）
-- 删：worker_id 死列（V180 用 lock_token 取代）
-- 补：parent_status / idempotency 唯一索引（GBrain 有，我们缺）
alter table minion_jobs add column if not exists error_text text;
alter table minion_jobs add column if not exists attempts_made integer not null default 0;
alter table minion_jobs drop column if exists worker_id;

create index if not exists idx_minion_jobs_parent_status on minion_jobs (parent_job_id, status) where parent_job_id is not null;
create unique index if not exists uniq_minion_jobs_idempotency on minion_jobs (idempotency_key) where idempotency_key is not null;
