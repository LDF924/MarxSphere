-- 084_edu_assets.sql — 教育复用资产条目表（V389：个人/公共隔离）
-- 学生端个人资产（scope=personal, owner_id=student_id）与教师端公共资产（scope=public）分离
create table if not exists edu_assets (
  id serial primary key,
  scope text not null default 'public',      -- public=教师发布(公共) | personal=个人
  owner_id text not null default '',          -- 个人资产所属 student_id；公共资产为空
  kind text not null,                          -- templates|cases|courses
  name text not null,                          -- 资产名/标题
  data jsonb not null default '{}',            -- 资产内容
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_edu_assets_scope on edu_assets(scope, owner_id, kind);
