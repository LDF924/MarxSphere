-- 053_memory_maintenance.sql — V391(P1-5): 记忆自动遗忘/合并
-- 记忆维护登记表: 记录写入记忆的条目 + 相似度指纹, 供自动整合
CREATE TABLE IF NOT EXISTS memory_maintenance (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  category text NOT NULL,               -- user / session / entity
  subtype text,                         -- preference / constraint / conclusion ...
  content text NOT NULL,
  fingerprint text,                     -- 内容相似度指纹(取前N字归一化)
  written_at timestamptz NOT NULL DEFAULT now(),
  last_recalled_at timestamptz,         -- 最近被召回时间(用于遗忘判定)
  merged_into_id bigint                 -- 若被合并: 指向保留的条目
);
CREATE INDEX IF NOT EXISTS idx_memory_maint_fp ON memory_maintenance (fingerprint);
CREATE INDEX IF NOT EXISTS idx_memory_maint_cat ON memory_maintenance (category, subtype);
