-- 106_router_audit.sql — V405 OpenSquilla 移植 P1: 三档路由决策审计表
-- 用途: 每次推理入站档位决策(lite/standard/deep)落一条 → 调档率观察/评测对照/成本分析
-- 仅 ROUTER_ENABLED=1 时写入(默认关, 零开销)
create table if not exists router_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  query text not null,
  qtype text not null,                          -- concept_definition|factual_retrieval|multi_hop_reasoning|policy_evaluation
  level text not null,                          -- lite|standard|deep
  reason text not null default '',
  mode text not null default 'auto',            -- auto(路由)|template|adaptive(显式)
  task_id uuid
);
create index if not exists idx_router_audit_created on router_audit (created_at);
create index if not exists idx_router_audit_level on router_audit (level, created_at);
