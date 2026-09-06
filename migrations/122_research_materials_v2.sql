-- 122_research_materials_v2.sql — SocialSci 补漏组2: 素材库深层操作
-- HAR 实测: material/generate(AI素材生成) / materials/{id}/sources(来源文献) /
--           artifacts/import(跨任务工件导入, wfart+contentHash) / phase3 materialUsages(素材采纳发布)
-- 语义对齐(自研): 素材可带来源文献; 素材采纳=素材与章节的关联; 跨任务工件=来源可溯的产物引用
alter table research_materials add column if not exists source_docs jsonb not null default '[]'::jsonb;
alter table research_materials add column if not exists content_hash text not null default '';
alter table research_materials add column if not exists section_ids jsonb not null default '[]'::jsonb;
alter table research_materials add column if not exists usage_status text not null default 'candidate'; -- candidate/adopted/rejected

-- 跨任务工件(素材/产物导入另一项目时注册, 保溯源)
create table if not exists research_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_type text not null default '',   -- statistics/viz/review/material/editor
  source_id text not null default '',     -- 来源实体 id(stats_artifact/viz_artifact/mat/...)
  source_task_id text not null default '',
  content_hash text not null default '',  -- 内容去重哈希
  snapshot jsonb not null default '{}'::jsonb, -- 轻量快照(标题/摘要/路径)
  material_id uuid,                       -- 若同时入了素材库
  created_at timestamptz not null default now()
);
create index if not exists idx_research_artifacts_user on research_artifacts(user_id, created_at desc);
create index if not exists idx_research_artifacts_src on research_artifacts(source_type, source_id);
create index if not exists idx_research_artifacts_hash on research_artifacts(content_hash);
