-- 077_agent_oauth.sql — 架构B: OAuth2 授权流 token 存储
-- token 加密存储（服务端 AES; 不注入沙箱环境）

CREATE TABLE IF NOT EXISTS agent_oauth_tokens (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  provider text NOT NULL,                 -- github / feishu / ...
  account text NOT NULL,                  -- 账号标识（用户名/邮箱）
  access_token text NOT NULL,             -- 加密后的 access token
  refresh_token text,                     -- 加密后的 refresh token
  expires_at timestamptz,                 -- 过期时间
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account)
);
