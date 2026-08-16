-- 022_prompt_patches.sql — 最小 diff 系统提示词补丁（BOOK-GAP-ROADMAP P1-5）
-- 同类别失败聚合 → LLM 生成 old_str→new_str 最小补丁 → 四门槛检查 → candidate/canary/released
-- 由 scripts/min-diff-patch.ts 写入; 生产通过 PROMPT_CANARY 环境变量启用

create table if not exists prompt_patches (
  id serial primary key,
  trigger_failure_ids jsonb,           -- 触发本补丁的失败题列表（eval_failures.question_id）
  component text not null,             -- 补丁作用组件（如 system_prompt/hypothesis_generator）
  old_str text,                        -- 被替换的原文
  new_str text,                        -- 替换后的新文
  scope text default 'reason',         -- 作用范围（reason=推理生成）
  checks jsonb,                        -- 四门槛检查结果（{diff_ratio, traceable, boundary_ok, retention_ok}）
  status text not null default 'candidate' check (status in ('candidate','canary','released','rejected')),
  created_at timestamptz default now(),
  released_at timestamptz
);
create index if not exists idx_prompt_patches_status on prompt_patches(status);
