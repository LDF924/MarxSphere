# 闭源社科研模块组件解码 — 数据分析 (Statistics) + 科研绘图 (Viz)

> 来源：`full/formatted/StatisticsView-C1S4N5xA.js`(3329 行)、`full/formatted/VizView-DKRGiXDc.js`(5034 行)、`full/StatisticsView-huzBM7kl.css`、`full/VizView-D_KoFWB6.css`、`full/ChartRenderer-DVxWvy7W.js`+CSS、共享模块 `full/index-xpWAkSSw.js`（API 层/任务store/auth 在此，行号为字符偏移量）
> 复刻要点：Vue3 `<script setup>` + Tailwind + scoped CSS；两者均为"工作台式页面组件"，通过共享 store 与 /tasks 任务体系深度绑定。

---

## 0. 共享基础设施（来自 index-xpWAkSSw.js）

### 0.1 API 封装（本页面全部 fetch 均经此）
- `dr = "/api"`、token 取 `localStorage.getItem("skf_auth_token")`（常量 `op`），401 自动清 token（offset 212614 起）。
- 包装 `q(url, opts)`：fetch `/api+url`，`Authorization: Bearer <skf_auth_token>`，错误非 2xx 抛 `Error(错误信息)` 并带 `.status/.code`；响应 JSON `{error}` 也抛（q 定义见 offset ~212960）。
- 页面内直接 `fetch("/api/...")` 处自行拼 `Authorization: Bearer <store.token>`（Stats 的 `E()` 包装，StatisticsView L358-363；Viz 用 `skf_auth_token` 兜底 L484-487, L4142）。

### 0.2 任务体系（Workflow Task，全产品共用）
- `Rt`（export a1）= task store API：`GET /tasks?module=x`、`POST /tasks`、`GET /tasks/:id`、`PUT /tasks/:id`(update/saveSnapshot)、`POST /tasks/:id/switch`、`DELETE`、release-lock；节点 KV：`GET /tasks/:id/nodes`、`GET /tasks/:id/nodes/:key`、`PUT /tasks/:id/nodes/:key {nodeData}`（offset 220776-220850）。
- 状态 store（StatisticsView 的 `P` = `$t` 导出？→ 实际为 taskStore，含 `currentTaskId`、`globalTasks`、`createTaskWithTitle(title,module)`、`loadTasks`、`saveProject`、`setCurrentTaskName`）：Statistics 用 L353-356 的 `zt()/Nt()/Ct()/It()`；module 枚举 {workflow:工作流, review:审稿, statistics:数据分析, viz:科研绘图, knowledge:知识库, editor:编辑器}（index offset ~213150）。
- 素材导入统一入口 `POST /workflow/versions/artifacts/import {taskId,sourceType,sourceTaskId,sourceArtifactId,artifactVersion,snapshot,...}`（index offset 226117，X0 模块即 workflow-export）。

### 0.3 确认弹层（无头环境安全的全局 confirm）
`tc()`（export a2）：`confirm({message,title}) => Promise<bool>`（index `function tc`）。统计/绘图"新建"按钮都走它。

---

## 1. StatisticsView（统计分析，17 方法，page-scopeId `data-v-38a82752`）

### 1.1 组件树

```
Statistics(page 组件)
├─ header 栏 sticky（L231-2588）：标题"统计分析"+当前任务徽标/未选择任务+"后端已连接/未启动/检测中"胶囊(轮询) + 文件名胶囊"已加载…"/"未加载数据" + 前往工作流 + 新建分析
├─ .statistics-workspace (flex, key=workspaceKey 强制重建, L2596-2599)
│  ├─ aside 方法面板 w-[260px]（4 分类，L2600-2751）
│  │   ├─ 分类 数据基础: descriptive描述统计 / frequency频数分析 / classify分类汇总 / transform数据转换 / filter数据筛选
│  │   ├─ 分类 推断统计: t-test / anova / multivariate-anova多因素ANOVA / correlation相关分析 / crosstab交叉表·卡方 / nonparametric非参数 / normality正态性检验
│  │   ├─ 分类 回归建模: regression OLS / logistic-regression Logistic
│  │   └─ 分类 信效度&高级: reliability信度α / efa因子分析 / mediation-moderation中介·调节
│  ├─ 配置面板 w-[360px]（L2752-2914）
│  │   ├─ StatisticsFileUploader（子组件，上传条）
│  │   ├─ 方法描述 desc
│  │   ├─ [需选变量的方法] 分析变量区：搜索框 + 变量列表（图标#/Aa、类型徽标 数值/分类、点击多选）
│  │   ├─ 参数区 = 动态渲染的 17 个字符串模板组件（见 1.3）
│  │   └─ 底部: 运行分析 / 重置
│  └─ 结果面板 flex-1（L2915-3315）
│      ├─ header: 分析结果 + StatisticsJobControls + Word/PDF 整报告 + 清空
│      ├─ welcome 空态（内置 8 标签宣传文案）
│      ├─ loading 覆盖层（spinner + "正在执行 X 分析…"）
│      ├─ warnings 警示条（_error 红 / 其他琥珀）
│      ├─ 每个 result-table: header 按钮(Word/图片/导入工作流素材库) + 标题 h4 + 三线表 + footnotes
│      └─ 每个 chart: 卡片 + header(标题/图片导出/导入素材库) + <div id="chart-i"> plotly 容器
```

