-- 126_review_full_schema.sql — SocialSci 补漏R4: 审稿全 schema(HAR 逐条审计发现)
-- 实测: review_jobs 含 settings_json/rules_json/content_hash/history_id/source_file_*;
--   result 全结构: {paperTitle, wordCount, overallScore, grade, overallComment,
--     dimensions:[{name, score, maxScore, weight, status, summary, issues:[{id,severity,location,originalText,suggestion}]}],
--     annotations:[{id,type,dimension,highlightText,comment}], highlights[], topSuggestions[]}
alter table review_jobs add column if not exists content_hash text not null default '';
alter table review_jobs add column if not exists history_id text;
alter table review_jobs add column if not exists settings_json jsonb not null default '{}'::jsonb;
alter table review_jobs add column if not exists rules_json jsonb not null default '{}'::jsonb;
alter table review_jobs add column if not exists result_text text not null default '';
alter table review_jobs add column if not exists result_json text not null default '';
alter table review_jobs add column if not exists progress_message text not null default '';
alter table review_jobs add column if not exists cancel_requested boolean not null default false;
alter table review_jobs add column if not exists source_file_id text not null default '';
alter table review_jobs add column if not exists source_file_name text not null default '';
alter table review_jobs add column if not exists source_file_type text not null default '';
alter table review_jobs add column if not exists started_at timestamptz;
alter table review_jobs add column if not exists completed_at timestamptz;
alter table review_jobs add column if not exists sidebar_task_id text not null default '';
