-- 113_wecom_config.sql — 企业微信配置(自建应用双向 + 群机器人)
alter table im_config add column if not exists wecom_corp_id text not null default '';
alter table im_config add column if not exists wecom_corp_secret text not null default '';
alter table im_config add column if not exists wecom_agent_id text not null default '';
alter table im_config add column if not exists wecom_callback_token text not null default '';
alter table im_config add column if not exists wecom_encoding_aes_key text not null default '';
alter table im_config add column if not exists wecom_webhook text not null default '';
alter table im_config add column if not exists wecom_touser text not null default '';
