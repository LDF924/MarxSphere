-- 049_commercial_admin_ops.sql — V390: 运营管理增强（用户启禁用/调余额/重置密码）
-- users 增加 status: active(正常) | disabled(禁用, 登录被拒)
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- 计费/用量表增加 user_id 外键索引（管理端按用户查）
CREATE INDEX IF NOT EXISTS idx_billing_records_user ON billing_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_usage_user ON user_usage_log (user_id, created_at DESC);
