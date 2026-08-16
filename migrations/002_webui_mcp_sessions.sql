create table if not exists mcp_sessions (
  id uuid primary key,
  tenant_id text not null default 'default',
  title text not null,
  status text not null default 'ACTIVE',
  model text,
  source_ids uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mcp_sessions_tenant_created_idx on mcp_sessions (tenant_id, created_at desc);

create table if not exists mcp_messages (
  id uuid primary key,
  session_id uuid not null references mcp_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists mcp_messages_session_created_idx on mcp_messages (session_id, created_at, id);

create table if not exists mcp_tool_calls (
  id uuid primary key,
  session_id uuid not null references mcp_sessions(id) on delete cascade,
  message_id uuid references mcp_messages(id) on delete set null,
  tool_name text not null,
  arguments jsonb not null default '{}',
  result jsonb,
  status text not null check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists mcp_tool_calls_session_created_idx on mcp_tool_calls (session_id, created_at, id);
