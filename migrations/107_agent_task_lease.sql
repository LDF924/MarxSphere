-- 107_agent_task_lease.sql — V405 OpenSquilla 移植 P2: agent_tasks 执行租约(跨进程防双跑)
-- 语义(对齐 WriterLease holder+fencing 模式, 原子 SQL 无中间态):
--   exec_lease_holder: 当前执行者标识(实例 id + pid, 如 "host-abc:1234")
--   exec_lease_token:  fencing — 每次易主递增, 旧持有者的续租/释放被拒(防旧进程复活误写)
--   exec_lease_until:  过期时间 — 持有者心跳续期; 过期后他人可抢(断线任务自动放弃)
-- 兼容: 老任务三列为 null → 任何人可抢(租约不影响旧路径); 不迁移历史数据
alter table agent_tasks add column if not exists exec_lease_holder text;
alter table agent_tasks add column if not exists exec_lease_token bigint;
alter table agent_tasks add column if not exists exec_lease_until timestamptz;
create index if not exists idx_agent_tasks_lease on agent_tasks (exec_lease_until) where exec_lease_holder is not null;
