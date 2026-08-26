-- 090_document_versions.sql — 文档版本历史表（2026-08-26，见 docs/DATA-HASH-VERSIONING-DESIGN.md 3.4）
-- 每次内容变化(upsert 冲突, content_version+1)写一行历史: 记录"哪次重灌变了什么"
-- 最小版只留当前 content_hash + content_version; 本表补全版本链, 支持"回到某历史版本"与变更审计
-- 幂等写法，可重复执行（与 089/088 同风格）

create table if not exists document_versions (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  changed_at timestamptz not null default now(),
  unique (document_id, version)
);
