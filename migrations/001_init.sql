create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists "uuid-ossp";

create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists sources (
  id uuid primary key,
  tenant_id text not null default 'default',
  name text not null,
  description text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sources_tenant_id_id_idx on sources (tenant_id, id);
create index if not exists sources_tenant_id_name_idx on sources (tenant_id, name);

create table if not exists documents (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  external_id text,
  title text not null,
  content text,
  status text not null default 'PENDING',
  parse_status text not null default 'PENDING',
  error text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_source_id_idx on documents (source_id);
create index if not exists documents_external_id_idx on documents (external_id);

create table if not exists document_sections (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete cascade,
  order_index integer not null,
  render_group_index integer not null default 0,
  type text,
  heading text not null default '',
  content text not null,
  raw_content text,
  image_url text,
  metadata jsonb not null default '{}',
  token_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists document_sections_document_order_idx on document_sections (document_id, order_index);

create table if not exists source_chunks (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  source_type text not null,
  external_source_id text,
  heading text,
  content text not null,
  raw_content text,
  rank integer not null,
  "references" uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  embedding vector(1024),
  search_text tsvector generated always as (
    to_tsvector('simple', coalesce(heading, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists source_chunks_source_document_rank_idx on source_chunks (source_id, document_id, rank);
create index if not exists source_chunks_search_text_idx on source_chunks using gin (search_text);
create index if not exists source_chunks_embedding_hnsw on source_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists entity_types (
  id uuid primary key,
  source_id uuid references sources(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  scope text not null default 'global',
  type text not null,
  name text not null,
  description text,
  weight numeric(4,2) not null default 1.0,
  similarity_threshold numeric(5,4) not null default 0.8,
  value_constraints jsonb not null default '{}',
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists entity_types_scope_unique_idx
  on entity_types (scope, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(document_id, '00000000-0000-0000-0000-000000000000'::uuid), type);
create index if not exists entity_types_default_active_idx on entity_types (is_default, is_active);

create table if not exists entities (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  entity_type_id uuid not null references entity_types(id),
  type text not null,
  name text not null,
  normalized_name text not null,
  description text,
  value_type text,
  value_raw text,
  int_value bigint,
  numeric_value numeric(24,6),
  datetime_value timestamptz,
  bool_value boolean,
  enum_value text,
  value_unit text,
  value_confidence numeric(5,4),
  embedding vector(1024),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists entities_source_type_name_unique_idx on entities (source_id, type, normalized_name);
create index if not exists entities_source_type_idx on entities (source_id, type);
create index if not exists entities_embedding_hnsw on entities using hnsw (embedding vector_cosine_ops);

create table if not exists events (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  chunk_id uuid references source_chunks(id) on delete set null,
  source_type text not null,
  external_source_id text,
  parent_id uuid references events(id) on delete cascade,
  level integer not null default 0,
  rank integer not null default 0,
  title text not null,
  summary text not null default '',
  content text not null,
  category text,
  keywords text[] not null default '{}',
  priority text,
  status text,
  start_time timestamptz,
  end_time timestamptz,
  "references" uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  title_embedding vector(1024),
  content_embedding vector(1024),
  search_text tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, ''))
  ) stored,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_source_deleted_idx on events (source_id, deleted_at);
create index if not exists events_source_chunk_idx on events (source_id, chunk_id);
create index if not exists events_document_rank_idx on events (document_id, rank);
create index if not exists events_search_text_idx on events using gin (search_text);
create index if not exists events_title_embedding_hnsw on events using hnsw (title_embedding vector_cosine_ops);
create index if not exists events_content_embedding_hnsw on events using hnsw (content_embedding vector_cosine_ops);

create table if not exists event_entities (
  id uuid primary key,
  event_id uuid not null references events(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  weight numeric(4,2) not null default 1.0,
  description text,
  embedding vector(1024),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists event_entities_event_entity_unique_idx on event_entities (event_id, entity_id);
create index if not exists event_entities_entity_event_idx on event_entities (entity_id, event_id);
create index if not exists event_entities_event_entity_idx on event_entities (event_id, entity_id);
create index if not exists event_entities_embedding_hnsw on event_entities using hnsw (embedding vector_cosine_ops);

