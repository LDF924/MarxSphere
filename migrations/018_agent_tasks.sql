-- 018_agent_tasks.sql — 自主任务规划器（2026-08-07 P2）
-- agent_tasks: 用户给目标 → 拆解子任务 → 逐项执行 → 进度回报 → 中途干预

create table if not exists agent_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  goal text not null,
  status text not null default 'planning',  -- planning / running / paused / completed / failed / cancelled
  plan jsonb default '[]'::jsonb,           -- [{id, title, type, status}]
  current_step integer default 0,
  progress text,
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_tasks_project on agent_tasks(project_id, created_at desc);
