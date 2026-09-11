-- 134_drop_stats_artifacts.sql — 清掉空壳表 stats_artifacts
--
-- 背景(2026-09-11 核查):
--   121_stats_artifacts.sql 建了这张表, 配套 4 条路由(POST 上传 / GET 列表 / DELETE / to-materials)
--   以及 /api/research/artifacts/import 的 sourceType:"statistics" 分支。
--   但 POST 是唯一写入者, 且要求前端传 pngBase64 —— 全仓零调用者, 表恒 0 行(生产实测 count(*)=0)。
--   其余 3 条路由与该分支都依赖 POST 产出的行, 必然查不到, 属不可达代码。
--
--   那些路由与分支已于 2026-09-11 一并移除(见 src/api/server.ts 内的说明注释)。
--   统计图的可用路径已改为:
--     ① 编辑器「送工坊精修」→ 把统计任务原始数据(model 层回查 stats_jobs.input.fileId)交给
--        成果可视化工坊, 由 viz 画真 PNG/SVG, 可插入正文
--     ② 工坊产物 → POST /api/viz/artifacts/:id/to-materials 进研究素材库
--
-- 保留该表的唯一后果是: 后人可能再次读到它, 再造一个"徒有其表"的功能。故直接删除。
-- 迁移由 schema_migrations 记录, 只执行一次; 全新库上会先建(121)后删(134), 无害。

drop table if exists stats_artifacts;
