-- 021_eval_failures.sql — 评测失败归因表（BOOK-GAP-ROADMAP P0-2）
-- 每个低分题(overall<0.55)的结构化归因: 首个错误步骤/错误类别/证据/可恢复性/置信度
-- 由 scripts/failure-attribution.ts 写入; 供回归测试(P0-3)/补丁生成(P1-5)/生产回流(P2-4)消费

create table if not exists eval_failures (
  id serial primary key,
  eval_run_id text not null,          -- 关联评测轮次(文件名或时间戳)
  question_id text not null,          -- Q01..Q50
  failure_category text not null,     -- retrieval|context|reasoning|hallucination|tool|timeout|other
  first_error_step text,              -- 首个错误步骤名（如 stage2_cogneeCoarse）
  tool_name text,                     -- 涉及工具（如 cognee_search / pg_iliike）
  evidence text,                      -- 可复核证据（原文摘录/步骤输出片段）
  root_cause text,                    -- 结构化根因描述
  is_recoverable boolean,
  confidence numeric(4,3),
  full_trace_ref text,                -- 关联 trace_id（trace_spans 已有）
  created_at timestamptz default now()
);
create index if not exists idx_eval_failures_run on eval_failures(eval_run_id);
