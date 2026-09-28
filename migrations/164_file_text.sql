-- 164_file_text.sql — user_files 补两列: 抽出的正文 + 它是怎么来的
--
-- 由来(2026-09-29 用户: "审稿的上传 PDF 要先 file_read/pdf_parse 拿到文本再建 job ——
--   后端没有 fileId → 纯文本这个能力。全部修复"):
--   `user_files`(迁移 123)一直只存**字节**(storage_rel)与**表格概览**(profile)。
--   数据类链路够用(viz 出图、统计台跑回归都只要 CSV), 但文档类链路要的是"正文" ——
--   而"这个上传文件的正文是什么"**没有任何地方能回答**:
--     · 审稿建 job 要全文, 只能让用户把文本粘贴进去;
--     · 评审面板上传 .pdf 走 `/api/files/extract-text`, 那条路由不落库也不返回 fileId
--       (临时文件当场删掉), 于是 `review_jobs.source_file_id` 永远写不进值;
--     · AI 对话里的 view_viz_data_files 只能看到文件名与行列数, 看不见内容。
--
-- 为什么正文要**存库**(而不是每次现抽): "引用这份文件"是高频动作(审稿要整篇、对话要读内容),
--   而抽一次 3MB 的 PDF 要几秒, 扫描件走 OCR 是分钟级。抽一次存下来, 后面都是读。
--   与迁移 153 的注释同一条道理 —— 那是"按 fileId 连接", 这是"按 fileId 取文本"。
--
-- `extraction` 与 `profile.parseStatus` 分开, 各说各的事:
--   profile 描述**表格数据**(行数/列名/变量类型), extraction 描述**正文文本**是怎么来的。
--   合并成一个字段的话, "OCR 认出来的"和"PDF 本来就带文字层"就没法区分了 ——
--   而 OCR 有错字是常态, 用户有权知道手里的正文该不该复核(与迁移 163 的 extractionMethod 同口径)。

alter table if exists user_files add column if not exists text text not null default '';
alter table if exists user_files add column if not exists extraction text not null default '';

comment on column user_files.text is
  'V421 抽出的正文(file-text-service 回填). 空 = 还没抽过或抽失败, 看 extraction';
comment on column user_files.extraction is
  '正文来源: native(纯文本/xlsx转csv) / text-layer(PDF文字层) / mammoth(docx) / ocr(识别件) / failed';

-- 列表页要按"有没有正文"筛(呈现层区分"已解析/待识别"), 半索引比全表扫省
create index if not exists idx_user_files_with_text on user_files (user_id, created_at desc) where text <> '';
