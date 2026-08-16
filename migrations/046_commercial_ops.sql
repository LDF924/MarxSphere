-- 046_commercial_ops.sql — 商业化阶段5: 运营（审计日志 + 限流 + 管理）
-- V389+

-- 审计日志（谁/何时/调了什么/结果）
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id uuid,
  username text,
  method text NOT NULL,
  path text NOT NULL,
  status_code int,
  duration_ms int,
  tokens_used bigint DEFAULT 0,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (created_at DESC);

-- 用量汇总（按用户按天，管理端看板）
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id uuid NOT NULL,
  day date NOT NULL,
  requests int NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
