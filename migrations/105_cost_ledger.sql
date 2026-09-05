-- 105_cost_ledger.sql — V405 OpenSquilla 移植 P0: 成本可审计账本
-- 目的: 每轮/每次 LLM 调用落一条真实用量明细(模型/端点/输入输出/cacheHit) + 按模型单价表
--   → 平台成本可审计(按模型/按日/按端点聚合), 与 billing(用户计费/含利售价)解耦
-- 语义:
--   llm_model_prices  = 平台成本单价表(人民币/每1M token, 分 in/out)。表空时服务层用内置默认 seed;
--                       admin 可 UPDATE 覆盖(覆盖后不被 seed 重置)
--   llm_usage_ledger   = 轮级用量明细账。cost_source 三态:
--                       provider_billed(厂商实扣, 预留) | estimate(默认估算) | byok(用户自付)
--   口径: cost_cny 为估算成本(元), 与 billing-service 的计费价(含利润/用户侧)相互独立
create table if not exists llm_model_prices (
  model text primary key,
  price_cny_per_m_in numeric(12,6) not null default 2.16,   -- 输入 元/1M token (默认 USD0.3×7.2)
  price_cny_per_m_out numeric(12,6) not null default 8.64,  -- 输出 元/1M token (默认 USD1.2×7.2)
  updated_at timestamptz not null default now()
);

create table if not exists llm_usage_ledger (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null default 'llm',                          -- llm | embedding | rerank
  endpoint text not null default 'unknown',                  -- 调用意图: reason/outline/search/agent/verify/rerank...
  model text not null default 'unknown',
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_cache_read bigint not null default 0,
  cost_cny numeric(14,6) not null default 0,                 -- 估算成本(元)
  cost_source text not null default 'estimate',              -- provider_billed | estimate | byok
  user_id uuid,                                              -- 可空: 平台全局审计; 用户级扣费仍走 user_usage_log
  task_id text,                                              -- query_tasks.id / agent_tasks.id
  context text                                               -- 自由备注(步骤名等)
);
create index if not exists idx_llm_usage_ledger_created on llm_usage_ledger (created_at);
create index if not exists idx_llm_usage_ledger_model on llm_usage_ledger (model, created_at);
create index if not exists idx_llm_usage_ledger_user on llm_usage_ledger (user_id, created_at);
create index if not exists idx_llm_usage_ledger_task on llm_usage_ledger (task_id);
