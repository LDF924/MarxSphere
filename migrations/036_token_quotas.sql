-- 036_token_quotas.sql — API 令牌配额配置 + 用量流水（配额治理体系）
-- 范式同 030: 纯 create table if not exists + create index if not exists, 不手动登记 schema_migrations
-- 0/null 语义 = 不限制; 默认值宽松, 不破坏现有工作流

create table if not exists token_quotas (
  token_id uuid primary key references api_tokens(id) on delete cascade,
  daily_search_limit int not null default 1000,                -- 每日搜索次数上限 (0=不限制)
  daily_ingest_bytes_limit bigint not null default 104857600,  -- 每日入库字节上限 100MB (0=不限制)
  monthly_cost_limit_usd numeric(10,4) not null default 10.0000, -- 每月成本上限 USD (0=不限制)
  rate_limit_per_min int not null default 60,                  -- 令牌级限流 次/分钟 (0=用全局默认)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists token_usage (
  id bigint generated always as identity primary key,
  token_id uuid not null references api_tokens(id) on delete cascade,
  usage_date date not null default current_date,               -- 搜索次数/入库字节 按日
  usage_month text not null default to_char(current_date, 'YYYY-MM'), -- 成本 按月
  endpoint text not null,                                      -- search | ingest | reason | other
  status text not null default 'ok',                           -- ok | blocked (超限被拒也记账)
  tokens_input bigint not null default 0,
  tokens_output bigint not null default 0,
  tokens_cache_read bigint not null default 0,
  estimated_bytes bigint not null default 0,                   -- ingest 用 utf8 字节数
  estimated_cost_usd numeric(12,6) not null default 0,         -- in*0.3/1e6 + out*1.2/1e6
  created_at timestamptz not null default now()
);
create index if not exists idx_token_usage_token_date on token_usage (token_id, usage_date);
create index if not exists idx_token_usage_token_month on token_usage (token_id, usage_month);
create index if not exists idx_token_usage_month on token_usage (usage_month);
