-- 073_agent_task_dependency.sql — 差距K②: 任务依赖 DAG
-- agent_tasks 加 depends_on: 前置任务 id 数组（任务链的 DAG 泛化 — 多任务并行/串行调度）
-- 执行器: 前置任务全部 completed 后才允许启动; 有依赖未满足 → 入队等待

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_agent_tasks_depends ON agent_tasks USING gin (depends_on);
