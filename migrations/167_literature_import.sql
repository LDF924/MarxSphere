-- 167_literature_import.sql — 题录文件导入: 批次台账 + 题录指纹
--
-- 由来(2026-10-01): 旧项目 AIToolman 有 9 个 `read_*_file`
--   (WOS/CNKI/PUBMED/SPRINGER/ARXIV/OPENALEX/SEMANTIC_SCHOLAR/QBYQ/OTHER),
--   本项目此前**只能通过 API 拉文献**(OpenAlex/Crossref/arXiv),
--   用户手里那堆从数据库导出的题录文件(`savedrecs.txt` / `.ris` / `.bib` / 知网导出)
--   没有任何入口能进来。
--
-- ⚠ 为什么**不新建一张平行的文献表**(这是本次最重要的一条判断):
--   平台已有的文献表是 `documents`(001_init + 087/016 的 content_hash 与同项目标题唯一索引),
--   四源检索、写作舱的文献检索臂、引用发现(`citation-discovery-service`)、
--   数据指纹(`eval-fingerprint`)、S3 同步、评测都从它读。再建一张 `papers` 意味着
--   这些消费者一个都不会看到导入进来的文献 —— 用户导了半天, 检索侧一篇都搜不到。
--   所以导入的落点就是 `documents`(与 zotero-service / paper-source-service 同口径)。
--
-- ⚠ 那为什么 still 要加两列? 因为**已有机制判不了题录的三种重复**, 而每一种都真实存在:
--   1) `external_id` 判重是各写入方**自定键**的(paper-source 用 `arxiv-*`/DOI,
--      zotero 用 Zotero key, paper-share 用 `share-<token>`)——
--      同一篇文献从 RIS 与 BibTeX 各导一次, 两边键不同 ⇒ 判重失效, 库里两行;
--   2) 016 的同项目标题唯一索引只在**完全相同**的标题上生效:
--      `A Study of X` 与 `A study of X`、`A Study of X.` 都不同 ⇒ 照样两行;
--   3) 087 的 content_hash 是**正文**哈希 —— 题录没有正文, 大家都是空串, 全库撞成一条。
--   故加 `lit_key`: 归一化后的题录键(`doi:<小写DOI>` 优先, 否则 `title:<去标点小写标题>|<年>`)。
--
-- ⚠ 这一列是**给题录导入专用的**。正文文献(content 非空)的 lit_key 留空不动 ——
--   它们的判重仍走 content_hash / 标题唯一索引那两条既有路, 本次不改动、不回填。
--   空值时唯一索引不生效(Postgres 唯一索引不约束 NULL), 所以存量 504 篇不受影响。
--
-- 幂等: add column if not exists / create table if not exists / create index if not exists。
--   不写 backfill(存量行为空是**正确状态**, 不是待修数据)。

-- ═══ 文献表补题录键 ═══
alter table documents add column if not exists lit_key text;

-- 唯一索引**按项目限定** `(source_id, lit_key)` —— 与 016 的 `(title, source_id)`
--   完全同一个粒度: "同一篇文献在同一个库里只应有一条"。不按全局唯一是因为
--   同一篇文献落在不同项目里是这个平台**本来就允许**的事(各项目各有一份文献库)。
create unique index if not exists documents_lit_key_unique
  on documents (source_id, lit_key) where lit_key is not null;

-- ═══ 导入批次台账 ═══
-- 为什么要有它(而不是只在接口里返回一份统计):
--   ① 用户导一个 2000 条的 `savedrecs.txt`, 想知道"这次到底进来了多少篇" ——
--      只看返回的 imported 数字, 事后无从复核是哪些、跳过了哪些;
--   ② 失败/跳过要能**逐条**定位(errors 是 jsonb 数组, 不是一句"共 N 条失败"),
--      否则用户面对一个坏文件只能靠猜;
--   ③ 同一文件重复上传要能看出"上次是什么时候导的、导了多少"。
--
-- source_id 加外键(项目删了台账跟着删); user_id **不加**外键 ——
--   与 user_files(123) / documents_v2(119) 的口径一致: 本平台多数用户维度的表
--   不挂 users 外键, 以便"未登录/本机"场景也能留痕。
create table if not exists literature_import_batches (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,
  source_id     uuid not null references sources(id) on delete cascade,
  file_name     text not null default '',
  format        text not null default '',            -- 识别出的格式 id(见 literature-formats)
  encoding      text not null default '',            -- utf-8 / gb18030 / utf-16le / 带 BOM …(用户能看到"这份是 GBK")
  raw_bytes     integer not null default 0,
  total         integer not null default 0,          -- 解析出的条数(含重复)
  imported      integer not null default 0,
  skipped       integer not null default 0,          -- 重复(库内已有 / 批内自重复)
  failed        integer not null default 0,
  errors        jsonb not null default '[]'::jsonb,  -- [{row, reason, raw}] 逐条失败原因
  document_ids  jsonb not null default '[]'::jsonb,  -- 真正入库的 documents.id 列表(可回溯)
  created_at    timestamptz not null default now()
);

-- 主查询形状: 某项目/某用户最近的导入历史
create index if not exists idx_lit_import_batches_source
  on literature_import_batches (source_id, created_at desc);
create index if not exists idx_lit_import_batches_user
  on literature_import_batches (user_id, created_at desc);
