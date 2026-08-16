-- 074_agent_task_feedback.sql — 借鉴 DSH feedback: Agent 任务反馈闭环
-- 👍👎 反馈 → 失败反馈转防错规则 / 好评沉淀经验

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS user_feedback integer;   -- +1 赞 / -1 踩 / 0 无
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS feedback_note text;       -- 用户反馈备注（如何改进）
