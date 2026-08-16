-- 071_agent_session_prefix.sql — 借鉴 Codex session_prefix: 会话前缀（目标摘要）
-- 会话级研究目标摘要, 供续作/规划注入（比单轮 query 更稳定的上下文锚点）

ALTER TABLE conversation_context ADD COLUMN IF NOT EXISTS session_prefix text;
CREATE INDEX IF NOT EXISTS idx_conv_context_prefix ON conversation_context (session_prefix) WHERE session_prefix IS NOT NULL;
