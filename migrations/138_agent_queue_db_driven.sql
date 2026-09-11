-- 138_agent_queue_db_driven.sql — agent 任务队列改成 DB 驱动(可跨实例接手)
--
-- 由来(2026-09-11 多实例审计): agent_task_queue 原来只存 (task_id, priority), 真正的执行闭包
-- `run: () => runAgentTaskInner(...)` 只活在**接到那次 POST 的副本内存**里。后果:
--   ① 副本被缩容/重启 → 它内存里的任务永远没人接手, 一直停在 planning(要等 24h 才被清理);
--   ② 启动恢复里 `delete from agent_task_queue`(无 where)会把**其他副本**的队列条目一并删掉。
--
-- 改法: 队列条目自带"怎么执行"(runner 类型 + 参数), 任何实例都能用 `for update skip locked`
-- 领取并重建执行闭包。

alter table if exists agent_task_queue add column if not exists runner text not null default 'agent-task';
alter table if exists agent_task_queue add column if not exists payload jsonb not null default '{}'::jsonb;
alter table if exists agent_task_queue add column if not exists
  exec_holder text;                                  -- 领取者(实例#序号)
alter table if exists agent_task_queue add column if not exists
  exec_until timestamptz;                            -- 领取租约到期(崩溃后可由他人接手)
alter table if exists agent_task_queue add column if not exists
  attempts int not null default 0;                   -- 已领取次数(防毒任务无限重试)

create index if not exists idx_agent_task_queue_claim
  on agent_task_queue(priority desc, enqueued_at asc);
