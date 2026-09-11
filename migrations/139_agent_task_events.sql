-- 139_agent_task_events.sql — agent 任务进度事件落库(跨实例可回放)
--
-- 由来(2026-09-11 多实例审计): 进度事件只存在**执行者进程内存**的环形缓冲里。
-- 用户连到另一个副本时, 缓冲是空的 → 只收到 snapshot + 心跳, 零事件、永不 done,
-- 而前端没有轮询兜底 → UI 永久卡在"运行中"(连接是健康的, onerror 不触发)。
-- 与 viz 的 viz_job_events 同款做法: 事件表 + seq 游标回放, 观察者与执行者解耦。

create table if not exists agent_task_events (
  task_id  uuid not null,
  seq      bigint not null,
  event    text not null,
  payload  jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (task_id, seq)
);

create index if not exists idx_agent_task_events_task on agent_task_events(task_id, seq);

-- 保留期清理用(只保留最近 3 天; 由定时任务删)
create index if not exists idx_agent_task_events_created on agent_task_events(created_at);
