-- 061_agent_p2o_tasks.sql — V395-10: PDF2Obsidian 任务持久化
-- 任务落库（重启不丢）: 状态机 + 6阶段进度 + 产物路径 + 错误信息
CREATE TABLE IF NOT EXISTS agent_p2o_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL DEFAULT '',           -- 来源文件名（上传 PDF 原名 / URL 解析名）
  pdf_path text NOT NULL,                        -- 本地 PDF 路径（上传落盘 / URL 下载）
  source text NOT NULL DEFAULT 'upload',         -- upload(上传) / url(链接) / base64
  status text NOT NULL DEFAULT 'queued',         -- queued / running / completed / failed
  progress integer NOT NULL DEFAULT 0,           -- 0-100 完成度
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{step, status, message}]
  error text,
  result jsonb,                                  -- 管线结果（slug/产物路径/configSummary）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_p2o_tasks_created ON agent_p2o_tasks (created_at desc);
