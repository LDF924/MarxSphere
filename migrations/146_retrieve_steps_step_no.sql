-- 146_retrieve_steps_step_no.sql — 给推理步骤加"逻辑步号"
--
-- 由来(2026-09-13): 前端「52 步推理链路」拿静态步骤数组的**下标**去对 retrieve_steps 的第 N 条
--   (`detail.retrieveSteps?.[index]`), 但后端落库顺序是 outline → stage2_* → stage3_* → …,
--   且 stage2/stage3 是在循环里按检索路径写的 —— 下标和逻辑步号根本对不上,
--   于是界面把 "1. 问题分类" 对到了 "stage2_pgChunks", 步骤名全错。
--
-- 修法: 落库时带上逻辑步号(1..52, 对齐前端 REASON_52_STEPS), 前端按步号对齐而非下标。
--   没跑到的步号(条件触发未命中)不写行, 前端显示"未触发"灰态。
--
-- 可空: 历史数据没有步号(它们本来就是错位的), 前端对 null 不做对齐, 保持灰态。

alter table retrieve_steps add column if not exists step_no int;

comment on column retrieve_steps.step_no is
  '逻辑步号(1..52, 对齐前端 REASON_52_STEPS); null = 历史数据或未映射的内部步骤';

-- 前端按 task_id 取全量步骤后按 step_no 对齐, 这个索引让"某任务的步骤"稳定有序取出
create index if not exists idx_retrieve_steps_task_step
  on retrieve_steps(task_id, step_no);
