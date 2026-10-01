-- 166_payment_orders.sql — 支付订单与退款(2026-10-01)
--
-- 由来: 复盘旧项目 AItoolman 时发现它有一整条订单链路
--   (`创建支付订单` `启动订单状态监控` `查询订单状态` `支付超时` `失败退款`
--    `按页退款且同一页最多退款一次`), 而本项目**收款这条路根本没通**:
--   · recharges 表只有 pending|success|failed 三态, 且代码里**直接写死 success**
--     (`billing-service.ts:151` 的 recharge 一进来就 insert ... 'success') ——
--     那笔钱到底收没收到, 库里没有任何记录能回答
--   · 没有订单号、没有过期时间、没有支付渠道流水号、没有回调去重
--   · provider 字段建了但**从没有任何代码写入**(COMMERCIAL-ARCHITECTURE.md 早就标了)
--
-- 本迁移补齐订单模型。**不动 recharges**(它已经被 billing-service 用着, 改语义会波及
--   现有读写), 新开两张表, 由 payment-order-service 维护:
--   · payment_orders     —— 一次支付意图(下单→待付→已付/关闭/退款)
--   · payment_refunds    —— 退款流水(一单一退, 幂等键 unique)
--
-- 幂等: 全部 CREATE ... IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, 重跑无副作用。

-- ════════════════════ 订单 ════════════════════
CREATE TABLE IF NOT EXISTS payment_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 商户订单号(对外唯一, 给微信/支付宝回调用)。用 string 不用 uuid:
  -- 第三方渠道对订单号有格式约束(长度/字符集), 需要一个我们自己可控的号
  out_trade_no   text NOT NULL UNIQUE,
  user_id        uuid NOT NULL,
  -- 金额一律用「分」存 bigint。**绝不用浮点** —— 0.1+0.2 那类误差在钱上是事故
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  currency       text NOT NULL DEFAULT 'CNY',
  -- 商品语义: 充余额 / 订阅某套餐 / 买积分
  subject        text NOT NULL DEFAULT '账户充值',
  kind           text NOT NULL DEFAULT 'recharge'
                 CHECK (kind IN ('recharge', 'subscription', 'points')),
  -- 目标: kind=subscription 时是 plan 名; kind=points 时是积分数; recharge 时为 NULL
  target_ref     text,

  -- 状态机: created → pending → paid → (refunding → refunded | closed | failed)
  --   created   : 已落库, 尚未拿到渠道二维码
  --   pending   : 已向渠道下单, 等用户扫码
  --   paid      : 渠道回调确认收款(**只有到这里才加钱**)
  --   closed    : 超时/用户取消
  --   failed    : 渠道明确失败
  --   refunding : 退款已发起, 等渠道确认
  --   refunded  : 退款到账
  status         text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','pending','paid','closed','failed','refunding','refunded')),

  provider       text NOT NULL DEFAULT 'wechat',
  -- 渠道侧流水号(微信 transaction_id), 对账用
  transaction_id text,
  -- 渠道预支付标识(微信 code_url 里的 prepay_id), 用于前端出二维码
  prepay_id      text,
  code_url       text,

  -- 幂等键: 同一用户带同一 idem_key 重复下单 → 返回既有订单, 不新建
  idem_key       text,

  paid_at        timestamptz,
  closed_at      timestamptz,
  -- 过期时间(默认下单后 15 分钟)。到点未付 → 由 closeExpiredOrders 关掉
  expire_at      timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),

  -- 渠道回调原文(审计与对账用; 脱敏后存)
  raw_callback   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 同一用户 + 同一幂等键只能有一单(幂等的落点)。部分唯一索引: idem_key 为空的行不参与
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_idem
  ON payment_orders (user_id, idem_key) WHERE idem_key IS NOT NULL;

-- 渠道流水号也要唯一 —— 同一笔微信支付**绝不能**被回调两次加两次钱
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_txn
  ON payment_orders (provider, transaction_id) WHERE transaction_id IS NOT NULL;

-- 过期清扫: 按 status + expire_at 扫
CREATE INDEX IF NOT EXISTS idx_payment_orders_sweep
  ON payment_orders (status, expire_at);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user
  ON payment_orders (user_id, created_at DESC);

-- ════════════════════ 退款 ════════════════════
CREATE TABLE IF NOT EXISTS payment_refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  -- 商户退款单号(渠道要求唯一)
  out_refund_no  text NOT NULL UNIQUE,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  reason         text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','success','failed')),
  channel_refund_id text,
  -- 幂等键: 同一订单的同一退款请求只生效一次
  idem_key       text,
  raw_callback   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_refunds_idem
  ON payment_refunds (order_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_refunds_order
  ON payment_refunds (order_id);
