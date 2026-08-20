-- 081_study_records.sql — 学习记录表（V389，复赛）
-- 阅读与语言学习 Agent 的学习记录（reading/writing/vocab 活动落库）
create table if not exists study_records (
  id serial primary key,
  student_id text not null,
  activity text not null,               -- reading|writing|vocab
  subject text not null,
  topic text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sr_student on study_records(student_id, subject, created_at);
