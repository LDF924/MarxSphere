-- 017_conversation_memory.sql — 短期记忆 + 长期经验（2026-08-07）
-- 短期记忆：conversation_context 按 session_id 存对话摘要，推理时注入
-- 长期经验：task_experience 每次推理沉淀(问题→策略→质量)，相似问题参考

create table if not exists conversation_context (
  session_id uuid primary key,
  project_id uuid,
  query text not null,
  answer_summary text,
  citations jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_conv_context_project on conversation_context(project_id, updated_at desc);

create table if not exists task_experience (
  id bigserial primary key,
  project_id uuid,
  query text not null,
  qtype text,
  strategy jsonb default '{}'::jsonb,
  quality_score numeric(4,3),
  duration_ms integer,
  success boolean default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_exp_project on task_experience(project_id, created_at desc);
create index if not exists idx_task_exp_query on task_experience using gin (to_tsvector('simple', query));
