-- 058_agent_plugins.sql — V395-4: Agent 插件体系
-- 插件 = 可插拔的工具包: 注册 entry 模块 → buildAgentTools 动态加载额外工具
CREATE TABLE IF NOT EXISTS agent_plugins (
  id text PRIMARY KEY,                     -- 插件 id（如 'classical-tools'）
  name text NOT NULL,                      -- 展示名
  description text NOT NULL DEFAULT '',    -- 说明
  entry text NOT NULL,                     -- 插件入口模块路径（相对 src/services/ 或绝对）
  enabled boolean NOT NULL DEFAULT false,  -- 是否启用（启用后才加载工具）
  tools jsonb NOT NULL DEFAULT '[]'::jsonb, -- 插件提供的工具声明 [{name, label, description, params, risk}]
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_plugins_enabled ON agent_plugins (enabled);
