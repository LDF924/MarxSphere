-- 175_user_notifications.sql — 用户级站内通知(与全局 alerts 分家)
--
-- 由来(2026-10-02): 本仓的通知一直只有**全局 alerts 一张表**, 它没有 user_id。
--   用中发现的三个同型缺陷都源于此:
--     ① `agent-task-service.ts:770` 把"任务完成"写进 alerts(level=info),
--        而 `AlertToast.tsx:38` 明确 `filter(a => a.level !== "info")` ——
--        **任务完成通知永远弹不出来**, 写了等于没写;
--     ② `rss-service.ts:122` 推送 RSS 新条目标 level=info, 同上, 也弹不出来;
--     ③ `AlertsPanel.tsx:27` 的 CATEGORY_LABELS 没有 `agent` 键, 告警中心里
--        这一类显示的是裸英文 `agent`。
--   根因不是这三处, 是**只有一张全局表**: 系统告警与"给某个人的通知"是两种东西,
--   强行共用一张表的后果就是上面这些。
--
-- ⚠ 为什么不给 alerts 加 user_id: 告警是**运维事实**(推理降级/熔断/巡检失败),
--   全站一份、本机豁免、外部令牌按 alerts 权限读。塞进 user_id 会让现有 16 个
--   写入点和 4 条路由全部要改判"这条算谁的", 而答案往往是"所有人的"。
--   所以另起一张表, 两边各管各的: alerts 不变, notifications 只装"给某人的消息"。
--
-- ⚠ 本表的定位与 digest_items 的区别: 速递条目是**内容**(有标题摘要要读),
--   通知是**事件**(「你的任务完成了」「积分到账 100」), 点进去跳到对应页面。两者不合并。
--
-- 幂等: create table if not exists / create index if not exists。

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  -- 事件类别。取值要**同时**决定: 前端图标/分组、点击后的跳转目标、以及是否弹 toast。
  -- 新增类别时必须一并更新 web/src/components/NotificationsPanel.tsx 的 CATEGORY 表
  -- (AlertsPanel 就是因为漏了这个映射, `agent` 类显示成裸英文)。
  category    text not null default 'system',
  -- info | success | warning | error —— 与 alerts.level 同词表, 便于前端复用配色。
  -- ⚠ 与 alerts 的一个关键差别: **本表的 info 会弹 toast**。
  --   alerts 那边 info 被 AlertToast 静默过滤(那是运维噪音, 弹出来是骚扰);
  --   但"你的任务完成了"正是 info 级, 不弹就失去意义。级别语义按表不同, 见写入侧注释。
  level       text not null default 'info',
  title       text not null default '',
  body        text not null default '',
  -- 点击通知的去处(前端路由视图名 + 可选参数), 空对象=不可点
  link        jsonb not null default '{}'::jsonb,
  -- 幂等键: 同一件事只通知一次。写成 `<事件类型>:<对象id>` 形式, 空值不受唯一索引约束。
  -- 例: `task_done:<taskId>` / `points_checkin:<yyyy-mm-dd>` / `digest_daily:<yyyy-mm-dd>`
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- 一个用户一条通知只能有一条 —— 重复投递(重试/多副本)不该在收件箱里出现两次
create unique index if not exists notifications_dedupe
  on notifications (user_id, dedupe_key) where dedupe_key is not null;

-- 主查询形状: 我的收件箱按时间倒序
create index if not exists idx_notifications_user
  on notifications (user_id, created_at desc);
-- 未读数: 只索引未读行(照 032_alerts 的部分索引写法)
create index if not exists idx_notifications_unread
  on notifications (user_id) where read_at is null;

comment on column notifications.level is
  'info/success/warning/error。与 alerts.level 同词表, 但**本表 info 会弹 toast** —— alerts 的 info 被 AlertToast 静默过滤。';
comment on column notifications.dedupe_key is
  '幂等键 `<事件类型>:<对象id>`; 同用户同键只保留一条(部分唯一索引)。空值不受约束。';
