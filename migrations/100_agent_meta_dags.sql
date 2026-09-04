-- 100_agent_meta_dags.sql — V404-10: 动态 MetaSkill DAG(人工审 accept 后注册, 运行时 list/run 合并)
-- 静态 META_SKILLS(代码) + 本表动态定义; 由 meta-skill-propose-service 写入(人工审红线)

CREATE TABLE IF NOT EXISTS agent_meta_dags (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  dag_json jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
