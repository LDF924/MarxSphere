-- 030_api_tokens.sql — 对外 API 访问令牌（MarxSphere 对外接入基建）
-- 场景: 部署到服务器 + 多用户时, Claude Code / Codex / 外部客户端通过 Bearer Token 调用 SAG API
-- 安全: 库中只存 token 的 sha256 hash, 明文只在创建时返回一次（对标 Sciverse sv_xxx 模式）
create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  name text not null,                       -- 令牌名称（如 "claude-code-prod"）
  token_hash text not null unique,          -- sha256(token) 十六进制
  prefix text not null,                     -- 明文前 8 位（前端展示识别, 如 sag_xxxx1234）
  permissions text[] not null default '{}', -- 权限: reason / search / ingest 组合
  revoked boolean not null default false,   -- 撤销标记
  last_used_at timestamptz,                 -- 最近调用时间
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_api_tokens_hash on api_tokens (token_hash);
