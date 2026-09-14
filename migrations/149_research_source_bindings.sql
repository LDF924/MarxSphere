-- 149_research_source_bindings.sql
-- V417: 科研项目 → 检索源绑定 —— 让写作舱的文献检索知道该从哪个库检索。
--
-- 由来（2026-09-14 实测"研途写作舱"）：
--   runLiteratureSearch 只让 LLM 编检索词，正文里留了 25 处 `[N]（待补引文）`，
--   而 buildCitationPool / buildMergedReferences 又要求素材里是 `[N] 条目` 格式 ——
--   两处互相不认识，参考文献永远是空串。
--
--   真接检索需要知道"检索哪些 source"。PG 侧 (source_chunks/documents) 是按 source_id
--   划分的（本机实测: 单个 source "资本下乡" 下有 504 篇文档）。
--   用户选题可能是别的领域 → 必须让项目自己声明检索源，而不是硬编码默认库。
--
--   sourceIds 空数组 = 未绑定 → 检索器回退到默认公共库（行为与现有 Ask/推理一致）。
--
-- 幂等: 可重复执行。

alter table research_projects
  add column if not exists source_ids uuid[] not null default '{}';

comment on column research_projects.source_ids is
  'V417: 文献检索数据源 (sources.id)；空数组=用默认公共库。写作舱 phase3 文献检索消费。';

-- 检索来源标记（哪些素材是真从库里搜出来的，哪些仍需人工补录）
alter table research_materials
  add column if not exists retrieval_sources text[] not null default '{}';

comment on column research_materials.retrieval_sources is
  'V417: 本素材的条目实际来自哪些检索源 (pg/graphiti/cognee/mdlibrary)；空=无真实命中，著录需人工补录。';
