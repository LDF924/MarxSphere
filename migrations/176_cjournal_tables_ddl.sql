-- 176_cjournal_tables_ddl.sql — 补回 3 张**只存在于运行库、没有任何迁移**的表
--
-- ═══ 这是本次最重要的一个修复, 比任何新功能都重要 ═══
--
-- 2026-10-02 实测发现: 代码在读写 `cjournal_journals` / `cjournal_journal_updates` /
--   `cjournal_method_systems`, 但**整个 migrations/ 目录里没有它们的 CREATE TABLE**。
--   它们的 DDL 只存在于开发机的运行库与备份里, 是建库当时手工执行、或从别处
--   restore 进来的 —— 从来没有进过版本控制。
--
-- 后果(这才是为什么必须补):
--   · `npm run db:setup` 在**全新环境**跑完, 库是"半成品": 那几张表不存在;
--   · 于是 /api/cjournal/journals、期刊同步管道(journal-sync-service)、
--     cjournal-service 的读写**全部会抛 relation does not exist**;
--   · CI 碰不到, 因为 CI 虽然起了 PG 却从不迁移, 且碰库的单测都把 pool mock 掉了
--     (见 memory: ci-vs-local-env-differences 第 ⑧ 条) —— 空库看不出来;
--   · 灾难恢复时更糟: 恢复出来的是一个比备份旧一截的 schema, 且**没有任何报错**,
--     只有那几个接口 500。
--
-- 判断依据不是"猜", 是**从运行库 information_schema 导出的实际形状**(列/类型/
--   默认值/可空性/索引/外键逐项对齐), 下面的 DDL 与运行库已有定义**完全等价**。
--   写 `if not exists` 所以对已存在的库是 no-op, 对新库才真正建表。
--   期刊库要用的检索字段(field/language/pinyin/abbr)在 177 迁移里加 —— 不放在这里,
--   因为它必须对**存量库与新库都生效**, 而存量库走到本文件时表已存在、整段被跳过。
--
-- ⚠ 为什么不是"删掉运行库的表让迁移重建": 那 4546 行期刊动态是真实抓取数据(46 天),
--   删了不可恢复。补 DDL 才是无损路径。
--
-- 幂等: create table if not exists / create index if not exists。

-- ═══ 1. 期刊库(80 本马理论期刊) ═══
create table if not exists cjournal_journals (
  id                text primary key,
  name              text not null,
  level             text not null default '南核',   -- 南核 / 北核 / C扩 / 其他
  org               text,                            -- 主办单位
  topic_tags        text[] default '{}'::text[],     -- 选题标签(用于热点匹配)
  style             text,                            -- 用稿偏好/风格描述
  official_site     text,
  updated_at        timestamptz not null default now(),
  last_sync_status  text default 'pending'           -- pending / ok / failed(期刊同步管道写)
);

-- ═══ 2. 期刊动态(目录/热点/趋势/征稿, 由 journal-sync-service 从公众号抓) ═══
create table if not exists cjournal_journal_updates (
  -- 与运行库一致用 serial(而不是 identity): 环境里已有 cjournal_journal_updates_id_seq,
  -- 换成 identity 会在已存在的库上产生第二套自增机制。
  id          serial primary key,
  journal_id  text not null references cjournal_journals(id) on delete cascade,
  -- hotspot 是**纯标签**(「政治经济学」「经济热点」), 不是可读条目 ——
  -- 速递查询必须排除它(见 digest/sources.ts 的三条约束)
  kind        text not null default 'hotspot',       -- hotspot / issue / trend / cfp
  title       text not null,
  -- ⚠ content 实测只有 15~23 字符, 固定是「来源: 微信公众号(搜狗搜索)」这条来源注记,
  --   **不是正文**。当成摘要展示会在卡片上出现"摘要: 来源: 微信公众号"。
  content     text,
  source_url  text,
  found_at    timestamptz not null default now()
);
create index if not exists idx_journal_updates_jid on cjournal_journal_updates (journal_id, found_at desc);

-- ═══ 3. 学者方法系统(7特征/5思路/生产系统/5告诫) ═══
create table if not exists cjournal_method_systems (
  id                text primary key,
  name              text not null,
  features          jsonb not null default '[]'::jsonb,
  ideas             jsonb not null default '[]'::jsonb,
  production_chain  jsonb not null default '[]'::jsonb,
  warnings          jsonb not null default '[]'::jsonb,
  builtin           boolean not null default false,
  created_at        timestamptz not null default now()
);
