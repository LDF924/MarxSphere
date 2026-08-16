-- 020_user_feedback.sql — 用户反馈闭环（2026-08-07）
-- 点赞/点踩 → 更新 task_experience.success 权重 + 经验排序

alter table task_experience add column if not exists user_feedback integer default 0;  -- +1 赞 / -1 踩
alter table task_experience add column if not exists feedback_at timestamptz;
