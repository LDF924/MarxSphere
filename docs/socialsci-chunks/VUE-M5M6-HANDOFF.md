# M5 Workflow + M6 QuickMode 实施交接(2026-09-08 会话 2 续做)

> 背景: 本文件由会话 1(已提交 M1/M2/M3/M4)撰写, 会话 2 依据此文档续做 M5/M6。
> 环境: worktree cranky-babbage-0a2349; 后端 4173 已由 worktree 代码 + .env(EMPIRICAL_PYTHON) 运行; vue dev 5174。
> 浏览器登录态: soc_test token 已注入 localStorage(skf_auth_token + sag_token)。
> 测试账号可重新注册: POST /api/auth/register {username,password,email} → {token,user}(注册即登录)。
> 每模块 1 提交纪律; vue-tsc + npm test 零回归; LF(gitattributes 已强制)。

## 已验证契约(后端 server.ts 实测)
| 用途 | 端点 | 响应 |
|---|---|---|
| 建项目(workflow 容器) | POST /api/research/projects {title,...} | {id}(projectId) |
| 任务 | POST /api/research/tasks {projectId,module,goal,phase,phaseLabel,jobKind} | {task} |
| 节点 KV | GET/PUT /api/research/projects/:pid/nodes/:key {payload} | nodes: input/sections/materials/workspace/finalize/viz_chat/viz_data |
| 快照(23 键池) | GET/PUT /api/research/projects/:pid/workbench | 全字段 |
| 执行调度泵 | POST /api/research/engine/run | 2s 泵已在 server 10625 起 |
| 后台 job 执行 | 建任务时 jobKind=phase4_batch/merge/review/revise/literature-search/theory-generate/table-generate → 泵自动跑 | 进度查 research_tasks.progress{current,total,stage} |
| 产物回写 | phase4_batch → nodes/sections payload.sections[] 含 content+status; merge/revise → nodes/finalize + project merged_* 列 | — |
| 素材 | /api/research/materials CRUD /allocate /review /generate | kind: citation/theory/data_result/figure/file |
| 章节技能卡 | POST /api/research/projects/:pid/skill-card + batch + workbench | aiSkill 语义 |
| 回滚 | POST /api/research/projects/:pid/nodes/sections/undo-batch | batch:pre 锚点 |
| versions | POST /api/research/projects/:pid/publish + /versions + /versions/:v/activate | 指针快照 |
| phase 链 stale | GET /api/research/versions/current(L10545) | {state:{...}} |

## M5 前端已完成(会话 1)
- `web/socialsci-vue/src/views/workflow/stores/workflow.ts` — 全量 store(已在 main 3f4f8ed 提交后新增未提交):
  refs: taskId(projectId)/phase/input{title,outline,totalWordCount,researchMethod,requirements,sampleFiles,clarifyAnswers}/
  sections[]/variables[]/hypotheses[]/stepAnalysisTexts/skillThinking/skillStep/project{logicFlow}/
  版本链 inputVersionId..phase5VersionId + *Stale/materials[]/materialAllocation/activeSectionId/textFlow/
  merged*(Title/Abstract/Keywords/FullText/References)/mergeGenerated/isFinalized/reviewResult/exportStatus/exportFormat
  methods: ensureTask(复用 in-progress workflow 任务或建)/saveProject(workbench 全量)/loadProject/loadMaterials/saveMaterials/goto(phase+save)

## 待建文件(会话 2, 按依赖序)
```
web/socialsci-vue/src/views/workflow/OutlineEditor.vue   # Phase1 大纲双向序列化(闭源 OutlineEditor-DECODED.md)
web/socialsci-vue/src/views/workflow/InputView.vue       # Phase1: 主题/字数/方法卡/参考文件/澄清问答→submitAnalysis
web/socialsci-vue/src/views/workflow/SectionsView.vue    # Phase2 纯消费: 变量卡/假设/aiSkill 章树/3步进度/打字机
web/socialsci-vue/src/views/workflow/MaterialsView.vue   # Phase3 5 分类手风琴/执行计划确认/生成
web/socialsci-vue/src/views/workflow/WorkspaceView.vue   # Phase4 三栏: 章导航/正文生成/素材卡
web/socialsci-vue/src/views/workflow/FinalizeView.vue    # Phase5 合稿三轮/导出
web/socialsci-vue/src/views/workflow/PhaseProgressBar.vue # 6 节点进度条(深采 ppb-*)
web/socialsci-vue/src/views/shared/MarkdownEditor.vue     # workspace/finalize 用
web/socialsci-vue/src/views/shared/PaperPreview.vue       # 终稿预览(PaperPreview-DVOZcwe9.css)
```
路由已注册占位在 router.ts(需替换 PlaceholderView→真实组件): /workflow/input|sections|materials|workspace|finalize

