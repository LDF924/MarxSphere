-- 015_event_directions.sql — 事件方向推断结果（subject/object 三元组）
-- 图谱关系查询的 in/out/both 方向语义支撑：LLM 从事件语义推断"谁指向谁"
create table if not exists event_directions (
  event_id uuid primary key references events(id) on delete cascade,
  subject_ids uuid[] not null default '{}',
  object_ids uuid[] not null default '{}',
  inferred_at timestamptz not null default now(),
  model text
);
create index if not exists idx_event_directions_event on event_directions(event_id);
