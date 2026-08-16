-- 025_skill_embeddings.sql — 技能语义索引（BOOK-GAP-ROADMAP P1-3 主动工具发现）
-- 187 技能的 description+正文 → embedding 存表, 语义路由找技能
create table if not exists skill_embeddings (
  skill_name text primary key,
  embedding vector(1024),            -- 对齐 005 的 embedding 维度（MAAS text-embedding-v4）
  source text not null default 'description',  -- description|description+body
  updated_at timestamptz default now()
);
