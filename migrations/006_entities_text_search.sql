alter table entities
  add column if not exists search_text tsvector generated always as (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(normalized_name, '') || ' ' || coalesce(description, ''))
  ) stored;

create index if not exists entities_search_text_idx on entities using gin (search_text);
create index if not exists entities_normalized_name_trgm_idx on entities using gin (normalized_name gin_trgm_ops);
