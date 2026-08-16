create table if not exists ai_provider_settings (
  id text primary key default 'global',
  embedding_base_url text not null,
  embedding_model text not null,
  embedding_dimensions integer not null check (embedding_dimensions > 0),
  embedding_api_key text,
  llm_base_url text not null,
  llm_model text not null,
  llm_api_key text,
  llm_timeout_ms integer not null check (llm_timeout_ms > 0),
  llm_max_retries integer not null check (llm_max_retries >= 0),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_provider_settings_singleton check (id = 'global')
);

insert into ai_provider_settings (
  id,
  embedding_base_url,
  embedding_model,
  embedding_dimensions,
  embedding_api_key,
  llm_base_url,
  llm_model,
  llm_api_key,
  llm_timeout_ms,
  llm_max_retries
)
values (
  'global',
  'https://api.302ai.cn/v1',
  'text-embedding-3-large',
  1024,
  null,
  'https://api.302ai.cn/v1',
  'qwen3.6-flash',
  null,
  60000,
  2
)
on conflict (id) do nothing;
