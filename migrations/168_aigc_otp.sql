-- 168_aigc_otp.sql — 邮箱验证码(OTP)真源表
--
-- 由来(2026-10-01, 从旧项目移植「发送验证码」/「处理发送验证码成功的回调」):
--   本仓此前只有**重置链接**(迁移 048 password_reset_tokens), 没有验证码。
--   注册流程因此**根本不验证邮箱真实性** —— 邮箱只是个可选字段, 于是"找回密码"
--   对没填真实邮箱的账号形同虚设。而验证码与链接不是同一个东西:
--     · 链接适合"在电脑上打开邮箱点一下";
--     · 验证码适合"在另一个设备上完成注册/改绑"(用户可能在手机上看邮件,
--       而操作发生在这台电脑上, 跨设备粘贴链接很别扭)。
--
-- 为什么**不复用** password_reset_tokens:
--   那张表连着 user_id(只能给已存在的用户发), 而注册场景恰恰**还没有用户**;
--   而且它一层就够用(token 本身 32 字节随机, 不可爆破), 验证码只有 10^6 种可能,
--   要额外的失败计数、用途隔离与发送限流 —— 生命周期完全不同, 混在一张表里
--   会让"重置链接"那条链也背上验证码的约束。
--
-- 安全字段的取值理由(每一条都对应一个真实攻击面):
--   · code_hash: 存 scrypt(盐+码) 的**自描述**格式 "scrypt$<salt_b64>$<hash_b64>",
--     **绝不存明文码**。6 位数字只有 10^6 种, 单轮 SHA-256 拖库后可秒级穷举;
--     scrypt 的计算代价让离线爆破不划算。自描述格式是为了校验时不用猜参数。
--   · salt 内嵌在 code_hash 里而不是单列: 哈希自足, 换存储/导出时不会丢参数。
--   · purpose: **参与校验条件**, 不只是备注。没有它, 攻击者用"注册"场景骗一次发送,
--     就能拿这个码去改别人的密码 —— 这是验证码类功能最常见的越权口子。
--   · attempts: 最多 5 次, 超限直接作废。没有它, 5 分钟窗口内可以枚举 10^6 空间。
--   · ip: 发送限流的第三个维度(同 IP 1 小时 20 次), 防"换邮箱地址刷同一个人"。
--     存 IP 是运营商级别的粗定位, 不是设备指纹 —— 它只用于限流, 不用于识别用户。
--   · consumed_at: 一次性。校验成功/重发/超限都写它, 而不是删行(保留审计痕迹)。
--
-- 幂等: create table if not exists + create index if not exists

create table if not exists email_otp_codes (
  id            uuid primary key default gen_random_uuid(),
  -- 归一后的邮箱(小写去空白)。与小写化前的写法不该产生两个限流桶
  email         text not null,
  -- register / reset / bind / login —— 用途隔离, 见上方注释
  purpose       text not null,
  -- scrypt 哈希(格式 scrypt$salt$hash)。**明文码不落库、不入日志**
  code_hash     text not null,
  -- 校验失败次数, 达上限即作废
  attempts      integer not null default 0,
  -- 发起发送请求的 IP(仅用于限流; 客户端可能伪造 x-forwarded-for, 见服务注释)
  ip            text not null default '',
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

comment on table email_otp_codes is
  'V422 邮箱验证码(哈希存储/一次性/限流计数的真源). 明文码永不落库';
comment on column email_otp_codes.code_hash is
  'scrypt$<salt_b64>$<hash_b64> — 自描述格式, 校验时无需另查参数';
comment on column email_otp_codes.purpose is
  '用途隔离: register/reset/bind/login. 用途参与校验条件, 不同用途的码不通用';
comment on column email_otp_codes.ip is
  '仅用于发送限流(同 IP 每小时上限), 不作为用户标识';

-- 校验路径: 按 email + purpose 取最新未消费的一条(带 for update 行锁)
create index if not exists idx_email_otp_lookup
  on email_otp_codes (email, purpose, created_at desc)
  where consumed_at is null;

-- 三个限流桶各自按下标扫: 60 秒窗口 / 邮箱小时桶 / IP 小时桶
create index if not exists idx_email_otp_email_sent on email_otp_codes (email, created_at desc);
create index if not exists idx_email_otp_ip_sent on email_otp_codes (ip, created_at desc) where ip <> '';
