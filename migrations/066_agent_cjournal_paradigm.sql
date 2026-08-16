-- 066_agent_cjournal_paradigm.sql — V395-25: 学者写作范式提取
-- cjournal_scholars 增加 paradigm（范式提取结果）字段
ALTER TABLE cjournal_scholars ADD COLUMN IF NOT EXISTS paradigm jsonb;
ALTER TABLE cjournal_scholars ADD COLUMN IF NOT EXISTS paradigm_source_dir text;
ALTER TABLE cjournal_scholars ADD COLUMN IF NOT EXISTS paradigm_updated_at timestamptz;
