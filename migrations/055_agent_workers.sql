-- 055_agent_workers.sql — V391(P2-1/2): 主管-工人层级编排 + Agent消息协议
-- worker_tasks: 主管拆包下发的工人任务（并行执行）
CREATE TABLE IF NOT EXISTS worker_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_task_id uuid,                  -- 归属的 Agent 任务
  worker_name text NOT NULL,            -- 工人名（worker-1, worker-2 ...）
  assignee text NOT NULL DEFAULT 'general',  -- 工人角色（general/retriever/writer/reviewer）
  goal text NOT NULL,                   -- 子目标（主管拆包）
  status text NOT NULL DEFAULT 'pending',  -- pending / running / done / failed
  result text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worker_parent ON worker_tasks (parent_task_id);

-- agent_messages: 结构化消息协议（主管↔工人 任务/结果/状态）
CREATE TABLE IF NOT EXISTS agent_messages (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id uuid,                         -- 关联 Agent 任务
  from_agent text NOT NULL,             -- 发送者（orchestrator / worker-1 ...）
  to_agent text NOT NULL,               -- 接收者（worker-1 / orchestrator / user）
  msg_type text NOT NULL,               -- task / result / status / approval / note
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_msg_task ON agent_messages (task_id, created_at);