## OutlineEditor 关键算法(闭源 OutlineEditor-DECODED.md)
- props: modelValue String; emits update:modelValue/change
- 大纲文本→树解析 L(): 7 类标题正则 — `#~######`(cap3) / `1.2.3`(cap3) / `1.`(1级) / `第X章`(1)`第X节`(2) / `一、`(1)`（一）`(2) / 缩进 bullet(≥4 空格3/≥2 空格2/否则1); 只保留 1/2 级
- 序列化 B(): "一、标题" + 子节 "  1.1 标题"(中文数 一~二十)
- 行工具: + 加子节(一级 hover)/折叠▼▶/↑ 首行 disabled/↓ 末行 disabled/✕; 空态 "目录为空,请添加章节或插入模板"+红链(workflow_outline_insert_template_empty)
- 插入模板: 五章固定大纲(引言1.1-1.3/文献综述2.1-2.3/现状3.1-3.2/问题对策4.1-4.2/结语5.1-5.2)
- watch modelValue → 解析; 编辑回写抑制位 v 防循环; sr-only textarea(workflow_outline)同步单真源

## InputView 提交链(闭源 B3)
submitAnalysis: 校验(主题≥4字非纯数字/outline 非空) → POST /api/research/projects {title, template:"five-stage"} → 建 task(module=workflow) → 写 nodes/input {input 快照+outline+sectionsList 由 outline 解析} → phase=2 → 跳 /workflow/sections
- 主题字段 data-assistant: workflow_research_title/total_word_count/outline/requirements/method_{qualitative|quantitative|mixed}/submit_analysis
- 澄清问答: POST /api/clarify/generate {title,outline,requirements,researchMethod,totalWordCount} → 手风琴(importance=高 红"核心问题")
- 参考文件 4 管道: txt FileReader/docx mammoth 动态/pdf pdfjs 动态; 分发失败 toast

## SectionsView(Phase2 纯消费)
- 挂载: loadProject → 若无 phase2 进行中 job 则 createTask{jobKind:"analyze", goal:title} + sections 种子(从 outline 解析或 workbench 恢复) → 泵跑
- 轮询 research_tasks progress{stage,current,total} + result.structured{skills,variables,logicFlow,stepAnalysisTexts,hypotheses}
- 结果回填: nodes/sections 由后端 phase4 类执行器写回前, 先由 analyze 执行器(result.structured)落 workbench 快照 → loadProject 恢复
- UI: 3 步进度(变量识别/框架分析/Skill生成)+打字机(20ms tick chunk=clamp(8..40,ceil(rem/20)))+变量卡(role 色: 自变量红/因变量灰/中介紫/调节琥珀/控制)+假设列表+章树(aiSkill 字数徽标 "N 字(Phase 1 分配)")
- 确认门 → phase=3 → /workflow/materials

## MaterialsView(Phase3)
- 5 分类(文献检索/表格素材/理论素材/数据分析素材/附件素材)手风琴; AI 生成走 createTask{jobKind:literature-search|table-generate|theory-generate, inputSnapshot:{sectionId,sectionTitle,keywords,prompt,tableType}}
- 执行计划: createTask{jobKind:"material-plan"} → result.plan{literatureSearch[],textTables[],dataAnalysis[]} → 确认层 → 逐段执行
- 轮询 job progress+result → materials 落库(research_materials kind=citation|theory|data_result)
- 素材手动: POST /api/research/materials {projectId,kind,title,contentMd,sectionIds}
- 发布: POST publishPhase → phase3VersionId → phase=4 → /workflow/workspace

## WorkspaceView(Phase4)
- 章列表: nodes/sections payload.sections[] (status/content) — loadProject 后从该节点拉
- 批量生成: createTask{jobKind:"phase4_batch", inputSnapshot:{sections:[{id,title,level,skill_prompt}]}} → 泵跑 → 轮询 progress → 完成后从 nodes/sections 回读 content
- 深快照回滚: batch 前存 localStorage wf_save_<uid>_<taskId>; undo-batch 端点
- 单节生成: createTask{jobKind:"phase4_batch"} 单节同路径(后端 runChapterBatch 支持单节)

## FinalizeView(Phase5)
- merge: createTask{jobKind:"merge", inputSnapshot:{sections:[{title}], chapterContents: 各章 content}} → project merged_* 列回读
- review: createTask{jobKind:"phase5_review"} → project.review_result + finalize 节点
- revise: createTask{jobKind:"phase5_revise"} → merged_fulltext 覆盖
- 导出: md/html 拼装(表题 **表N** 提升 .rf-table-caption + A4 印刷 CSS); docx 走闭源 paperExport 前端 docx 库(Packer)
- isFinalized=true → 收尾

## M6 QuickModeView(最后)
- @vue-flow/core 已装; AgentFlowNode(纯模板 190px)/AgentFlowCanvas(布局 Kahn+三色边)/QuickModeView(9 态状态机)
- DAG 持久化: nodes/quick_graph {workflowMode,nodes,edges}; lastTask_workflow localStorage
- 意图对话: POST /api/research/ai-intent(如未补端点→前端规则兜底)

## 通用要点
- 5 视图都挂 ToastHost; 阶段页头复用 phase-progress(6 节点: 研究主题→1信息录入→2科研架构→3素材准备→4文本创作→5合稿定稿)
- 全部写操作防抖 500ms saveProject(store 内已含); watch phase===N 自动 save
- 每视图 data-assistant-* 属性按 DOM 深采(workflow_research_title 等)标注
- 后端无逐字 SSE(泵+轮询): 前端统一 600-800ms 轮询 research_tasks?projectId&jobKind + progress/result; 打字机用 stage 文案驱动
- 主题色: 主按钮 bg-red-600; 页面 max-w-4xl/5xl mx-auto px-6 py-8
