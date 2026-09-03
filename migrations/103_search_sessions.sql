-- 103_search_sessions.sql — 检索会话快照表(G10, 对齐 Zleap sag_search_session)
-- 服务端快照 + 游标翻页: 首次检索存结果, cursor 恢复切片
create table if not exists search_sessions (
  id uuid primary key,
  request_digest text not null,          -- 请求指纹(防 cursor 错用)
  cursor_key text not null,              -- hmac 签名密钥
  result_payload jsonb not null,         -- 检索结果快照(最多 8MB)
  total integer not null default 0,      -- 总条数
  page_size integer not null default 20,
  expires_at timestamptz not null,       -- TTL 过期
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists search_sessions_expiry_idx on search_sessions (expires_at);
