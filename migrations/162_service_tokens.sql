-- 162_service_tokens.sql — 外部服务密钥的真源表 + 有效期
--
-- 由来(2026-09-28 用户要求):
--   MinerU 的 OCR token 在 2026-09-16 悄悄过期, 11 天后才被发现 —— 那时扫描版 PDF
--   已经传不上去了, 但**没人看得到"因为一个密钥过期了"**。根因不是密钥会过期,
--   是**过期这件事没有任何地方记录, 也没有任何地方提醒**:
--     · 值只存在 .env 里, 没有签发日/到期日, 界面上看不见;
--     · 检查它的唯一办法是发生一次真实调用 —— 也就是等它坏掉。
--
-- 为什么**不**复用 agent_credentials(迁移 070):
--   那张表存的是"服务端拿出去用的凭据"(值 + 脱敏提示), 没有时间维度。
--   这里要的是**可运营的密钥**: 什么时候签的、什么时候到期、上次验通是什么时候、
--   验的结果是什么、还剩几天该提醒。混进 agent_credentials 会让那张表的语义变糊。
--
-- 值的安全约定(与 agent_credentials 一致, 见该文件头部):
--   ① 任何 API **只返回脱敏视图**, value 永不出库;
--   ② 日志/工具参数走 maskCredentials;
--   ③ 提示词里只给 last6, 不给全量。
--
-- 幂等: create table if not exists(不预置行)

create table if not exists service_tokens (
  -- 服务标识, 与代码里的常量对齐(当前: 'mineru')
  service          text primary key,
  -- 密钥本体。只进不出 —— 读它的只有服务端代码, 没有 API 能把它带出去
  token            text not null,
  -- 签发/到期。到期日可为空 = 未知(不猜, 也不拿签发日+90天冒充 ——
  --   MinerU 当前是 90 天, 但那是它的策略不是我们的数据, 策略变了会静默算错)
  issued_at        timestamptz,
  expires_at       timestamptz,
  -- 留 6 位用于辨认"换没换过"(界面上显示 ...xxxxxx)。不足以推导出全量
  token_tail       text not null default '',
  -- 上次校验: 时间 + 结果(ok / rejected / expired / unreachable / not_configured)
  last_checked_at  timestamptz,
  last_check_ok    boolean,
  last_check_note  text not null default '',
  -- 备注(谁签的/哪个账号, 便于到期时知道去哪续)
  note             text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table service_tokens is
  'V418 外部服务密钥(值+有效期+上次校验). 值只出不进; 任何 API 只回脱敏视图';
comment on column service_tokens.token_tail is
  '末尾 6 位, 仅用于辨认是否换过; 不足以还原密钥';

-- 巡检按到期日扫全表(条数很少, 建索引只为语义清晰)
create index if not exists idx_service_tokens_expires on service_tokens (expires_at);
