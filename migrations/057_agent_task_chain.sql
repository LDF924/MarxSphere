-- 057_agent_task_chain.sql — V394-5: Agent 会话连续性（任务链）
-- agent_tasks 增加 parent_task_id: 同一目标/会话的多次任务互相关联（续作概念）
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS parent_task_id uuid;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks (parent_task_id);
