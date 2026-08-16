-- 023_context_compressions.sql — 上下文压缩记录表（BOOK-GAP-ROADMAP P0-6）
-- 每次压缩的触发/结果/模型/失败状态; 连续失败≥3 → 熔断放弃压缩
create table if not exists context_compressions (
  id serial primary key,
  session_id text not null,
  trigger_reason text not null,       -- threshold80|manual
  input_chars int, output_chars int,
  model text,
  failed boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_context_compressions_session on context_compressions(session_id, created_at);
