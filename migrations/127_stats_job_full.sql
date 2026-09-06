-- 127_stats_job_full.sql — SocialSci 补漏R6: 统计job 完整 schema(HAR 逐条审计)
-- 实测 statsjob: {user_id, source_task_id, workflow_task_id, method, file_id, status, progress_message,
--   input_json{fileId,testType,variables,method,sourceTaskId}, result_json, error_json, cancel_requested,
--   retry_of, result_version_id, charge_points, billing_status, billing_policy, started_at/completed_at,
--   result:{tables, charts, warnings, metadata, artifactIds}}
alter table empirical_results add column if not exists user_id uuid;
alter table empirical_results add column if not exists source_task_id text not null default '';
alter table empirical_results add column if not exists workflow_task_id text;
alter table empirical_results add column if not exists file_id text not null default '';
alter table empirical_results add column if not exists progress_message text not null default '';
alter table empirical_results add column if not exists cancel_requested boolean not null default false;
alter table empirical_results add column if not exists retry_of uuid;
alter table empirical_results add column if not exists result_version_id text not null default '';
alter table empirical_results add column if not exists charge_points bigint not null default 0;
alter table empirical_results add column if not exists billing_status text not null default 'unbilled'; -- unbilled/frozen/settled/refunded
alter table empirical_results add column if not exists billing_policy text not null default 'per_run';
alter table empirical_results add column if not exists error_json jsonb;
alter table empirical_results add column if not exists started_at timestamptz;
alter table empirical_results add column if not exists completed_at timestamptz;
alter table empirical_results add column if not exists artifact_ids jsonb not null default '[]'::jsonb;
create index if not exists idx_empirical_results_user on empirical_results(user_id, created_at desc);
