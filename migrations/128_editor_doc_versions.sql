-- 128_editor_doc_versions.sql — SocialSci HAR R8c: documents_v2 保存自动版本化
-- 闭源行为: 每次保存 current_version_id 递增(8→9→10, 指针到独立版本行)
-- 我方: documents_v2.current_version_id 列存在但从未写; 补 doc2_versions 表(与 090 document_versions
--   挂旧 documents 表隔离) + 服务在 saveDoc/createDoc 写版本行并回填指针
create table if not exists doc2_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents_v2(id) on delete cascade,
  version int not null,
  content_hash text not null default '',
  title text not null default '',
  content_len int not null default 0,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);
create index if not exists idx_doc2_versions_doc on doc2_versions(document_id, version desc);
