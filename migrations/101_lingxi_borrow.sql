-- 101_lingxi_borrow.sql — 借鉴 LingxiLearn 三项(V396, 2026-08-30)
-- 1. verification_debt(验证债务): 强帮助后记账, 推迟到自然检查点, 独立正确还债
-- 2. 证据内容寻址 digest: 同观察重复追加自动坍缩(sha256 摘要即去重键)
-- 3. 复习优先级单尺子: 逾期/薄弱/不确定加权(0.45/0.35/0.20)
alter table review_queue add column if not exists verification_debt boolean not null default false;
alter table review_queue add column if not exists debt_reason text;
alter table review_queue add column if not exists review_priority numeric not null default 0;
alter table review_queue add column if not exists stability numeric not null default 0;

-- 内容寻址: learner_event_ledger 加 evidence_digest(同观察重复追加坍缩)
alter table learner_event_ledger add column if not exists evidence_digest text;
create unique index if not exists uq_learner_event_digest on learner_event_ledger(evidence_digest) where evidence_digest is not null;
