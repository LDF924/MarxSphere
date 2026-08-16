-- 052_strategic_memory.sql — V391(P1-4): 战略记忆（项目级长期目标/决策历史/约束）
-- 用途: Agent 每次会话开始时加载项目战略上下文, 避免每次会话重建上下文
CREATE TABLE IF NOT EXISTS strategic_memory (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  project_id uuid,
  kind text NOT NULL,               -- goal(项目目标) | decision(决策历史) | constraint(约束) | milestone(里程碑)
  content text NOT NULL,
  source text,                      -- 来源: user(用户声明) | agent(Agent提炼) | system
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strategic_project ON strategic_memory (project_id, kind, created_at DESC);
