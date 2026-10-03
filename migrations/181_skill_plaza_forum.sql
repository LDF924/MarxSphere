-- 181_skill_plaza_forum.sql — 技能广场市场 + 学友论坛(2026-10-03)
--
-- 两件事放一个迁移里, 因为它们共用一套"用户产出内容"的形态(作者/审核态/可见性),
-- 而且分两次建表会让"谁能看谁的内容"这条规则在两处各写一遍, 迟早漂。

-- ═══════════════════════════════════════════════════════════════
-- 一、技能广场: 上传 → 审核 → 上架
-- ═══════════════════════════════════════════════════════════════
--
-- 与既有 `skills` / SKILL.md 的关系: 技能本体仍是磁盘上的 SKILL.md(那是唯一真源,
--   Agent 召回、健康检查、self-check 全读它)。这张表只存**平台侧的元信息**:
--   谁提交的、审核到哪一步、审核意见、装了多少次、看得见的版本号。
--   ⚠ 不把 SKILL.md 正文搬进库 —— 搬进去就会出现"两份正文", 改了哪份生效说不清
--   (仓里已经因为这个吃过亏: 派生的副本永远比真源旧)。

create table if not exists skill_submissions (
  id             uuid primary key default gen_random_uuid(),
  -- 提交人; 技能本体落在 data/skills/<owner_id>/<slug>/, slug 与 SKILL.md 的 name 一致
  owner_id       uuid not null,
  -- 技能的 name(与 SKILL.md frontmatter 一致), 上架后就是广场上的唯一标识
  slug           text not null,
  title          text not null,
  summary        text not null default '',
  -- 从 SKILL.md 解析出来的分类/标签/来源, 提交时快照一份 —— 审核时看的就是这一份,
  -- 不随文件后续改动而变(不然"审核时是这样, 上架后变那样"无法追责)
  category       text not null default '',
  tags           jsonb not null default '[]'::jsonb,
  origin         text not null default 'self-made',
  version        text not null default '1.0.0',
  -- 审核态: pending(待审) / approved(已上架) / rejected(驳回) / withdrawn(作者撤回)
  status         text not null default 'pending',
  review_note    text not null default '',
  reviewer_id    uuid,
  submitted_at   timestamptz not null default now(),
  reviewed_at    timestamptz,
  -- 广场排序用; 上架时 +1, 每次安装再 +1
  install_count  integer not null default 0,
  updated_at     timestamptz not null default now(),
  constraint skill_submissions_status_chk check (status in ('pending','approved','rejected','withdrawn'))
);

-- 同一个人的同一个技能名只允许一条**活跃**记录: 被驳回/撤回的可以再提,
-- 但待审与已上架不能重复提交(否则广场上会出现两条同名, 装哪个说不清)
create unique index if not exists skill_submissions_active_uniq
  on skill_submissions (owner_id, slug)
  where status in ('pending','approved');

create index if not exists skill_submissions_status_idx
  on skill_submissions (status, submitted_at desc);

-- 安装记录: 谁装过哪个。既做"去重计数", 也让作者能看到自己的技能被谁在用。
create table if not exists skill_installs (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references skill_submissions(id) on delete cascade,
  user_id       uuid not null,
  installed_at  timestamptz not null default now(),
  -- 装的是哪一版 —— 作者发新版时, 老安装者需要知道"你手上这份落后了"
  version       text not null default '',
  unique (submission_id, user_id)
);

create index if not exists skill_installs_user_idx on skill_installs (user_id, installed_at desc);

-- 广场讨论区: 帖挂在某个技能下(技能论坛)。独立讨论见下面的 forum_* 表。
create table if not exists skill_comments (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references skill_submissions(id) on delete cascade,
  -- 回复支持一层嵌套(parent 为空 = 顶层评论); 不做无限层级 —— 论坛式无限嵌套
  -- 在窄栏里根本读不了, 贴吧/知乎也只是两层
  parent_id     uuid references skill_comments(id) on delete cascade,
  user_id       uuid not null,
  body          text not null,
  created_at    timestamptz not null default now()
);

create index if not exists skill_comments_sub_idx on skill_comments (submission_id, created_at);

-- ═══════════════════════════════════════════════════════════════
-- 二、学友论坛(独立 tab): 板块 → 帖 → 回复
-- ═══════════════════════════════════════════════════════════════
--
-- 参考贴吧/知乎的**信息结构**而不是像素: 板块(贴吧的"吧") → 帖(主题) → 回复(楼层),
--   帖有标题+正文+标签, 支持置顶/加精(这是贴吧最核心的两个运营动作), 回复按楼排,
--   支持一层楼中楼。知乎那一侧的形态是"赞同+收藏", 这里映射成 vote/star —— 不引入
--   踩(负反馈对学术讨论是噪声, 且会诱发拉踩)。

create table if not exists forum_boards (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  -- 排序权重, 数字小的排前面; 内置板块给 10/20/30…, 留出插入空间
  sort_order  integer not null default 100,
  -- 内置板块由迁移播种, 不给删(删了帖就没地方去); 用户建的板块可以
  is_builtin  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists forum_threads (
  id           uuid primary key default gen_random_uuid(),
  board_id     uuid not null references forum_boards(id) on delete cascade,
  user_id      uuid not null,
  title        text not null,
  body         text not null default '',
  tags         jsonb not null default '[]'::jsonb,
  pinned       boolean not null default false,
  digest       boolean not null default false,   -- 加精(知乎的"编辑推荐")
  reply_count  integer not null default 0,
  view_count   integer not null default 0,
  vote_count   integer not null default 0,
  last_reply_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists forum_threads_board_idx on forum_threads (board_id, pinned desc, last_reply_at desc);

create table if not exists forum_replies (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references forum_threads(id) on delete cascade,
  parent_id  uuid references forum_replies(id) on delete cascade,
  user_id    uuid not null,
  body       text not null,
  vote_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists forum_replies_thread_idx on forum_replies (thread_id, created_at);

-- 投票: 一人一帖/一回复一票, 靠唯一键挡住重复
create table if not exists forum_votes (
  user_id    uuid not null,
  target_type text not null,
  target_id  uuid not null,
  created_at timestamptz not null default now(),
  constraint forum_votes_type_chk check (target_type in ('thread','reply')),
  primary key (user_id, target_type, target_id)
);

-- 收藏(知乎式): 一人一帖一条
create table if not exists forum_stars (
  user_id    uuid not null,
  thread_id  uuid not null references forum_threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

-- 内置板块 —— **种子写进迁移**, 与期刊库那次同一个判断:
-- 空库里"一个板块都没有"会让论坛看起来是坏的, 而播种成本只有几行。
insert into forum_boards (slug, name, description, sort_order, is_builtin) values
  ('announce',  '站务公告',   '平台更新、维护通知、规则说明',                     10, true),
  ('method',    '研究方法',   '定性/定量/混合方法、识别策略、数据获取的讨论',      20, true),
  ('tools',     '工具与技能', '科研工具、技能用法、踩坑与替代方案',                30, true),
  ('writing',   '论文写作',   '选题、框架、投稿、审稿意见回应',                    40, true),
  ('reading',   '读书与文献', '文献精读、理论脉络、书单互荐',                      50, true),
  ('jobs',      '课题与就业', '基金申报、课题合作、学术求职',                      60, true),
  ('offtopic',  '灌水区',     '与研究无关的闲聊',                                  90, true)
on conflict (slug) do nothing;

comment on table skill_submissions is '技能广场: 用户提交的技能与审核态(技能本体仍在磁盘 SKILL.md)';
comment on table forum_threads is '学友论坛主题帖; pinned=置顶, digest=加精';
