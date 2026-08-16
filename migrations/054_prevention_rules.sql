-- 054_prevention_rules.sql — V391(P1-6): 错误模式→预防规则
-- 用户踩反馈/评测失败 → 自动归因 → 生成预防规则（Agent 下次执行时注入）
CREATE TABLE IF NOT EXISTS prevention_rules (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  category text NOT NULL,               -- relevance / accuracy / completeness / citation / format / unknown
  pattern text NOT NULL,                -- 错误模式（问题关键词/类型）
  rule text NOT NULL,                   -- 预防规则（可执行提示）
  source text NOT NULL,                 -- user_down(踩反馈) | eval_failure(评测失败) | manual
  hit_count integer NOT NULL DEFAULT 0, -- 命中次数
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prevention_pattern ON prevention_rules (category, enabled);
