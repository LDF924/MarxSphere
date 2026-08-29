-- 098_generation_reviews.sql — 产物审查三态机 + 材料分析快照(2026-08-30, 借鉴 TraitTutor needs_review)
-- 核心设计(TraitTutor 对照):
--   1. needs_review 三态机: 质量未过关的生成物可预览/丢弃/确认/重试, 但未确认前不可附加到学习计划、不可评分
--   2. 材料分析快照: 学科/难度/概念候选/页级证据/模态适配 可复用(LLM 失败降级为确定性启发式)
create table if not exists generation_reviews (
  id uuid primary key default gen_random_uuid(),
  student_id text not null default 'default',
  subject text not null,
  goal text not null,
  kind text not null,                    -- courseware | quiz | flashcards | plan | tutoring
  status text not null default 'needs_review' check (status in ('needs_review','confirmed','discarded')),
  content jsonb not null default '{}',   -- 生成产物(预览用)
  issues jsonb not null default '[]',    -- [{dimension, score, note}]
  plan_id uuid references learning_plans(id),   -- 确认后可附加到哪个计划
  confirmed_at timestamptz,
  review_history jsonb not null default '[]',   -- [{action, at, note}]
  created_at timestamptz not null default now()
);
create index if not exists idx_generation_reviews_status on generation_reviews(status, student_id, created_at desc);

-- ─── 材料分析快照 ───
create table if not exists material_analyses (
  id uuid primary key default gen_random_uuid(),
  student_id text not null default 'default',
  title text not null,
  content_hash text not null,
  subject text,
  difficulty text,                       -- basic | intermediate | advanced
  language text,
  confidence numeric,
  concept_candidates jsonb not null default '[]',
  page_evidence jsonb not null default '[]',
  component_affordances jsonb not null default '{}',  -- {visual, audio, worked_example, practice}
  source text not null default 'llm',    -- llm | heuristic
  created_at timestamptz not null default now()
);
create index if not exists idx_material_analyses_student on material_analyses(student_id, created_at desc);
