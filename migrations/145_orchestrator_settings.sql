-- 145_orchestrator_settings.sql — V415: 编排器设置(用户可切, 前端可见)
--
-- 由来(2026-09-13 用户要求): "Agent 能不能触发编排"这个开关必须**前端用户看得见**。
--   只在 .env 里配的话, 用户不知道它开没开、也不知道对话为什么有时能编排有时不能。
--   所以状态存这里(用户可改), 环境变量 ORCH_AGENT_ENABLED 只作为总闸与初始默认:
--   env 未开时前端只能看到"被部署方禁用", 不允许用户自己打开。
--
-- 语义(当前只有一个 key: orchestrator:agent_enabled):
--   value_json = { enabled: boolean, maxNodes: number, requireConfirm: boolean }
--   maxNodes 防"一句话烧掉整月额度"; requireConfirm 打开时 Agent 提议的编排要用户点确认才跑。
--
-- 幂等: create table if not exists(不预置行 —— 无行 = 用 env 默认)

create table if not exists orchestrator_settings (
  key text primary key,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table orchestrator_settings is 'V415 编排器用户级设置(Agent 编排开关等; env 为总闸与默认值)';
