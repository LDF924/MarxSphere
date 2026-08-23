-- 009_external_entities_embedding.sql: Add embedding column + HNSW index for entity vector search

alter table external_entities
  add column if not exists embedding vector(1024);

create index if not exists external_entities_embedding_hnsw
  on external_entities using hnsw (embedding vector_cosine_ops);


