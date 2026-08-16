-- 026_task_experience_embedding.sql — 记忆向量化（BOOK-GAP-ROADMAP P1-4）
-- task_experience 加 embedding 列(1024维对齐005), findSimilarExperiences 语义召回臂
alter table task_experience add column if not exists embedding vector(1024);
create index if not exists idx_task_experience_embedding on task_experience using hnsw (embedding vector_cosine_ops);
