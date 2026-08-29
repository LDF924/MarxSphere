-- 099_memory_preferences.sql — Compass 记忆治理(2026-08-30, 借鉴 TraitTutor Reflection/Compass)
-- 核心设计(TraitTutor 对照):
--   1. 偏好三态: explicit(用户确认, 永久有效) / inferred(推断, 90天TTL) / rejected(反偏好, 作约束)
--   2. 候选→确认门: 推断内容默认 candidate, 需用户确认或 ≥2 条独立证据才激活
--   3. 边界声明随数据走: 偏好只调整教学策略, 绝不诊断能力(与 BKT 证据隔离)
create table if not exists memory_preferences (
  id uuid primary key default gen_random_uuid(),
  student_id text not null default 'default',
  scope text not null default 'global' check (scope in ('global','subject')),
  subject text,
  key text not null,                       -- 如 preference:pace / preference:feedback_style
  value text not null,
  state text not null default 'inferred' check (state in ('explicit','inferred','rejected')),
  confidence numeric not null default 0.7,
  evidence_count int not null default 0,   -- 独立证据数(≥2 或用户确认 → 可进 compass)
  evidence_refs jsonb not null default '[]',
  source text not null default 'inference', -- inference | user_confirmed | user_rejected | chat_correction
  expires_at timestamptz,                  -- 推断 90 天 TTL; explicit 永不失效
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_memory_pref on memory_preferences(student_id, scope, coalesce(subject,''), key);
create index if not exists idx_memory_pref_active on memory_preferences(student_id, state, expires_at);
