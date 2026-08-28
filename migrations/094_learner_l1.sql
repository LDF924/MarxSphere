-- 094_learner_l1.sql — L1 学习者画像增强（2026-08-29, 借鉴 Inno Agent L1 learner profile）
-- 学习目标 + 误解诊断 + 画像事件(自动更新画像的依据)
CREATE TABLE IF NOT EXISTS learning_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id text NOT NULL DEFAULT 'default',
  title text NOT NULL,
  type text NOT NULL DEFAULT 'skill',        -- skill | knowledge | project
  priority real NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'active',     -- active | archived
  success_criteria jsonb NOT NULL DEFAULT '[]',
  source text NOT NULL DEFAULT 'user_declared', -- user_declared | inferred
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learning_goals_student ON learning_goals(student_id, status);

CREATE TABLE IF NOT EXISTS misconceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id text NOT NULL DEFAULT 'default',
  topic text NOT NULL,
  description text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open',       -- open | resolved
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_misconceptions_student ON misconceptions(student_id, status);

CREATE TABLE IF NOT EXISTS learner_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id text NOT NULL DEFAULT 'default',
  event_type text NOT NULL,                  -- goal_declared|goal_updated|goal_archived|misconception_recorded|misconception_resolved
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learner_events_student ON learner_events(student_id, created_at);