**3 个局部子组件：**
1. `StatisticsJobControls`（L54-162）：props {jobId,status,loading,jobs}; emits [cancel,retry,open]。运行中显示红"取消任务"按钮；failed 显示琥珀"从失败任务重试"；右侧下拉"历史分析任务"（option 文案 `method · 状态中文 · MM-DD HH:mm`）。
2. `StatisticsFileUploader`（L164-229）：props {fileId,fileName}; emits [upload]。全局上传条样式（dashed→loaded solid 绿），hidden input `.csv,.xlsx,.xls` + click/drag。
3. 17 个参数模板组件：常量 `be`（L617-1216），每个是字符串 template + `props:["params","variables"]` + `emits:["update:params"]`，内部 `watch(local, e=>emit("update:params", local), {deep, immediate})` —— 即**子组件即时回传参数**，父只存 `p.value`。缺注册的 method 用 `be.__default__` 兜底（L1217-1220）。

### 1.2 Setup 状态（L346-409）
| ref | 含义 |
|---|---|
| `y=ref("descriptive")` | 当前工具 id |
| `ee` fileId / `q` fileName / `K` variables[] | 上传数据 |
| `j=new Set` | 已选变量名集合 |
| `te` | 变量搜索词 |
| `p` | 工具参数对象 `{...}`（按模板 local） |
| `m={tables,charts,warnings,metadata}` | 结果 |
| `L` jobId / `ae` job status / `We` 历史 jobs / `pe` resultVersionId | 任务态 |
| `me="unknown"` | 后端健康态 |
| `Ve="saved/error"` | 保存闪示 |
| `ve` workspaceKey（reset/切换任务自增 → 用 `:key` 重建 DOM） | |
| `ke` 轮询代际序号 | 防止旧轮询覆盖新任务 |
| `X`(EventSource) `He`=15s health timer `Re` | |

派生：`fe`（当前方法对象+desc 文案表，L409-441）；`Be`（是否需选变量：排除 crosstab/regression/logistic/multivariate-anova/mediation-moderation/filter，L442-452）；`qe`/`at`/`st`（anova 只列数值列；按搜索过滤）；`ne`（有无结果）。

**方法注册数据**（数组 A/H/we/Le 定义 L364-389，17 个 = 4+7+2+4，汇总 `ze=[...A,...H,...we,...Le]`）。

### 1.3 17 个参数模板详情（key: local 初始值 + 提交字段）

| method | 参数 UI | local 默认 | → 请求字段（见 `Je()` L1318-1439） |
|---|---|---|---|
| descriptive | 统计量复选(mean/median/std/minmax/quartiles/skew/kurt) + 图表复选(boxplot/histogram) | `{mean:1,median:1,std:1,minmax:1,quartiles:1,skew:0,kurt:0,boxplot:1,histogram:1}` | `variables:selected, options:p` |
| frequency | 无参数 | – | `variables` |
| t-test | radio: one_sample(检验值 testValue 输入) / independent(分组变量 select)/ paired(提示选≥2数值变量，按顺序两两配对) | `{testType:"one_sample",testValue:0,groupVar:"",pairedVars:[]}` | one_sample→`variables`+`testValue`; independent→`dependentVar:e[0]+groupVar`; paired→`pairedVars:e` |
| anova | 分组变量 select(nominal) | `{groupVar:""}` | `variables`(仅 scale 且非 id) + `groupVar` |
| correlation | method select pearson/spearman/kendall | `{method:"pearson"}` | `variables, method` |
| crosstab | 行变量+列变量两个 nominal select | `{rowVar:"",colVar:""}` | 只发 `{fileId,rowVar,colVar}`（不用选变量列表） |
| nonparametric | testType select mann-whitney/wilcoxon/kruskal + 分组变量（wilcoxon 隐藏） | `{testType:"mann-whitney",groupVar:""}` | `variables, testType, groupVar` |
| normality | 无参数 | – | `variables` |
| regression | 因变量 Y select(scale) + 自变量 X 复选(scale) | `{dependentVar:"",independentVars:[]}` | `dependentVar, independentVars` |
| logistic-regression | 因变量 select(全部变量，amber 提示须二分类 0/1) + X 复选 + showOddsRatios | `{dependentVar:"",independentVars:[],showOddsRatios:1}` | + `showOddsRatios` |
| multivariate-anova | Y select + 因素复选(2–3 个上限 disabled) + showSimpleEffects | `{dependentVar:"",factors:[],postHocMethod:"tukey",showSimpleEffects:0}` | `dependentVar, factors, postHocMethod, showSimpleEffects` |
| reliability | 仅提示文案（选量变题项算 α） | `{}` | `variables` |
| efa | extraction select principal_axis/ml + rotation varimax/promax/oblimin + nFactors 数字 | `{extraction:"principal_axis",rotation:"varimax",nFactors:null}` | `variables, extraction, rotation, nFactors` |
| mediation-moderation | 顶部 中介/调节 双按钮; 中介: X/Y/M；调节: X/Y/W(scale 2 列 grid)；centering 复选(mean/none) | `{analysisType:"mediation",xVar:"",yVar:"",mVar:null,wVar:null,covariates:[],method:"bootstrap",bootstrapSamples:5000,centering:"mean"}` | 对应字段全量下发 |
| transform | 多选 z-score/min-max/log/rank/sqrt | `{transforms:["z-score"]}` | `variables, transforms` |
| filter | 条件行(变量/运算符≥>≤<==!=/值/清空)+添加条件+AND/OR radio | `{conditions:[{variable:"",operator:">=",value:""}],logic:"and"}` | `conditions, logic` |
| classify | 分组变量 select（可不选=整体汇总） | `{groupVar:""}` | `variables, groupVar` |

