-- 087_documents_content_hash.sql
-- 文献正文哈希：内容级幂等 + 变化感知（2026-08-25，见 docs/DATA-HASH-VERSIONING-DESIGN.md）
-- 幂等写法，可重复执行（与 086/085 同风格）

alter table documents add column if not exists content_hash text;
alter table documents add column if not exists content_version integer not null default 1;

-- 按哈希查重索引（部分索引仅覆盖有哈希的行，兼容存量旧数据）
create index if not exists documents_content_hash_idx
  on documents(content_hash);

-- 不建唯一约束：同一论文多来源（期刊版+预印本）内容相同应允许双记录，判重走应用层
