-- 174_research_digest.sql — 研究速递: 统一文献条目 + 用户级订阅 + 抓取批次
--
-- 由来(2026-10-02): 对照旧项目 Respal 的「研究速递」功能测绘出来的。
--   它有 /api/digest 按主题分组推送、用户级主题/期刊订阅、每日 19:19 抓取。
--   本仓此前**没有任何"推给用户"的路径**: 抓取侧有 rss-service(arXiv/RSS)、
--   literature-browser(知网/万方/维普代抓)、journal-sync-service(80 本期刊动态),
--   但落点全是 alerts(sources 表 metadata), 而 **alerts 没有 user_id** ——
--   订阅了谁看都一样, 且 AlertToast 只弹 level!='info', 推了也不可见。
--
-- ⚠ 为什么不复用 `documents`(167 那次的结论是"别建平行表", 这次反过来)
--   167 拒绝建 `papers`, 因为导入的文献用户要在**检索侧**搜到, 必须落 documents。
--   速递条目不同: 它是**未读的推送流水**, 用途是"今天有什么新东西"然后决定要不要
--   读/入库。全部塞进 documents 会让四源检索被每日抓取的噪声淹没。所以:
--     · 本表 = 推送流水(轻, 可过期, 可被"不再提示"标记)
--     · 用户点「加入文献库」→ 走既有 ingestionService 落 documents(那条路已存在,
--       paper-source-service / zotero-service 同口径), 本表只记 promoted_document_id。
--
-- ⚠ 三个坑(都是 Respal 实测踩出来的, 建表时就避开)
--
--   坑① 去重键。Respal 按 `id` 去重, 而 arXiv 的 id 是**按分类分别分配**的 ——
--        同一篇预印本在 Economics (General) / General Economics / Econometrics
--        三个分类下 id 各不同(78876/78887/78896), title/doi/url 全同, 于是入库三次。
--        故本表**不以任何源的 id 作唯一键**, 而是两条归一化唯一索引:
--          · item_doi_key    —— doi 去 https://doi.org/ 前缀、转小写
--          · item_title_key  —— 标题去标点/空白/大小写(中文不做分词)
--        两者都为空的行(极少)不受唯一索引约束, 由 runs 内的应用层去重兜底。
--
--   坑② `fetched_at` 必须落, 且**不能可空**。Respal 中文刊那条链路不写 fetched_at,
--        查询 `ORDER BY fetched_at DESC` 时 Postgres 的 DESC **默认 NULLS LAST**,
--        19 篇中文刊被整批推到末尾 —— 中文社科研究者打开面板先看到 9 篇英文刊。
--        这里 fetched_at 定 NOT NULL DEFAULT now(), 从结构上不可能出现 NULL。
--        注意与 published_at 的分工: fetched_at=我们何时抓到的(排序用),
--        published_at=出版方声明的出版日(展示用, 可空 —— 很多源就是不提供)。
--
--   坑③ `published` 格式不归一。Respal 库里混了四种:
--        `YYYY-MM-DD`(20) / RFC-2822 带时区(7) / ISO-8601(4) / 纯年份(1),
--        前端只能写 `cleanAbstract` 之类正则去擦。这里 published_at 是 timestamptz,
--        **入库前在 JS 侧归一化**(见 src/services/digest/sources.ts 的 parsePublished),
--        解析不出来一律 NULL, 绝不写 `now()` 冒充 —— 那会把"哪天出版"变成"哪天抓的"
--        (同 opinion-sources.ts 记的新华网 RSS 那条教训)。
--
-- 幂等: create table if not exists / create index if not exists / add column if not exists。

-- ═══ 抓取批次台账 ═══
-- 为什么要有它: 每日抓取是无人值守的。"今天为什么只有 3 篇"必须能查到是
--   源挂了(ok=false + error)还是真的没新内容(ok=true, fetched=0)。
--   只把结果写进 items, 用户与运维都看不出"某源连续一周失败"。
create table if not exists digest_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  trigger       text not null default 'cron',   -- cron | manual | api
  topics        text[] not null default '{}',   -- 本轮跑的主题快照
  per_source    jsonb not null default '[]'::jsonb,
  -- [{source, ok, fetched, inserted, dup, error}] —— 逐源记账, 失败必须留痕
  inserted      integer not null default 0,
  dup           integer not null default 0,
  ok            boolean not null default true,
  error         text
);
create index if not exists idx_digest_runs_started on digest_runs (started_at desc);