ID 列识别（隐藏过滤）：`$e()` L453-458 — 变量 type==="id" 或名称匹配 `/^(id|uuid|identifier|case[_-]?id|subject[_-]?id)$/i`；anova 变量列表与提交均剔除 ID。

### 1.4 核心业务流程

**上传** `ct()` L1251-1306：
1. `POST /api/files/upload` FormData{file}；失败 alert("请确保统计分析后端已启动")。
2. resp 取 `fileId`、`profile.variables || profile.columns || variables`（行/列数 log 自 `rowCount/colCount`）。
3. 变量归一：categorical/binary/nominal→`nominal`；continuous/numeric/scale→`scale`；type 缺失→"unknown"（L1274-1290）。
4. 写 `ue.statisticsFileId/FileName/Variables` + `saveProject()`（跨路由快照）。

**变量选择** `dt()` L1307-1317：toggle Set；anova 时校验 scale 非 ID，否则 `k("ANOVA 的分析变量必须是数值列...","warning")`。

**运行** `ut()` L1440-1665：
1. 校验链（每项 warning toast）：未上传→"请先上传数据文件"；需变量方法没选→"请至少选择一个变量"；首次无任务时 `createTaskWithTitle(fileName去扩展名,"statistics")`（L1450-1461）；crosstab 行/列；regression/logistic Y+X；multivariate-anova 需 ≥2 factors；anova groupVar+至少一 scale 变量；nonparametric(wilcoxon 需 ≥2 paired)；transform 至少一种；filter 条件完整；mediation X/Y + M 或 W；paired t-test ≥2 变量。
2. `POST /api/statistics-jobs` body = `{...Je(), tool, sourceTaskId}`（见 API 节）。
3. 记录 jobId → `localStorage.stats_job_<uid>` → **循环轮询**：每 700ms `GET /api/statistics-jobs/:id` 直到 completed/failed/cancelled（L1599-1624）；completed 取 `job.result`（{tables,charts,warnings,metadata}）与 `job.result_version_id`。
4. 失败：`it()` 把 Python 异常串翻译为中文（L1227-1250）：str/unsupported operand→数据类型不匹配；shape/buffer→维度错误；KeyError/column→变量名不存在；DataFrame/attribute→后端异常；ValueError→非数字内容；NaN/null/missing→缺失值；HTTP xxx→"服务器错误:"；兜底原文 + 技术信息。
5. 成功后自动 `Se()` 存 localStorage；finally 清空 running localStorage key。

**渲染图表** L1690-1744：懒加载 plotly（`import("./plotly.min-CjjARwkY.js")` → `window.Plotly`）；对 `m.charts[]` 逐个 `document.getElementById("chart-"+i)` → `newPlot(el, config.data, config.layout, {responsive:true, displayModeBar:true})`。容器找不到重试 5 次(200ms 递增)；watch `[charts, loading]` 防抖 500ms 触发。

**结果恢复（重进页面/切任务）**：SSE 优先 + 轮询兜底（详见 1.7）；恢复后把最后结果写 localStorage；charts 有则延迟 `De()` 重渲染（L590-600）。

**数值格式** `Oe()` L1751-1763：|x|≥1000 或 <0.001 → `toExponential(3)`；<0.01 → 4 位小数；整数原样；否则 3 位。

**导出**：
- 表格→Word `vt()` L1764-1903：docx.js（Document/Packer/Table…），三线表：表头行上下粗边框；首列列宽=floor(9000/colCount) DXA；最后一行 data bottom border；表头 SimSun 20(10pt 半磅单位) bold；数据 Times New Roman；footnotes 生成"注："斜体；标题 SimHei；页边距 1440 twips。`<title>_<ts>.docx`。
- 表格→PNG `gt()` L1928-2002：html2canvas 离屏重建 table（.cssText 三线边框）scale:3 → toBlob PNG。
- 图表→PNG `xt()` L2070-2092：`yt()` 三级降级 L2003-2069：① plotly.toImage(已挂载 div, 960×600) ② 失败→离屏 800×500 newPlot staticPlot + toImage ③ 再失败→html2canvas scale:2。产物统一装 `{buf,w:520,h:325}` Blob saveAs `<title>_<ts>.png`。
- 整报告 Word/PDF `ft()/bt()` L1904-1927：懒加载 `./reportExport-*.js` 的 `exportFullReport(result, methodDescComputed, fileNameRef, selectedVarsSet, saveAs)` / `exportFullReportPDF(...)`（chunk 未捕获，属外部依赖）。
- 素材导入（表格→工作流）`wt()` L2110-2158 /（图表）`kt()` L2159-2262：先保证 workflow 任务存在（`lastTask_workflow` 或 loadTasks 找 module=workflow）；表格走 `importArtifact({sourceType:"statistics", sourceArtifactId:`table:${method}:${idx}`, artifactVersion: resultVersionId, snapshot:{title,type:"table",analysisMethod,tableData}})`；图表先 `PUT /api/statistics-jobs/artifacts/:chartVersionId/image {imageDataUrl}` 持久化正式产物 → 再 importArtifact `sourceArtifactId:"chart:..."` + snapshot{type:"chart", imageDataUrl 由后端落}。成功 toast "已导出至素材库"。

