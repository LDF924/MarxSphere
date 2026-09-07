-- 129_editor_doc_versions_content.sql — SocialSci R8c 续: doc2_versions 补 content 快照列(回档用)
-- 128 只存 hash/len(时间线用); 本迁移补 content 使"版本回档"可行
-- 服务端保存时若列不存在会导致 SQL 报错, 故独立迁移幂等补列
alter table doc2_versions add column if not exists content text not null default '';
alter table doc2_versions add column if not exists by_editor text not null default '';
