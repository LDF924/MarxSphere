-- 131_search_query_history.sql — SocialSci 历史中心对照: knowledge(知识库查询)分区真源
-- 闭源 HistoryView 六分区含 knowledge: 我方 AskPanel 检索无历史记录 → 补轻量查询历史表:
--   每次 Ask 检索完成由前端静默记一条(query+检索范围), 历史中心 knowledge 分区展示 + 点击重放该查询
-- 清除全部历史时一并清理(与 research_tasks/review_jobs/viz_sessions/documents_v2/empirical_results 同批)
create table if not exists search_query_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  query text not null,
  source_id text not null default '',       -- 检索范围(项目 id / 空=全库)
  created_at timestamptz not null default now()
);
create index if not exists idx_search_query_history_user on search_query_history(user_id, created_at desc);
