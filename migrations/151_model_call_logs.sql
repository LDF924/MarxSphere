-- 151_model_call_logs.sql — V417: 模型调用日志落库
--
-- 由来(2026-09-14 安全/稳定性审计):
--   模型调用日志原先只是进程内的 500 条环形数组(observability/model-call-log.ts):
--     · 重启即丢 —— "刚才那次为什么失败"重启后无从查证
--     · 多副本下每个实例只看得见自己那 500 条, 而读接口 /api/model-call-logs 只读本进程内存,
--       负载均衡把请求打到哪个副本, 看到的就是哪一份残缺视图
--   成本账本(llm_usage_ledger)已有 token 维度, 但没有"每次调用的成败/耗时/错误", 两者互补。
--
-- 保留策略: 只留最近 7 天(由启动时的清理钩子按天裁), 避免无限增长。
-- 幂等: IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS model_call_logs (
  id text PRIMARY KEY,
  kind text NOT NULL,                    -- llm | embedding
  operation text NOT NULL,
  status text NOT NULL,                  -- SUCCEEDED | FAILED
  duration_ms int NOT NULL DEFAULT 0,
  error text,
  request jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_call_logs_time ON model_call_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_call_logs_status ON model_call_logs (status, created_at DESC);
