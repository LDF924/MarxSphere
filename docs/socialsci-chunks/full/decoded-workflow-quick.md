# 闭源 Vue3 科研工作流前端解码 —— QuickModeView(可视化 DAG 编排) + 共享 API 契约层

> 来源: `QuickModeView-DJU6Ms4b.js`(18020 行, 已 prettier 格式化, 含 vue-flow 库本体 ~13470 行内联) + 共享模块 `index-xpWAkSSw.js`(20133 行格式化版, 全部 API 服务封装于此)
> 本文件覆盖面: **QuickModeView 全组件解码 + 共享 API/服务层契约**; 其余视图(Materials/Workspace/Finalize/Sections/Input)单独文档。
> 行号均指 `formatted/` 目录下格式化后的文件。

---

## 0. 模块边界总览(重要前置)

- `QuickModeView-DJU6Ms4b.js` **L1-13472**: vue-flow(vue-flow-core)库本体 + 少量库内 helper。行 1232 `Id={passive:!1}`、行 4417 `Da={...}`(库内组件)、行 4464 `(this.name="VueFlowError")`(库错误类)、行 9433/9708(库组件)。**复刻时直接引 npm `@vue-flow/core`, 不必看这一段。**
- **业务代码起于 L13473**。三个业务组件:
  - `AgentFlowNode` (L13403-13522, scopeId `data-v-be4e6308`) — vue-flow 自定义节点
  - `AgentFlowCanvas` (L13526-14200, scopeId `data-v-0bebca05`) — vue-flow 封装画布
  - `QuickModeView` (L14304-18019, scopeId `data-v-1606ef93`) — 主视图,默认导出(L18019 `export { k_ as default }`)
- 全部 API 调用经共享模块 `index-xpWAkSSw.js` 的具名服务对象;QuickModeView 引用的别名: `dt=Q0`(DAG)、`Mu=Vt`(workflow jobs)、`Tu=Rt`(tasks)、`na=ga`(phase1/phase3 versions)、`Au=Fs`(materials)、`Iu=G0`(ai navigation)、`ku`=router、`Pi`=PaperPreview 子组件(独立 chunk)、`Du`=Packer/docx、`Pu`=FileSaver、`zu`=paperExport。
> **行号修正说明**: 初稿引用的 setup 内函数行号普遍前移(因 minified 源码中 const 表在函数定义前),下方为精确锚点,请以本文 **§3 各节函数行号** 为准。

---

## 1. 组件树 QuickModeView(scopeId data-v-1606ef93)

### 1.1 布局骨架(单文件三栏布局, 无嵌套视图路由)

```
T1 div.quick-view                        L16418
├─ header.quick-header                   L16422 (Eu 静态 HTML 注入):
│   brand-lockup(Q logo) · 标题"可视化DAG编排模式" · mode-tabs · preview-badge"开发中"
├─ main.quick-shell                      L16451
│   ├─ aside (左栏对话)                  L16452
│   │   ├─ header.agent-panel-header: 科研 Agent 头像+在线态+副标"确认研究目标后自动连续执行至出稿"
│   │   ├─ 按钮组: 紧凑 run 按钮(ke 文案 暂停/恢复/重试)、mobile-canvas-toggle(画板/对话)、panel-toggle ＋(新建对话→qr)
│   │   ├─ .conversation-context: 当前任务标题+stateLabel (be)
│   │   ├─ .conversation-stream (ref j / conversationRef) → v-for 消息卡片
│   │   │    消息 kinds: text/question/plan/progress/artifact/node-update
│   │   │    filter(模板 L16502): plan 由 dagChatUiConfig.showPlanCards; artifact 由 showArtifactCards; progress 由 showInternalProgress
│   │   ├─ thinking-row (z=处理中动画"正在整理任务计划")          L16886
│   │   ├─ agent-shortcuts (快捷按钮["帮我梳理研究框架","检索相关文献","检查当前进度"]) L16913
│   │   └─ form.composer: textarea(ref composerRef de) + send-button ↗  L16927-16977
│   ├─ section.workspace-stage (右区, is-mobile-visible=l)
│   │   ├─ div.canvas-stage (ref te) → He(A1 AgentFlowCanvas)  L17016
│   │   │    props: nodes=M/edges=d/locked=xe/editable=Ee/overlay-open; events: nodeSelected=cu graphChanged=Kl paneContextMenu=tu nodeContextMenu=nu
│   │   ├─ 覆盖层 canvas-start-gate (r==="draft" 时): "工作流已准备 · 开始自动执行"按钮→ve  L17034
│   │   ├─ canvas-lock-badge (锁定态)                            L17069
│   │   ├─ .canvas-context-menu (右键菜单 K)                      L17072
│   │   ├─ Transition workspace-panel → 右侧滑出工作界面 (ne 选中节点时)  L17138+
│   │   │   ├─ phrase1 分支: 研究任务初始化表单(主题 topic/目标 goal + 进度条 + 让 Agent 检查 Qr + 保存并进入 Phrase 2 uu)  L17255-17476
│   │   │   ├─ phrase4 分支: 正文预览(PaperPreview Pi; body=P||documentPreview; 刷新正文预览按钮→le) L17480-17566
│   │   │   ├─ phrase5+done 分支: 最终稿件(元数据/字数/参考文献条数 + Pi 论文版式 + 论文预览按钮→ue=!0 + 下载 Word lu) L17567-17662
│   │   │   └─ 其他节点(占位): 模块工作区描述+实时进度/输出 + "让 Agent 开始处理"→Qr  L17663-17730
│   │   └─ Transition drawer-slide → aside.node-drawer (节点详情抽屉 w 且非 workspace 展开时) L17731-17906
│   └─ (Teleport to body Cu): PaperPreviewModal (ue && Rt() 时)  L17908-18017
```

### 1.2 消息 kinds 与渲染结构(对话流核心 UI 状态)

| kind | 渲染 | 关键数据字段 | 模板位置 |
|---|---|---|---|
| text(agent/user) | .message-bubble 文本 | text/time | L16539 起 |
| question | .question-card | target(当前目标)/understanding(已识别)/autoFill(AI已补全)/question(主问句)/templateFields(可选补充)/options(单选按钮 is-selected)/missingInputs(批量补齐 chips) | L16606-16778 |
| plan | .plan-card "执行计划 N 个步骤" | items[{label,module,state(done✓/active•)}] | L16779-16836 |
| progress | .progress-line | module+progress% | L16839 |
| artifact | .artifact-card | icon/title/detail/nodeId("查看关联节点 ↗") | L16852-16884 |
| node-update | .node-update-heading+detail | nodeId/title/state/statusLabel/detailLabel/detail/preview/artifactCount | (消息头 L16543 附近, 结构体见 4.2.4) |

