-- 156_empirical_project_owner.sql
--
-- 由来(2026-09-25): 写作舱的「本章依据」要引用实证台(因果推断)的结果时, 撞上一个事实 ——
--
--   `empirical_projects` **没有 user_id 列**, 实证台的 63 个路由**没有一处调 requireUser**,
--   服务端对本机连接又全豁免。也就是说 **实证台的数据是"实例级"的, 本来就没有用户隔离**:
--   任何能访问到这个部署的人都能列出并打开所有人的实证课题。
--
-- ⚠ 这条迁移**只补齐归属这一列**, 不假装把 63 个路由的鉴权一次做完 —— 那会**打断实证台界面**:
--   `requireUser` 要求 JWT 且**不放行本机**(本机豁免在另一个 onRequest 钩子层, 与它无关)。
--   实证台前端(web/src/empirical/*)在未登录/本地起服务时是能用的, 直接加 requireUser 会让它 401。
--
-- 所以本迁移 + 配套改动**向后兼容**:
--   · 新课题记录归属(user_id);
--   · 历史行回填 `null`;
--   · **有归属**的行按归属过滤与校验; **无归属**的行保持现状(对所有人可见, 并在界面标出来)。
--   这样"新数据开始有归属"与"老数据不消失"同时成立, 也给后续逐路由收紧留出路径。
--
-- 回填策略: **不回填**。
--
-- ⚠ 试过并放弃了两个来源, 都是"看起来能猜, 实际猜不准":
--   ① `empirical_results.user_id` —— 那张表**没有 project_id 列**(只有 file_id), 关联不上课题;
--      而且它的 user_id 是迁移 127 才加的, 历史行里**恒为 null**。
--   ② `empirical_pipeline_runs` —— 同样只有 project_id, 没有任何用户列。
--
-- 既然**没有任何可靠来源**, 就不猜: 历史行一律留 null(界面标为"历史 · 未归属")。
-- 猜错的归属比没有归属更糟 —— 那会把别人的课题锁死在错误的账号下, 而且没有任何界面
-- 能让人发现这件事。新课题从今天起正常记录归属, 用一段时间后老数据自然退场。

alter table empirical_projects
  add column if not exists user_id uuid;

comment on column empirical_projects.user_id is
  'V426: 课题归属; null=历史数据(迁移 156 之前建的), 视为"实例级共享"并在界面标注。'
  '⚠ 实证台的读取路由尚未全部强制归属校验 —— 本列是收紧的第一步, 不是完整隔离。';

create index if not exists idx_empirical_projects_user
  on empirical_projects (user_id, created_at desc)
  where user_id is not null;
