-- 063_agent_p2o_batch_jobs.sql — V395-14: P2O 批量任务持久化
-- 批量导入 job 落库（重启不丢）: 状态/统计/参数/日志
CREATE TABLE IF NOT EXISTS agent_p2o_batch_jobs (
  id text PRIMARY KEY,                       -- 批量任务 id（8位hash）
  input_dir text NOT NULL,
  output_dir text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',    -- running / completed / failed / cancelled
  total int NOT NULL DEFAULT 0,
  done int NOT NULL DEFAULT 0,
  succeeded int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  duplicate int NOT NULL DEFAULT 0,
  current_file text,
  task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_daily_pages int NOT NULL DEFAULT 900,
  log jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_p2o_batch_created ON agent_p2o_batch_jobs (started_at desc);
