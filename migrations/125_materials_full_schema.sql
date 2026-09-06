-- 125_materials_full_schema.sql — SocialSci 补漏R3: 素材完整 schema + 引用池 + finalize 扩展
-- HAR 三审发现: materials 实体 25 键(含 references 引用池/source/caption/tableData/imageDataUrl/analysisMethod);
--   正文 [N] 内联引用编号 ↔ 引用池; finalize 节点含 mergeGenerated/mergeRawOutput/reviewResult
alter table research_materials add column if not exists summary text not null default '';
alter table research_materials add column if not exists caption text not null default '';
alter table research_materials add column if not exists source_type text not null default '';  -- literature/data/ai/image/table...
alter table research_materials add column if not exists source_url text not null default '';
alter table research_materials add column if not exists image_path text not null default '';
alter table research_materials add column if not exists table_data jsonb not null default '{}'::jsonb;
alter table research_materials add column if not exists analysis_method text not null default '';
alter table research_materials add column if not exists section_id text not null default '';
alter table research_materials add column if not exists references_json jsonb not null default '[]'::jsonb; -- 引用池
alter table research_materials add column if not exists notes text not null default '';
alter table research_materials add column if not exists sort_order int not null default 0;

-- finalize 扩展(合稿状态字段)
alter table research_projects add column if not exists merged_title text not null default '';
alter table research_projects add column if not exists merged_abstract text not null default '';
alter table research_projects add column if not exists merged_keywords text not null default '';
alter table research_projects add column if not exists merged_fulltext text not null default '';
alter table research_projects add column if not exists merged_references text not null default '';
alter table research_projects add column if not exists merge_generated boolean not null default false;
alter table research_projects add column if not exists merge_raw_output text not null default '';
alter table research_projects add column if not exists review_result jsonb;
