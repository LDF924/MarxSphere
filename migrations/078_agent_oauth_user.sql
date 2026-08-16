-- 078_agent_oauth_user.sql — 架构#9: OAuth token 按用户隔离
-- agent_oauth_tokens 加 user_id: 多租户场景 token 归属用户（当前无 JWT 时用 null=全局）

ALTER TABLE agent_oauth_tokens ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS idx_agent_oauth_user ON agent_oauth_tokens (user_id, provider);
