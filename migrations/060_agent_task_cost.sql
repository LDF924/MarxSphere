-- 060_agent_task_cost.sql — V395-6: 任务成本预估+实际对比
-- agent_tasks 增加: estimated_cost_cents(计划预估, 创建时写入) / actual_cost_cents(完成后回填)
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS estimated_cost_cents integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS actual_cost_cents integer NOT NULL DEFAULT 0;
