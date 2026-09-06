-- 121_stats_artifacts.sql — SocialSci P0-3 补漏: 统计图表产物(statsart)
-- HAR 实测链: statistics-jobs 完成后 PUT /statistics-jobs/artifacts/{id}/image → 导入素材
-- 语义: 统计任务产出图表 = 可版本化产物(png+svg), 与 viz_artifacts 同构; 独立表便于统计域追溯
create table if not exists stats_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  stats_job_id text not null default '',   -- 来源统计任务(id)
  method text not null default '',          -- descriptive/t-test/anova...
  title text not null default '',
  png_rel text not null default '',         -- data/viz-files/... 同目录(复用文件服务)
  svg_rel text not null default '',
  spec jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, stats_job_id, method)
);
create index if not exists idx_stats_artifacts_user on stats_artifacts(user_id, created_at desc);
