-- 119_documents_v2.sql — SocialSci P0-5: 学术文档(documents_v2)
-- 与既有 doc-session(锁/变更集)、document_versions(090) 配合; 面向"论文全文"形态
-- 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-12(编辑器后端原语)
create table if not exists documents_v2 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  task_id uuid,                                  -- 关联 research 任务(可选)
  title text not null default '未命名文档',
  content text not null default '',              -- markdown 全文
  word_count int not null default 0,
  status text not null default 'draft',          -- draft / locked / archived
  tags text[] not null default '{}',
  locked_by text not null default '',            -- 锁持有者(编辑器会话; doc-session 语义)
  locked_at timestamptz,
  current_version_id uuid,                       -- 关联 document_versions(id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_documents_v2_user on documents_v2(user_id, updated_at desc);
create index if not exists idx_documents_v2_task on documents_v2(task_id);
