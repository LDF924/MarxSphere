-- 029_knowledge_pages_effective.sql — 失效知识下线（BOOK-GAP-ROADMAP P1-8）
-- 政策更新场景: 新政策生效旧政策下线, 检索时 now() < effective_to 过滤
alter table knowledge_pages add column if not exists effective_from timestamptz;
alter table knowledge_pages add column if not exists effective_to timestamptz;