### 1.5 API 契约总表

**直接 fetch（页面内）：**
- `POST /api/files/upload` `FormData{file}` → `{fileId, rowCount, colCount, profile:{variables/columns:[{name,type}...], sampleRows...}}`（L1256-1263）
- `POST /api/statistics-jobs` `{tool, fileId, fileName?, variables?, selectedVars?...}`（Je() 输出 + sourceTaskId + tool，具体见 1.3 表）→ `{job:{id,status:"queued",...}}`（L1563-1596）
- `GET /api/statistics-jobs/:id` → `{job:{id,status,result:{tables,charts,warnings,metadata},result_version_id,error:{message,code}}}`（L1601-1608）
- `POST /api/statistics-jobs/:id/cancel` → `{job}`（L2413）
- `POST /api/statistics-jobs/:id/retry` → `{job}`（L2423-2428）
- `GET /api/statistics-jobs?limit=N` → `{jobs:[{id,method,status,created_at,...}]}`（L2278, L2329）
- `GET /api/statistics-jobs/:id/stream` = **SSE**：恢复任务续流用（可恢复事件流：服务端重发已发生事件）（L2370-2372）
- `PUT /api/statistics-jobs/artifacts/:chartVersionId/image` `{imageDataUrl}`（图表正式产物回写；L2212-2218）
- `GET /api/statistics/health` → 200 = "FlowMaster v5 后端"（L2264-2275）

**共享模块 helper：** importArtifact = `POST /workflow/versions/artifacts/import`；task 体系 = `/tasks*`（见 0.2）。

### 1.6 localStorage 键
| key | 值 | 位置 |
|---|---|---|
| `stats_save_<uid>_<taskId\|default>` | 工作区快照 JSON `{tool,fileId,fileName,variables,selectedVars,toolParams,varSearchQuery,resultVersionId}` | L535-538 写、L603-616 读 |
| `stats_save_<uid>` | 同上（无任务兜底） | L539-542 |
| `stats_job_<uid>` | 当前活动 jobId | L1594/2324/2348 写读，完成清 |
| `lastTask_workflow` | workflow 任务 id（素材导入目标） | 内部 Ke() L2101 |

恢复策略 `je()` L603-616：先读任务专属 key，无则读全局 key（旧版迁移），解析→`nt()` 恢复（含图表重渲染）；失败 reset。切用户/切任务 watch 触发（L2438-2472）。页面卸载停轮询/关 SSE。

### 1.7 任务状态机（history job 恢复链）
`_e(job)` L2284-2319：completed→结果落地；failed→warnings=[error.message], metadata._error+errorCode；cancelled→"统计任务已取消"。`Ye()` 页面加载尝试恢复最近任务；`ge(jobId)` L2344-2410 全流程：GET job → completed: 保存+清 key → queued/running: loading=true，开 `EventSource(.../stream)`，同时 1000ms 轮询兜底（SSE 断开时继续），代际 `ke` 防竞态；退出后清 localStorage、刷新历史列表 `Fe()`。`Qe(jobId)`（历史下拉 open）= get + `ge`。新建分析 `Ue()` L510-534：confirm("开始新分析？当前分析数据将清空。") → 有任务上下文先 createTaskWithTitle("未命名数据分析","statistics") → 删 localStorage key + reset + workspaceKey++。

