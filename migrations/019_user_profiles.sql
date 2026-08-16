-- 019_user_profiles.sql — 用户画像（2026-08-07）
-- 记录研究领域/偏好检索源/常用场景 → 推理个性化路由

create table if not exists user_profiles (
  id text primary key default 'default',
  research_domains text[] default '{}',
  preferred_sources text[] default '{}',
  common_scenarios text[] default '{}',
  query_topics jsonb default '{}'::jsonb,  -- 主题词频 {topic: count}
  total_queries integer default 0,
  updated_at timestamptz not null default now()
);
