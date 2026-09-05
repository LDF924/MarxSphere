-- 112_im_config.sql — IM 接入配置(飞书/钉钉/Telegram webhook)
-- 单行配置表; 运行时读取(优先 DB, env 兜底) — 前端面板改配置即时生效, 无需重启
create table if not exists im_config (
  id int primary key default 1 check (id = 1),
  feishu_webhook text not null default '',
  dingtalk_webhook text not null default '',
  telegram_token text not null default '',
  telegram_chat_id text not null default '',
  updated_at timestamptz not null default now()
);
insert into im_config (id) values (1) on conflict (id) do nothing;
