-- 093_notes_wikilinks.sql — 双链笔记 + 知识图谱（2026-08-27, Agentero 对照）
-- Obsidian 风格 [[wikilinks]] 笔记: 笔记互链 → 浏览本地知识图谱
-- 幂等写法

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  source_id uuid references sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (title)
);

create table if not exists note_links (
  id bigserial primary key,
  from_note_id uuid not null references notes(id) on delete cascade,
  to_note_id uuid references notes(id) on delete cascade,
  to_title text not null,          -- 未解析的目标标题（[[...]] 内容）
  created_at timestamptz not null default now(),
  unique (from_note_id, to_title)
);
