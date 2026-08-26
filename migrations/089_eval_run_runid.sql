-- 089_eval_run_runid.sql — 评测 Run 唯一标识（2026-08-26，见 docs/DATA-HASH-VERSIONING-DESIGN.md 3.5）
-- eval-runner.ts 每次 /api/eval/run 生成 evalRunId(如 eval-1750245612345-abc123), 传入子进程 runId
-- 加 eval_run_id 列 + 唯一约束 → 快照写入用 insert ... on conflict(eval_run_id) do update
-- 实现"重复评测更新同一条记录"（幂等）, 而非每次插新行
-- 注意: 用普通唯一约束而非部分唯一索引 — ON CONFLICT arbiter 推断不支持部分索引(42P10)
--       PostgreSQL 唯一约束默认 NULLS DISTINCT → agent 评测(不写 eval_run_id, 保持 null)多行互不冲突
-- 幂等写法，可重复执行（与 088/087 同风格）

alter table agent_eval_runs add column if not exists eval_run_id text;
-- 老索引(若有)与约束重复, 删除; 部分索引无法作 ON CONFLICT arbiter, 统一换成唯一约束
drop index if exists agent_eval_runs_runid_idx;
alter table agent_eval_runs
  drop constraint if exists agent_eval_runs_runid_key;
alter table agent_eval_runs
  add constraint agent_eval_runs_runid_key unique (eval_run_id);
