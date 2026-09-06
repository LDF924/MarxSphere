-- 117_review_suite.sql — SocialSci P0-3: 审稿任务流 + 期刊库 + 审核标准库
-- 形态对齐(闭源产品交互语义, 原创实现): 传稿→SSE流式审稿(维度JSON边流边渲染)→维度评分卡
--   review_jobs:    审稿任务(分段审稿/断点续传/结构化结果)
--   review_journals: 期刊库(投稿须知原文 + AI解析规则, 审稿可选用刊物规则)
--   review_standards:审核标准库(自定义维度, 解析/设默认)
-- 注: 命名避开既有 review_queue(100=间隔复习) 与 paper-quality(单次检查)
-- 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-16~S-22

-- ═══ 审稿任务 ═══
create table if not exists review_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null default 'text',        -- text / pdf / docx
  title text not null default '',           -- 稿件标题(自动从正文抽)
  source_file_path text not null default '',-- 上传文件落盘 data/review/
  text_snapshot text not null default '',   -- 全文纯文本快照(分段审稿源)
  journal_id uuid,                          -- 选用刊物规则(可选)
  standard_id uuid,                         -- 选用审核标准(可选)
  dimensions jsonb not null default '[]'::jsonb, -- 本次审稿维度快照(来自标准/刊物解析)
  status text not null default 'queued',    -- queued/segmenting/summarizing/streaming/done/failed/cancelled/paused
  progress jsonb not null default '{}'::jsonb,   -- {segmentsDone, totalSegments, lastEventSeq} 断线续传
  result jsonb,                             -- {paperTitle, wordCount, dimensions:[{name,score,comment,issues[]}], overall, segments}
  error jsonb,                              -- {code,userMessage,canRetry,hint}
  retry_of uuid,                            -- 重试追链
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_review_jobs_user on review_jobs(user_id, created_at desc);
create index if not exists idx_review_jobs_status on review_jobs(status);

-- ═══ 期刊库(投稿须知解析入库) ═══
create table if not exists review_journals (
  id uuid primary key default gen_random_uuid(),
  name text not null,                       -- 期刊名(如 中国社会科学)
  level text not null default 'other',      -- CSSCI / 北核 / 其他
  scope text not null default '',           -- 收录范围
  submission_guide_text text not null default '', -- 投稿须知原文(粘贴/解析源)
  parsed_rules jsonb not null default '{}'::jsonb, -- {formatRules[], reviewFocus[], citationRules[]}
  user_id uuid,                             -- 归属(null=公共库)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_review_journals_user on review_journals(user_id);

-- ═══ 审核标准库(自定义维度) ═══
create table if not exists review_standards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  built_in boolean not null default false,  -- 内置标准(公共)
  source_text text not null default '',     -- 评分标准原文(解析源)
  dimensions jsonb not null default '[]'::jsonb, -- [{key,name,weight,criteria,min,max}]
  is_default boolean not null default false,-- 默认标准(新审稿自动带)
  user_id uuid,                             -- 归属
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_review_standards_user on review_standards(user_id);
