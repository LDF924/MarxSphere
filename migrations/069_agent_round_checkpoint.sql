-- 069_agent_round_checkpoint.sql — 借鉴 DSH goal-round-driver: 长时任务轮次持久化
-- 每轮(loop)完成时落 checkpoint 快照(计划+轮次+失败原因), 进程重启后按快照续跑
-- 对齐 DSH: append-only 轮次日志 + durability checkpoint + 恢复 replay

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS checkpoint jsonb;
-- checkpoint 结构: {
--   loop: number,                    -- 已完成的轮次数
--   plan: [...],                     -- 该轮计划快照（replan 后新计划）
--   failures: [...],                 -- 该轮失败原因（续跑时注入）
--   checkpointedAt: timestamptz      -- 最近 checkpoint 时间
-- }
CREATE INDEX IF NOT EXISTS idx_agent_tasks_checkpoint ON agent_tasks (checkpoint) WHERE checkpoint IS NOT NULL;
