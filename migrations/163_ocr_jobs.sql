-- 163_ocr_jobs.sql — 文档 OCR 任务(扫描版 PDF → 文本)
--
-- 由来(2026-09-28): 写作舱的素材上传对扫描版 PDF 是死路 —— 抽不到文本层就报错,
--   而平台本来就有 OCR 能力(MinerU), 只是挂在 Agent 工具上, 上传链路碰不到。
--
-- 为什么要有表(而不是纯内存 Map):
--   识别是分钟级的。纯内存的话, 服务一重启, "进行中的任务"在内存里就查不到了,
--   前端会永远停在"识别中"—— 轮询一个永远返回 404 的 id。DB 里那份是重启后的依据。
--   (statistics-job-service 的 restoreStatsJobs 注释记的就是这个坑。)
--
-- 与 viz_jobs(迁移 132) 同形, 刻意保持一致: status 五值 + current_step 一行进度 + error。
-- 不建事件流表: OCR 的进度是"一条线"(排队→识别→整理), 没有 viz 那种多轮事件需要重放。

create table if not exists ocr_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  status        text not null default 'queued',   -- queued/running/done/failed/cancelled
  file_name     text not null default '',         -- 用户看到的原始文件名
  file_path     text not null default '',         -- 源文件落盘位置(MinerU 只吃真实文件)
  current_step  text not null default '',         -- 一行人类可读进度
  text          text not null default '',         -- 识别出的 Markdown。完成后才有
  char_count    int  not null default 0,
  error         text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 列表按用户最近排; 卡死巡检按 status + updated_at 扫
create index if not exists idx_ocr_jobs_user on ocr_jobs (user_id, created_at desc);
create index if not exists idx_ocr_jobs_active on ocr_jobs (status, updated_at) where status in ('queued','running');

comment on table ocr_jobs is
  'V418 文档 OCR 任务(扫描版 PDF → Markdown). 内存 Map 是快路径, 本表是重启后的依据';
