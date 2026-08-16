-- 024_eval_failures_layer.sql — 三层验证 layer 列（BOOK-GAP-ROADMAP P1-6）
-- 结果(result)/过程(process)/质量(quality) 三层分离, 评测报告分层呈现
alter table eval_failures add column if not exists layer text check (layer in ('result','process','quality'));
