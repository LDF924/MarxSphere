-- 091_empirical_data_hash.sql — 实验表格数据哈希（2026-08-26，见 docs/DATA-HASH-VERSIONING-DESIGN.md 对照表 #2）
-- ScienceX "实验表格登记 + SHA-256 版本" 补齐: empirical_data_versions 每次上传登记内容哈希
-- 复用文献场景(content_hash)模式: 同内容重传可判重(stale/重复), 数据变更可感知
-- 幂等写法，可重复执行（与 090/089 同风格）

alter table empirical_data_versions add column if not exists content_hash text;
create index if not exists empirical_data_versions_hash_idx
  on empirical_data_versions(content_hash);
