-- 083_edu_resource_sources.sql — 教育外部资源源（V389）
-- 教育复用资产接入外部来源：学校资源库 / 公开平台 / 任意 HTTP JSON 接口
create table if not exists edu_resource_sources (
  id text primary key,
  name text not null,
  type text not null default 'url',     -- url|api
  url text not null default '',
  kind text not null default 'courses',  -- templates|cases|courses
  auth_header text,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