### 1.8 样式体系（StatisticsView-huzBM7kl.css，scope data-v-38a82752，语义类 -mb/-sm 后缀）
- `.statistics-page{width:100%;overflow-x:auto}` 且 `>*{min-width:1080px}`；`.statistics-workspace{height:calc(100dvh - 180px);min-height:520px}`
- 方法面板：`.tool-category`→`.cat-title`(11px 紫 #6366f1 uppercase 带 6px 条) + `.method-grid{grid 2 列;gap:5px}`；`.method-item`(浅灰 #f1f5f9 胶囊) `.active` = indigo #6366f1 底白字阴影（后被 tailwind 覆盖段改 #eef4fa/#1e4d8c —— 项目二次定制色出现在 CSS 尾部：active/#eef4fa、按钮族 #9bb8d8/#1e4d8c、hover #173a6a —— 证据：L1 css 文件内 `.method-item.active` 覆盖规则）。
- 上传条 `.global-upload-bar`：linear-gradient(135deg,#f0f4ff,#faf5ff) 2px dashed #c7d2fe；`.dragover` indigo；`.loaded` 绿边绿字（文件名 `.file-name-display-sm` 绿）。
- 变量项 `.var-item-mb.selected` indigo 底；类型图标/徽标：scale 蓝 #3b82f6、nominal indigo。
- 参数卡 `.panel-section-sm{padding:14px;background:#f8fafc;border-left:3px solid #f97316}`（orange 竖条），`.var-section` 绿条。
- 结果：`.results-body-mb{background:#fff}`；三线表 `.three-line-table-mb`：`thead th` 上下边框 2px/1px #1e293b/#475569；td 无边框、`.even-row-mb` 隔行 #f8fafc；`.three-line-bottom td` 底部 2px 粗线且 line-height:0。footnote 小灰字 italic。
- 按钮族：`.btn-run-mb/.btn-report-mb/.btn-pdf-mb` 白底 #9bb8d8 边 #1e4d8c 字（深藏青=本产品主色）；`.btn-export-mini-mb` hover 变 indigo；`.btn-reset-mb` 灰。hover 统一切 #eef4fa。
- spinner `@keyframes spin-38a82752`；`.chart-plot-area{min-height:350px}`；thin scrollbar 5px #e2e8f0。
- 全局页尾有 tailwind 未覆盖的**"新建分析"按钮内联样式**（#1e4d8c 边框，js hover 换色）L2553-2587 — 复刻时直接组件化。

---

## 2. VizView（科研绘图，chat+canvas 双栏工作台，page-scope `data-v-df5821c7`）

### 2.1 组件树

```
Viz page (L3301-5031)
├─ header（sticky）：标题"科研绘图"+ tab 切换 图表视图/任务视图 + 新建图表(confirm 弹窗) + [导入至工作流素材库] + 前往工作流 + 导出为图片 + 删除(二次确认 3s 内变"确认")
└─ .viz-workbench 主体 flex
   ├─ VizChatPanelV2 左侧对话（ref 宽度拖拽 220~480px，竖分隔条 mousedown 拖动 re() L3636-3648）
   │   ├─ 消息流 chat-scroll（空态欢迎：上传数据文件卡/描述图表需求卡 + 快捷模板 双Y轴/子图网格/柱线叠加/回归散点/基准线 5 chips）
   │   ├─ 消息类型: user 气泡(蓝) / assistant(thinking trace + 图表参数表 + markdown 正文 + error + 代码已保存提示 + 图表 img[View/Down]) / tool 行(图标+状态) / system 预览数据卡（表头 文件名+行数列数+清除 ×; 列 chips ≤8） / system 文本
   │   ├─ VizThinkingTrace 子组件（trace 折叠卡片）
   │   ├─ 输入区: textarea(enter 发送, 自动增高≤120px) + 附件 + 发送 + 停止; 字数/token 估算 0.4×字数
   │   ├─ 图片预览弹层 Teleport to body（Download/关闭）
   │   └─ 拖放/粘贴图片→ base64 拼进输入
   ├─ 画布区（图表视图）:
   │   ├─ 图表 tab 条（label 小圆点+名字, ≤8 个 + "+" 手动加空 Fig）
   │   ├─ 预览 img（max 480×320）或空态提示
   │   └─ 底部信息栏 260px 高: 数据/图注/代码 三 tab —— 数据=选中图 dataSnapshot 表格(列+前50行)；图注=caption 或"暂无图注"；代码=深色 python 高亮(Ye() 自写正则: 注释#/字符串/keyword def|plt|ax|pd|np|sns…/数字/@、行号栏 + 复制)  footer "N lines"
   └─（任务视图）VizTaskWindowView: 任务列表(标题+状态胶囊+创建时间+文件+对话N轮+图表N张+查看任务) → 该任务图表横排缩略卡(图/无图文案/label/图注/caption 或 chartType/代码 N 行) → select-job → 恢复画布
```

### 2.2 Setup 状态（VizView 主，L3306-3690）

| ref | 含义 |
|---|---|
| `S="canvas"` | 视图: canvas / windows |
| `I=[]` | 画布图表数组（图卡对象 $e()） |
| `D=-1` | 选中图表索引；`j=computed(I[D])` |
| `q="data"` | 底部信息 tab: data/caption/code |
| `we=480` | 对话栏宽度（220~480） |
| `Y=[]`, `oe` | 数据快照栈（data-upload 事件累积）+当前 |
| `X=""` | 选中的 jobId（url query jobId 同步） |
| `Z=ref(null)` | VizChatPanelV2 实例（expose 大量方法/状态） |
| `le=[]`, `ye` loading, `Ce` selectedJobId, `Q` selectedChartIndex | 任务视图 |
| `Ve` 删除二次确认（3s 自动复位） | |
| 无状态 helper：`et()` workflow 任务查找、`Pe` id 计数器、`He()` 图片 blob 化（4 次退避重试） | |

**图卡对象** `$e(label,png,code,caption,analysisText,chartType,vizJobId="",chartVersionId="")` L3691-3716：`{id:++Pe, vizJobId, chartVersionId, chartKey, label, png, _pngRaw, code, caption, analysisText, chartType, dataSnapshot:Y 末尾 or oe, fileId}`。UUID 生成 `_e()` 用 crypto.randomUUID。

**事件处理** `Xe(chart-update)` L3755-3851：按 `vizJobId+chartKey/图Key(be(): chartVersionId→figureId/panelId→"default"|"figure:x")` 查重 → 更新已有（caption/analysisText/code/chartType）或新建图卡 → png 由 `He()` blob/url 化 → 选中+滚动到画布。查不到 code 时从 chat 最新 assistant 消息补。`Oe(data-upload)` L3651-3670：columns/rows(500)/fileName/fileId → push 快照栈 + 给所有无绑定图卡绑 dataSnapshot + setCurrentTaskName(去扩展名)。job-status 事件 `G()` L3474-3485：刷新任务列表(250ms 防抖)；completed → 120ms 后 `M()` 自动恢复到画布。

**任务恢复三级** `M(job)` L3539-3629：get job → charts 去重（figureId/panelId key）→ 逐个取 png blob → 建图卡（缺图跳过）→ 有图: I=D=0 + chatPanel.restoreFromVizJob；无图：也调 restoreFromVizJob（对话恢复）。`he()` url query jobId 变化恢复；`F()` 任务列表 load。

**图表渲染源**：viz 出图不靠本地 plotly —— 图 = 后端生成 PNG（SSE `chart` 事件给 base64 或 `/api/...` 路径），`ChartRenderer` 组件（下方 §3）用于画布内嵌代码图表（mermaid/echarts）的轻量渲染，viz 主链不依赖它（消息区仅 img）。

### 2.3 VizChatPanelV2（对话核心，L449-2869，scope `data-v-cca9ccd1`）

props: compact/inSheet/initialJobId/readOnly。emits: chart-update / multi-chart / figure-caption / data-upload / job-status。expose（L1144-1244）：messages, sessionId, uploadedData, uploadedFileName, saveToLocal, loadFromLocal, clearMessages, restoreFromVizJob(job), restoreFromBackend(msgs,sid,data)。

**消息对象 F()** L557-571：`{role:"assistant",content,thinking,chartPng,chartType,error,code,plan,toolActivities[],chartMetadata,…}`。存储裁剪时删 chartPng/chartSvg/SvgEmbedded/_pngRaw/_showCode/_thinkOpen（>500KB base64 置 null）。

**发送主链 `d()`** L1453-1594：
1. 无 currentTaskId → `createTaskWithTitle(fileName 去扩展名或 message 前30字, "viz")`。
2. push user msg → 清输入 → push 空 assistant 占位 → **fetch `POST /api/viz-jobs`**，body（关键契约）：
   ```
   {message, session_id, conversation: [...history 去掉渲染字段],
    fileId, fileName, user_id,
    journalConfig:{journal:"nature",layout:"single-column",colorScheme:"nature-default",dpi:600,fontSize:7,fontFamily:"Arial",axisLineWidth:0.8,dataLineWidth:1,widthMm:89,heightMm:62.3},
    modelConfig:{defaultJournal:"nature"}, maxToolRounds:≤5(读 vizConfig),
    autoPolish:"best_practice", autoComplianceCheck:"", contextWindow:null, systemPromptOverride:null,
    defaultColorScheme/fontSize/lineWidth: 从设置 store vizConfig 透传}
   ```
3. → `{job:{id,status}}` → `R("job-status")` → **GET `/api/viz-jobs/:id/stream` (SSE, AbortController)**，读 reader 逐块解 `event:/data:` 两行式 SSE。
4. 事件分发 `m(event,payload,msgIdx)`（L1646-1801，见下表）。
5. 流结束清占位 → 保存；AbortError → "~~已停止生成~~"；其他 error → 气泡内容"抱歉，出错了：…"。

**SSE 事件 → UI 状态映射：**
| event | 处理 |
|---|---|
| plan | `msg.plan=content`（目标行，显示于 trace goal） |
| delta | `content+=content` 且流式正文累计（he） |
| thinking | 追加 thinking（Round N/M 开头或 type=recovery 强制换段 h() L1602）；`pendingActivityDetail` |
| tool_status / tool | toolActivities 数组 upsert：status calling/retrying→running、done/failed；detail 取 activity detail 或 message/summary 截 120 字（w() L1618-1641）；tool msg 另存 toolStatus |
| chart | 合并 metadata 别名（chart_type/chartType/width_mm→widthMm 等，Ae() L537-556 双向映射表）→ 若 png 以 `/` 开头：`_pngRaw=路径`、blob 化 4 次重试后 emit chart-update；`data:` → base64 解码→URL；裸 base64→补齐 `data:image/png;base64,`。capture svg/svg_embedded/svg_editable、caption、analysisText、code、chartVersionId/figureId/figureIndex/panelId → emit chart-update |
| svg | 仅存 chartSvg |
| code | 存 code + `_showCode=true` |
| critique | `thinking += "\n审查: N/10 · summary"; 问题: [severity] desc;…` |
| critique_fix | thinking += prompt 前 200 字 |
| error | toolActivities 全 failed；非 [Auto-retry] 文案则 content 追加错误 |
| done | toolActivities running→done |
| viz.completed / viz.failed / viz.cancelled | emit job-status（父刷新任务列表+恢复） |

**自动保存**：watch 消息数/流式内容 → 300ms 防抖 `be()`；流结束立刻保存。`be()` L662-750 写 localStorage `viz_v2_<uid>_<taskId>`（含 sessionId `v2_<ts36>`、lastChartPng/Svg 限 4MB），并 `POST /tasks/:id/nodes/viz_chat`（saveNode 云端）+ saveSnapshot(sessionId)。409/ACTIVE_PROJECT_LOCKED 静默跳过。**云端优先恢复**：`Ue()` → getNode(tid,"viz_chat") 有消息 → 恢复；否则 localStorage。上传数据节点存 `viz_data`（rows 前 500）。历史任务恢复 `Ve()` L820-900：ke.list(20) 过滤 source_task_id==currentTaskId → running/queued 则重连 SSE 续跑；completed 则拉 result.content/charts 回填。

**上传** `o()` L1382-1444：`dt.upload(file)` → 校验 `parseStatus==="completed" && profile` → 数据卡消息 `[Loaded] **name** \n N rows, M columns \`前6列…\`` + emit data-upload + 云端存 viz_data；解析失败空实现静默（仅 console）。

后端状态轮询 `tt()` L1327-1336：`GET /api/viz2/status` 每 30s，Z=checking/connected/error/disconnected → 驱动 3 态小圆点。粘贴图片 `qe()` 剪贴板 image→base64 拼输入。

**markdown 渲染 z()** L1817-1913（v-html，无外部 md 库）：手工正则——代码块→`<details>查看 LANG` 折叠(占位符置换防二次替换)；md 表→table/thead/tbody(斑马纹)+等宽；#/##/###/#### → h1-h4（tailwind 类）；`- `→li；`**bold**`；`` `code` ``；`---`→hr；段落包装。已实现 XSS 转义（&<>" → entity）再插 HTML。

### 2.4 API 契约（viz 侧）

**共享 helper Y0（export a0）**：`POST /viz-jobs`、`GET /viz-jobs?limit=N`、`GET /viz-jobs/:id`、`POST /viz-jobs/:id/cancel`、`DELETE /viz-jobs/:id`、`POST /viz-jobs/:id/retry`、`GET /viz-jobs/versions/:chartVersionId`（取 chart version 元数据）、`GET /viz-jobs/versions?limit=N`（index offset 221752-222260）。`GET /viz-jobs/:id/stream` = SSE（fetch 直连，见上）。`GET /api/viz2/status`（30s 心跳）。
- job 响应关键字段：`{id, status(queued/running/completed/failed/cancelled), title?, input:{message, conversation, fileId, fileName, session_id, ...}, result:{content, plan, thinking, charts:[{png|chartPng(路径/base64), caption, analysisText, code, chartVersionId, figureId/figureIndex/panelId, metadata:{chartType, figureId…}, svg/svg_embedded/svg_editable}], error?:{message}}}`；列表项含 source_task_id/sourceTaskId/workflow_task_id（多字段兼容读取）。
- 文件：`dt.upload` = `POST /files/upload` FormData{file} → `{data:{fileId, parseStatus:"completed", profile:{columns:[{name}], sampleRows, rowCount, colCount}, parseError}}`；`dt.profile(fileId)` = `GET /files/:id/profile`（K0 模块，index offset 217730）。
- 云端持久化：`PUT /tasks/:id/nodes/viz_chat {nodeData:{messages, sessionId, savedAt}}`；`GET /tasks/:id/nodes/viz_chat`、`viz_data` 同构；`PUT /tasks/:id {phase,status,phaseLabel,snapshot:{sessionId}}`。
- 素材导入 `tt()` L3990-4074：blob/路径图先 fetch→FileReader dataURL → `POST /workflow/versions/artifacts/import {taskId:workflow任务, sourceType:"viz", sourceTaskId:viz任务, sourceArtifactId:图卡id, artifactVersion:chartVersionId, vizJobId, chartVersionId, snapshot:{title(去 Figure N. 前缀), caption, type:"chart", imageDataUrl, content:analysisText, summary, analysisMethod:chartType, metadata:{chartType}}}` → toast "已导入素材库（含图注）"。缺 chartVersionId 时回查 job 内匹配 png/code 的 chart 补（L4003-4026）。

### 2.5 localStorage 键
| key | 说明 |
|---|---|
| `viz_v2_<uid>_<taskId>` | 完整会话（消息+数据+末图）；load 时按 `[uid_task, guest_task, task, uid_default]` 候选链读并**迁移**到规范 key（Xe() L961-1037） |
| `viz_v2_guest_<taskId>` / `viz_v2_<taskId>` | 旧格式迁移源 |
| `viz_active_job_<uid>` | `{jobId, savedAt}` |
| `viz_save_<uid>_<taskId>` | 画布图卡序列（含 dataSnapshot≤500 行/图表 key），恢复时逐个按 chartVersionId→version API→job result→versions 列表→job list 四层兜底捞 png/code/caption（Qe() L4167-4351） |
| `viz_chat_<uid>` | 旧版整包（clear 时删/恢复兜底读，L4361-4364） |
| `skf_auth_token` | 全站令牌（header 兜底） |
| `lastTask_workflow` | 导入素材的目标 workflow 任务 |

路由协议：`/viz?new=1`(新图表) `/viz?reset=1`(免确认清空) `/viz?jobId=x`(选中任务)，切换写回 url（pe.replace L3525）。

### 2.6 样式体系要点（VizView-D_KoFWB6.css）
- 页面 `viz-page` **负 margin 撑满容器**：`width:calc(100% + 48px);margin:-20px -24px;height:calc(100% + 40px)`，内 `viz-workbench{width:max(100%,1024px);height:100%;overflow:hidden}`（媒体 ≤720px 折半）——复刻注意宿主留白。
- 四个 scope：`viz-thinking-trace data-v-8281c8a5`、chat `data-v-cca9ccd1`（tailwind 全部内联）、task window `data-v-d32f1a3a`、page `data-v-df5821c7`。
- trace：goal 行 灰蓝色 12px/600 + `.thinking-header` 折叠（chevron 旋转）、body max-height 138px scroll thin、条目 monospace 10px、`.command-cursor` 闪烁 @keyframes steps(1,end)、状态 failed #b86a6a。`thinking-state` active 蓝。
- 语法高亮 `[data-v-df5821c7] .hl-kw/.hl-str/.hl-cmt/.hl-num/.hl-fn`（紫/米/灰斜体/橙/蓝），深色 code 面板 bg-gray-900。
- chat scrollbar 渐变紫 #c4b5e0→#a890cc（唯一彩色滚轮，品牌记忆点）。
- 任务卡缩略 52 宽、选中 ring-blue、斑马、hover:-translate-y-0.5（蓝色描边主按钮 hover 上浮为该产品通用动效）。

---

## 3. ChartRenderer（通用代码图表渲染，mermaid/echarts 2KB，scope `data-v-4f047ab7`）

独立可复用小组件（导入自 index 的 `a8` p 包）：

```js
props:{code:?, chartType:?}
state: mermaidRef, echartsRef, html(ref 渲染结果), error
onMounted + watch([code, chartType]) → 按前缀分发:
  chartType.startsWith("mermaid") → 懒加载 mermaid.core → initialize({startOnLoad:false, theme:"default", securityLevel:"strict"})
      → await mermaid.render(`chart-${Date.now()}`, code).svg
      → html = DOMPurify.sanitize(svg, {ADD_TAGS:["svg"], ADD_ATTR:["viewBox","xmlns"]})   // XSS 净化
      → v-html 输出（padding 20 center、svg max-width）
  chartType.startsWith("echarts") → 懒加载 echarts → init(echartsRef div, 高 350px)
      → setOption(JSON.parse(code) 或 object) → ResizeObserver 自适应
  error → 红字"XX 渲染失败: msg"；其他 → "未知图表类型: xxx"
onUnmounted: dispose
```

样式：外框 1px #e2e8f0 radius 12、error #ef4444 12px；mermaid 内衬白底居中、echarts 固定高 350px。→ 复刻信号：闭源平台存在"图表卡内嵌 mermaid/echarts 代码"形态（viz 画布 tab 之外的图卡预览组件，估计用于多图表图卡编辑面）。

---

## 4. 复刻对照建议（关键取点）

1. **两模块与 /tasks 体系解耦点**：所有"任务上下文"来自一个全局 store：`currentTaskId/createTaskWithTitle(title,module)/globalTasks/loadTasks(0,module)`。首次运行前自动建任务（stats: 上传后 L1450；viz: 首条消息前 L1457）；tab 切换/刷新按 `tasks/:id/nodes/<module>_<purpose>` 节点恢复 —— 我方 SAG 已有任务/租约体系可对齐，无需照抄 /tasks REST。
2. **stats：17 参数模板字符串 + update:params 双向** 是低代码核心 —— 参数表单 × 提交对象组装(`Je()` switch) × 校验链(运行前逐条 warning) × Python 异常翻译表(`it()`)，三张表齐即可 1:1 复刻。
3. **viz：SSE 协议 13 类事件** 后端输出规范可独立采用（尤其 thinking/chart/tool_status/critique 分轨）；PNG 传输三态（路径/dataURL/裸 base64）前端统一 blob 化。
4. **结果渲染**：stats 图表容器 id=`chart-<i>` + plotly.newPlot(config.data/config.layout)；viz 纯 img + blob URL（blob: 无法跨页面持久，故有 dataURL 双存 `_pngRaw` 机制）。
5. **持久化双写**：localStorage（防抖 300ms/流结束立即）+ 服务端快照节点（409 lock 静默跳过）→ 多端一致性经验。
6. 页面容器：stats 高 `100dvh-180px` min1080 横滚；viz 负 margin 撑满+内宽 max(100%,1024px)；两页均 `min-height:0` + `overflow:hidden` flex 链（父容器须给确切高度）。
