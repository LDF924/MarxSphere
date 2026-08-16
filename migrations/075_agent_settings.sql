-- 075_agent_settings.sql — 借鉴 DSH settings: Agent 设置持久化
-- 预设/自主级别/工具白名单 等运行时设置落库（重启保持; 优于仅环境变量）

CREATE TABLE IF NOT EXISTS agent_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
