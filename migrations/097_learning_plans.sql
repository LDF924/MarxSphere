-- 097_learning_plans.sql — 版本化学习计划链(2026-08-29, 借鉴 TraitTutor LearningComponentPlan)
-- 核心设计(TraitTutor 对照):
--   1. 计划版本化 + supersede 链: 重规划不覆盖旧计划, 旧计划置 superseded 保留审计
--   2. 只重规划未开始的尾部: 已开始组件前缀不可变(历史证据), 新计划只重建 pending 尾部
--   3. 证据引用: 每步计划携带 evidence_refs(关联知识点/事件), 可溯源
create table if not exists learning_plans (
  id uuid primary key default gen_random_uuid(),
  student_id text not null default 'default',
  subject text not null,
  goal text not null,
  version int not null default 1,
  status text not null default 'active' check (status in ('active','completed','superseded')),
  supersedes_plan_id uuid references learning_plans(id),
  components jsonb not null default '[]',          -- [{id,title,type,concept_refs,evidence_refs,status,reason}]
  rationale jsonb,                                  -- {adaptation, knowledgeGap}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_learning_plans_student on learning_plans(student_id, subject, created_at desc);
