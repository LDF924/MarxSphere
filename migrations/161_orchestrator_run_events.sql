-- 161_orchestrator_run_events.sql — 编排运行事件流(计划历史浮层的真数据源)
--
-- 由来(2026-09-28, 对齐参考产品截图「计划历史 / PLAN HISTORY」):
--   参考产品的浮层展示的是一条**带时间戳的事件时间线**:
--     job.created / job.started / job.batch_started / node.running / node.child_attached
--     / node.diagnosed / node.failed —— 每条还带"所属节点"和给用户看的中文说明。
--
--   我方原来的 orchestrator_runs.step_log_json **表达不了这个**。它是"每步最后一次状态"
--   的快照, 而且写入方(orchestrator-run-store.ts)是 `on conflict do update` **整行覆盖** ——
--   同一 stepId 的 pending → running → done 三个瞬间, 最终库里只剩最后那个 done。
--   于是"这条线是怎么走到失败的"(先跑了一次、诊断过、再失败)在库里**天生读不出来**。
--   这不是"没渲染", 是**数据不存在**。所以本表不是补一个视图, 是补一条真的事件流。
--
-- 语义:
--   event  事件名, 两个命名空间 —— job.*(整次运行) / node.*(单个节点)
--   node_id 所属节点(stepId); job.* 事件为空串
--   message 给用户看的中文说明(node.failed 的诊断就放这里)
--   seq    同一 run 内自增, 观察端做游标续传用(与 agent_task_events 同款做法)
--
-- ⚠ 只从本迁移之后开始记事件: 历史运行没有事件流, 前端据此显示空态
--   ("暂无执行事件"是**真实答案**, 不要拿 stepLog 反推一串假事件补上)。
--   与参考产品图 13 的空态是同一条判据: 空就显示空。

create table if not exists orchestrator_run_events (
  run_id     text not null,
  seq        bigint not null,
  event      text not null,
  node_id    text not null default '',
  message    text not null default '',
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

-- 浮层按 run 取全量(升序), 这个索引就是它的读路径
create index if not exists idx_orch_run_events_run on orchestrator_run_events (run_id, seq);

-- 保留期清理用(与 agent_task_events 同款: 按时间留最近一段)
create index if not exists idx_orch_run_events_created on orchestrator_run_events (created_at);

comment on table orchestrator_run_events is
  'V416 编排运行事件流(job.*/node.*, 带时间戳与中文说明; 计划历史浮层的数据源)';
comment on column orchestrator_run_events.message is
  '给用户看的中文说明。node.failed 的中文诊断放这里, 不塞原始 e.message 之外的错误码';
