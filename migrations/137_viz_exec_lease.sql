-- 137_viz_exec_lease.sql — 绘图任务的集群级执行租约
--
-- 由来(2026-09-11): viz 的卡死自愈只按 `updated_at < now() - 2 minutes` 判定, 没有任何归属信息。
-- 单机时够用; 多副本下 B 副本一启动就会把 A 正在跑的长绘图任务判成 failed, 而 A 那边跑完还
-- 会把状态写回 done("任务显示失败但产物突然出现")。长任务单次 LLM 调用超 2 分钟就会踩到。
-- 与 review_jobs / agent_tasks 同一套语义: holder + token fencing + TTL 心跳。

alter table if exists viz_jobs add column if not exists exec_lease_holder text;
alter table if exists viz_jobs add column if not exists exec_lease_token int;
alter table if exists viz_jobs add column if not exists exec_lease_until timestamptz;

create index if not exists idx_viz_jobs_lease
  on viz_jobs(exec_lease_until) where exec_lease_holder is not null;
