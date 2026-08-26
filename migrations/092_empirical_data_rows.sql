-- 092_empirical_data_rows.sql — 数据版本存数据本体（2026-08-27）
-- 根因: empirical_data_versions 只存 columns/n_rows/meta, 不存数据行 → 选了数据版本下游拿到 rows=[] 无数据可用
-- 修复: 加 data jsonb 列存数据行, 下游(变量敲定/管道/回归/信效度)读取时用真数据
-- 幂等写法，可重复执行

alter table empirical_data_versions add column if not exists data jsonb;
