-- 042_empirical_ledger.sql — 证据账本(econ-paper-studio 模式)（V380+）
-- 每个回归系数绑定: 代码片段/数据表/原始数据/文献 — 杜绝 AI 编造回归结果
-- 范式同 038: 纯 create table if not exists + create index if not exists

-- 账本条目
create table if not exists empirical_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  run_id uuid references empirical_pipeline_runs(id),
  coefficient text not null,
  coef_value text not null default '',   -- 来自真实运行结果, 禁止手填
  se_pvalue text not null default '',
  spec text not null default '',
  code_snippet text not null default '',     -- 绑定1: 代码片段(run.input_snapshot 只读来源)
  data_table text not null default '',       -- 绑定2: 数据表名(run 标题)
  raw_data_ref text not null default '',     -- 绑定3: 原始数据引用(data-versions 下拉)
  literature_ref jsonb not null default '[]',-- 绑定4: [{cite_key, title, note}]
  status text not null default 'linked',     -- linked|needs_update(重跑后)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_eledger_project on empirical_ledger_entries (project_id, created_at desc);
create index if not exists idx_eledger_run on empirical_ledger_entries (run_id);

-- 文献库
create table if not exists empirical_ledger_citations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references empirical_projects(id) on delete cascade,
  cite_key text not null,              -- 如 yang2025llm
  title text not null,
  authors text not null default '',
  source text not null default '',     -- 期刊/卷期/页/DOI
  url text not null default '',
  created_at timestamptz not null default now(),
  unique (project_id, cite_key)
);
create index if not exists idx_ecite_project on empirical_ledger_citations (project_id);
