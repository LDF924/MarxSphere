-- universe 时间线计数轴索引: source 内按 created_at desc 排序 + 游标定位
-- (created_at, id) 复合支持行值比较 <(created_at, id) 与 newest/oldest 边界查询
create index if not exists events_source_time_idx
  on events (source_id, created_at desc, id desc)
  where deleted_at is null;
