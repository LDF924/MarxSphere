-- 141_scheduler_leases.sql — 定时任务的跨副本租约(同一轮只由一个副本执行)
--
-- 由来(2026-09-11 上云审计): 期刊同步(6h)/主动研究(24h)/Dream(24h)/agent 评测(24h)/
-- 审批超时巡检(30min) 都是每副本各起一个定时器 → 多副本下同一批数据被处理 N 遍,
-- 重复写库、重复烧 LLM; 期刊同步还会 N 倍抓取外部站点(历史上已因高频被抓触发过风控)。
--
-- 语义: 任务名主键 + 持有者 + 到期时间。抢不到(未过期)就跳过本轮;
-- 持有者崩溃 → 到期后下一个副本自然接手, 无需故障转移逻辑。

create table if not exists scheduler_leases (
  name       text primary key,          -- 任务名, 如 journal-sync / dream-daily
  holder     text not null,             -- 持有者(hostname#pid)
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_scheduler_leases_expires on scheduler_leases(expires_at);
