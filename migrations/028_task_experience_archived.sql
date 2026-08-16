-- 028_task_experience_archived.sql — 睡眠学习修剪（BOOK-GAP-ROADMAP P1-8）
-- 记忆只写不修剪 = 上下文腐化; 归档标记代替物理删除, 检索默认过滤
alter table task_experience add column if not exists archived boolean default false;
alter table task_experience add column if not exists conflict_unsolved boolean default false;
alter table task_experience add column if not exists last_used_at timestamptz default now();
