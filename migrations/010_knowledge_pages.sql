-- 010_knowledge_pages.sql: GBrain Compiled Truth + Timeline 机制
-- knowledge_pages: 知识页面（Compiled Truth 区：当前最佳理解，可改写）
-- page_entries:    证据时间线（Timeline 区：只追加，记录"何时从何得到"）

create table if not exists knowledge_pages (
  id uuid primary key,
  title text not null,                     -- 页面标题（主题/实体名）
  compiled_truth text not null default '',  -- Compiled Truth 区：当前最佳理解
  source_hint text,                         -- 来源提示（如 paper_id / sciverse doc_id）
  tags text[] not null default '{}',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint knowledge_pages_title_unique unique (title)
);

create table if not exists page_entries (
  id uuid primary key,
  page_id uuid not null references knowledge_pages(id) on delete cascade,
  content text not null,                   -- 时间线条目内容
  entry_type text not null default 'note', -- note | evidence | contradiction | synthesis
  source text,                             -- 证据来源（论文标题 / doc_id / 网页）
  confidence real not null default 0.5,    -- 置信度 0-1
  created_at timestamptz not null default now()
);

create index if not exists page_entries_page_id_idx on page_entries (page_id, created_at);
create index if not exists page_entries_page_id_time_idx on page_entries (page_id, created_at desc);


