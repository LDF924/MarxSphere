-- 124_workbench_snapshot.sql — SocialSci 补漏R2: 任务级整包快照 + aiSkill 结构化写作卡
-- HAR 二次审计发现(高频非噪音): PUT task 携带 23键整包快照(phase/projectId/input/sections/materials/
--   merged*/_englishAbstract/variables/skillStepDone/...); 每章含 aiSkill 9字段结构化写作卡
-- 语义: workbench_snapshot = 前端工作台全状态整包持久化(与 research_nodes 分离式并存, 提供"项目管理+整包恢复")
alter table research_projects add column if not exists workbench_snapshot jsonb not null default '{}'::jsonb;
alter table research_projects add column if not exists english_abstract text not null default '';

-- aiSkill 结构化写作卡(按章; 前端原存 sections[].aiSkill, 此处规范化存表便于查询/统计)
create table if not exists chapter_skill_cards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  section_id text not null default '',      -- 章节 id(sections[].id)
  section_title text not null default '',
  skill_type text not null default '',      -- intro/lit_review/theory/analysis/...
  word_count int not null default 0,
  writing_goal text not null default '',
  key_points jsonb not null default '[]'::jsonb,
  notes text not null default '',
  connection text not null default '',      -- 与上下章的衔接逻辑
  framework_source text not null default '',
  chapter_draft text not null default '',   -- AI 草稿正文
  child_sections jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, section_id)
);
create index if not exists idx_skill_cards_project on chapter_skill_cards(project_id);
