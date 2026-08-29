-- 096_learner_evidence_ledger.sql — 学习者事件账本 + BKT 参数(2026-08-29, 借鉴 TraitTutor)
-- 核心设计(TraitTutor 对照):
--   1. append-only 事件账本: 掌握度状态可从账本确定性重放重建, 任何行不可原地修改
--   2. 强证据闸门: 只有服务端判分(evidence_strength='strong')且归属可靠的事件才更新 BKT
--   3. 纠错只能追加 void amendment, 原始裁决永远可回放
--   4. BKT 参数版本化: 校准参数带 calibrated 标志, 未校准参数永不显示为精确后验

-- ─── 学习者事件账本(append-only) ───
create table if not exists learner_event_ledger (
  id bigint generated always as identity primary key,
  student_id text not null,
  subject text not null,
  knowledge_point text not null,
  surface_type text not null default 'practice',
  question text not null,
  user_answer text,
  expected_answer text,
  is_correct boolean,
  evidence_strength text not null default 'none',        -- strong | exposure | none
  attribution_status text not null default 'reliable',   -- reliable | pending
  graded_by text not null default 'server',              -- server | client | self
  difficulty text not null default 'medium',
  idempotency_key text not null,
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists uq_learner_event_idem on learner_event_ledger(idempotency_key);
create index if not exists idx_learner_event_replay on learner_event_ledger(student_id, subject, knowledge_point, answered_at, id);
-- 防止行内修改(append-only 强制: update 无 where 的整表改除外)
create or replace function prevent_learner_event_update() returns trigger as $$
begin
  raise exception 'learner_event_ledger is append-only';
end; $$ language plpgsql;
drop trigger if exists trg_learner_event_append_only on learner_event_ledger;
create trigger trg_learner_event_append_only before update on learner_event_ledger
  for each row execute function prevent_learner_event_update();

-- ─── 纠错账本(void amendment) ───
create table if not exists learner_event_amendments (
  id bigint generated always as identity primary key,
  event_id bigint not null references learner_event_ledger(id) on delete cascade,
  action text not null default 'void' check (action = 'void'),
  reason text not null check (reason in ('grading_error','item_invalid','attribution_error','duplicate_evidence','privacy_request')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_learner_amendment_event on learner_event_amendments(event_id);

-- ─── BKT 参数(版本化) ───
create table if not exists bkt_parameters (
  version text primary key,
  transition numeric not null check (transition > 0 and transition <= 0.5),
  guess numeric not null check (guess >= 0 and guess < 0.5),
  slip numeric not null check (slip >= 0 and slip < 0.5),
  prior numeric not null check (prior > 0 and prior < 1),
  calibrated boolean not null default false,
  log_loss numeric,
  observations int,
  created_at timestamptz not null default now()
);

-- 种子: 未校准回退参数(与 TraitTutor UNCALIBRATED_FALLBACK_PARAMS 对齐)
insert into bkt_parameters (version, transition, guess, slip, prior, calibrated)
values ('v1-uncalibrated', 0.12, 0.2, 0.1, 0.2, false)
on conflict (version) do nothing;
