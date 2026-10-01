-- 172_aigc_external.sql — AIGC 检测外接权威平台(2026-10-01)
--
-- 由来: 本仓此前的 AIGC 检测是**自研标定**(aigc-detect-service.ts) —— 离线、无外部依赖,
--   但它是固定阈值模型(困惑度/突发性/四字格/套话密度…10 维), 在标定集上 AUC 0.957,
--   换模型或换学科会漂移。用户在投稿前要面对的是**期刊/学校指定的那家平台**(知网/维普/朱雀…),
--   自研分数再准也不能替他回答"我的稿子过不过得了那一家"。
--
-- ═══ 为什么不是"所有平台都调 API" ═══
--   实测(2026-10-01, 六家逐一打端点): 有公开 API 的只有 GPTZero / Winston AI / Copyleaks /
--   Sapling / Pangram 五家(Originality.ai 的 API 要 Enterprise 订阅, 假 key 打上去直接
--   422 "Enterprise Subscription Required")。知网 AIGC 检测 / 维普 / 万方 / 腾讯朱雀 /
--   中科睿鉴 / AIGC-X **不提供公开接口**, 它们只有网页版与机构协议。
--   所以 schema 必须同时容得下两种: 外接适配器(adapter)与人工送检+回填(manual)。
--
-- ═══ 为什么密钥单独一张表, 不用 users.byok_key_encrypted ═══
--   那个列存的是**用户自己的 LLM 密钥**(BYOK), 语义是"用我的模型额度跑平台的推理"。
--   这里是"把文本送到**某一家检测机构**去检" —— 不同服务商、不同计费、不同隐私后果,
--   而且用户可能在平台侧统一配一家(全租户共用一把)也可能每人自带。
--   混在一个列里, 改配置时两边互相覆盖。
--
-- 幂等: 全部 CREATE ... IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

-- ════════════════════ 服务商密钥 ════════════════
create table if not exists aigc_provider_credentials (
  id          uuid primary key default gen_random_uuid(),
  -- NULL = 平台级配置(全站共用); 非 NULL = 该用户自带
  user_id     uuid,
  provider    text not null,
  -- ⚠ **密文**, 复用 auth-service 的 AES-256-GCM(ByokKey 同一套编解码)。
  --   绝不存明文 —— agent_credentials 表存明文是个既有问题, 这里不跟着学。
  key_encrypted text not null,
  -- Copyleaks 是两段式: 先用 email+key 换 48 小时 access token。
  -- 需要 email 的只有它一家, 单独一列而不是塞进 key 字符串里(分隔符迟早会撞)。
  account_email text not null default '',
  enabled     boolean not null default true,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- 同一个 (用户, 服务商) 只有一条; user_id 为 NULL(平台级) 时靠下面的部分索引兜唯一
create unique index if not exists uq_aigc_cred_user_provider
  on aigc_provider_credentials (user_id, provider) where user_id is not null;
create unique index if not exists uq_aigc_cred_platform_provider
  on aigc_provider_credentials (provider) where user_id is null;

-- ════════════════════ 送检记录 ════════════════
create table if not exists aigc_external_scans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  provider      text not null,
  -- api = 平台适配器直接调用; manual = 用户导出送检包、去平台网页检、把结果回填
  mode          text not null check (mode in ('api','manual')),
  status        text not null default 'pending'
                check (status in ('pending','running','done','failed')),
  -- 送检文本的**指纹**, 不含正文 —— 正文可能有几万字, 而且多半是未发表的稿子。
  --   指纹用于"同一段文本重复送检"的判重与结果复用提示。
  text_sha256   text not null default '',
  text_chars    int  not null default 0,
  -- 归一化后的结论(各家的口径不同, 适配器负责翻译成这套)
  --   score: 0-100, **恒为"越高越像 AI"** —— 有的平台给的是"人类概率", 适配器要翻转。
  score         double precision,
  -- 与自研那套对齐的四档, 便于同屏对比
  verdict       text check (verdict in ('likely_human','mixed','likely_ai','insufficient')),
  -- 平台返回的原始 JSON(截断后)。**必须留着** —— 各家的字段名与档位口径都在变,
  --   出了问题只有原始响应能自证是"我们读错了"还是"平台改了"。
  raw           jsonb,
  error         text not null default '',
  latency_ms    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_aigc_scan_user on aigc_external_scans (user_id, created_at desc);
create index if not exists idx_aigc_scan_fingerprint on aigc_external_scans (text_sha256);

-- ════════════════════ 人工回填 ════════════════
-- 与 scans 分表而不是加几个可空列:
--   manual 流程的字段(送检批次号/平台回执/截图)与 api 流程毫无重叠,
--   合表会让一半的列在另一半场景下永远是 NULL(本仓已有"只写不读的列"的先例)。
create table if not exists aigc_manual_submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  -- 用户在平台上拿到的批次号/报告编号 —— 日后对账靠它
  reference_no  text not null default '',
  provider      text not null,
  title         text not null default '',
  text_sha256   text not null default '',
  text_chars    int  not null default 0,
  -- 回填的分数(0-100, 越高越像 AI)与平台原文说明
  score         double precision,
  verdict       text check (verdict in ('likely_human','mixed','likely_ai','insufficient')),
  -- 平台报告里的原文结论(例如"AI 生成疑似度 12.3%")—— 用户照抄, 保留原样
  raw_excerpt   text not null default '',
  -- 报告截图(dataURL 或文件相对路径)。期刊/学校要的是这个, 不是我们的数字。
  evidence_rel  text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists idx_aigc_manual_user on aigc_manual_submissions (user_id, created_at desc);
