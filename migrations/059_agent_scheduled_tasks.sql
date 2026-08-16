-- 059_agent_scheduled_tasks.sql — V395-9: Agent 定时任务
-- 到期(按 cron 分钟级近似)自动创建 agent 任务执行
CREATE TABLE IF NOT EXISTS agent_scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal text NOT NULL,                      -- 研究目标（触发时创建 agent 任务）
  cron text NOT NULL DEFAULT '0 9 * * *',  -- cron 表达式（分钟 时 日 月 周, 本地时区）
  next_run timestamptz,                    -- 下次执行时间（调度器每次计算）
  last_run_at timestamptz,                 -- 上次执行时间
  last_task_id uuid,                       -- 上次触发的 agent 任务 id
  enabled boolean NOT NULL DEFAULT true,   -- 启用状态
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_sched_enabled ON agent_scheduled_tasks (enabled, next_run);
