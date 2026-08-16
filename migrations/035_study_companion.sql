-- 035_study_companion.sql — 学习陪伴 Agent（V388）
-- 日/周学习计划 + 进度跟踪 + 复盘记录（情感+任务双驱动）

-- 学习计划（日/周，定时提醒+进度跟踪）
create table if not exists study_plans (
  id serial primary key,
  student_id text not null default 'default',
  plan_type text not null,              -- daily|weekly
  period_start date not null,           -- 计划起始日
  period_end date not null,             -- 计划结束日
  title text not null,
  items jsonb not null default '[]',    -- [{task, time, duration, status}]
  progress numeric(4,3) default 0,      -- 0~1 完成度
  status text default 'active',         -- active|done|expired
  reminder_at timestamptz,              -- 定时提醒时间
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sp_student on study_plans(student_id, status, period_start);

-- 学习复盘（每日/每周）
create table if not exists study_reviews (
  id serial primary key,
  student_id text not null default 'default',
  review_type text not null,            -- daily|weekly
  review_date date not null,
  summary text,                         -- 复盘总结
  achievements text[],                  -- 收获
  improvements text[],                  -- 待改进
  mood text,                            -- 情绪记录
  created_at timestamptz default now(),
  unique (student_id, review_type, review_date)
);
