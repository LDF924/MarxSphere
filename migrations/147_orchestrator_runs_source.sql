-- 147_orchestrator_runs_source.sql — V415: 编排运行记录记住"谁发起的"
--
-- 起因: 恢复一次暂停的运行要靠 orchestrator_runs 里的图重建执行计划, 而执行角色(manager/ui
-- vs analyst/agent)是**权限位**, 必须跟着落库 —— 否则 UI 上画的图跑一半暂停、恢复之后
-- 就降成 analyst, 里面的写类工具(file_write / run_code / sag_ingest)全部报"需要 manager 角色"。
-- 反方向同样危险: 若恢复时统一按 manager 起, Agent 触发的运行就会被越权放大。
--
-- 缺省 'ui': 本列之前的所有运行都是画布上人工发起的。

alter table orchestrator_runs
  add column if not exists source text not null default 'ui';

comment on column orchestrator_runs.source is
  'V415: 发起来源 ui(用户画布点击, 工具按 manager 执行) | agent(外部 Agent 经 orch_run, 按 analyst 执行)';
