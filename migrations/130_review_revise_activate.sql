-- 130_review_revise_activate.sql
-- P-A(R14 闭源对齐): job.result 产物载体 + revision 修订链
-- 闭源实证(#589/#601/#612/#651): phase5 review 产六维 reviewReport 存 job.result;
-- revise 回传 reviewReport → 输出完整修订稿(abstract+body)挂 revisionOf; 激活=版本置 published。
-- 我方等价实现(原创): research_tasks.result 存执行器产物(job.result 语义),
-- finalize 快照存修订稿指针(revision_of_version), activate 端点发布版本。

alter table research_tasks add column if not exists result jsonb;
alter table research_tasks add column if not exists revision_of_version int; -- 修订针对的发布版本号
alter table research_projects add column if not exists revision_of_version int; -- 终稿激活版本号
