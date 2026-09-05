-- 103_runtime_guard_events.sql — V404-30: 运行时防护事件持久化(跨重启审计)
-- 防护拦截/告警/摘要事件落库; 保留 30 天(周期清理)
CREATE TABLE IF NOT EXISTS runtime_guard_events (
  id bigserial PRIMARY KEY,
  guard text NOT NULL,             -- h1_progress/h2_repetition/h7_injection/m2_summary/h3_killtree/h4_decode
  action text NOT NULL,            -- warn/block/summary/kill
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guard_events_time ON runtime_guard_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guard_events_guard ON runtime_guard_events (guard, created_at DESC);
