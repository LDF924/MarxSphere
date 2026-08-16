-- 043_commercial_auth.sql — 商业化阶段1: 用户认证 + 租户 + 订阅 + admin
-- V388+ 商业化多租户

-- users 用户表
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,               -- bcrypt
  role text NOT NULL DEFAULT 'user',         -- user | admin
  tenant_id uuid NOT NULL,
  plan text NOT NULL DEFAULT 'free',         -- free | pro | enterprise
  balance_cents bigint NOT NULL DEFAULT 0,   -- 余额(分)
  llm_provider text NOT NULL DEFAULT 'platform',  -- platform | byok
  byok_key_encrypted text,                   -- BYOK key(AES加密)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tenants 租户表（single 单用户 | enterprise 企业）
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'single',
  name text NOT NULL,
  owner_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tenant_members 企业成员
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',       -- owner | admin | member
  PRIMARY KEY (tenant_id, user_id)
);

-- subscriptions 订阅表
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan text NOT NULL,
  status text NOT NULL DEFAULT 'active',     -- active | expired | cancelled
  quota_tokens bigint NOT NULL DEFAULT 0,    -- 月额度 token 数
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- 现有表扩展用户维度
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- 默认公共租户（共享知识库归属）
INSERT INTO tenants (id, type, name) VALUES ('00000000-0000-0000-0000-000000000001', 'single', '公共共享库')
ON CONFLICT (id) DO NOTHING;

-- 默认管理员（密码在 auth-service 初始化时设置）
INSERT INTO users (id, username, password_hash, role, tenant_id)
VALUES ('00000000-0000-0000-0000-000000000002', 'admin', 'INIT_PENDING', 'admin', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (username) DO NOTHING;
