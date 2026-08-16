-- 072_agent_message_thread.sql — 借鉴 Codex agent_communication: 消息线程语义
-- agent_messages 加 parent_message_id: 回复挂线程（主管↔工人对话线, 前端可渲染）

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS parent_message_id bigint;
CREATE INDEX IF NOT EXISTS idx_agent_msg_parent ON agent_messages (parent_message_id) WHERE parent_message_id IS NOT NULL;
