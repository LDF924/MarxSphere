-- 100_review_queue.sql — 间隔重复复习队列(2026-08-30, 借鉴 TraitTutor learning/scheduler.py)
-- 核心设计(TraitTutor 对照):
--   1. 按知识类型间隔序列: MEMORY[0,1,3,7,14,30,60] / PROCEDURE[0,1,3,7,14] / CONCEPT[3,7,14,30] / DESIGN[7,14,30,60]
--   2. 档位推进: 答对连中 2 次跳 2 档, 答错退 1 档, 连错 2 次重置
--   3. 错误未修复的知识点优先级最高; 与事件账本联动(强证据驱动)
create table if not exists review_queue (
  id uuid primary key default gen_random_uuid(),
  student_id text not null default 'default',
  subject text not null,
  knowledge_point text not null,
  knowledge_type text not null default 'concept',   -- memory | procedure | concept | design
  interval_idx int not null default 0,              -- 当前所在间隔序列档位
  consecutive_correct int not null default 0,
  consecutive_wrong int not null default 0,
  due_at timestamptz not null default now(),        -- 下次复习时间
  last_result boolean,
  needs_repair boolean not null default false,      -- 最近答错未修复(优先复习)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_review_queue on review_queue(student_id, subject, knowledge_point);
create index if not exists idx_review_queue_due on review_queue(student_id, due_at);
