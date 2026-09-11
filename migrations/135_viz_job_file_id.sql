-- 135_viz_job_file_id.sql — viz job 记住数据来源文件(闭源 VizView: 前端传 fileId, 由服务端取数)
--
-- 由来(2026-09-11): 前端上传数据后把 fileId 发给后端, 但 /api/viz/jobs 只读 csv/columnOrder,
--   fileId 被忽略 → 全部绘图任务 csv 为空 → analyze_data 恒 skipped → 图表是 LLM 编数据的示意图。
--   实测: 11/11 历史 job csv=null, 且传了 fileId 的那个 job 列名已带进 prompt 却仍无数据。
-- 设计: csv 可能非常大(整表), 不入库; 只存 file_id, 每次运行从 user_files 解析成 csv(单一真源)。
alter table if exists viz_jobs add column if not exists file_id text;
