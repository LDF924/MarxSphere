-- 086_edu_feedback.sql — 教育反馈闭环（2026-08-21）
-- 学生/教师对教育功能使用后的反馈（赞/踩+备注+场景+角色），供教学效果统计与改进驱动
create table if not exists edu_feedback (
  id bigserial primary key,
  student_id text not null default 'anonymous',        -- 匿名化标识（默认 anonymous，不采集个人标识）
  role text not null default 'student' check (role in ('student', 'teacher')),  -- 反馈角色
  scene text not null default 'general',                -- 反馈场景（tutoring/plan/diagnosis/grading/lesson/general）
  feedback integer not null default 0 check (feedback in (1, -1, 0)),           -- +1 赞 / -1 踩 / 0 中性
  note text,                                            -- 可选备注（脱敏后存储，不落日志）
  source text,                                          -- 来源上下文（如辅导知识点、教案标题，脱敏）
  created_at timestamptz not null default now()
);
create index if not exists idx_edu_feedback_created on edu_feedback(created_at);
create index if not exists idx_edu_feedback_scene on edu_feedback(scene, feedback);
