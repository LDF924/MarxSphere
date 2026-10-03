-- 182_web_archive.sql — 网页归档: URL 快照 + 段落级定位(2026-10-03)
--
-- 由来(对照开源项目 观澜/Guanlan 的 archive, MIT): 本仓此前**没有任何网页快照能力**。
--   已有的三种"版本"都不是它:
--     · doc2_versions       —— 编辑器里**我们自己的文档**的版本
--     · ppt_page_versions   —— PPT 页面的版本
--     · git snapshots       —— 工作区代码的快照
--   而"某个外部网页在当时是什么样、后来改了什么"这个问题, 全仓没有一处能回答。
--   对政策/舆情/竞品页面这是刚需: 政策文件会改, 新闻会撤稿, 榜单会重排。
--
-- ═══ 设计要点 ═══
--   ① **同一 URL 的多次抓取是"快照序列"**, 不是"覆盖"。content_hash 相同就不新增 ——
--      避免定时抓取把同一份内容存成几百条(观澜的 `unchanged` 也是这个语义)。
--   ② **段落级定位**: 存正文时切段, 每段记 offset。这样"某句话是哪一版、哪一段"
--      可以精确回答, 而不是只能整页对比。
--   ③ 归档要能**联动资料库**: 导出的 Markdown 落到 vault 白名单目录下,
--      于是它自动出现在资料库树里、可被检索、可被写作舱当素材引用。

create table if not exists web_archives (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  url           text not null,
  -- 归一化后的 URL(去 fragment、去常见追踪参数) —— 同一篇文章的不同分享链接要归到一条
  url_key       text not null,
  title         text not null default '',
  -- 首次见到与最近一次快照
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  snapshot_count integer not null default 0,
  -- 归属课题(可选): 与资料库/写作舱的课题概念对齐
  project_id    uuid,
  tags          jsonb not null default '[]'::jsonb
);

-- 一个用户的同一个 URL 只有一条主记录
create unique index if not exists web_archives_user_url_uniq on web_archives (user_id, url_key);
create index if not exists web_archives_user_idx on web_archives (user_id, last_seen_at desc);

create table if not exists web_snapshots (
  id             uuid primary key default gen_random_uuid(),
  archive_id     uuid not null references web_archives(id) on delete cascade,
  -- 内容的 sha256 —— 判"变了没有"只看它, 不看抓取时间
  content_hash   text not null,
  title          text not null default '',
  markdown       text not null,
  -- 质量报告(web-read-service 的 ReadQuality 原样落库) —— 事后能回答
  -- "这条证据当时抽得干不干净", 而不是只有一份不明来源的文本
  quality        jsonb not null default '{}'::jsonb,
  /** 这份快照是怎么来的: fetch(直连抓) / manual(人工导入) / jina(第三方 reader) */
  via            text not null default 'fetch',
  http_status    integer,
  fetched_at     timestamptz not null default now()
);

create index if not exists web_snapshots_archive_idx on web_snapshots (archive_id, fetched_at desc);
-- 同一档同一内容只存一份
create unique index if not exists web_snapshots_hash_uniq on web_snapshots (archive_id, content_hash);

/**
 * 段落表 —— 段落级定位就靠它。
 *
 * ⚠ 不存 markdown 全文的副本: `text` 是那一段的内容, offset 是它在当次 markdown 里的位置。
 *   快照的 markdown 本身在 web_snapshots.markdown 里, 这里只做"可检索的切片"。
 *   这样"某句话在哪一版的第几段"可以一次查询答出来。
 */
create table if not exists web_passages (
  id           uuid primary key default gen_random_uuid(),
  snapshot_id  uuid not null references web_snapshots(id) on delete cascade,
  /** 段落在该快照 markdown 里的字符偏移(起) —— 与 doc_anchors 同一口径 */
  start_offset integer not null default 0,
  ord          integer not null default 0,
  text         text not null
);

create index if not exists web_passages_snapshot_idx on web_passages (snapshot_id, ord);
-- 按内容找段落(定位"这句话出自哪一份快照")
create index if not exists web_passages_text_trgm on web_passages using gin (text gin_trgm_ops);

comment on table web_archives is '网页归档主记录: 一个用户一个归一 URL 一条, 含快照序列';
comment on table web_snapshots is '网页快照: content_hash 相同不重复存, quality 是抓取时的质量报告';
comment on table web_passages is '快照的段落切片, 支持"这句话出自哪一版哪一段"的定位';
