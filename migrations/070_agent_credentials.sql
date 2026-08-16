-- 070_agent_credentials.sql — 借鉴 DSH credentials 包: Agent 凭证安全存储
-- 存储外部服务凭据供 Agent 工具使用（web_fetch/agent_subagent 等需认证的调用）
-- 安全: 仅服务端可读, API 返回脱敏视图; 凭证不落日志/不注入沙箱环境

CREATE TABLE IF NOT EXISTS agent_credentials (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL UNIQUE,             -- 凭证名（如 feishu_api）
  kind text NOT NULL DEFAULT 'bearer',   -- bearer(令牌) / basic(用户名密码) / key(API Key)
  value text NOT NULL,                   -- 凭证值（服务端存储）
  hint text,                             -- 用途说明
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_creds_name ON agent_credentials (name);
