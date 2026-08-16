-- 045_commercial_tenant.sql — 商业化阶段4: 多租户数据隔离（MVP）
-- V389+ 方案: sources 表加 tenant_id(数据源归属租户) + 检索按租户过滤
-- 已有数据归公共共享租户(00000000-0000-0000-0000-000000000001)

ALTER TABLE sources ADD COLUMN IF NOT EXISTS tenant_id uuid;
-- 存量数据归公共共享租户
UPDATE sources SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- 检索历史按用户记录（用量/审计用）
ALTER TABLE query_tasks ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE retrieve_steps ADD COLUMN IF NOT EXISTS user_id uuid;
