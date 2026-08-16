-- 062_agent_permissions.sql — V395-11: 导航功能与令牌权限/配额对齐
-- ①token_quotas 加 daily_p2o_limit（PDF2Obsidian 独立次数配额, 0=不限制）
ALTER TABLE token_quotas ADD COLUMN IF NOT EXISTS daily_p2o_limit int NOT NULL DEFAULT 20;
