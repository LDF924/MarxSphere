-- 080_knowledge_graph_edu.sql — 教育知识点先修图（复赛冲刺期）
-- 知识点节点 + 先修/关联边（驱动：先修缺失检测 + 拓扑路径规划）
-- 与既有学习表（knowledge_mastery / answer_history / wrong_questions）配合使用

-- 知识点节点
create table if not exists kp_points (
  id serial primary key,
  name text not null,                 -- 知识点名称
  subject text not null,              -- 科目
  level text not null default 'basic', -- basic|intermediate|advanced
  description text,                   -- 知识点说明（可选）
  unique (subject, name)
);
create index if not exists idx_kpp_subject on kp_points(subject);

-- 知识点边（先修/关联）
create table if not exists kp_edges (
  id serial primary key,
  subject text not null,
  from_point text not null,           -- 前置知识点
  to_point text not null,             -- 目标知识点
  edge_type text not null default 'prerequisite',  -- prerequisite|related
  unique (subject, from_point, to_point, edge_type)
);
create index if not exists idx_kpe_to on kp_edges(subject, to_point);

-- 种子数据：马理论/政治经济学常用知识点先修关系（示例课程《政治经济学批判》导言、价值规律）
insert into kp_points (name, subject, level, description) values
  ('商品', '政治经济学', 'basic', '商品二因素：使用价值与价值'),
  ('劳动二重性', '政治经济学', 'basic', '具体劳动与抽象劳动'),
  ('价值', '政治经济学', 'basic', '价值实体、价值量'),
  ('价值规律', '政治经济学', 'intermediate', '价值决定价格、供求调节'),
  ('剩余价值', '政治经济学', 'intermediate', '剩余价值的生产与来源'),
  ('资本主义基本矛盾', '政治经济学', 'advanced', '生产社会化与生产资料私有制'),
  ('一元一次方程', '数学', 'basic', '含一个未知数的一次方程'),
  ('因式分解', '数学', 'basic', '多项式分解为因式乘积'),
  ('配方法', '数学', 'intermediate', '完全平方配方求解二次方程'),
  ('二次方程', '数学', 'intermediate', '一元二次方程的标准解法'),
  ('价值规律作用', '政治经济学', 'advanced', '调节生产、促进竞争、优胜劣汰')
on conflict (subject, name) do nothing;

insert into kp_edges (subject, from_point, to_point, edge_type) values
  ('政治经济学', '商品', '劳动二重性', 'prerequisite'),
  ('政治经济学', '劳动二重性', '价值', 'prerequisite'),
  ('政治经济学', '价值', '价值规律', 'prerequisite'),
  ('政治经济学', '价值规律', '剩余价值', 'prerequisite'),
  ('政治经济学', '剩余价值', '资本主义基本矛盾', 'prerequisite'),
  ('政治经济学', '价值规律', '价值规律作用', 'related'),
  ('数学', '一元一次方程', '因式分解', 'prerequisite'),
  ('数学', '因式分解', '配方法', 'prerequisite'),
  ('数学', '配方法', '二次方程', 'prerequisite')
on conflict (subject, from_point, to_point, edge_type) do nothing;
