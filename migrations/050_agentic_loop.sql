-- 050_agentic_loop.sql — V391(P0-1): Agentic Loop 多轮循环
-- agent_tasks 增加 loop_count（已完成循环轮次）+ reflect 评估记录
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS loop_count integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS reflect_log jsonb NOT NULL DEFAULT '[]'::jsonb;  -- [{round, verdict, issues, action}]
