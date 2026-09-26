-- 158_review_responses.sql — 批6: 外部审稿意见与逐条回应
--
-- 由来(2026-09-26 全流程审计):
--   写作舱此前**没有"外部审稿意见"这个概念**。全仓三处沾边的都不是它:
--     · `/api/review/*` 是**单向的"我方当审稿人"** —— 输入只有稿件全文
--       (review-service.ts 的入参里没有放外部意见的字段), 产出是我方给别人的报告;
--     · `phase5_revise` 的输入**不是审稿意见**, 而是**系统自审报告**(review_result);
--       而且报告里 `dimensions[].issues[]` 那些**逐条问题根本没进 prompt** ——
--       送进去的只有 checks 的通过与否 + topSuggestions 的合并串;
--     · 场景卡 S30「审稿意见回应」是**纯提示文案**, 指向用户本机的技能包,
--       平台侧没有任何路由把 SKILL.md 当 prompt 执行。
--   于是真实科研里最硬的一环 —— 收到的意见要**逐条**回应, 且"我没改"与"我改了但没改到位"
--   是两回事 —— 在平台上是空白的。
--
-- ⚠ 为什么不复用 research_hypotheses 那张表:
--   形状像(都是"条目 + 状态 + 依据"), 但语义正交 —— 那张是**假设检验**,
--   这张是**意见回应**。混用会让两边的查询都要加判别列, 且删除语义不同
--   (删项目时假设该走、意见该走, 但不该联动)。所以建新表。
--   但**设计照抄它**是对的: 唯一 code + 多态 status + evidence 字段, 这三条都验过。
--
-- 幂等: create table if not exists / create index if not exists。

create table if not exists research_review_responses (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references research_projects(id) on delete cascade,

  -- 第几轮意见。真实投稿里"投→退修→再投→再退修"会来回好几轮,
  --   而**同一轮内**的条目要能整体看待(本轮共 N 条、处理了几条)。
  --   不给默认值: 由服务端算"当前最大轮次+1", 让调用方显式看到自己在哪一轮。
  round         int  not null default 1,

  -- 审稿人标签(审稿人1/外审专家A/编辑部)。自由文本 —— 真实意见里怎么称呼都有,
  --   做成枚举只会逼用户选一个不准确的。
  reviewer_label text not null default '',

  -- 本轮内的序号, 决定展示顺序。正文与回应信里都按它引用("意见3")。
  seq           int  not null default 0,

  -- 意见分类。四类各有各的回应对策, 所以**不是**装饰性标签:
  --   修改类 → 照着改; 质疑类 → 要么补证据要么辩护; 补充类 → 加内容或说明为何不加;
  --   拒绝类 → 编辑部/审稿人直接否掉某个做法, 要正面回应而非绕过。
  kind          text not null default 'revise'
                  check (kind in ('revise','question','supplement','reject')),

  -- 原文引用(意见里被针对的那句原文)与意见正文。分开存是因为回应时**两句都要用**:
  --   "您指出『……』" + "我的回应是" —— 合在一起没法只引其一。
  quote         text not null default '',
  comment       text not null default '',

  -- 我方回应。**没有回应时为空串**, 不用 null —— 与 quote/comment 一致, 省掉读取侧的分支。
  response      text not null default '',

  -- 回应方式三态。空串 = 还没处理。
  --   为什么不并进 status: 这两件事会**各自独立地变** —— 一条意见可以是"已回应但还在
  --   等编辑确认"(status=resolved, type=responded) 后来又变成"已修改"。合成一个字段
  --   就得在每次流转时猜前一个值, 而它们是正交的两维。
  response_type text not null default ''
                  check (response_type in ('','revised','responded','disagreed')),

  status        text not null default 'pending'
                  check (status in ('pending','resolved')),

  -- 这条意见对应改出来的修订版本号(research_versions.version)。
  --   **可空且不强外键**: 意见处理往往先于修订稿生成 —— 用户先把 N 条意见逐条标成
  --   "已修改", 再跑一次 revise 出稿。要求先有版本会让这个顺序走不通。
  revision_refs int[] not null default '{}',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_review_responses_project
  on research_review_responses (project_id, round, seq, created_at);

-- 投稿记录(投了哪个刊、什么时候、什么状态)。与意见条目同属"投稿与返修"区,
--   但**不合成一张表**: 一条投稿记录对应 N 条意见, 且投稿本身在还没收到意见时就存在。
create table if not exists research_submissions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references research_projects(id) on delete cascade,
  journal_name  text not null default '',
  -- 投出日期用 date 而不是 timestamptz: 用户填的是"哪天投的", 不是"几点几分"。
  --   用时间戳会逼所有读取侧做时区处理, 而这里根本不需要。
  submitted_on  date,
  status        text not null default 'submitted'
                  check (status in ('submitted','under_review','revision_requested','accepted','rejected','withdrawn')),
  note          text not null default '',
  round         int  not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_research_submissions_project
  on research_submissions (project_id, created_at desc);
