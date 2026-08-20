-- 082_idea_cards.sql — 想法卡（V389，复赛）
-- Hazel 式多想法并行管理：记录原始想法 → 五步打磨 → 每卡独立进度
create table if not exists idea_cards (
  id serial primary key,
  student_id text not null,
  title text not null,               -- 想法标题
  raw_idea text not null,            -- 原始想法/研究问题
  subject text default '政治经济学',
  progress int default 0,            -- 完成度 0-5（校验实际产出）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ic_student on idea_cards(student_id, updated_at desc);
