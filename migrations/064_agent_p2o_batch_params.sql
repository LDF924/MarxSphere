-- 064_agent_p2o_batch_params.sql — V395-15: 批量任务参数持久化（重启续跑需要）
ALTER TABLE agent_p2o_batch_jobs ADD COLUMN IF NOT EXISTS max_files int;
ALTER TABLE agent_p2o_batch_jobs ADD COLUMN IF NOT EXISTS retry_failed boolean NOT NULL DEFAULT false;
