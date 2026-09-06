-- 114_research_projects.sql — SocialSci P0-1: 科研项目容器(可视化DAG科研工作台)
-- 形态对齐: 在线科研工作流平台项目容器(画布态=节点+连线, 每项目一份画布)
--   项目 = 研究主题容器(可含多个执行任务/节点快照); canvas 存整个 DAG 画布状态
-- 原创实现(仅交互语义对齐闭源产品, 不涉源码), 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-01~S-04

create table if not exists research_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                    -- 归属(同 users.id, 不建外键保弹性)
  title text not null,                      -- 研究标题
  topic text not null default '',           -- 研究主题(详述)
  thesis text not null default '',          -- 核心论点(可选)
  style text not null default '',           -- 语体偏好(默认严谨的哲社科学术语体)
  -- 画布态: DAG 节点+连线 全量 JSON, 由前端画布编辑写回
  canvas jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  -- 线性模板进度(辅助视图, 五阶段模板的完成相位)
  phase int not null default 0,             -- 0..5 (input→analysis→materials→sections→finalize→published)
  phase_label text not null default '',
  status text not null default 'active',    -- active / archived / deleted
  current_task_id uuid,                     -- 最近执行任务(快捷恢复)
  state_version bigint not null default 1,  -- 乐观锁(同 107 语义: 并发画布编辑防互相覆盖)
  published_version int not null default 0, -- 已发布版本号(指针快照, 见 research_versions)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_research_projects_user on research_projects(user_id, updated_at desc);
create index if not exists idx_research_projects_status on research_projects(status);

-- 画布乐观锁版本(便于前端并发提交校验, 也可直接读 research_projects.state_version)
alter table research_projects add column if not exists canvas_version bigint not null default 1;
