-- 178_im_app_credentials.sql — IM 补"自建应用"凭据(飞书)
--
-- 由来(2026-10-02): 对照 Respal 的 IM 机器人面板 —— 它配的是**自建应用**
--   (App ID / App Secret / 测试连通性)。本仓 `im_config` 只有 `feishu_webhook`,
--   是**自定义机器人**: 只能"往一个固定群里推文本", 不能按人发、不能收事件、不能回复。
--
-- 实测确认的现状(不是推测):
--   · `im-service.ts` 的 platform 联合类型里有 "feishu", 但实现只有 `sendFeishu(webhook, text)`;
--   · 全仓 `app_id` / `app_secret` 在 im-service 里**零命中**;
--   · `open.feishu.cn/open-apis/bot/v2/hook/xxx` 是唯一的飞书调用。
--
-- 补这几列是为了做**按人推送**: 通知中心(175)产生的消息要能发到用户自己的飞书。
--   webhook 做不到这件事 —— 它只会往配置的那个群发, 谁都能看见。
--
-- ⚠ 关于凭据落库: app_secret 与 encrypt_key 是**明文存 DB**。这不是疏忽, 是与本表
--   既有字段(telegram_token)一致的口径, 且这些凭据的作用域是"机器人自己的身份",
--   不是用户凭证。若要更强保护应走 agent_credentials(070) 那套加密路径 —— 那是
--   另一个决定, 不在本次范围内, 这里明确记下现状以免被误读成"已经加密了"。
--
-- 幂等: add column if not exists。

alter table im_config add column if not exists feishu_app_id          text not null default '';
alter table im_config add column if not exists feishu_app_secret      text not null default '';
-- 事件订阅: 飞书会把 verification_token 回显做 URL 校验, encrypt_key 用于解密事件体
alter table im_config add column if not exists feishu_verification_token text not null default '';
alter table im_config add column if not exists feishu_encrypt_key     text not null default '';

comment on column im_config.feishu_app_id is
  '飞书自建应用 App ID。与 feishu_webhook 是**两条独立通道**: webhook 只往固定群推文本, 应用可发到指定人/收事件。';
comment on column im_config.feishu_encrypt_key is
  '飞书事件订阅的 Encrypt Key(AES-256-CBC 解密事件体)。明文存库, 与 telegram_token 同口径。';
