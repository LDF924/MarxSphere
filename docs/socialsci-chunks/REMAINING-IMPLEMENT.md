# 源码级对齐 — 剩余实施清单(基于全部 chunk 解码, 按序推进)

## R6: EditorView AI 统一 job 端点 + 断线恢复
- 闭源: POST /api/editor/v1/ai/jobs {action,text,context,language:"中文",document_id} → {job_id} → 轮询 delta(累积) → done {content}; AbortController 停止
- localStorage "editor.activeJobId" + recoverActiveJob/retryActiveJob(挂载时若存在 jobId → 恢复流)
- 我方: 独立端点 rewrite/check-fulltext/title-abstract/format-references/chart-code, 无 job 化
- 实施: 后端加 ai/jobs(建 editor_ai_jobs 表或复用 research_tasks 语义) + delta 轮询端点; 前端 AIPanel 统一走 job, 存 activeJobId, 挂载恢复

## R7: 编辑器 docx 导出格式映射(formatPresets → docx)
- 闭源 formatPresets 每套带 docxFont/docxFontSize: general=SimSun/10.5, journal_cn=SimSun/10.5, apa=Times New Roman/12, degree=SimSun/11
- 我方 DOC_STYLES 已带 style, 补 docxFont/docxFontSize 字段并在导出 docx 时套用(若导出走 format-docx-service 需传字体)

## R8: VizView Nature 投稿参数面板
- 闭源 de 默认: journal=nature/layout=single-column/colorScheme=nature-default/dpi=600/fontSize=7/fontFamily=Arial/axisLineWidth=0.8/dataLineWidth=1/widthMm=89/heightMm=62.3
- 请求体: {chartType:"自动判断",journal,journal_name:"Nature",layout,colorScheme...}
- ✅ 已完成(2026-09-11): 期刊参数卡落在 Vue VizChatPanelV2「出版规范」条(6 期刊预设+配色+尺寸/DPI/字号/线宽), journalConfig 经 POST /viz/jobs 透传后端 mergeSpec→specPrompt 套用; React VizAgentPanel(已废)连同此待办一并移除

## R9: VizView 图片加载重试
- 闭源: fetch blob(cache no-store), 失败仅 401/404/408/425/429/500/502/503/504 重试 4 次(150ms*(attempt+1) 退避)
- 我方 artUrl 直链 → 改 blob 获取+重试链(产物图加载体验)

## R10: QuickMode DAG 节点/右键菜单形态
- AgentFlowNode: index 序号+module 徽标+node-menu "..."+title+progress 进度条(state class: is-{draft|...}/is-locked/is-system-start)
- AgentFlowCanvas: xyflow + pane 右键菜单 + node 右键菜单 + editable 门禁
- 我方 DagWorkbenchPanel: 核对节点卡是否含 index/module 徽标/progress, 缺则补; 右键菜单若缺补

## R11: KnowledgeBase evidence 徽标交互细节
- 闭源: 回答中编号可点击 → 对应依据(四库 citation_index)
- 我方 AskPanel 已覆盖徽标 → 核对点击展开形态一致性

## R12: MaterialsView 万方文献检索卡
- 生成弹层 literature: 生成前展示 wanfang 文献检索结果卡(编号/标题/作者/期刊·年份/摘要/文献库检索蓝徽标/GB 引用)+变量参考 chips
- 我方无万方源(用户自采) → 记录: 检索源对接待定, UI 形态(变量 chips+结果卡)可先还原

## R13: OutlineEditor 交互补丁(W1 后)
- 闭源行工具: + 添加子节(一级行 hover)/▶展开▼折叠(collapsed tree-collapsed)/↑ 首行 disabled/↓ 末行 disabled/✕
- 行标题 input 双向; 空目录专属空态("目录为空,请添加章节或插入模板"+红链插入模板)
- 我方 ResearchInputWizard 已做行内编辑+序号, 核对: 折叠/展开按钮+空态红链+首末 disabled 是否齐, 缺则补

## 状态更新(2026-09-08)
- R5/R6后端/R9/R10 已实施(见提交 908d723/c077b21/4e77049/f8b862b)
- R6 前端接线待做: EditorView AIPanel 改走 /ai/jobs+SSE(现为同步端点); localStorage editor.activeJobId 断线恢复; 主入口挂载时若有 activeJobId → retry
- R7-R8 已确认 R8(Nature 参数)已有 SPEC_PRESETS