### 1.3 setup 顶层状态清单(QuickModeView)

| ref | 初值 | 含义 |
|---|---|---|
| t | `_e("quick-demo")` | 当前会话/任务条目 id(卡片列表 C 中) |
| n | `_e(!1)` | 新建本地草稿标记(未落服务端) |
| o | `ku()` | router |
| i | `ye(()=>o.dagChatUiConfig)` | DAG 对话 UI 配置(共享 settings store) |
| a | `_e("standard")` | workflowMode: standard/custom/standard_plus_extensions |
| r | `_e("draft")` | 运行态状态机(见 4.2.2) |
| s | timeout id | 暂停兜底计时器 |
| l | `_e(!1)` | 移动端画板/对话切换 |
| u | `_e(null)` | 服务端 taskId(dag task) |
| c | `_e("")` | 任务创建错误信息 |
| d | `_e([])` | **用户配置边**(canvasPosition 布局边; 来自画布手动连线) |
| v | 保存中标记 | |
| p | `_e(null)` | plan 结果(服务端 run 前 plan 的返回) |
| S | `_e(null)` | DAG jobId |
| E | interval id | 800ms 轮询定时器 |
| T | `new Map()` | nodeId → 消息 id(node-update 消息去重定位) |
| N | `new Map()` | 节点进度指纹(nodeId → 指纹串, 去重) |
| L | `_e("")` | 输入框 v-model |
| w | `_e(null)` | 节点详情抽屉节点 |
| z | `_e(!1)` | 意图解析处理中(thinking) |
| Z | `_e(0)` | 追问轮次 intakeRound(0-2) |
| J | `_e(!1)` | awaitingExecutionConfirmation |
| ee | `_e(new Set())` | 已问过的字段(askedInputs) |
| j | 对话滚动容器 ref | scrollTop=scrollHeight(Jl) |
| de | 输入框 ref | |
| te | 画布容器 ref | |
| K | context-menu 状态 {visible,x,y,nodeId,nodeTitle,position,canDelete} | |
| A | `_e(null)` | 选中节点 id(workspace 面板) |
| ue | `_e(!1)` | PaperPreviewModal 显隐 |
| h | `_e(!1)` | Word 导出中 |
| I | `_e([])` | materials(终稿导出时收集) |
| m | `_e(!1)` | 材料恢复加载中 |
| D | `{taskId,versionId,body,sectionCount,loading}` | phrase4 正文预览聚合缓存 |
| b | `{topic,object,type:"理论研究",goal,boundary}` | Phrase1 草稿表单(自动持久化) |
| C | 任务卡列表 `[{id:"quick-demo",title:"新建科研任务",state:"draft"}]` | |
| M | **节点数组**(初始为空; 显式启动时填充 7 节点, 见 3.2) | |
| q/F/Y | 入口卡片/标准非独立节点模板/右键新建菜单 | |

### 1.4 生命周期/持久化(watch 图)

- `Ae(W, ()=>et(Jl), {deep:!0})` 对话滚动到底 (L15615)
- `Ae([b,W,Z,J], H, {deep:!0})` H=写入 localStorage `dag_intake_context` (L15616; key 常量 Zi L14303, H L14361, O L14399)
- onMounted: `localStorage.lastTask_workflow` 存在则 `Yr(g)` 恢复 (L15617-15621)
- onUnmounted: 清 interval (同组 _r, L15623)
- watch(computed 组合串 `taskId:nodeId:finalData.body.length:phase4VersionId` L14768-14784) → phrase5 时 k()(收材料)+phrase4 时 k()+le()

### 1.5 持久化 key 清单

| key | 内容 | 读写函数 |
|---|---|---|
| `lastTask_workflow` | 最近服务端 DAG taskId | Xr 读; Yr 404 时删 |
| `dag_intake_context` | {taskId, phrase1Draft, intakeRound, awaitingExecutionConfirmation, messages[](仅 text/question/plan 后 20 条), updatedAt} | H 写 L14361 / O 读 L14399 |
| `skf_auth_token`(共享层) | Bearer token | Yl/ap |
| `skf_settings`(共享层) | 全局设置 | settings store |
| `researchflow:auth-expired`(共享层) | CustomEvent 名,401 广播 | Bw |

---

## 2. 子组件解码

### 2.1 AgentFlowNode(自绘节点, 仿 AgentFlowNode 闭源样式)

- **L13403-13522**, props: `{id:String req, data:Object req, selected:Boolean=false}`, 无 emits/setup 逻辑(纯模板组件)。
- 根: `div.agent-flow-node.is-{state} [.is-selected/.is-locked/.is-system-start]` role=button
- 内部结构(自上而下):
  1. Handle target(Nn=库内 Handle): `type="target" position=layout==="vertical"?Top:Left, class="flow-handle"` — `hasTarget!==!1` 才渲染 (L13435-13452)
  2. `.node-header`: `span.node-index`(如 "01"/"M01"/"00"/"END") · `span.node-module`(如 "STANDARD WORKFLOW") · `.node-menu`"…"(静态)
  3. `.node-title-row > strong`(title, 两行截断)
  4. `.node-progress`(data.progress!==undefined): `span.node-progress-track>i{width:progress%}` + 百分比文字
  5. `.node-meta`×2: 输入(左小字)+`span.node-value`(data.input||"待分配"); 输出(输出 data.output||stateLabel)
  6. `.node-footer`: `.node-state`(.node-status-dot + stateLabel) · `.node-artifacts`(□ N 产物) · `.node-arrow`"→"
  7. 条件块: `.node-hint`(data.hint,青蓝强调)/`.node-execution-detail`(data.executionDetail)/`.node-output-preview`(最后 120 字预览)
  8. Handle source: `position=Bottom/Right`, 同样 class flow-handle; `hasSource!==!1` 渲染 (L13488-13505)
- data 字段全集(由父组件填充): `{index,module,title,state,stateLabel,input,output,progress,artifactCount,layout,locked,hint,executionDetail,outputPreview,documentPreview,hasTarget,hasSource,systemStart,workflowNode→原节点}`

### 2.2 AgentFlowCanvas(画布编排容器)

