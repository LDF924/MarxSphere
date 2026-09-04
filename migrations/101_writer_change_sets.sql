-- 101_writer_change_sets.sql — V404-13: WriterLease/ChangeSet/锚点(借鉴 OpenSquilla artifact_session, 最小版)
-- 在 documents 上加并发编辑控制 + 原子变更集 + 文本锚点批注
-- 幂等, 可重复执行

-- 1) documents 加并发编辑列: content_version(乐观锁) + writer_lease(编辑者锁, 令牌防旧写者覆盖)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS writer_lease_holder text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS writer_lease_token integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS writer_lease_until timestamptz;

-- 2) 原子变更集: 一次编辑 = 基准版本 + 操作列表 + 应用结果
CREATE TABLE IF NOT EXISTS doc_change_sets (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',   -- draft/applied/rejected/conflict
  operations jsonb NOT NULL DEFAULT '[]', -- [{op:'replace',start,end,text}]
  actor text NOT NULL DEFAULT 'agent',
  applied_version integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_change_sets_doc ON doc_change_sets (document_id, created_at DESC);

-- 3) 文本锚点: revision 作用域的定位符(引用内容片段, 支持批注/未来编辑定位)
CREATE TABLE IF NOT EXISTS doc_anchors (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  kind text NOT NULL DEFAULT 'text_range', -- text_range
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  quote text,
  note text,
  state text NOT NULL DEFAULT 'resolved',  -- resolved/orphaned(编辑后失效)
  remapped_from uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (remapped_from) REFERENCES doc_anchors(id)
);
CREATE INDEX IF NOT EXISTS idx_anchors_doc ON doc_anchors (document_id, version);
