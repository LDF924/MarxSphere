update ai_provider_settings
set
  embedding_base_url = 'https://api.302ai.cn/v1',
  updated_at = now()
where
  id = 'global'
  and embedding_base_url = 'https://api.302.ai/v1';

update ai_provider_settings
set
  llm_base_url = 'https://api.302ai.cn/v1',
  updated_at = now()
where
  id = 'global'
  and llm_base_url = 'https://api.302.ai/v1';
