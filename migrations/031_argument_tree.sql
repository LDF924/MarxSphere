-- 031_argument_tree.sql — 论证树（经典文本研究专属能力）
-- 论证结构拆解的可视化数据层: 节点(前提/结论/环节) + 边(前提→结论)
create table if not exists argument_nodes (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  tree_id text not null,               -- 同一文档的多次拆解用 tree_id 区分
  node_type text not null check (node_type in ('premise','conclusion','step','module')),
  label text not null,                 -- 节点文本
  source text,                         -- 原文出处（章节/段落）
  raw_quote text,                      -- 原文引用
  created_at timestamptz not null default now()
);

create table if not exists argument_edges (
  id uuid primary key default gen_random_uuid(),
  tree_id text not null,
  from_node uuid not null references argument_nodes(id) on delete cascade,
  to_node uuid not null references argument_nodes(id) on delete cascade,
  edge_type text not null default 'supports',  -- supports / derives / contradicts
  created_at timestamptz not null default now()
);

create index if not exists idx_argument_nodes_doc on argument_nodes (document_id, tree_id);
