-- 034_homework_help.sql — 作业辅导系统（V385）
-- 错题归集 + 知识点溯源（驱动变式题生成与巩固）

-- 错题本（自动归集错题，溯源知识点，生成变式题依据）
create table if not exists wrong_questions (
  id serial primary key,
  student_id text not null default 'default',
  subject text not null,
  knowledge_point text not null,       -- 溯源知识点
  question text not null,              -- 原题
  user_answer text,
  correct_answer text,                 -- 正确答案/解析
  mistake_type text default 'unknown', -- 概念不清|方法不熟|计算失误|审题偏差|unknown
  difficulty text default 'medium',
  variant_count int default 0,         -- 已生成变式题数
  mastered boolean default false,      -- 是否已掌握（变式题答对后标记）
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_wq_student on wrong_questions(student_id, subject, mastered);

-- 变式题记录（巩固练习）
create table if not exists variant_questions (
  id serial primary key,
  wrong_question_id int references wrong_questions(id) on delete cascade,
  student_id text not null,
  subject text not null,
  knowledge_point text not null,
  variant_question text not null,
  variant_answer text,
  is_correct boolean,                  -- 学生作答是否正确
  created_at timestamptz default now()
);
