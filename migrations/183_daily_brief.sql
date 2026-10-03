-- 183_daily_brief.sql —— 每日简报: 历史基准 + 主题 wiki 构建记录
--
-- 为什么需要这两张表(而不是像观澜那样写文件):
--   · 观澜是**单机单用户 CLI**: 日报历史写 `~/.guanlan/daily/history.jsonl`。
--     本仓是**多用户服务**, 同一个文件会串用户 —— A 的对比基准混进 B 的采集记录,
--     表现为"我昨天没见过这条线"其实是别人查过。历史按 user_id 隔离是必须的。
--   · 主题 wiki 的产物落在磁盘(要能整目录拷给本地模型), 但**构建记录**要落库:
--     否则界面不知道上次构建是什么时候、覆盖了多少条、哪些是 candidate。
--
-- 幂等: 迁移可重复跑。

create table if not exists daily_brief_history (
  id            bigserial primary key,
  user_id       text not null,
  -- 归一后的 query(去空白+小写) —— 对比只在同一课题内进行
  query_key     text not null default '',
  title         text not null default '',
  generated_at  timestamptz not null default now(),
  time_window   text not null default '3d',
  edition       text not null default 'general',
  -- 只存紧凑主线(id/headline/freshness/risk_level/action/confidence), 不存全文
  storylines    jsonb not null default '[]'::jsonb,
  source_health jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- 对比查询的模式: 按用户 + query + 时间倒序取最近 N 期
create index if not exists idx_daily_history_user_query
  on daily_brief_history (user_id, query_key, generated_at desc);

create table if not exists daily_wiki_builds (
  id              text primary key,
  user_id         text not null,
  topic           text not null default '',
  output_format   text not null default 'markdown',
  output_dir      text not null default '',
  documents       int  not null default 0,
  core_documents  int  not null default 0,
  candidate_docs  int  not null default 0,
  topics          int  not null default 0,
  min_quality     int  not null default 60,
  -- 生成的文件相对路径清单 —— 界面"打开目录/下载"要用
  files           jsonb not null default '[]'::jsonb,
  -- 轻量共现图(节点/边) —— 不落全量, 只落摘要计数与实体榜
  graph_summary   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_daily_wiki_user
  on daily_wiki_builds (user_id, created_at desc);