## 2026-09-08 追加核验
- R11(知识库徽标): 已覆盖 — AskPanel [N] 可点击徽标(滚定定位)与闭源 knowledge-evidence 编号点击语义等价; 差异仅卡内 meta/actions 区(闭源 detail 有 title/summary/body/meta), 我方卡含标题+摘要+来源步骤溯源(更强), 记录不重建
- R7 已完成(docx 字体映射+导出按钮); R13 已完成(大纲折叠/空态红链/首末disabled)

## 2026-09-08 R15 HistoryView 对照结论(我方历史中心, 已完成 ff277db+9b507ec)
对照 HistoryView-DECODED.md, 我方 ResearchHistoryPanel 深采前缺口 → 实施证据:
- **6 模块分区缺真源**: 原面板只拉 research_tasks(强制标 workflow)+review+documents,
  viz 解构 bug(响应键 sessions 误写 materials)致绘图区恒空, statistics/knowledge 无数据源恒空
  → 实施: GET /api/research/history 一次聚合 6 真源(workflow=research_tasks 带 module 真值/
  review/review_jobs/viz/viz_sessions/statistics/empirical_results/editor/documents_v2/
  knowledge/search_query_history); 迁移 131 新表 + AskPanel 检索 done 静默记一条
- **卡结构对齐**: 状态点(status dot)+phase 徽标+标题+相对时间(<1h 分钟/<1d 小时/<7d 天/日期) —
  原实现已有雏形, 保留; 补"运行中"徽标(active 判定含 queued/running/paused/waiting_user/
  segmenting/summarizing/streaming)
- **清除历史 ACTIVE_JOB 保护**(R14 提交 8cb1c82 只保护 queued/running research_tasks + 误删
  documents_v2/mcp_sessions): R15 补全 — review_jobs 非终态保护、文档资产保护(不删稿件)、
  failed 明细返回 [{id,module,reason}], 删除计数; confirm 文案与闭源一致
- **deep-resume 恢复**(闭源 switchToTask/currentTaskId 语义): 卡点击写 localStorage
  sag:resume:<module> {id,projectId} → 6 工作台面板挂载消费自动打开(DagWorkbench 原会话恢复
  死代码一并修复); knowledge 查询经 App pendingDemo 通道重放
- **lastTask 清理语义**: 清除成功后清全部 sag:resume:* 指针(=闭源 lastTask_* removeItem)
- 浏览器实测(4183 临时实例, 不动 4173 用户进程): 6 分区渲染/清除 toast('已删除 1 条,1 条未能
  删除(1 条仍在运行,请先取消或等待完成)')/ACTIVE_JOB 保护/statistics 真源 30 条/跳转实证面板
  自动开历史抽屉 全部通过; vitest 799 零回归

## 2026-09-08 R16 DOM 深采对照补缺(真机 CDP 点击 6 模块, 提交 4a08963~7a9f66c)
深采: 60+ 份 DOM/弹层/交互态存 docs/socialsci-chunks/deep/ + DeepDive-DOM-DECODED.md(结构汇总)
对照补缺(已实施, 提交见右):
1. review 新建审稿确认层"开始新的审稿?当前审稿状态将清除。" — 7e4227b
2. review 手动新增期刊弹层(名称+7分类下拉+核心审稿要点一行一条) — 7e4227b
3. editor 空态双按钮(新建文档+上传 Word)+ 自绘新建弹层(弃 window.prompt) — 7e4227b
4. DAG 模板节点 index(00起)+module(SYSTEM/STANDARD WORKFLOW)+输入/输出 meta+systemStart
   (修复 index string 类型永不渲染 bug); 前端 chip 渲染 module 徽标+meta 行 — 8333d24
5. DAG 新建项目自绘弹层(空白画布/五阶段模板, 弃 window.prompt) — 7a9f66c
   (headless 验证发现原生 prompt 卡死主线程 = 自动化可操作性缺口)
浏览器验证(4183 临时实例): 模板 API 返回节点全 meta 字段 ✓; vitest 799 零回归 ✓
未实施(记录, 后续可选): materials 五类手风琴头部行内操作按钮、workspace 章生成卡形态、
  statistics 17 方法左栏分类树布局(我方用 12 流程导航+方法向导, 语义等价, 布局不同)
