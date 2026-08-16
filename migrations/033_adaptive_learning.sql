-- 033_adaptive_learning.sql — 自适应学习系统（V384）
-- 学情建模：知识点掌握度 + 答题历史 + 学习记录（驱动自适应推送/节奏/分层）

-- 知识点掌握度（学情建模核心：区分 已掌握/模糊/未掌握）
create table if not exists knowledge_mastery (
  id serial primary key,
  student_id text not null,            -- 学生标识（默认 'default'）
  subject text not null,               -- 科目
  knowledge_point text not null,       -- 知识点
  mastery_level text not null default 'unlearned',  -- mastered|fuzzy|unlearned
  score numeric(4,3) default 0,        -- 0~1 掌握度（平滑更新）
  attempts int default 0,              -- 答题次数
  correct_count int default 0,         -- 答对次数
  last_answer_at timestamptz,          -- 最近作答
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (student_id, subject, knowledge_point)
);
create index if not exists idx_km_student on knowledge_mastery(student_id, subject);

-- 答题历史（学情建模输入）
create table if not exists answer_history (
  id serial primary key,
  student_id text not null,
  subject text not null,
  knowledge_point text not null,
  question text not null,
  user_answer text,
  is_correct boolean not null,
  difficulty text default 'medium',   -- easy|medium|hard
  answered_at timestamptz default now()
);
create index if not exists idx_ah_student on answer_history(student_id, subject, answered_at);

-- 学习节奏记录（节奏适配：难度/时长调整依据）
create table if not exists learning_pace (
  id serial primary key,
  student_id text not null,
  subject text not null,
  session_date date default current_date,
  session_minutes int default 0,
  avg_difficulty text default 'medium',
  points_covered int default 0,        -- 本日覆盖知识点数
  unique (student_id, subject, session_date)
);