- **L13526-14200**, scopeId data-v-0bebca05
- props: `{nodes:Array=[], edges:Array=[], expanded:Boolean=false, fitRequest:Number=0, locked:Boolean=false, editable:Boolean=true, overlayOpen:Boolean=false}`
- emits: `["node-selected","expand","pane-context-menu","node-context-menu","graph-changed"]`
- setup:
  - `i={agent:AgentFlowNode}` 节点类型表
  - 内部状态: `a=[]`(已渲染 vue-flow 节点)、`r=[]`(渲染边)、`s=[]`(用户手动加边)、`l=Set`(被接管重连的边 id)、`u` 容器 ref、`c=0`(容器宽度, ResizeObserver 观测)
  - `Be(S)` 得 vue-flow 实例方法 `{fitView, screenToFlowCoordinate, updateEdge}` (L13549)
  - 布局引擎 `te(nodes,edges)` L13593-13816:
    - 空 → 单节点 "agent-start"(00/SYSTEM/开始/待输入,"请在左侧对话中描述需求",无进出边)
    - 拆分 standalone(模块)与非 standalone(主流程); Kahn 拓扑排序(k 队列+入度减) → 层级深度 $
    - **vertical**(宽 <1080, isNarrow): 开始节点 top 居中, 主流程节点按层纵排, 同层左右错开 `(X%2)*225`; horizontal: 主流程从左到右横排,层号决定 X 偏移
    - 布局碰撞规避 `j`(205×220 距离内冲突)与 `de`(坐标夹取 + 纵向下移兜底)
    - 模块节点 re() 排布在主流程下方/右侧, `agent-result`(END/结束/任务终点)收尾
    - **ID 约定**: vue-flow 节点 id=`agent-{workflowNode.id}`; 开始="agent-start"; 结束="agent-result"; 边 id 前缀 `configured-edge-`(服务端配置边)或 `agent-edge-`(自动补边)或 `manual-edge-`(用户拖拽)
    - 边推导: 用户边(source/target 为 workflowNode.id)→lt() 映射 `agent-` id; 若主流程节点无连边(Fe.length>2 且缺首/尾边)则自动补边 Tn; 完全无用户边时按主流程顺序链 Ei
    - 边样式: markerEnd=ArrowClosed; 颜色/线宽: 目标节点 state==="active"→`#7184f5` 2.4px, 否则 `#a6b2cf` 1.8px (An L13792); animated=目标节点 active
  - 重算入口 `K({fit})` L13823: 监听 props.nodes/edges/locked/editable 变化与容器宽度跨档(1080)变化; 首次或显式 fit 时 debounce 40ms fitView(padding 0.14/0.18)
  - 手动连线校验 `I(onConnect)` L13917-13962: editable、非自环、两端节点存在、无重复边、**不成环**(h=BFS 从 source 沿现有边查是否可达 target)
  - `m(onEdgeUpdate)` 重连边: 校验同 I; `N(edge,connection,false)` 更新; 原 id 若以 manual-edge- 开头则继续手动标记,否则记入接管 Set l → 重算时 K 会把接管边排除自动补边; 触发 ue() graph-changed
  - `D(onEdgesChange)` 仅处理 type==="remove"(删除手动边; 自动边禁止)
  - `b(onNodesChange)` 仅处理 type==="position" 且非 dragging 结束 → ue()
  - `H(onNodeClick)` → emit node-selected(workflowNode 原对象)
  - `ue()` graph-changed payload: `{edges:[{id,source(原id),target(原id),type}], nodes:[{id:workflowNode.id, canvasPosition:{x:round,y:round}}]}`
  - vue-flow 渲染(L14147-14212): Background variant="lines" **pattern-color="#00FFFF"** gap=24 size=1; MiniMap(pannable zoomable node-color 函数: active→#7184f5/done→#43a18d/其他#c3ccdc); Controls(库内 Ng)。min-zoom 0.35 max-zoom 1.8
  - 覆盖 .flow-toolbar: chip "标准工作流 · 主流程"(含 standalone 时追加 "按需调用 · 扩展模块")
  - emits `expand` 声明但模板未用(预留全屏)
- 样式语义类(主文件自带, 见 css 解码 QuickModeView 段): agent-flow-node/agent-flow-canvas/agent-flow/flow-toolbar/flow-zone-chip(main/extension)/flow-handle/node-* 全家桶

---

## 3. QuickModeView 业务逻辑流程(从中文文案+调用还原)

### 3.1 节点静态注册表(标准工作流 + 独立模块)

- **M 初始(被清空后由模板 F 补充)**: phrase1-5(STANDARD WORKFLOW, icon 01-05) + statistics/viz/review(独立模块 standalone) (L14432-14568)
  - 状态标签: draft→"待执行"; 描述含完整业务语义(如 phrase3 "汇总文献、量表、数据和图表素材,并将检索证据绑定到对应章节")
- **V 阶段契约表** L14569-14626(关键!): 每个节点定义 `inputTypes/outputTypes/requiredInputs/canRetry`
  - phrase1: input research_intent → output task_context; phrase2: task_context→outline(必输 task_context); phrase3: outline→evidence; phrase4: outline+evidence→draft; phrase5: draft+evidence→manuscript(required only draft); statistics: dataset→analysis_result; viz: dataset+analysis_result→chart; review: draft→review_report
- **q 入口卡片** 4 个: workflow(标准工作流 ⌁teal,route /workflow)/statistics(◒orange)/viz(⌘purple)/review(✓red) — 卡片显示在"新建"处与点击画布空白处右键菜单; 每卡片含 route 用于跳转独立模块视图 (L14627-14654)
- **Y 右键菜单项**: workflow→"新建标准工作流"; 其余→"新建{title}" (L14673-14680)

### 3.2 节点模型与状态机

节点(state=8 值)语义 (L15058-15069):
`draft待执行 / queued排队中 / running执行中 / paused已暂停 / completed已完成 / failed执行失败 / cancelled已取消 / blocked已阻塞(等待上游修复)`

**服务端 job 恢复 → 本地节点状态映射**(Dn L15365-15379): job.steps[].status: completed→node done(100%)、running→active(progress 取步骤内联计算 5-95%)、failed→failed、queued→queued、cancelled→cancelled、默认 draft; **failed job 时后续 queued 步骤→blocked**(L15370-15372 "已阻塞(等待上游修复)")
节点 state 与 job 内 step.result.nodeId 对应(不在同一步骤按 order 序号兜底)(L15349-15354)

**运行态状态机 r**(整个工作台, 9 态):
draft草稿可编辑 / confirming正在确认 / locked已锁定 / running自动驾驶中 / pause_requested正在安全暂停 / paused已暂停可编辑 / completed已完成 / failed执行失败可修正 / cancelled已取消可编辑 (L14692-14707)
- 迁移: `Mi()` 启动 draft→confirming→running; `eu()` 暂停 running→pause_requested(500ms 兜底→paused); `Ii()` 恢复 paused→confirming→running; Dn 轮询对账: 服务端 paused/failed/cancelled/completed/queued|running|validating|pausing 各态 (L15436-15451); completed 但节点未全 done → 判定 failed + 一次性提示 "任务记录显示已完成,但标准工作流节点未完整恢复..." (L15445)
- 轮询 `yo()`: `setInterval(Dn, 800)`(800ms 一次 DAG job 对账)

### 3.3 主执行管线 Phase1-5(自动连续执行核心)

触发: 对话确认 `Ur()`(保存 topic 到任务卡 → 装载 F 主流程节点 → 锁定 → 选中 phrase1 → `Mi()`)

`Mi()` 启动流程(L16060-16167)细分:
1. gate: 画板必须非空(Ni 校验: standard 模式缺 phrase1-5 任一即拒:"标准工作流缺少 xx,请先补齐")
2. 若 paused 且有 S → 直接 Ii() 恢复; 若 S 且 r=failed/cancelled → `dt.retryJob(S)` 重试
3. `Xr()` 拿 taskId: 本地草稿(u=null)时先试恢复 lastTask_workflow(Yr); 否则 `Tu.create({title,module:"workflow",status:"in-progress",phase:0,phaseLabel:""})` 建任务并写 lastTask_workflow (L15523-15563)
4. `Ql(taskId)`: `na.getCurrent(taskId)` 查当前输入版本 → 有则复用; 无则 `na.publishPhase1({taskId,title:topic,outline:goal||默认五部分综述文案,domain:type,researchMethod:type,requirements:boundary,totalWordCount:10000,sectionsList:[]})`, 返回 `{version:{id}}` (L15575-15615)
5. `wo()`: `dt.save(taskId,{workflowMode,nodes,edges,jobId?})` (L15563-15575)
6. `p = dt.plan(taskId, Kt())` (执行计划生成) (L16179)
7. `S = dt.run(taskId, Kt()).job.id` → r=running (L16181-16189)
8. 回写 `dt.save(taskId, 含 jobId)`; 首节点置 active; 选中 phrase1; 对话提示 "标准工作流已启动。"; `yo()` 开始 800ms 轮询

`Kt()` 快照体 (L15096-15102): `{workflowMode:a, nodes:M, edges:d(用户边,空则自动链 mt), jobId:S?}`

`eu()` 暂停(L16167-16185): 立即请求 `dt.pauseJob`(乐观),r=pause_requested,并 setTimeout 500ms:若仍未变则强制 r=paused 并提示 "任务已暂停,可以调整画板;点击恢复继续。"(服务端 pause 是 async 状态 pausing→paused)

`Dn()` job 同步(L15297-15410)细读:
- `dt.getJob(S)` → job 含 `steps[]`; 每 step 有 `step_no/status/error{message,detail}/attempt/completedAt/child{currentStep,steps[],status,result}`; step.result.nodeId 关联节点
- 每节点计算: progress(步骤完成数/总数, running 步计 0.35, clamp 5-95)、outputPreview=Ul 抽取、documentPreview=step.child 全文、executionDetail(failed 时 error.message/detail 否则阶段文案)、artifactCount、runtimeResult、phase4VersionId、finalData(phrase5 result.data)
- 阶段文案映射 mo L15091-15099: phrase1"正在确认研究任务输入"/phrase2"正在生成章节结构与写作依据"/phrase3"正在检索并整理研究素材"/phrase4"正在生成章节正文"/phrase5"正在贯通章节并合并定稿"
- phrase2 阶段详情: "结构生成步骤 {currentStep}/{steps 数或 3}"; phrase5: "合稿步骤 {currentStep}/4" (L15177-15182)
- **Ul 产物计数**: phrase3→pe.total 或 materialIds.length 或子结果汇总(素材条数); phrase4→result.sections.length|sectionCount; phrase5→data.body 存在即 1 (L15149-15174)

### 3.4 对话意图路由(ai/navigation)

`Ai()` 发送(L16393): push user 消息 → dagChatUiConfig.enabled 且 r∈draft/paused/failed/cancelled 时 `jl(g)` 走意图引擎; 否则只回一句状态提示(running 时 "任务正在运行...")

`jl(g)` 意图解析(L15708)最复杂:
1. 特殊命令正则 `(?:请)?(?:帮我)?(?:继续(?:任务|当前任务|流程)?|恢复...|重新开始|重启工作流)` → 按状态执行 Ii()/Mi()/提示 (L15711-15724)
2. 请求 `Iu.navigationIntent({message,context:{pageTitle:"可视化DAG编排模式",pagePurpose,currentState:{runState,taskId,hasCanvas,intakeRound,askedInputs}},profile:{topic,goal,researchObject,boundary,domain,researchType,method,outline,confirmedOptions,executionConfirmed},capabilityCatalog:{platformCapabilities:[workflow/statistics/viz/review 四能力 {id,title,route,actions}]},conversationHistory:最近16条消息拼装文本≤900字/条})` (L15735-15827)
3. 响应字段(契约): `{data:{success,interactionMode:"task_operation"|...,missingInputs[],options[{label,prompt}],templateFields,nextQuestion,clarification,clarificationQuestion,goalHint,domainHint,topicHint,needSummary,message,answer,taskAdvice,requiresExecution,autoFill{goal,researchObject,boundary,...},operationPlan[]}}` 或直接顶层 (L15840-15870)
4. 判定链(重要, 还原其 UX):
   - 无 interactionMode=task_operation 且非追问/自动执行意图 → 输出 Ie(答案/建议/操作计划拼接) (L15872-15890)
   - topicHint 回填 topic; 4 研究类型名单 ["理论研究","实证研究","综述研究","案例研究"] 过滤 domainHint (L15890-15930)
   - missingInputs 中 主题/核心问题 类过滤(topic 已给); 全量 slice(0,8)
   - 判定追问门槛: 消息带"确认/同意/按当前方案/可以开始/开始执行"(Jr) 或 requiresExecution===true 或 "你来决定/自动补全/默认"(Do) 且 (轮次≥2 Bn 且有主题)
   - **首条消息(Q=草稿无主题)**: 识别主题(lt 正则, 中文主题判定 Zt 8字符+6汉字以上并剔除纯指令串)→写入 b.topic; 问信息 Mt(nextQuestion 或 "方案已整理完成。确认后将按标准 Phrase 1–5 自动执行并生成最终稿,是否开始?", options=[{label:"确认方案并开始",prompt:"确认按当前方案开始执行标准工作流。"},{label:"先调整方案",prompt:"请先根据我的需求调整研究方案,暂不开始执行。"}]) (L15950-16020)
   - 追问轮次: Z 0→1 正常问; ≥2(Bn) 不再逐项问,输出 "已完成两轮集中补充。xx仍未明确,请在同一条消息中补充;其余信息将使用可修改的默认设置。" (L16060-16080)
5. 全部 catch → "当前无法完成这次需求判断...已保留你的研究主题,请重试或补充需求;在明确确认前不会启动工作流。"

`Mt()` 追加 question 消息(L14922-14950): `{role:"agent",kind:"question",question:文案,missingInputs(≤8),options(≤6,label/prompt 均去 tech 字段名化 Fe),templateFields(≤6),target,understanding,autoFill,selectedOption:"",optionSubmitted:!1,fieldSelected:"",batchSubmitted:!1,intakeRound}`

字段名→中文词典 Qe(L14851-14874): topic/title/researchTopic→研究主题; goal/researchQuestion→研究目标(问题); researchObject/object→研究对象; domain/field→专业方向; researchType/method→研究方法; boundary→研究范围; requirements→格式与特殊要求; totalWordCount/wordCount→篇幅要求; outline/sectionsList→章节结构; dataSource→数据来源。go()(L14966-14985)归一化英文键: topic→topic、goal→researchQuestion、researchObject、field、method、boundary、requirements、targetWords(词数)。

### 3.5 画布右键菜单动作

- 空白处(可编辑且非运行): `tu` → K={nodeId:null,...position 流坐标} 菜单项=Y(新建标准工作流 + 3 个独立模块 + 新建空白任务) (L16221-16231; 菜单 L17102-17137)
- 节点上: `nu` → nodeId(去 agent- 前缀)=菜单标题; canDelete=可编辑且非系统节点 (L16232-16245)
- `ou` 查看节点详情: 定位 M 节点→开节点抽屉 w (L16247)
- `iu(g)` 添加: id==="workflow"→重载标准 5 节点(+保留现有 standalone); 否则 push 新模块节点 `{id:`{g.id}-{Date.now()}-{rand7}`, module:g.id.toUpperCase(), title, state:"draft", standalone:true, canvasPosition:右键坐标}` workflowMode→custom (L16254-16289)
- `ru` 删除模块: canDelete 时 filter 掉, 关闭关联 workspace/抽屉, 保存 (L16290-16301)

### 3.6 Phrase1 工作界面(右侧滑出表单)

- 字段: 研究主题 topic(disabled=xe 锁定中) / 研究目标 goal textarea; 完成度=progress
- "先确认研究主题和目标/研究对象、类型与范围会根据你的描述由 Agent 自动补全" 提示条
- 按钮: "让 Agent 检查"→`Qr`(把当前节点输入完整性问题写入输入框并聚焦); "保存并进入 Phrase 2"→`uu`: 无主题拒("请先填写研究主题,确认后我会自动连续执行 Phrase 1–5。") → `Ur()`
- 修改 watch 自动 H() 写 localStorage

### 3.7 Phrase4/5 预览与导出

- `le()` Phrase4 聚合正文: 节点 data.phase4VersionId 存在 → `Mu.getPhase4Sections(taskId,versionId)` 拉 sections[{content}], join("\n\n") 存 D; D.taskId 与当前任务一致才复用缓存 (L14794-14831)
- phrase5 完成: watcher 触发 `k()` 用 `Au.list(taskId)` 恢复 materials 供 Pi 引用呈现; (L14738-14774)
- Pi PaperPreview 接收: {title,abstract,keywords,body,references,materials}
- `lu()` 导出 Word: `zu({title,abstract,keywords,body,references,materials})`(paperExport 模块)→Packer.toBlob→FileSaver.saveAs(`{title净化}.docx`); 标题非法字符替换 `[\\/:*?"<>|]→_` (L16327-16352)
- 节点抽屉: 输入/预期输出/当前进度/实时输出(仅前若干字符)/产物数 + "在画布打开工作界面"(Kr)/"让 Agent 处理此节点 ↗"(fu 把指令写入输入框聚焦)

### 3.8 历史任务恢复(挂载+新建后)

- 挂载: lastTask_workflow → `Yr(taskId)` (L15623-15626; Yr L15458-15527)
- Yr 内部: `dt.get(taskId)` → {graph:{workflowMode,nodes,edges,jobId?},task:{title}}; 无 graph/空节点→false; 恢复 workflowMode(非 standard/custom 均归 standard)、Se() 规范化节点、恢复 d、jobId→`dt.getJob` 映射 r 态与节点运行态 + Dn 全量刷新 + running 态启轮询; **stale job**(服务端无此 job)→清 S、节点全 done 则 completed 否则 draft、`dt.save` 覆盖 (L15488-15502)
- 404 → 删 lastTask_workflow (L15520)

### 3.9 新建任务 qr()

清全部状态,本地新卡 id=`quick-${Date.now()}`, r=draft, 模式取 `standardWorkflowEntryConfig`(enabled? defaultMode||"standard" : "custom"), 问候语 "新任务已创建。直接描述研究主题、希望产出和已有材料即可;缺少的信息我会集中补齐,确认后自动启动标准工作流。" (L15630-15664)

---

## 4. API 契约(全部经共享模块 index-xpWAkSSw.js; 行号为共享模块格式化行号)

> 请求封装 `q(path,{method,body})`(L12813-12829): base=`/api`(L12796); header Content-Type json + `Authorization: Bearer <skf_auth_token>`(localStorage, Go L12804); 401→清 token+广播 researchflow:auth-expired; 失败抛 Error{status,code}; 响应约定: 非 2xx 或 `{success:false,error}` 抛错; 成功返回解析后 JSON。
> SSE 封装两套: `sn()`(L13563, 事件流通用, 处理 reasoning/status/variables/skills/ref_item/refs_start/refs_end/assignments/merge_result/review_result/done/[DONE]) 与 `ma()`(L13035, 单事件收割模式); 均返回 `{promise,controller}`。

### 4.1 DAG 任务(Q0, QuickModeView 别名 dt)(L13272)

| 调用 | 端点 | 方法/体 | 响应 |
|---|---|---|---|
| Q0.get(taskId) | GET /api/dag/tasks/{id} | — | `{graph:{workflowMode,nodes,edges,jobId?},task:{title}}` |
| Q0.save(taskId,payload) | PUT /api/dag/tasks/{id} | `{workflowMode,nodes,edges,jobId?}` | ok |
| Q0.plan(taskId,payload) | POST /api/dag/tasks/{id}/plan | 同上 | `{plan}` |
| Q0.run(taskId,payload) | POST /api/dag/tasks/{id}/run | 同上 | `{job:{id,...}}` |
| Q0.getJob(jobId) | GET /api/dag/jobs/{id} | — | `{job:{id,status,currentStep,steps[]}}`,step=`{step_no,status(queued/running/completed/failed/cancelled),attempt,completedAt,error{message,detail},result{nodeId,...},child{currentStep,steps[{status,contentText}],status,result}}` |
| pauseJob | POST /api/dag/jobs/{id}/pause | — | |
| resumeJob | POST /api/dag/jobs/{id}/resume | — | |
| cancelJob | POST /api/dag/jobs/{id}/cancel | — | |
| retryJob | POST /api/dag/jobs/{id}/retry | `{}` 或 `{fromStep}` | `{job}` |

### 4.2 Workflow Jobs(Vt, 别名 Mu)(L13349-13475)

| 调用 | 端点 | 体 | 响应 |
|---|---|---|---|
| createPhase2 | POST /api/workflow/jobs/phase2 | 见 SectionsView 文档 | job |
| get(jobId) | GET /api/workflow/jobs/{id} | | |
| getActive | GET /api/workflow/jobs/active | | |
| getLatestPhase2(t) | GET /api/workflow/jobs/phase2/task/{tid}/latest | | |
| getLatestPhase3 | GET /api/workflow/jobs/phase3/task/{tid}/latest | | |
| createPhase4 | POST /api/workflow/jobs/phase4/sections | | |
| createPhase4Batch | POST /api/workflow/jobs/phase4/batch | | |
| getLatestPhase4 | GET .../phase4/task/{tid}/latest | | |
| createPhase5Merge | POST /api/workflow/jobs/phase5/merge | | |
| createPhase5Review | POST /api/workflow/jobs/phase5/review | | |
| createPhase5Revision | POST /api/workflow/jobs/phase5/revise | | |
| getLatestPhase5 | GET .../phase5/task/{tid}/latest | | |
| getLatestPhase5Review | GET .../phase5/task/{tid}/latest-review | | |
| activatePhase5Version(t,vid) | POST /api/workflow/jobs/phase5/version/{vid}/activate | `{taskId}` | |
| getPhase4Stages | GET .../phase4/task/{tid}/stages | | |
| getPhase4Sections(tid,vid,ids) | GET .../phase4/version/{vid}/sections?taskId=&sectionIds= | | `{sections:[{id,title,content,...}]}` |
| cancel/pause/resume/retry(jobId) | POST /api/workflow/jobs/{id}/(cancel\|pause\|resume\|retry) | | |
| **stream(jobId,{onSnapshot,onEvent,signal,after})** | GET /api/workflow/jobs/{id}/stream[?after=N] | SSE | event `job.snapshot`→onSnapshot; 其他 event 名→onEvent(eventName,payload,id) |

### 4.3 Phase 1/3 版本(ga, 别名 na)(L13476-13486)

| 调用 | 端点 | 体 |
|---|---|---|
| publishPhase1 | POST /api/workflow/versions/phase1 | QuickModeView 组装 `{taskId,title:topic,outline:goal||默认,domain,researchMethod,requirements,totalWordCount:10000,sectionsList:[]}` → resp `{version:{id}}` |
| publishPhase3 | POST /api/workflow/versions/phase3 | 见 MaterialsView |
| getCurrent(tid) | GET /api/workflow/versions/task/{tid}/current | → `{state:{inputVersion:{id}|input_version:{id},...}}` |

### 4.4 Materials(Au=Fs)(L12868-12895)

GET /api/materials?taskId= / GET|PUT|DELETE /api/materials/{id} / POST /api/materials `{...}` / POST /api/materials/batch `{taskId,items[]}` / POST /api/materials/reorder `{taskId,ids[]}`
响应含 `{materials:[...]}`(list 用途)。

### 4.5 AI 导航/编排(G0, 别名 Iu)(L12897-13034)

| 调用 | 端点 | 体要点 |
|---|---|---|
| navigationIntent | POST /api/ai/navigation/intent | `{message,context{pageTitle,pagePurpose,currentState{runState,taskId,hasCanvas,intakeRound,askedInputs}},profile{topic,goal,researchObject,boundary,domain,researchType,method,outline,confirmedOptions,executionConfirmed},capabilityCatalog{platformCapabilities[{id,title,route,actions}]},conversationHistory[{role,content}]}` → `{data:{success,interactionMode,missingInputs,options,nextQuestion,...}}` |
| researchSession | POST /api/ai/navigation/research-session | `{...}` |
| getResearchSession / confirm / bindTask / updateState / acquireLease / releaseLease | GET/POST /api/ai/navigation/research-session[/{id}[/confirm\|/task\|/state\|/lease]] | `{stateVersion}` 等 |
| dispatchAgentModule | POST /api/ai/navigation/agent/dispatch | |
| navigationRuntime / navigationNextAction | POST /api/ai/navigation/runtime\|next-action | |
| mainComplete | POST /api/ai/main/complete | |
| visionComplete | POST /api/ai/vision/complete | |
| mainController | POST /api/ai/main/analyze (SSE sn) | |
| executeSection | POST /api/ai/execute/section (SSE) | |
| summarizeSection | POST /api/ai/summarize/section (SSE) | |
| planSections | POST /api/ai/section/plan (SSE) | |
| generateMaterial | POST /api/ai/material/generate (SSE) | |
| assignMaterials | POST /api/ai/material/assign (SSE) | |
| mergeGeneration | POST /api/ai/merge/generate (SSE) | |
| fullReview | POST /api/ai/review/full (SSE) | |
| generateSkills | POST /api/ai/skill/generate (SSE) | |
| mainReview/mainIntegrate | POST /api/ai/main/review\|integrate (SSE) | |
| reviewSection/reviseSection/humanizeSection | POST /api/ai/execute/review-section\|revise-section\|humanize-section (SSE ma) | |

**SSE 协议(L13563 sn)**: 行事件 `event: X` + `data: JSON`; X 可取: `reasoning{content}`(转发 window.__rfSSEReasoning)/`status`/`variables`/`skills`/`ref_item`/`refs_start`/`refs_end`/`assignments`/`merge_result{content,structured}`/`review_result{content}`/`done`/`[DONE]`; 无事件名=增量文本 content|text|delta 累积。错误 data `{error|code|userMessage|canRetry|hint}`。

### 4.6 Tasks(Rt, 别名 Tu)(L13219-13271)

GET /api/tasks?module=X / GET|PUT|DELETE /api/tasks/{id} / POST /api/tasks `{title,module,status,phase,phaseLabel,snapshot?}` / DELETE /api/tasks/history / PUT /api/tasks/{id}(saveSnapshot `{phase,status,phaseLabel,snapshot}`) / POST /api/tasks/{id}/switch / POST /api/tasks/{id}/release-lock / GET /api/tasks/{id}/nodes / GET|PUT /api/tasks/{id}/nodes/{nodeId} `{nodeData}`

### 4.7 其他共享服务(同文件, 其余视图共用)

- Phase3 jobs(X0)(L13488-13562): material-plan/table-generate/theory-generate(均 `{taskId,...t}`)、literature-search `{taskId,tasks}`、materials/{id}/sources、review `{taskId}`、allocate `{taskId}`、artifacts/import、phase3 files 上传(FormData taskId+file)
- Review jobs(q0)/Review 库(J0 journals+standards CRUD+parse)/Viz(Y0)/文件(K0 上传 /files/upload)/websites/projects/settings ai-config(j u)
- auth store(L12572-12790): register/login/logout/me/password/profile/wechat/register/settings(GET/PUT /api/auth/settings), token 存 localStorage `skf_auth_token`, 401 全局过期事件
- **settings store 系统配置字段**(L13680-13830): `dag_chat_ui_config`(enabled 默认 true, compactMode true, showPlanCards false, showArtifactCards false, showShortcuts false, showInternalProgress false, showDebugDetails false, showOnlyUserAndAgentText true)、`standard_workflow_entry_config`(enabled, defaultMode "standard", requirePhase1Input true)、`dag_agent_response_config`(answerStyle/answerDepth/initiative/answer 字数档/requireEvidence/allowAutoFill/maxClarificationRounds 2/askOptionsOnlyWhenBlocked/customInstruction/rewriteWeakAnswers 等)、`model_viz`

---

## 5. 状态与数据流要点

- **画布数据所有权**: M(业务节点, 业务态) → AgentFlowCanvas 派生渲染节点 `agent-*`(含画布坐标) → graph-changed 只回传 `{id,canvasPosition}` 与用户边(映射回业务 id), **position 持久化走 canvasPosition 而非 vue-flow 内部**
- **自动链 vs 用户边**: 无 d 时服务端拿到的 edges=mt() 顺序链; 用户在画布拖出连线→configured-edge/manual-edge 存 d 后保存; 画布内自动补边只在前端渲染层, 不落盘
- **进度刷新闭环**: run → S(jobId) → 800ms 轮询 getJob → Dn 逐节点对账(指纹 N 去重) → 会话 node-update 卡片(Ze 复用同节点卡片, 不死堆) + 节点 UI 更新 → watcher(4.2.3)联动材料/正文预览
- **草稿持久化**: 输入/会话只落 localStorage(dag_intake_context), 主题 goal 等经 publishPhase1 才上服务端; DAG 图经 wo()/save 防抖落服务端
- 各视图(workflow 传统版/statistics/viz/review)route 跳转独立 chunk; QuickModeView 与 Workspace/Finalize/Sections/Input 视图为**两套并列入口**(后者传统分步工作流)

## 6. QuickModeView 设计要点(供复刻)

1. 三组件结构: 纯展示节点 AgentFlowNode(190×190 起, 内部 7 段信息)+ 画布编排 AgentFlowCanvas(布局/边推导/环路防护/手动边管理全在前端) + 巨型状态机主组件
2. vue-flow 参数: fit-view-on-init, min-zoom .35, max-zoom 1.8, nodes-connectable/edges-updatable=可编辑, pan-on-drag, Background pattern-color #00FFFF(网格), MiniMap 在右下
3. 布局: 横/竖两套(以容器宽 1080 为界); 竖向主流程纵排+左右交错, 横向主流程横排+层间距 225/235; 模块独立区排布+END 节点收尾; 坐标夹取防拖出
4. 右键菜单: 空白=添加模块(标准/统计/绘图/审稿)+新建空白; 节点=查看详情/删除(系统节点禁删, 灰化"系统节点不可删除")
5. 状态机与提示文案高内聚: xe/Ee/ke/$e/_/$ 派生 computed 全部围绕 r 9 态, 锁定态禁用一切编辑+输入
6. 对话消息 7 类卡片 + 2 轮集中补齐 UX + "确认方案并开始/先调整方案" 双选项卡 = 信息收集的核心交互
7. 节流防抖细节: 拖拽结束才 graph-changed; fitView debounce 40/60/80ms; pause 500ms 兜底; 进度轮询 800ms

## 6.5 QuickModeView CSS 语义类全集(源 QuickModeView-sxJdb82J.css, 供复刻对照)

**布局**: quick-view/quick-header/quick-shell/agent-panel/agent-panel-header/conversation-rail/conversation-context/conversation-stream/workspace-stage/canvas-stage
**顶栏**: brand-lockup/brand-mark/mode-tabs/mode-tab/preview-badge/agent-identity/agent-avatar/agent-name-row/agent-status/agent-header-actions/agent-context/panel-toggle/compact-run-button/mobile-canvas-toggle
**对话消息**: message-avatar/message-content/message-meta/message-bubble(+.is-agent/.is-user/.is-question 等)/question-card(+.question-target/understanding/autofill/prompt/template/fields/selected-mark/batch-fields/batch-list/label)/plan-card/plan-card-heading/plan-check(is-done✓/is-active•)/plan-item/progress-line/artifact-card/artifact-preview/node-update-card/heading/detail/artifact/preview/thinking-row/thinking-bubble/agent-shortcuts
**编排**: agent-flow/agent-flow-canvas(is-expanded/has-overlay)/agent-flow-node(is-active/is-done/is-error/is-system-start/is-locked/is-selected)/flow-toolbar/flow-zone-chip(main/extension)/flow-handle/canvas-legend/canvas-research-card/canvas-caption-title/canvas-caption/canvas-start-gate(+mark/copy/button)/canvas-lock-badge/canvas-context-menu/context-menu-item(is-danger/is-muted)/context-menu-label/context-menu-title
**节点**: node-header/index/module/menu/title-row/progress/progress-track/meta/value/footer/state/status-dot/artifacts/arrow/hint/execution-detail/output-preview
**右侧工作面板**: workspace-panel(+Transition workspace-panel-enter/leave)/workspace-panel-header/kicker/actions/workspace-close/workspace-summary(-label)/workspace-progress/workspace-form-grid/workspace-field(-wide)/workspace-evidence-row/dot/workspace-live-status(head/track/preview)/workspace-live-state(is-running 等)/workspace-module-{id} 占位/workspace-placeholder(-label)/workspace-primary/secondary/final-manuscript-preview/is-loading/final-manuscript-meta/actions
**抽屉与预览**: node-drawer/drawer-topline/module/title-row/icon/description/section/live-output/artifact/label/state(is-*)/action(-secondary)/close; paper-preview-shell/header/scroll/dag-paper-preview-modal
**composer**: composer/composer-toolbar/composer-tools/send-button
**变量与色板(全局)**: CSS 变量 --ink/--muted/--line/--soft/--blue; vue-flow 覆盖 .vue-flow__background/.vue-flow__minimap/.vue-flow__controls-button; body 底色 #edf1f6

## 7. 行号勘误表(精确定位, setup 函数实测行号)

> 初稿按阅读顺序估行的函数行号整体偏差 -50~-100 行(渲染函数在前、setup 函数定义在 L14360 之后),以下为 grep 实测精确值,供代码检索:

| 函数/锚点 | 精确行号 | 函数/锚点 | 精确行号 |
|---|---|---|---|
| setup 开始(v_=) | L14304 | H() localStorage 写 dag_intake_context | L14361 |
| O() 读 dag_intake_context | L14399 | Zi key 常量 | L14303 |
| k() 材料恢复(Au.list) | L14687 | le() Phrase4 预览刷新 | L14730 |
| 组合串 watcher(phrase4/5 联动) | L14768-14784 | ve() 主按钮路由 | L14782 |
| oe() 任务卡状态回写 | L14789 | re() agent 文本消息 | L14805 |
| Ne()/Ie() 答案清洗/拼接 | L14816/14824 | Qe 字段名→中文词典 | L14851 |
| Re()/Zt()/go() 主题判定/归一 | L14872/14895/14966 | Mt() 追加 question | L14922 |
| Tn() 批量补齐 | L14995 | Ei() 选项点击 | L15009 |
| Ni() 启动前缺节校验 | L15021 | Se/ze/Ue 节点规范化/主流程/全完成 | L15047/15055/15060 |
| mt()/Kt() 自动链边/快照体 | L15072/15083 | Ci/Ui(截断) | L15098 |
| Ul() 步骤抽取+产物计数 | L15104 | Zl() 节点进度消息卡片 | L15213 |
| Dn() 800ms job 同步 | L15297 | yo() 轮询启停 | L15410 |
| Kl() graph-changed 落位 | L15415 | Yr() 任务恢复 | L15427 |
| Xr() taskId 确保 | L15523 | wo() DAG save | L15563 |
| Ql() Phase1 发布 | L15575 | watch 组(Ae W→Jl / Ae [b,W,Z,J]→H) | L15615-15616 |
| onMounted 恢复 | L15617-15621 | qr() 新建空白任务 | L15627 |
| Wr()/Ur() 装载主流程/启动 | L15683/15695 | jl() 意图解析 | L15708 |
| Mi() 启动管线 | L16060 | eu()/Ii() 暂停/恢复 | L16167/16185 |
| Qt/Zr/tu/nu 右键菜单 | L16207-16245 | ou/iu/ru 详情/加模块/删除 | L16247/16254/16290 |
| Kr/Pn 选中/关闭 | L16302/16305 | Rt()/su/lu Word 导出 | L16314/16320/16327 |
| Qr/uu/cu/du/fu/hu | L16353-16386 | Ai() 发送 | L16393 |
| render 返回 | L16418 | AgentFlowCanvas 嵌入点 | L17016 |
| paper-preview-modal Teleport | L17908 | NodeDrawer 区 | L17731-17906 |
| AgentFlowNode | L13403-13522 | AgentFlowCanvas | L13526-14200 |
| AgentFlowNode scopeId | data-v-be4e6308 | AgentFlowCanvas scopeId | data-v-0bebca05 |

### 共享模块(index-xpWAkSSw.js)行号速查
| 锚点 | 行号 | 锚点 | 行号 |
|---|---|---|---|
| q() 请求封装 | L12813 | Go()/Yl()/ap() header/token | L12804/12802/12809 |
| auth store | L12572 | Fs materials 服务 | L12868 |
| G0 ai navigation | L12897 | ma() SSE 单事件封装 | L13035 |
| X0 phase3 jobs | L13488 | Rt tasks 服务 | L13219 |
| Q0 DAG 服务 | L13272 | Y0 viz | L13319 |
| Vt workflow jobs+stream | L13349 | ga versions(phase1/3/current) | L13476 |
| sn() SSE 通用流 | L13563 | settings store(dag_chat_ui_config 等) | L13680 |
| project store | L15595 | taskList store | L14189 |

## 8. 路由与视图并列关系(共享模块 index-xpWAkSSw.js L17495-17645)

| path | name | chunk | meta |
|---|---|---|---|
| /workflow | WorkflowHome | WorkflowHome-CdD9lDE9.js(独立) | — |
| /workflow/input | WorkflowInput | InputView-DwlhRWpv.js | fixedLayout |
| /workflow/sections | WorkflowSections | SectionsView-C4lM9Tih.js | fixedLayout |
| /workflow/materials | WorkflowMaterials | MaterialsView-CW_9_w3K.js | fixedLayout |
| /workflow/workspace | WorkflowWorkspace | WorkspaceView-Baf0x_1H.js | fixedLayout |
| /workflow/finalize | WorkflowFinalize | FinalizeView-Br8-MIOb.js | fixedLayout |
| /workbench/quick | QuickWorkbench | QuickModeView-DJU6Ms4b.js | fixedLayout, **quickAgent** |
| /statistics /viz /review /review/library /journal /websites /editor /knowledge /history /admin ... | | 各独立 chunk | 部分 fixedLayout |

- **两条并列产品线**: ①传统分步工作流 /workflow/*(5 连续页面, input→sections→materials→workspace→finalize, 共享 task/project store 顺序推进); ②QuickModeView(/workbench/quick) = 可视化 DAG 一键自动执行 Phrase1-5 的新入口, 内部复刻同一 5 阶段语义(节点注册表/V 契约表与其一致)。
- QuickModeView 内部 q 卡片上的 route: workflow→/workflow、statistics→/statistics、viz→/viz、review→/review, 均跳转独立模块页。
