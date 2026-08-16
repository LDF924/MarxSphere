-- 067_agent_final_audit.sql — 最终审计 G5: 补齐 Agent 子系统缺失 DDL（幂等, 可重复执行）
-- 干净部署必崩修复: agent_skills / agent_eval_suite / agent_eval_runs / agent_episodic_memory
-- / agent_task_queue 建表 + agent_tasks(user_id, judge_score, judge_at) 与
-- agent_exec_logs(parent_id, span_type, conversation_id) 补列

-- ① agent_tasks.user_id — W6 用户隔离/计费归属
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks (user_id, created_at DESC);

-- ② agent_tasks.judge_score / judge_at — 评测回写（agent-eval-service.ts 写, 无迁移则干净部署报错）
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS judge_score double precision;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS judge_at timestamptz;

-- ③ agent_exec_logs span 树三列 — V396-3 可观测性（logAgentExec 无条件写入）
ALTER TABLE agent_exec_logs ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE agent_exec_logs ADD COLUMN IF NOT EXISTS span_type text NOT NULL DEFAULT 'TOOL';
ALTER TABLE agent_exec_logs ADD COLUMN IF NOT EXISTS conversation_id text;

-- ④ agent_skills — V396-9 技能蒸馏（proposeSkill/recallSkills 查询, 干净部署无表必崩）
CREATE TABLE IF NOT EXISTS agent_skills (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  when_to_apply text NOT NULL DEFAULT '',
  skill_md text NOT NULL DEFAULT '',
  source_tasks text[] NOT NULL DEFAULT '{}',
  distilled_by text NOT NULL DEFAULT 'agent',
  consensus real NOT NULL DEFAULT 0,
  votes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',   -- pending / proposed / approved / rejected
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_skills_status ON agent_skills (status, consensus DESC);
CREATE INDEX IF NOT EXISTS idx_agent_skills_name ON agent_skills (name);

-- ⑤ agent_eval_suite + agent_eval_runs — V396-2 回归评测集（listEvalSuite/runEvalSuite 查询）
CREATE TABLE IF NOT EXISTS agent_eval_suite (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'gold',
  goal text NOT NULL,
  expected_steps integer NOT NULL DEFAULT 0,
  expected_tools text[] NOT NULL DEFAULT '{}',
  expected_keywords text[] NOT NULL DEFAULT '{}',
  min_score real NOT NULL DEFAULT 0.7,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_eval_suite_cat ON agent_eval_suite (category);

CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  suite_id bigint REFERENCES agent_eval_suite(id) ON DELETE CASCADE,
  task_id uuid,
  passed boolean NOT NULL DEFAULT false,
  score real NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  fault_injected text NOT NULL DEFAULT 'none',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_suite ON agent_eval_runs (suite_id, created_at DESC);

-- ⑥ agent_episodic_memory — V396-8 情景记忆（recordEpisodicMemory/recallEpisodicMemory 查询）
CREATE TABLE IF NOT EXISTS agent_episodic_memory (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id uuid,
  goal text NOT NULL,
  summary text NOT NULL DEFAULT '',
  key_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_used text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'success',   -- success / partial / failed
  importance real NOT NULL DEFAULT 0.5,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_episodic_goal ON agent_episodic_memory (goal);

-- ⑦ agent_task_queue — V396-5 队列持久化（enqueueTask/recoverAfterRestart 查询）
CREATE TABLE IF NOT EXISTS agent_task_queue (
  task_id uuid PRIMARY KEY,
  priority integer NOT NULL DEFAULT 1,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);
