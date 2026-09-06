-- 120_points_wechat.sql — SocialSci P0-8: 积分商业化(签到/兑换/冻结-实扣对账/邀请码) + 微信扫码登录
-- 形态对齐(闭源产品交互语义, 原创实现), 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-34~S-40
-- 与 billing(balance_cents=真钱/token额度) 解耦: 积分只计 feature 级消费, 互不折算
-- 设计差异(照搬有害替代): 负余额挂账→禁止透支; 注册带role→邀请码只挂积分归属, 提权走admin

-- ═══ 积分账户(乐观锁) ═══
create table if not exists points_accounts (
  user_id uuid primary key,
  balance bigint not null default 0,     -- 可用积分
  frozen bigint not null default 0,      -- 冻结积分(消费中)
  version bigint not null default 1,     -- 乐观锁
  updated_at timestamptz not null default now()
);

-- ═══ 积分流水(双 amount 对账: freeze_amount=冻结额 / settle_amount=实扣额) ═══
-- 消费: freeze 行(金额进 frozen) → 核销: settle 行(从 frozen 转出进消费)
-- 对账 SQL: sum(freeze_amount where type=freeze) 应 = sum(settle_amount where type=settle) + frozen余额
create table if not exists points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text not null,                    -- checkin/grant/redeem/deduct/freeze/settle/unfreeze/refund/admin_adjust/invite_bonus
  amount bigint not null,                -- 正入负出(结算口径)
  freeze_amount bigint not null default 0, -- 冻结额(该流水对应冻结)
  settle_amount bigint not null default 0, -- 实扣额(核销时)
  ref_type text not null default '',     -- 关联对象类型(research_task/viz_job/review_job/rag...)
  ref_id text not null default '',
  balance_after bigint,                  -- 流水后可用余额
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_points_ledger_user on points_ledger(user_id, created_at desc);
create index if not exists idx_points_ledger_ref on points_ledger(ref_type, ref_id);

-- ═══ 每日签到 ═══
create table if not exists daily_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  points int not null default 20,
  streak int not null default 1,         -- 连签天数
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists idx_daily_checkins_user on daily_checkins(user_id, date desc);

-- ═══ 兑换码(批次+码+兑换记录) ═══
create table if not exists redeem_batches (
  id uuid primary key default gen_random_uuid(),
  code_prefix text not null,             -- 批次前缀(生成码用)
  count int not null default 0,
  points_each int not null default 0,
  status text not null default 'active', -- active/disabled
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists redeem_codes (
  code text primary key,
  batch_id uuid not null,
  points int not null default 0,
  used_by uuid,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_redeem_codes_batch on redeem_codes(batch_id);
create table if not exists redemptions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  user_id uuid not null,
  points int not null default 0,
  created_at timestamptz not null default now()
);

-- ═══ 邀请码(只挂积分奖励与归属, 提权仍走 admin) ═══
create table if not exists invite_codes (
  code text primary key,
  owner_user_id uuid,                   -- 生成者(空=平台发放)
  bonus_points int not null default 50,  -- 邀请双方各得(邀请人/被邀人)
  claimed_by uuid,
  created_at timestamptz not null default now()
);
-- users 加列: 归属邀请 + 可邀请标志(first-user 后注册必填邀请码)
alter table users add column if not exists invited_by uuid;
alter table users add column if not exists can_invite boolean not null default false;

-- ═══ 微信扫码登录(ticket 轮询, 3min TTL) ═══
create table if not exists wx_login_tickets (
  ticket text primary key,              -- 32 hex 随机
  qr_scene text not null default '',    -- 二维码场景值
  status text not null default 'pending', -- pending/scanned/bound/expired
  openid_tmp text not null default '',  -- 扫码后临时 openid
  base_url text not null default '',    -- 公众号 base url(环境)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 minutes'
);
create index if not exists idx_wx_tickets_status on wx_login_tickets(status, expires_at);

-- ═══ 微信绑定 ═══
create table if not exists user_wechat (
  openid text primary key,
  user_id uuid not null,
  unionid text not null default '',
  nickname text not null default '',
  avatar_url text not null default '',
  bound_at timestamptz not null default now()
);
create index if not exists idx_user_wechat_user on user_wechat(user_id);

-- ═══ 每日积分用量统计(当日调用次数+消耗分布) ═══
create table if not exists points_usage_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  kind text not null default '',        -- workflow/review/viz/rag/editor...
  count int not null default 0,
  cost bigint not null default 0,
  unique (user_id, date, kind)
);
