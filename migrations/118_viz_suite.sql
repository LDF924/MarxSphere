-- 118_viz_suite.sql — SocialSci P0-4: 对话式科研绘图 Agent(会话流 + 版本化产物)
-- 形态对齐(闭源产品交互语义, 原创实现): NL对话→Agent循环(plan→analyze→chart→critique→fix)→
--   png+svg_editable 双产物版本化(viz_artifacts), 会话消息可重放 SSE
-- 参考 docs/SOCIALSCI-GAP-ANALYSIS.md S-26~S-31
create table if not exists viz_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null default '',             -- 首问摘要
  status text not null default 'active',      -- active / archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_viz_sessions_user on viz_sessions(user_id, updated_at desc);

-- 会话消息流(角色即 SSE 事件名, 可重放)
create table if not exists viz_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  role text not null,                         -- user / plan / model / thinking / tool / chart / critique / critique_fix / done
  content jsonb not null default '{}'::jsonb, -- 文本或结构化 {name,args,result_summary}/{artifact_id,...}
  seq int not null default 0,                 -- 会话内序号
  created_at timestamptz not null default now()
);
create index if not exists idx_viz_messages_session on viz_messages(session_id, seq);

-- 版本化产物(png + svg_editable 可再编辑矢量)
create table if not exists viz_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null,
  version int not null,                       -- 会话内版本号(redo=+1)
  prompt text not null default '',            -- 本轮用户请求
  python_code text not null default '',       -- 生成代码(可再编辑)
  data_snapshot_ref text not null default '', -- 数据快照(CSV 路径/摘要)
  spec jsonb not null default '{}'::jsonb,    -- 图表声明(供再编辑)
  png_path text not null default '',          -- 产物相对路径 data/viz-files/...
  svg_editable_path text not null default '',
  critique jsonb not null default '{}'::jsonb,-- 自审结果
  status text not null default 'draft',       -- draft / critiqued / final
  created_at timestamptz not null default now(),
  unique (session_id, version)
);
create index if not exists idx_viz_artifacts_session on viz_artifacts(session_id, version desc);
create index if not exists idx_viz_artifacts_user on viz_artifacts(user_id);
