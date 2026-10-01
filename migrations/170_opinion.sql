-- 170_opinion.sql — 舆情检索: 源条目池 + 同一 query 的检索结果缓存
--
-- 由来(2026-10-01): 「舆情检索」这件事在本仓**完全没有实现**(旧项目 AItoolman 只有一句
--   `舆情检索请求失败` 的提示和一个源字典, 没有采集/分析)。这里的用途是**研究场景**,
--   不是商业舆情监控: 政策出台后的讨论走向 / 社会议题的媒体框架 / 网络舆论与官方话语对照。
--   研究场景的特点决定了要落库而不是"抓完就丢":
--     · 同一批语料要反复看(换关键词、换时间窗、隔天复核), 每次重抓既慢又打扰对方站点;
--     · 趋势与立场分布要能对着**历史**算 —— 结果只活在内存里的话, 进程一重启就没了。
--
-- 两张表, 职责刻意分开:
--   · opinion_items        —— 外部条目池(按 source+url 去重)。写一次长期在: 换关键词重查、
--                             或某个源当天挂了, 都能从这里回补。检索缓存做不到这件事。
--   · opinion_search_cache —— query+参数 → 完整结果。防"同一 query 反复打对方站点"。
--                             只存结果不回补: 缓存里没有"这一条来自哪个源"的可用结构。
--
-- 幂等: 全部 create ... if not exists / 索引 if not exists, 重跑无副作用。

create table if not exists opinion_items (
  id            uuid primary key default gen_random_uuid(),
  source_id     text not null,
  source_name   text not null default '',
  category      text not null default '',
  title         text not null,
  summary       text not null default '',
  url           text not null default '',
  -- 无发布时间的源(新华网那类站不写 pubDate)存 null —— **不要**填 now() 冒充发布时间,
  --   那会让"某天讨论量暴增"完全是抓取时刻的假象。
  published_at  timestamptz,
  lang          text not null default 'zh',
  -- 分析结果与原文一起存: 重算代价(尤其 LLM 校准)不该在每次读池时再付一遍
  sentiment     text not null default 'neutral',
  stance        text not null default 'neutral',
  intensity     real not null default 0,
  topics        jsonb not null default '[]'::jsonb,
  first_query   text not null default '',
  fetched_at    timestamptz not null default now(),
  -- source_id + url 的内容哈希。url 可能很长(超 btree 索引项上限), 且带跟踪参数,
  --   所以判重落在定长哈希列上, 不落在 url 本身
  content_hash  text not null unique
);

create index if not exists idx_opinion_items_source on opinion_items (source_id, published_at desc);
create index if not exists idx_opinion_items_time on opinion_items (published_at desc);
-- 回补要按关键词在标题/摘要上找: 用 pg_trgm 不可用时退化为顺序扫, 先给时间列建索引即可
create index if not exists idx_opinion_items_fetched on opinion_items (fetched_at desc);

create table if not exists opinion_search_cache (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  query       text not null,
  -- sha256(userId|归一query|参数) —— 查询串可能很长, 索引键要定长
  query_hash  text not null,
  params      jsonb not null default '{}'::jsonb,
  result      jsonb not null,
  item_count  int not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists idx_opinion_cache_hash on opinion_search_cache (query_hash, expires_at desc);
create index if not exists idx_opinion_cache_user on opinion_search_cache (user_id, created_at desc);

comment on table opinion_items is
  '舆情检索源条目池(按 source+url 哈希去重). 换关键词重查/源当日故障时从这里回补';
comment on table opinion_search_cache is
  '舆情检索结果缓存(query+参数 → 完整结果). 防止同一 query 反复请求外部源站点';
