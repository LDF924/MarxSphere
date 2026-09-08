# SocialSci Vue 还原 — 分阶段进度 checkpoint(2026-09-08 会话中段)

> 目标/纪律: docs/socialsci-chunks/VUE-IMPLEMENTATION-ROADMAP.md + VUE-BACKEND-MAPPING.md
> 每模块 1 提交 + typecheck/vitest 零回归 + LF 行尾; 浏览器实测证据入提交说明。

## 已完成提交(main 分支, 本 worktree cranky-babbage-0a2349)
| commit | 内容 | 验证 |
|---|---|---|
| a37b6e3 | 脚手架: vue 子工程(vite 独立构建→web/dist/soc)+hash router+共享层(api/tasks/constants/ui/utils)+viewRegistry 6 入口+App.tsx categories+proxy+gitattributes LF | vue-tsc 0 错; 主测试 804/804 |
| 14fcd25 | **M1 学术编辑器**: EditorView/TopBar/SideBar/AIPanel(6tab)/VersionHistory/ChartRenderer/academicExtensions/tiptapSetup + stores(document/editorAi) + presets(4 档 ade-format-preset) + editorApi | 浏览器实测: 建文档→TipTap 输入→1200ms 防抖→后端 197 字 JSON 树落库; activeDocumentId 刷新恢复; AI 全文检查真 LLM SSE 4 findings; vue-tsc 0 错 |

## M3 统计分析(已全部完成, 待用户后台 chip 会话提交 — task_0a3b58cf 已被用户启动)
- 前端: StatisticsView.vue(三栏 17 法)+methodParams.ts(17 方法注册表)+statsApi.ts
- 后端补全(完整实现, 未借道 empirical): statistics-job-service.ts + 133_stats_jobs.sql + server.ts jobs CRUD/SSE/health + scripts/statistics_runner.py(17 法 Python)+files/upload 变量类型推断
- 实测: 上传 stats_demo.csv(200 行)→descriptive 11 列三线表(均值 42.22)+plotly 直方图 canvas; regression income~age+edu 系数 220.8/320.3 R²=.7504; 浏览器 spinner→结果渲染
- 状态: 文件已 stage; 804/804 测试已跑通

## M4 科研绘图(viz, 开发中)
已完成:
- vizApi.ts(契约层: ensureVizSession/createVizJob{job_id}/listVizJobs/blobifyPng 3 态/SSE 13 事件/DEFAULT_JOURNAL_CONFIG)
- VizChatPanelV2.vue(消息模型/手写 markdown 正则/XSS 转义/SSE 分发表 13 事件/300ms 自动保存/上传/生命周期修复)
- VizView.vue(双视图/图卡画布/底部三 tab/220-480 拖拽/任务恢复/代码高亮)
- 后端补: listVizJobs(服务+GET /api/viz/jobs)+getVizJob 聚合会话产物→result.charts+png URL 修正
实测(全通):
- 消息→POST viz/jobs 200→SSE 连上→后端 done 2 charts
- 任务视图 2 卡(done)→点卡→切图表视图→800px PNG 真实渲染
- 第二条消息(折线图)→job running→轮询 done 1 新图
遗留小坑:
- SSE chart 事件推画布时 blob 化偶败→空 Figure 卡(chart-update 的 png/url 双字段处理需加固)
- 任务 meta "0 张图"(chart_count 映射字段名对不上, 前端读 chartCount/job.result.charts?.length)
- 发消息后 assistant 消息的 chartPng 未显示(事件已到后端 job, 但 blob URL 化需走 viz/files 需带 token — blobifyPng 已实现 authedBlob, 待复验)

## M2(已提交)+ M5/M6(会话 2)
- M2 ReviewView 已提交(4 页状态机/22 批注定位 5/5 命中/审稿库 CRUD 实测)
- M5 workflow store 已完成(未提交); 视图待建 — 见 VUE-M5M6-HANDOFF.md 全量交接
- M6 QuickModeView 未开始

## 环境状态
- 后端 4173: worktree 代码 + .env(SAG_ROOT=worktree? 需确认 EMPIRICAL_PYTHON 生效 — statistics health venvReady:true 已证)
- vue dev 5174 运行; 父 React dev 4174 运行
- 测试账号 soc_test(sag_token/skf_auth_token 在浏览器 localStorage)
- stats_demo.csv: data/stats_demo.csv(200 行 6 列)

## 下一步(按序)
1. M4 收尾: 修 chart-update 空图卡 + 复验 SSE 直推画布; 提交 M4(待 M3 后台会话提交后 rebase 不冲突—文件不相交)
2. M2 review / M5 workflow / M6 quick 依次推进
3. 全量对照清单 docs/socialsci-chunks/VUE-VERIFICATION.md
