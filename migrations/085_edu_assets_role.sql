-- 085_edu_assets_role.sql — 资产空间按角色隔离（V389 修正）
-- 学生端与教师端各自独立的资产空间（role=student / role=teacher），预置内容两端各初始化一份
alter table edu_assets add column if not exists role text not null default 'teacher';
create index if not exists idx_edu_assets_role on edu_assets(role, kind);
