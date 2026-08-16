-- 027_knowledge_page_drafts.sql — 知识沉淀 PR 工作流（BOOK-GAP-ROADMAP P1-7）
-- Proposer(reason)写草稿 → Reviewer(qwen3.7-max异源)审核 → mergeReviewedPage 才入正式表
create table if not exists knowledge_page_drafts (
  id serial primary key,
  title text not null,
  compiled_truth text not null,
  source_hint text,
  tags jsonb default '[]',
  proposer_model text,                -- 起草模型（reason 角色）
  reviewer_model text,                -- 审核模型（qwen3.7-max 异源）
  review_verdict text check (review_verdict in ('approve','revise','reject')),
  evidence_refs jsonb default '[]',   -- 审核引用的证据
  line_feedback jsonb default '[]',   -- 逐行反馈
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected','merged')),
  created_at timestamptz default now(),
  reviewed_at timestamptz
);
create index if not exists idx_knowledge_drafts_status on knowledge_page_drafts(status);
