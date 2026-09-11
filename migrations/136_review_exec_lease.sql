-- 136_review_exec_lease.sql — 审稿执行的集群级租约 + 全局并发槽位
--
-- 由来(2026-09-11): 并发闸原来是进程内状态(running Set / 内存队列), 单机够用, 但有两类问题:
--   1) 同一任务开两条 SSE(两个标签页、或刷新后旧连接未断)会让同一份稿子被完整审两遍
--      —— 实测两条流各跑满全程, LLM 调用与入库事件全部翻倍;
--   2) 多实例后每个副本各自算并发, 上限形同虚设。
-- 与 agent-task-queue 的 exec_lease_* 同款语义(holder 标识实例 + token fencing + TTL 兜底),
-- 额外加了全局槽位表: 并发上限必须是集群级的, 不能各实例各算。
--
-- 用法: 执行前 update ... where (holder 为空 or 已过期 or 是自己) → 抢到才跑; 运行期 30s 心跳续期;
--   实例崩溃不再续期 → TTL 到期后别的实例可接管; token 变化使旧持有者的释放/续期失效(fencing)。

alter table if exists review_jobs add column if not exists exec_lease_holder text;
alter table if exists review_jobs add column if not exists exec_lease_token int;
alter table if exists review_jobs add column if not exists exec_lease_until timestamptz;

create index if not exists idx_review_jobs_lease
  on review_jobs(exec_lease_until) where exec_lease_holder is not null;

-- 全局并发槽位: 行数 = 集群允许同时执行的审稿数(默认 4, 启动时按 REVIEW_CONCURRENCY 补齐)
create table if not exists review_exec_slots (
  slot        int primary key check (slot > 0),
  job_id      uuid,
  holder      text,
  acquired_at timestamptz
);
insert into review_exec_slots (slot) select generate_series(1, 4) on conflict (slot) do nothing;