-- ═══ 文献条目(推送流水) ═══
create table if not exists digest_items (
  id              uuid primary key default gen_random_uuid(),
  -- 源的稳定标识(openalex / crossref / arxiv / rss:<feedId> / cnki / wanfang …)
  source          text not null,
  -- 源内的原始 id(仅用于回溯原条目,**不作去重键** —— 见坑①)
  external_id     text,
  title           text not null,
  doi             text,
  url             text not null default '',
  journal         text not null default '',
  authors         text[] not null default '{}',
  abstract        text not null default '',
  -- LLM 生成的中文概括(对**所有来源**统一生成, 不只英文 —— Respal 也是这么做的:
  -- 中文刊 abstract 本身已是中文, cn_summary 仍照常生成)
  cn_summary      text not null default '',
  cn_summary_at   timestamptz,
  -- 出版方声明的出版日; 解析不出即 NULL(见坑③, 绝不冒充 now())
  published_at    timestamptz,
  -- 我们抓到的时刻。NOT NULL 是**结构上的保证**: 排序永远有依据(见坑②)
  fetched_at      timestamptz not null default now(),
  -- 归一化去重键(见坑①)。空值不受唯一索引约束。
  item_doi_key    text,
  item_title_key  text,
  lang            text not null default '',     -- zh | en | ''(未知, 不猜)
  -- 命中的订阅主题(一个条目可能同时属于多个主题, 所以是数组而非单值)
  topics          text[] not null default '{}',
  -- 用户点「加入文献库」后回填, 指向 documents.id; 空=还只是推送
  promoted_document_id uuid,
  created_at      timestamptz not null default now()
);

-- 唯一索引成对存在: 有 doi 的行按 doi 判重, 没有的按归一化标题判重。
-- 不用 coalesce(doi, title) 单表达式索引 —— 那样有 doi 的行一旦标题变了
-- 会变成"新条目", 而实际上它就是同一篇。
create unique index if not exists digest_items_doi_key
  on digest_items (item_doi_key) where item_doi_key is not null;
create unique index if not exists digest_items_title_key
  on digest_items (item_title_key) where item_title_key is not null;

-- 主查询形状: 按主题 + 时间倒序取最近 N 天(即 /api/digest 的那条查询)
create index if not exists idx_digest_items_topics
  on digest_items using gin (topics);
create index if not exists idx_digest_items_fetched
  on digest_items (fetched_at desc);
create index if not exists idx_digest_items_source
  on digest_items (source, fetched_at desc);

-- ═══ 用户级订阅 ═══
-- 与 review_journals(117) 那个"公共期刊库"是**两回事**:
--   那是全站共享的期刊资料(投稿须知/收录范围), 这是**某个用户订阅了哪些主题与刊**。
-- user_id 不加外键 —— 与 user_files(123) / literature_import_batches(167) 口径一致,
--   本平台多数用户维度的表不挂 users 外键, 以便"未登录/本机"场景也能留痕。
create table if not exists digest_subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  topics              text[] not null default '{}',
  -- 订阅的期刊名(与本仓 cjournal_journals.name 同口径, 但**不强绑** ——
  -- 用户可能想订一本不在 80 本库里的刊)
  preferred_journals  text[] not null default '{}',
  days                integer not null default 7,     -- 未读滚动窗口
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- 一个用户一条订阅配置(不是一行一个主题 —— 首选项是整体提交的, 见 /api/topics 契约)
create unique index if not exists digest_subscriptions_user
  on digest_subscriptions (user_id);

-- ═══ 已读标记 ═══
-- 为什么不复用 alerts 的 `read boolean`: alerts 是全局单份, 同一条被谁读了都算读了。
-- 速递是**每人一份**的, 必须按 (user_id, item_id) 记。
create table if not exists digest_reads (
  user_id     uuid not null,
  item_id     uuid not null references digest_items(id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (user_id, item_id)
);
