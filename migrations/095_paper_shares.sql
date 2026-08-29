-- 095_paper_shares.sql — 论文分享链接(2026-08-29, 借鉴 frowang /s/:token 分享模式)
-- 分享不复制论文: 记录 token→document_id 映射, 接收时引用源文档内容
create table if not exists paper_shares (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  document_id uuid not null references documents(id) on delete cascade,
  title text not null,
  created_by text not null default 'local',
  expires_at timestamptz,
  max_uses int,
  use_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_paper_shares_token on paper_shares(token);
create index if not exists idx_paper_shares_created_by on paper_shares(created_by, created_at);
