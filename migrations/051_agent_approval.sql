-- 051_agent_approval.sql — V391(P0-4): 人工审批门
-- agent_tasks 增加 approval 状态支持: awaiting_approval(任务挂起等批准)
-- approval_request: 待批准的高危步骤信息 {stepIdx, title, action, reason}
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS approval_request jsonb;
