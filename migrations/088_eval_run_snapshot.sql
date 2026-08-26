-- 088_eval_run_snapshot.sql — 评测 Run 参数/环境快照（2026-08-26，见 docs/DATA-HASH-VERSIONING-DESIGN.md 3.5）
-- 追加两列（照抄 ScienceX analysis_runs.parameters_json/environment_json 思路）:
--   parameters_json — 评测参数（EVAL_QUESTIONS/EVAL_OUTPUT/EVAL_DIMS/EVAL_MERGE_POLICY/EVAL_JUDGE_MODEL 等）
--   environment_json — 运行环境（node 版本/tsx 版本/dataFingerprint 等）
-- 幂等写法，可重复执行（与 087/086/085 同风格）

alter table agent_eval_runs add column if not exists parameters_json jsonb not null default '{}';
alter table agent_eval_runs add column if not exists environment_json jsonb not null default '{}';
