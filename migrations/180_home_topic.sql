-- 180_home_topic.sql — 首页「当前课题」持久化(2026-10-03)
--
-- 由来: 首页「当前课题」横幅与它下面那行关键词此前都是 HomePanel.tsx 里的**字面量**,
--   用户要"可输入、可固定, 输入时自动给出关键词候选"。要固定就得有地方存 —— 存
--   localStorage 只在那台浏览器上生效, 换设备就没了, 而课题是这个账号的研究主线。
--
-- 一人一条(与 digest_subscriptions 同形): 首选项是整体提交的, 不是逐项增删。
create table if not exists user_home_topic (
  user_id    uuid primary key,
  title      text not null default '',
  keywords   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table user_home_topic is '首页当前课题(一人一条): 课题全称 + 勾选后的关键词, 首页 Hero 与推理入口共用';
