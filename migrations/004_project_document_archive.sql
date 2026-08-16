alter table sources
  add column if not exists archived_at timestamptz;

alter table documents
  add column if not exists archived_at timestamptz;

create index if not exists sources_tenant_archived_updated_idx
  on sources (tenant_id, archived_at, updated_at desc, id);

create index if not exists documents_source_archived_updated_idx
  on documents (source_id, archived_at, updated_at desc, id);
