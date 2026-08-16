-- 076_agent_exec_metadata.sql — 借鉴 Codex turn_metadata: 执行日志元数据
-- exec_logs 加 model(调用的模型) / metadata(扩展元数据 JSON)

ALTER TABLE agent_exec_logs ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE agent_exec_logs ADD COLUMN IF NOT EXISTS metadata jsonb;
CREATE INDEX IF NOT EXISTS idx_agent_exec_model ON agent_exec_logs (model) WHERE model IS NOT NULL;
