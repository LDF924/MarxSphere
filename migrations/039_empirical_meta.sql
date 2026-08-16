-- 039_empirical_meta.sql — 实证工作台元数据（课题/问卷/数据版本）
-- 范式同 038: 纯 create table if not exists + create index if not exists
-- 变量白名单唯一真源 = empirical_data_versions.columns

-- 课题（研究项目）
create table if not exists empirical_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  topic text not null default '',
  status text not null default 'active',     -- active|archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_eproj_created on empirical_projects (created_at desc);

-- 问卷（生成器产出 / 上传识别产出）
create table if not exists empirical_questionnaires (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  title text not null,
  source text not null default 'generated',  -- generated|uploaded
  raw_text text not null default '',
  structure jsonb not null default '[]',     -- Question[]
  columns jsonb not null default '[]',       -- 变量名白名单(问卷侧)
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_eqnaire_project on empirical_questionnaires (project_id);

-- 数据版本（上传数据快照, columns 为变量白名单唯一真源）
create table if not exists empirical_data_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  name text not null,
  columns jsonb not null default '[]',       -- 数据列白名单(唯一真源)
  n_rows integer not null default 0,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_edver_project on empirical_data_versions (project_id);
