alter table ai_provider_settings
  drop constraint if exists ai_provider_settings_embedding_dimensions_check;

alter table ai_provider_settings
  add constraint ai_provider_settings_embedding_dimensions_check
  check (embedding_dimensions = 1024);
