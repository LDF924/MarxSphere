-- 116_research_materials.sql — SocialSci P0-2: 素材库(跨模块产物汇聚, DAG节点产出/下游写作注入)
-- 形态对齐: 素材生成/AI分配/拖入正文(闭源产品交互语义, 原创实现)
--   素材 kind: note(笔记) / citation(文献引用) / data_result(实证结果) / figure(图表) / file(附件) / theory(理论)
--   produced_by_dag_node: 来源画布节点(素材自动随节点产物生成)
--   source_ref: 来源任务/作业 id(审稿job/绘图产物/实证结果, 跨模块追溯)
create table if not exists research_materials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  kind text not null default 'note',        -- note / citation / data_result / figure / file / theory
  title text not null default '',           -- 素材标题
  content_md text not null default '',      -- 正文(markdown; 图片/表格用嵌入链接)
  tags text[] not null default '{}',
  source_ref text not null default '',      -- 来源 job id (reviewjob/viz/statjob/citation…)
  produced_by_dag_node text not null default '', -- 来源画布节点 id
  meta jsonb not null default '{}'::jsonb,  -- 附加元数据(文件路径/图表版本/统计方法…)
  created_by uuid,                          -- 创建人
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_research_materials_project on research_materials(project_id, created_at desc);
create index if not exists idx_research_materials_user on research_materials(user_id);
create index if not exists idx_research_materials_kind on research_materials(project_id, kind);
create index if not exists idx_research_materials_dag on research_materials(produced_by_dag_node);
