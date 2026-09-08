# social-sci.com 闭源社科研修云平台 → 原创 Vue3 还原实施路线图(组件级拆分)

> 方案 A(用户 2026-09-08 明确选择): 1:1 采用闭源实现逻辑, 不丢一点; 代码原创、注明还原来源。
> 规范源: `docs/socialsci-chunks/` 全部解码文档(full/decoded-*.md ×7 + css-styles-decoded + route-chunk-map + FULL-REVERSE-ROADMAP + REMAINING-IMPLEMENT + DeepDive-DOM-DECODED + deep/*.txt DOM 实拍)。
> 素材源码: `.claude/socialsci-probe/full/*.js`(prettier 格式化 chunk, 仅作定点检索)。
> 修订: 每模块落地时更新状态列与映射表。

---

## 0. 目标与验收纪律

1. 每模块 = 原创 Vue3 `<script setup>` + `<template>`(渲染函数 h() → 模板; 保留全部 props/emits/store 字段/事件名/localStorage key)。
2. 样式 1:1: 11 个 scoped CSS 按语义类迁移到组件 `<style scoped>`(不丢规则; 品牌色=红 bg-red-600 + 深藏青 #1e4d8c/#9bb8d8 + indigo 辅助)。
3. API 契约对齐: 闭源端点 → 我方 Fastify 语义等价则适配映射, 不等价补端点; 全部记录 §8 映射表。
4. 第三方库用 npm(不重造): @tiptap·@vue-flow·pdfjs-dist·docx·docx-preview 语义→自研热区·jsonrepair·plotly·marked·dompurify·katex·mermaid·echarts·mammoth·file-saver。
5. 嵌入: 独立 Vue 子工程构建到 `web/dist/soc`, 父 App.tsx 经 viewRegistry 注册 6 入口, 各 iframe 指向 `/soc/index.html#/路由`。
6. 提交纪律: 每模块 1 提交(证据+测试状态); 主 typecheck/vitest 零回归; 行尾统一 LF; 最后 sync-open。

## 1. 嵌入架构(侦察结论: a51c6051 / 后端代理未归)

| 项 | 决策 | 证据 |
|---|---|---|
| 父导航 | `web/src/components/viewRegistry.tsx` 注册 + App.tsx `categories` 分类加 6 items(GROUP_DOTS 可加) | App.tsx:1594 注册表渲染点; 注册表不自动进顶栏, 需手动加 category item; 已有 jupyter/backup/format-eval 占用 |
| Vue 子应用路由 | `createWebHashHistory`, iframe src=`/soc/index.html#/workflow/input` 等 | 父级自写 location.hash 路由(App.tsx:538-575)与 vue-router 冲突; iframe 自带 hash 独立于父级 |
| 静态托管 | vue build outDir=`web/dist/soc`; 后端 fastifyStatic root=web/dist 已注册(server.ts:8886-8890)→ `/soc/index.html` 天然命中, **零后端静态改动**; 在 setNotFoundHandler(8899) 之前命中 | fastify-static 先于 fallback 注册 |
| dev 模式 | vue dev server 独立 5174; 父 vite.config.ts server.proxy 增 `/soc → http://127.0.0.1:5174` | vite.config.ts:17-27 现有 proxy 块 |
| React 版复刻 | 原地保留(DagWorkbench 等), 不与 Vue 版合并 | 用户指示 |
| 挂载 id | vue 子应用自己的 index.html + `#app`(与父 `#root` 无争) | 各自 HTML 文档(iframe 隔离) |

新增 npm 依赖(根 package.json): vue@^3.5 pinia vue-router @vitejs/plugin-vue vue-tsc @tiptap/*(core/starter-kit/vue-3/placeholder/link/underline/text-align/highlight/image/table/table-row/table-cell/table-header/code-block-lowlight) lowlight @vue-flow/core @vue-flow/background @vue-flow/controls @vue-flow/minimap marked dompurify docx file-saver jszip mammoth pdfjs-dist jsonrepair echarts plotly.js-dist-min; katex/mermaid 已有。
scripts: `dev:socialsci-vue`(5174) / `build:socialsci-vue`(vue-tsc 先跑 → vite build → outDir web/dist/soc) / `typecheck:socialsci-vue`。主 `npm run typecheck`/`npm test` 保持不变(零回归基线)。

## 2. 工程布局

```
web/socialsci-vue/                  # 独立 vite 子工程(vite.config.ts + index.html + tsconfig)
  src/
    main.ts                         # createApp + pinia + hash router
    router.ts                       # 闭源 11 路由表(route-chunk-map.md §1)
    shared/
      api.ts                        # q() Bearer skf_auth_token / 401→auth-expired / {status,code}
      sse.ts                        # streamSSE(event/data 两行帧, event: X + data: JSON)
      services.ts                   # 服务对象: tasks/workflow/materials/review/library/viz/files/aiNav/dag/editor(映射表 §8)
      confirm.ts / toast.ts / markdown.ts / paperExport.ts / format.ts(数值格式) / saveAs.ts
      constants.ts                  # module 枚举 {workflow,review,statistics,viz,knowledge,editor} / localStorage key 常量表
      stores/                       # pinia: project/taskList/settings(含 dag_chat_ui_config 等)/ai/document/editorAi/review/reviewLibrary
    views/
      workflow/{InputView,OutlineEditor,SectionsView,MaterialsView/…,WorkspaceView,FinalizeView}.vue
      quick/{QuickModeView,AgentFlowNode,AgentFlowCanvas}.vue
      viz/{VizView,VizChatPanelV2,VizThinkingTrace,VizTaskWindow}.vue
      statistics/{StatisticsView,StatisticsJobControls,StatisticsFileUploader,ParamField.vue(17 模板渲染器),methodParams.ts(17 参数 schema)}
      review/{ReviewView,…6 子组件,store}/review-library/{LibraryHome,JournalList,JournalEditDialog,StandardList,StandardEditDialog}.vue
      editor/{EditorView,TopBar,SideBar,AIPanel,VersionHistory,ChartRenderer}.vue + presets.ts
      shared-components/{MarkdownEditor,PaperPreview,ChartRenderer}.vue
web/src/components/SocialSciVueHost.tsx   # iframe 容器(route prop; 注册 6 个 view)
```

## 3. M1 学术编辑器(EditorView-CaKgg_bg.js 40843 行; 解码 §decoded-editor-review.md §3)

来源组件(行号/scopeId) | 还原目标 | 关键契约/状态
|---|---|---|
| `Editor` 主组件 E:39364, data-v-8380a051 | views/editor/EditorView.vue | 三栏 ade-layout; 路由 `/editor?new=1&documentId=N`; 恢复 localStorage editor.activeDocumentId; AI 面板宽度 ade-ai-panel-width clamp 340-720 |
| GN() 装配 E:39289-39315 | views/editor/useEditor.ts | extensions 全表(StarterKit.configure{codeBlock:false,link:false,underline:false}+Placeholder+Link+Underline+academicTextStyle/academicBlockStyle+TextAlign+Highlight multicolor+Image allowBase64+ImageResize+Table resizable+CodeBlockLowlight 29 语言) |
| 文档 store E:17901 | stores/document.ts | canonical 排序键 contentHash; **仅变更才 PUT(乐观锁)**; 1200ms 防抖自动保存; 60s 锁心跳; editor-documents-changed 事件 |
| editor-ai client/store E:18449/18595 | stores/editorAi.ts + client | POST /api/editor/v1/ai/jobs {action,text,context,language,document_id}→job_id→SSE delta/model/done/error; editor.activeJobId 挂载恢复(recoverActiveJob→retry); AbortController |
| TopBar E:18101 | TopBar.vue | 保存/版本历史/状态徽标/新建弹窗; 导入 Word(/documents/import); 导出(/documents/:id/export format_options) |
| SideBar E:18305 | SideBar.vue | 文档 rail(word_count 千分位 + MM-DD HH:mm + 删除) |
| AIPanel E:18962, data-v-e0631cb6 | AIPanel.vue | 6 tab: check(4 动作, 全文≤60000 字)/local(5 动作需选区, context 前后 4000 字)/title(3)/citation(2, 明示不判断真实性)/format(4 预设 persist ade-format-preset)/chart(5 类型→POST /ai/chart→ChartRenderer 预览→ai-insert-chart) |
| VersionHistory E:19965 | VersionHistory.vue | /documents/:id/versions + restore(confirm 备份提示) |
| 排版 | presets.ts + CSS 变量 | --ade-doc-font-family/size/line-height/paragraph-margin/first-line-indent; 4 预设 general/journal_cn(SimSun 10.5)/apa(Times New Roman 12)/degree(SimSun 11) |
| 事件总线 | — | window CustomEvent: ai-apply(replaceSelection 原文回读校验)/ai-insert-chart(mermaid→SVG dataURL; echarts→离屏 getDataURL pixelRatio 2)/doc-conflict 409/editor-open-new-document/auth-expired |

样式: ade-* 全家桶 197 规则 → EditorView.vue scoped + 布局变量 --ade-sidebar-width:280px/--ade-ai-panel-width:420px; A4 210mm×297mm 纸面。
CSS scope 对照: TopBar 500ac1b8 / SideBar 493134a1 / AIPanel e0631cb6 / VersionHistory 7ad466f9 / 主 8380a051。

## 4. M2 科研审查(ReviewView-B4QyxKEn.js 37255 + LibraryHome-CugeBZHb.js 2089)

| 闭源组件(行号) | 还原目标 | 要点 |
|---|---|---|
| review store R:623-1198 | stores/review.ts | pageState 4 态机; paper 六元组; settings {strictness,journalId,standardIds[],customRequirements}; **五级容错 JSON 解析**(直解→剥围栏/注释+自研 repair→大括号平衡→quoted-string→rawOutput 兜底); 快照 collect/restore; window 桥 __rfSSEStatus/__rfReviewToken/__rfReviewError |
| ReviewSettings R:1220 | ReviewSettings.vue | 严格度三档 radio; 期刊 select; 标准多选; 额外要求 |
| ReviewInput R:1537 | ReviewInput.vue | 粘贴(≥100 字)/上传(txt/docx/pdf 校验); POST /api/files/extract-text→{text,fileId,metadata{reviewChunkCount,truncated}}; 分段提示"将分 N 段审稿" |
| ReviewProgress R:1990 | ReviewProgress.vue | 审稿动画; 取消 |
| ReviewResult R:2096 | ReviewResult.vue | 评分卡/维度条/核心问题/导出: export-report(POST→html→window.open+print) + Word(前端 docx: 批注 CommentRangeStart/End 双模式, 空白归一化定位) |
| ReviewPdfViewer R:35369 / ReviewDocxViewer R:6874 | PdfViewer.vue / DocxViewer.vue | PDF.js getDocument + 自绘 canvas(IntersectionObserver rootMargin 900px; dpr≤2); docx-preview→TreeWalker 全局空白压缩 indexOf; 页级热区按钮 data-pdf-ann-id(合并算法 top 差≤3\|h*0.35 且左重叠 12px)/data-docx-ann-id; expose scrollToAnnotation; 两法定位页(【PDF第N页】正则 + 全文搜) |
| ReviewDetail R:35882 | ReviewDetail.vue | txt 三态高亮(annotation-highlight + 重叠 sup [N]) 双向同步 |
| ReviewHistoryRail R:36577 | HistoryRail.vue | 20 条; 双击 select 规则(queued/running→恢复 SSE; failed/cancelled→retry) |
| ReviewView 容器 R:36724 | ReviewView.vue | ?jobId= 恢复 / ?new=1 重置; EventSource 4 事件 + onerror 1.5s 重连(无则 1.2s 轮询); 409 retry→弹已有运行任务; sidebar 任务快照 phaseLabel grade分 |
| reviewLibrary store L:26 | stores/reviewLibrary.ts | 期刊/标准 CRUD + parse; **前端正则 6 类归槽**(字数区间/引用/风格/结构/禁用项→specialNotes) + structuredRules→文本序列化 f() |
| LibraryHome L:1924 | LibraryHome.vue | tab 期刊库/标准库; 弹窗 4; 徽标 isBuiltIn蓝/isVerified绿/其他琥珀/默认绿 |
| JournalList/EditDialog L:542/51; StandardList L:1563; StandardEditDialog L:1054 | 同名 .vue | 维度默认模板 {weight:3, thresholds:{90,75,60}, aiInstruction, criteria} |

契约: /review/jobs CRUD+retry(409 语义)+stream; /review/library/*; /files/extract-text; /files/:id/content; /review/export-report。
样式: ReviewView-gnBufk0W.css 48 规则(热区 3 类 + history rail 218px + 2 处 media); 高亮层 z-index 分层。

## 5. M3 数据分析(StatisticsView-C1S4N5xA.js 3329 行; decoded-stats-viz.md §1)

| 闭源 | 还原目标 | 要点 |
|---|---|---|
| Statistics page data-v-38a82752 | StatisticsView.vue | header sticky + 三栏 workspace(flex, key=workspaceKey); 4 分类 17 法; min-width 1080; height calc(100dvh-180px) |
| 17 方法常量 be L617-1216 | methodParams.ts + ParamField.vue | 低代码字符串模板→声明式 schema(参数类型/默认 local/提交字段); props params/variables + emit update:params deep immediate watch |
| StatisticsJobControls L54 | JobControls.vue | cancel/retry/历史下拉(method·状态中文·MM-DD HH:mm) |
| StatisticsFileUploader L164 | FileUploader.vue | dashed→loaded; .csv/.xlsx/.xls |
| 上传 ct L1251 | — | POST /api/files/upload→fileId+profile.variables; 变量归一 categorical→nominal 等; 写 store+saveProject |
| 运行 ut L1440 | — | 校验链 warning toast(逐方法); POST /api/statistics-jobs {tool,fileId,...}; 700ms 轮询; **Python 异常翻译表 it()**(类型不匹配/维度/变量名/缺失值…); result_version_id |
| 图表渲染 L1690 | plotlyLoader.ts | 懒加载 plotly; chart-<i> newPlot responsive; 5 次重试(200ms 递增) |
| 恢复 je L603 | — | stats_save_<uid>_<taskId>/stats_save_<uid> 迁移链; 切用户/任务 watch |
| 数值格式 Oe L1751 | format.ts | ≥1000\|<0.001→toExponential(3); <0.01→4 位; 3 位 |
| 导出 vt/gt/xt L1764+ | exportTableDocx.ts/exportPng.ts | 三线表 docx(9000DXA 列宽/SimSun 20 半磅/头尾粗边); PNG html2canvas scale3; 图 PNG 三级降级(toImage→离屏→html2canvas); 整报告 Word/PDF(共享 exportFullReport) |
| 素材导入 wt/kt L2110 | importArtifact.ts | 先确保 workflow 任务(lastTask_workflow); 表格 snapshot{type:"table",analysisMethod,tableData}; 图表先 PUT /statistics-jobs/artifacts/:chartVersionId/image 再 import |

契约: /files/upload; /statistics-jobs CRUD+stream+artifacts; /statistics/health("FlowMaster v5"); SSE 可恢复事件流。
样式: StatisticsView-huzBM7kl.css 全部(注意 CSS 尾部二次覆盖: active #eef4fa/#1e4d8c, 按钮族 #9bb8d8 边, hover #173a6a — 覆盖初始 indigo)。

## 6. M4 科研绘图(VizView-DKRGiXDc.js 5034 行; decoded-stats-viz.md §2)

| 闭源 | 还原目标 | 要点 |
|---|---|---|
| VizView 主 L3301 data-v-df5821c7 | VizView.vue | header(tab 图表/任务视图+新建 confirm+删除 3s 二次确认); 负 margin 撑满(width calc(100%+48px)); 画布 tab 条 ≤8; 底部信息栏 260px(数据/图注/代码); 代码语法高亮 Ye() 手写正则 |
| VizChatPanelV2 L449 data-v-cca9ccd1 | VizChatPanelV2.vue | expose 全套(messages/sessionId/restoreFromVizJob…); 发送主链 d()→POST /api/viz-jobs(body 全字段含 journalConfig Nature 89×62.3 等)+AbortController SSE; 13 事件分发表; 自动保存 300ms→viz_v2_<uid>_<taskId>+tasks/:id/nodes/viz_chat(409 静默); markdown 手写正则(v-html+XSS 转义); 上传 data-upload; 剪贴板图; 0.4×字数 token 估 |
| VizThinkingTrace data-v-8281c8a5 | ThinkingTrace.vue | goal 行 + 折叠 chevron + command-cursor 闪烁 |
| VizTaskWindow data-v-d32f1a3a | TaskWindow.vue | 任务列表→缩略卡; select-job→M() 三级恢复 |
| ChartRenderer data-v-4f047ab7 | ChartRenderer.vue(共享) | mermaid→DOMPurify ADD_TAGS svg; echarts→init+ResizeObserver |

契约: /viz-jobs CRUD+versions+stream; /viz2/status 30s 心跳; chart PNG 三态(路径/dataURL/裸 base64)→He() blob 化 4 次重试(150ms*(attempt+1))。
localStorage: viz_v2_* / viz_active_job_<uid> / viz_save_<uid>_<taskId>(画布图卡, 四层兜底恢复 Qe) / viz_chat_<uid>; URL /viz?new=1&reset=1&jobId=。

## 7. M5 在线科研工作流 5 视图(decoded-workflow-*.md ×4)

### 7.1 InputView(Phase1)
| 闭源 | 还原目标 |
|---|---|
| OutlineEditor data-v-e03bb037 | views/workflow/OutlineEditor.vue: 大纲 markdown ↔ 树双向(7 类标题正则, 只收 1/2 级); 中文数序号; 加/删/上移下移/折叠/插入五章模板/清除; 空态"目录为空"+红链; sr-only textarea workflow_outline 同步 |
| InputView | InputView.vue: 主题/字数预估(3000-50000)/额外要求/方法 3 卡/参考文件(拖拽 4 类解析管道 txt/mammoth-docx/pdfjs-pdf)/agent 引导提问手风琴 4 态 + 180s abort→TIMEOUT; submitAnalysis 链: 校验→POST /api/projects→publishPhase1 10 字段→createPhase2→跳 sections; onInput autoSaveDraft(skf_draft) |

### 7.2 SectionsView(Phase2)
单文件纯消费页: 页头统计; AI 横幅 3 态 + 3 步进度 + 打字机(20ms tick, chunk clamp 8-40); 变量/因素卡(角色色板 定量 5 色/定性); 假设解析 j()(定性空; ```json conceptModel.hypotheses → 行正则 → 兜底配对); 章节树(+字数徽标"{wordCount} 字(Phase 1 分配)"/frameworkSource amber/chapterDraft); 确认门 confirmSections(空/未完整/stale 三拒); 恢复: window.__rfSSEVariables/__rfSSESkills 回调 + resumeActiveWorkflowJob。

### 7.3 MaterialsView(Phase3, 10 组件)
- 智能生成编排 `na` composable(计划→确认弹层三段 checkbox→三段式执行 B→z→F, 成功 toast 计数; 直连 fetch POST /api/statistics/api/analyze/{method} 生成数据素材)
- 文献解析 `la`(DOI `10.\d{4,}`/年份/APA·GB 混合/批量粘贴)
- 组件: DocumentImportPanel(上传流式)/MaterialSourcePanel(5 分类手风琴+头按钮)/MaterialJobStatus(literature.group_completed/recovered)/MaterialReviewPanel/MaterialPublishBar/MaterialAllocationDialog/MaterialList(文献卡含来源徽章/GB 引用/三线表)/MaterialEditorDialog(手动添加校验+批量解析)/MaterialGenerateDialog(AI 单类生成)
- 发布链: 无素材/未关联/phase2 stale 三拒 → publishPhase3 {materialUsages status:"adopted"} → /workflow/workspace
- localStorage: wf_save_<uid>_<taskId>; material 对象全字段(4.4 表, source.sourceStatus.ncpssd/wanfang, references[].gbRef)

### 7.4 WorkspaceView(Phase4)
三栏: SectionNavItem(递归/红数字/绿点 generated/琥珀 generating/选中红边)/SectionGenerator(状态胶囊+禁用门禁)/MaterialCard(图标类型表/已关联琥珀警告/hover 插入删除); 单节生成 SSE phase4.section_delta(sectionId 过滤); 批量生成(深快照 T 全字段→整批还原/成功可回滚 Fe/Ae; window.confirm); 恢复 getLatestPhase4; 主控 AI 面板消费 skills 事件; 素材生成弹窗→POST /api/ai/material/generate; 进合稿门禁。

### 7.5 FinalizeView(Phase5)
三轮: merge(时间轴 5 步 H() 节流补齐 <2s → 引用编号重建 fe(§REF_a_b§ 顺序 [n] + gbRef 拼表) + 表格重编号 xe)→ review(琥珀流/绿结果)→ revise(S 待采用 + 查看差异 + activatePhase5Version); 元数据三档解析 be(对象/标记/Markdown); mergeGenerated 编辑态(5 受控区 + MarkdownEditor render-opts materials); 导出 docx(paperExport)/pdf(docx+提示)/md/html(表题提升 + A4 印刷 CSS); 打印页眉/页码; isFinalized=true; localStorage skf_draft 等。

### 7.6 阶段版本链(贯穿)
publishPhase1→phase2 SSE→confirmSections(phase2Version)→materials publishPhase3(phase3VersionId)→phase4 batch(phase4VersionId)→phase5 merge/review/revise(phase5VersionId activate)→isFinalized。每阶段 getCurrent 校验 stale。watch 防抖 500ms saveProject + saveCurrentNode 双通道。

## 8. M6 可视化 DAG(QuickModeView-DJU6Ms4b.js L13473+; decoded-workflow-quick.md)

| 闭源 | 还原目标 | 要点 |
|---|---|---|
| AgentFlowNode L13403 data-v-be4e6308 | quick/AgentFlowNode.vue | 纯模板 190×190; 7 段信息(header index/module/menu + title 2 行截断 + progress + meta 输入输出 + footer state/artifacts/arrow + hint/executionDetail/outputPreview 120 字) |
| AgentFlowCanvas L13526 data-v-0bebca05 | quick/AgentFlowCanvas.vue | props/emits 照表; **@vue-flow/core**(npm, 不内联); Kahn 拓扑布局(vertical<1080 左右错 225/horizontal 层距 225/235); 三色边体系 configured-edge-/agent-edge-/manual-edge- + markerEnd ArrowClosed + active #7184f5 2.4px/animated; 环路防护(BFS); 手动边接管 Set; Background pattern #00FFFF gap24; MiniMap node-color(active #7184f5/done #43a18d); fitView debounce 40ms |
| QuickModeView L14304 data-v-1606ef93 | quick/QuickModeView.vue | 巨型状态机 9 态(draft→confirming→locked→running→pause_requested→paused→completed→failed→cancelled); 节点注册表 phrase1-5+standalone 模块(statistics/viz/review); V 契约表 inputTypes/outputTypes/requiredInputs/canRetry; 800ms 轮询 Dn()(指纹去重 N/节点消息复用 T); 7 类消息卡+filter; 意图对话 jl()(特殊命令正则/2 轮追问 Bn/双选项卡/中文主题判定 8 字 6 汉); 右键菜单(空白 4 入口/节点详情+删除+系统节点禁删); phrase1 表单/Phrase4 预览聚合/Phrase5+done 终稿+Word 导出 lu(); localStorage lastTask_workflow/dag_intake_context |
| 消息 kinds | — | text/question(2 选项卡+missingInputs chips)/plan(勾/点)/progress/artifact(查看关联节点)/node-update |

DAG 契约(全): dag/tasks GET PUT plan run / dag/jobs get pause resume cancel retry {fromStep} / workflow jobs 全套(Vt) / versions ga / materials Fs / ai navigation G0(意图+research-session 全套) / tasks Rt。→ §9 映射表。

## 9. 后端契约映射表(闭源 → 我方 Fastify, 待后端侦察代理归并后冻结)

| 闭源端点 | 我方现状 | 处置 |
|---|---|---|
| (表格占位 — 由后端侦察代理 a1e04d4f 结果填充; 现有已见: /api/editor/v1/ai/jobs 四端点已在 server.ts:9929-9948; /api/research/* 任务/项目/材料/版本全系已在; 差异集中在 /tasks、/dag/*、/workflow/jobs 前缀命名) | | |

## 10. 执行顺序

1. **S0 脚手架提交**: npm 依赖 + vue 子工程骨架(vite/pinia/router/health 页) + 父级注册表 6 入口 + dev proxy + 后端映射表初稿 → 提交 `chore(socialsci-vue): 脚手架`。
2. **S1 M1 editor**(独立后端契约最清晰, 全自含) → 提交+浏览器实测。
3. **S2 M3 statistics**(无 SSE 复杂态, 17 模板+轮询) → 提交。
4. **S3 M4 viz**(SSE 13 事件最难协议) → 提交。
5. **S4 M2 review**(store 状态机+三态渲染) → 提交。
6. **S5 M5 workflow 5 视图**(依赖 S0-S4 共享层全, 视图量大) → 每视图可拆 1 提交或整模块 1 提交。
7. **S6 M6 quick DAG**(状态机最大) → 提交。
8. **S7 收尾**: 全量浏览器实测 6 模块 + 对照清单产出(闭源功能点→还原后→实测证据, docs/socialsci-chunks/VUE-VERIFICATION.md) + sync-open 链。
每阶段: vue-tsc + vitest(主)零回归 + LF 行尾 + 证据截图/console 输出入提交说明。
