-- 009_external_entities_embedding.sql: Add embedding column + HNSW index for entity vector search

-- 确保表存在（老迁移未建表，仅 alter 依赖它）
create table if not exists external_entities (
  id uuid primary key default gen_random_uuid(),
  source_id uuid,
  name text not null,
  entity_type text default 'external',
  description text,
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

alter table external_entities
  add column if not exists embedding vector(1024);

create index if not exists external_entities_embedding_hnsw
  on external_entities using hnsw (embedding vector_cosine_ops);


