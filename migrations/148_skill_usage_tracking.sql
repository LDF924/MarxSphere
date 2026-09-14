-- 148_skill_usage_tracking.sql
-- V417: 技能"越用越熟"闭环 —— 记录技能被**召回/采用/验证**的痕迹。
--
-- 由来（2026-09-14 用户问"有没有一套天天在更新、越用越熟的 skill"）：
--   实测 agent_skills 里 144 条技能，consensus 全是 2 —— 那不是"用了 2 次"，而是
--   **2 个 LLM 校验器放行**（见 agent-skill-distill.validateSkill 的语义）。
--   技能一旦入库就没有任何使用痕迹：source_tasks 全是单元素数组，
--   也没有"最近使用"时间。于是"反复遇到同类任务→技能沉淀得更熟"这条链是断的。
--
--   注意 consensus **保持原义不动**（校验票数）—— 往它里面塞使用次数会让已有数据
--   变成两种含义混在一起。使用情况另开列 / 另开流水表。
--
-- 幂等: 可重复执行。

alter table agent_skills
  add column if not exists use_count      integer      not null default 0,
  add column if not exists success_count  integer      not null default 0,
  add column if not exists last_used_at   timestamptz,
  add column if not exists last_used_by   text;          -- 'recall' | 'agent' | 'manual'

comment on column agent_skills.use_count     is '被召回并注入到任务上下文的次数（使用热度）';
comment on column agent_skills.success_count is '其中任务成功完成的次数（效果，与 use_count 比即成功率）';
comment on column agent_skills.consensus     is 'LLM 校验器通过票数（**不是**使用次数，见 148 头注释）';

-- 每条使用痕迹留档, 便于回溯"某技能何时被哪类任务用上"
create table if not exists skill_usage_events (
  id          bigserial primary key,
  skill_id    integer not null references agent_skills(id) on delete cascade,
  task_id     text,
  goal        text,
  source      text not null,          -- recall | agent | manual
  outcome     text,                   -- null=仅召回未知结果 | done | failed
  created_at  timestamptz not null default now()
);

create index if not exists idx_skill_usage_skill  on skill_usage_events (skill_id, created_at desc);
create index if not exists idx_skill_usage_task   on skill_usage_events (task_id);

-- 技能热度查询(运营面板/召回排序用): 只用有使用记录的行
create index if not exists idx_agent_skills_hot on agent_skills (status, use_count desc, last_used_at desc nulls last);
