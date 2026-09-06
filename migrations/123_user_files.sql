-- 123_user_files.sql — SocialSci 补漏组3: 通用用户文件(file_upload/profile/content)
-- HAR 实测链: POST files/upload → file_{id} → GET files/{id}/profile(自动剖析) → GET files/{id}/content(原始字节)
-- 语义: 通用文件仓(与 documents/upload 入库管线区分: 本表存"用户工作文件"原始字节+剖析)
create table if not exists user_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  filename text not null default '',
  mime text not null default '',
  size_bytes bigint not null default 0,
  storage_rel text not null default '',     -- data/user-files/{userId}/{fileId}.bin
  profile jsonb not null default '{}'::jsonb, -- 自动剖析(文本/CSV 概览)
  created_at timestamptz not null default now()
);
create index if not exists idx_user_files_user on user_files(user_id, created_at desc);
