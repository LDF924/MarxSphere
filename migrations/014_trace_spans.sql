-- 014_trace_spans.sql — Trace Waterfall 统一追踪（OTEL 风格 span）
-- Ask 步骤 + Jobs 任务流水的统一 span 存储
create table if not exists trace_spans (
  id uuid primary key,
  trace_id text not null,              -- 一次检索/任务的总 trace
  parent_id text,                      -- 父 span（Jobs 子任务）
  kind text not null,                  -- step / job / llm / sql / embed
  name text not null,                  -- span 名（如 step3MultiQuery / lint）
  status text not null default 'ok',   -- ok / error / running
  started_at timestamptz not null default now(),
  duration_ms integer,
  tokens_input integer not null default 0,
  tokens_output integer not null default 0,
  tokens_cache_read integer not null default 0,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_trace_spans_trace on trace_spans (trace_id, started_at);
create index if not exists idx_trace_spans_kind on trace_spans (kind, created_at);
