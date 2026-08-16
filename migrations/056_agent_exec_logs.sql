-- 056_agent_exec_logs.sql — V391(P2-4): 统一 Agent 执行日志
-- 全链路记录: 工具调用/决策/成本（推理已有 retrieve_steps, 这里补 Agent 级执行日志）
CREATE TABLE IF NOT EXISTS agent_exec_logs (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id uuid,                          -- Agent 任务
  step_id text,                          -- 步骤 id
  action text NOT NULL,                  -- 动作（tool_call / decision / llm / approval / reflect）
  tool text,                             -- 工具名（reason/search/write/review/...）
  input_summary text,                    -- 输入摘要
  output_summary text,                   -- 输出摘要
  cost_cents integer NOT NULL DEFAULT 0, -- 该动作成本（分）
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ok',     -- ok / failed / skipped
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_exec_task ON agent_exec_logs (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_exec_time ON agent_exec_logs (created_at DESC);
