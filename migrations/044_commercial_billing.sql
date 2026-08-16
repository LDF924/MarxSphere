-- 044_commercial_billing.sql — 商业化阶段2: 计费系统（订阅 + 按量）
-- V389+ 混合计费: 订阅含额度 + 超额按量扣余额

-- 账单记录（订阅扣费 / 用量扣费 / 充值入账）
CREATE TABLE IF NOT EXISTS billing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,                    -- subscription | usage | recharge | refund
  amount_cents bigint NOT NULL,          -- 正=收费(支出) 负=入账(余额增加); 约定: 支出为正, 充值入账为负
  tokens_used bigint,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_records (user_id, created_at DESC);

-- 充值订单
CREATE TABLE IF NOT EXISTS recharges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | success | failed
  provider text DEFAULT 'manual',          -- manual | alipay | wechat ...
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 用量记账（按用户聚合; token_usage 已有细粒度记录, 此表为按次计费汇总）
CREATE TABLE IF NOT EXISTS user_usage_log (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  tokens_input bigint NOT NULL DEFAULT 0,
  tokens_output bigint NOT NULL DEFAULT 0,
  tokens_cache_read bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_usage_log ON user_usage_log (user_id, created_at DESC);
