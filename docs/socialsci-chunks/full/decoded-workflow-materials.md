# 闭源 Vue3 科研工作流解码 —— MaterialsView(素材准备 Phase 3)

> 来源: `formatted/MaterialsView-CW_9_w3K.js`(5820 行, prettier 格式化)。导出组件 `kr as default`(L5820)。
> 行号指该文件; API 服务对象均指共享模块 `index-xpWAkSSw.js`。

## 1. 组件树(本 chunk 共 10 组件 + 2 个顶层组合式函数)

### 顶层可复用组合式/工具(非组件)
| 函数 | 行号 | 作用 |
|---|---|---|
| `na({onJobStarted})` | 56-579 | 智能生成编排: isGenerating/currentStep/progress/planResult/showPlanDialog/planState + 7 async 方法(生成执行计划/智能生成素材/审视素材/编排素材/分段执行 literature/table/dataAnalysis/collectAllMaterialsForAgent) |
| `la(materialObj)` | 580-667 | 文献条目解析: 空条目工厂/单条解析(DOI `10.\d{4,}/`、年份 `\(?(\d{4})\)?`、APA/GB 混合)/批量粘贴解析 |
| `ra(paramObj)` | 668-844 | AI 单类生成弹层逻辑: doGenerate/saveGeneratedMaterial |

### 组件清单(全部 Teleport 或内联于页面)
| 组件 | 行号 | __name | props | emits | scopeId |
|---|---|---|---|---|---|
| DocumentImportPanel | 859 | DocumentImportPanel | kind String="all" | close/imported/job-started | — |
| MaterialSourcePanel | 1043 | MaterialSourcePanel | generating/sectionCount/materialCount/unassignedCount(Number), importRequest(Number), importKind("all") | plan/review/allocate/literature/manual/navigate/imported/job-started | — |
| MaterialJobStatus | 1340 | MaterialJobStatus | visible/running/retryable/failed, label/message, progress{done,total} | cancel/retry | — |
| MaterialReviewPanel | 1428 | MaterialReviewPanel | report, generating | (内部展开开关) | — |
| MaterialPublishBar | 1487 | MaterialPublishBar | publishing | back/publish | — |
| MaterialAllocationDialog | 1540 | MaterialAllocationDialog | visible, suggestions/sections | close/apply | — |
| MaterialList | 1800 | MaterialList | categoryGroups/expandedCategories/projectStore + 10 回调 props | 无(全回调下行) | data-v-70a58c25 |
| MaterialEditorDialog | 2828 | MaterialEditorDialog | visible/editingMaterial/createDialogTitle/newMaterial/sections/bulkReferenceText + 7 函数 props | update:bulkReferenceText | — |
| MaterialGenerateDialog | 3556 | MaterialGenerateDialog | visible + genCategoryKey/Label/GenPromptHint/GenPrompt/GenPlaceholder/GenSectionId/GenPreview/genStreaming/generating, sections/variables/wanfangRefItems, 状态 id, genTableType + 7 函数 props | close/update:genPrompt/update:genSectionId/update:genTableType | — |
| MaterialsView | 4180 | MaterialsView | —(页面主体) | — | — |

### 嵌套关系
```
MaterialsView(4180) ─┬─ MaterialSourcePanel ja(5223) ── Teleport ── DocumentImportPanel ma
                     ├─ MaterialJobStatus za(5306)
                     ├─ MaterialReviewPanel Oa(5332)
                     ├─ MaterialList $n(5358)
                     ├─ MaterialPublishBar Wa(5385)
                     ├─ MaterialEditorDialog al(5397, Teleport→body)
                     ├─ MaterialGenerateDialog zl(5430, Teleport→body)
                     ├─ MaterialAllocationDialog rs(5799, Teleport→body)
                     ├─ Teleport 图片预览全屏层(5484-5530)
                     └─ Teleport 生成计划确认弹层(5531-5798)
```

### MaterialsView setup 状态(4183-4358)
- stores: `ta()`router / `ea()`route / `st()`projectStore / `fe()`taskList / `Jt()`aiStore / `sa()`errorStore
- `u=j(null)` phase3 后台 job; `o=j({done,total})`; 模块 let: C/S/T = AbortController/重连定时器/去重 key
- UI: `L=j(Set)` 展开分类; `de=j(0)` importRequest 计数; `ve=j("all")`; `ue=j(!1)` publishing; `le=j(null)` 已发布版本号; `ae=j(!1)` 版本失效; `ce=j(!1)` 编排弹层; `$e` suggestions; `nt` wanfangRefItems; `Oe/He` 生成物 materialId; `D=aa({...})` 新建/编辑表单; `lt` bulkReferenceText; `Ue` 图片预览; `Fe` + 7 gen ref AI 弹层; `Ge=j("comparison")` 表类型
- 变量角色色板(4377-4390): 定量/定性两套, researchMethod==="qualitative" 切换; 自变量红 bg-red-600/因变量灰/中介/调节/控制
- 分类定义 `ze`(4419-4468): **literature「文献检索」(AI=检索文献/手动添加文献) / data「表格素材」 / theory「理论素材」 / dataAnalysis「数据分析素材」(3 actions: 上传图片→/statistics→/viz) / document「附件素材」(上传附件)**
- hasAI 卡片头按钮: 检索文献/生成表格/生成理论

## 2. 业务逻辑流程

### A. 分类与列表
- 分组 `Pt`(4469-4490): dataAnalysis = type image|chart 或 data 含 imageDataUrl; data = type table 或 data 无图; 其余 type===key
- 折叠: `L` Set + `jt` 切换(4760-4762); 默认展开非空分类(4514-4517)
- 文献卡(2079-2410): 平台徽章(wanfang/ncpssd→"文献库检索"、internal_knowledge_base→"内部资料" 1827-1836)、作者清洗、GB/T 7714 灰底引用(y() 组装或 gbRef 清洗 1845-1891)、source.sourceStatus 徽章(completed→"文献库检索已用"蓝/empty→"无结果"/failed→"失败" 1819-1826)、hover 单条删除
- 非文献卡(2411-2744): 章节 chip、image/chart → imageDataUrl 缩略、tableData 渲染 .three-line-table(2584-2672)、`N 字`/analysisMethod chip
- 底部 "+ 继续搜集{label}"(2752-2768)

### B. 手动新建/编辑(EditorDialog al 2828-3491 + qt 4996-5084)
- 入口: "手动添加" `bt`(4904-4916) 重置 D + `Te="manual"`(literature 预置一条空 ref); 编辑 `Nt`(4977-4992)
- 保存校验(3450-3461): literature 需 ≥1 条 title+author+sectionId; 其余需 title+sectionId+content(image 需 caption)
- 保存 `qt`: literature 拼 `1.【题目】…【作者】…【来源】…【年份】…【DOI】…【引用】…【摘要】…` 文本存 content; 单条 title=首条前 60 字/多条"文献素材(N 条)"; edit→updateMaterial / new→addMaterial
- 删除 `ht`(5085-5087); 删单条引用 `Et`(5088-5118) 重排 content, 删空则删整条
- 批量粘贴解析(la 630-648): "每行或每段一条, APA/GB/混合"; 无结果→"未识别到有效文献,请检查格式"; 成功→"已批量解析 N 条文献,请核对字段"

### C. 智能生成素材(计划→确认→执行)
1. source "智能生成素材" → emit plan → `Y`=generateExecutionPlan(88-130): "正在分析论文框架,生成执行计划..." → `me.createMaterialPlan(taskId, {title,requirements,researchMethod,hasDataFile:!!statisticsFileId,statisticsFileName,variables:[{name,role}]})` → result.plan 归一化为 literatureSearch/textTables/dataAnalysis 三数组, 各项 `_enabled=true`(有数据文件才保留 dataAnalysis) → 弹确认层(5531 起)
2. 确认层三组列表(checkbox): 文献检索(章节/关键词)/文本表生成(列)/数据分析(方法+变量); 空→"当前不需要生成额外素材"(5763-5769); "开始执行" → `Lt`(4802-4821) 按 _enabled 过滤 → smartGenerateMaterials(461-494) 三段式 B(文献)→z(文本表)→F(数据分析), 成功 "生成完成:X 个文献组、Y 个文本表、Z 个分析结果"
3. 文本表 `z`(194-227): 逐条 `T()`(131-147) 标题三段匹配 section(精确/包含/去空白 level1 含 2 字)→ 拼 prompt → generateTable({...,tableType:"text"}), 失败 "生成「{title}」失败:…" 继续
4. 数据分析 `F`(228-328): **本文件唯一直接 fetch** → POST `/api/statistics/api/analyze/{method}`(见 §3)
5. job 实时接管: `qe`(4587-4655) plan 完成自动弹确认层; monitor `pt`(4692-4713)+`Re`(4656-4691, job 流 `literature.group_completed/group_recovered` 事件刷新进度, 断流 1.5s 重连); job 状态条(取消 `At` re.cancel / 重试 `Rt` re.retry)

### D. 单类 AI 生成(MaterialGenerateDialog + ra doGenerate 687-795)
- `Ze`(4924-4976): literature prompt="自变量/影响因素+因变量/结果表现 变量名"或项目标题; data="为「{项目}」设计所需的表格"+表类型 radio 文本对比表/数据表(需提供数据); theory="为「{项目}」梳理相关的理论框架"
- doGenerate: 需 section("请先选择关联章节"); literature→searchLiterature({sectionId,sectionTitle,keywords:[prompt],count:5})→materialIds[0]→references 载入 wanfangRefItems+预览; data/theory→generateTable/generateTheory({sectionId,title:slice(0,120),prompt,tableType})→materialId+content
- saveGeneratedMaterial(796-842): literature 需真实 refs(否则 "未获取到真实文献数据,请检查网络或重试")→addMaterial→"已保存"
- aiStore: materialGenerating/currentTask="material"/materialStreamContent

### E. 审视素材 review
`O`=reviewAllMaterials(524-542) "正在审视全部素材..."→ reviewMaterials→report 存 materialReviewReport→"素材审视完成"; MaterialReviewPanel 折叠条 "素材审视报告" markdown-body 渲染

### F. 编排素材 allocate
`Ft`(4872-4875)→`Z`(543-562): 无 sections→"请先完成科研架构"; 全关联→"所有素材已关联章节"; 否则 allocateMaterials→suggestions 过滤(仅无 sectionId)→MaterialAllocationDialog "素材编排确认"/"每项素材只关联一个对应章节,确认后用于该章节正文生成。" 逐条 checkbox+目标章节 select(层级缩进全角空格)
`Gt`(4879-4903): 逐条 updateMaterial({sectionId})→重建 materialAllocation(仅 level1)→"已为 N 个素材关联章节"

### G. 上传导入(DocumentImportPanel 860-1013)
- kind 文案: image "上传图片素材 支持 PNG/JPG/JPEG/WebP ≤8MB"; document "上传附件素材 PDF/DOCX/TXT/MD/CSV/TSV ≤25MB"; all "导入素材 文档≤25MB 图片≤8MB"
- 流程(934-950): 无任务→"当前没有可用的工作流任务"; uploadFile(taskId,file)→job-started→流式: running"正在解析文档..."→completed: loadMaterials + materialId→"解析完成并已导入素材" emit imported / 否则"解析完成,但素材导入失败"

### H. 发布版本(进入创作)
`Ut`(4822-4871) 守卫链: 无素材"请先添加素材" → 未关联"还有 N 个素材未关联章节,请先为每个素材选择所属章节" → getCurrent 校验 phase2Version 未 stale("科研架构版本已失效,请返回 Phase 2 重新确认") → publishPhase3({taskId,phase2VersionId,materialUsages:[{materialId,status:"adopted",sectionIds:[sectionId]}],reviewReport}) → "素材版本 vN 已发布" → router /workflow/workspace
- MaterialPublishBar: "返回章节清单"→/workflow/sections; 主按钮 "确认并进入创作" data-assistant-control=workflow_confirm_materials

### I. 装载与同步
`Ve`(4506-4519): sections 空→loadNode("sections")→loadMaterials→gt()→默认展开; `gt`(4554-4583): getCurrent→inputVersionId/phase2VersionId(stale→null)/phase3VersionId/le=version_no/ae=stale
- onMounted(4730) + onActivated(4738) + 清理(4741); route.query.search 深链 → 300ms 后开"检索文献"弹层预填 prompt
- watch materials.length(4743)/deep materials(4750)→ phase===3 时 saveProject+saveCurrentNode; 深版另跑 gt

## 3. API 契约

### 本文件直接 fetch(仅 1 处)
- **POST `/api/statistics/api/analyze/${method}`** (250-258), Bearer token 来自 `Ot().token`。请求体按方法组装(`E` 329-429), 均含 `fileId: w.statisticsFileId`:
  - descriptive/frequency/normality/reliability/classify → `{variables}`(classify 加 groupVar)
  - correlation → `{variables, method:"pearson"}`
  - t-test → `{testType:"independent"|"one_sample", dependentVar, groupVar, variables?, testValue?}`
  - anova → `{variables:vars.slice(1), groupVar:vars[0]}`
  - regression → `{dependentVar:vars[0], independentVars:vars.slice(1)}`
  - efa → `{variables, extraction:"principal_axis", rotation:"varimax"}`
  - crosstab → `{rowVar, colVar}`
  - nonparametric → `{variables 去尾, groupVar:末位, testType:"mann-whitney"}`
  - multivariate-anova → `{dependentVar, factors, postHocMethod:"tukey"}`
  - logistic-regression → regression 形 + `showOddsRatios:true`
  - mediation-moderation → `{analysisType:"mediation"|x.analysisType, xVar,mVar,wVar,yVar,covariates:[],method:"bootstrap"}`
  - transform → `{variables, transforms:["zscore"]}`
  - filter → `{conditions, logic:"and"}`
  - **resp** `{tables:[{title,columns:[str],rows:[[str]]}], charts:[{config:{data,layout}}]}`(259-276)
- 图表: 表格拼 TSV 文本; chart 动态 import `./plotly.min-CjjARwkY.js` 离屏 1200×600 newPlot+toImage → base64 PNG(430-460) → 合成 material `{type:"data",title:方法+"(数据分析)",caption,content,analysisMethod,sectionId,metadata:{generatedBy:"smartGenerate",analysisType}}` addMaterial 失败本地 push 兜底; 失败 toast "分析「{title}」失败:…"

### 共享服务对象(共享模块 index-xpWAkSSw.js)
| 服务 | 方法 → 端点(请求体要点) → resp |
|---|---|
| materials 域 `me()` | createMaterialPlan → POST /workflow/jobs/phase3/material-plan `{taskId,title,requirements,researchMethod,hasDataFile,statisticsFileName,variables}` → `{job}` → result.plan`{literatureSearch[],textTables[],dataAnalysis[]}` |
| | searchLiterature → POST /workflow/jobs/phase3/literature-search `{taskId,tasks:[{sectionId,sectionTitle,keywords[],count}]}` → `{job}` → result `{groups[]}`(计划段)/`{materialIds[]}`(单类段) |
| | generateTable → POST /workflow/jobs/phase3/table-generate `{taskId,sectionId,sectionTitle,title,prompt,columns,rows,description,tableType:"text"|"comparison"|"data"}` → `{job}` → result `{materialId,content}` |
| | generateTheory → POST /workflow/jobs/phase3/theory-generate `{taskId,...title≤120字,prompt,tableType}` → `{job}` → result `{materialId,content}` |
| | reviewMaterials → POST /workflow/jobs/phase3/review `{taskId}` → `{job}` → result `{report}` |
| | allocateMaterials → POST /workflow/jobs/phase3/allocate `{taskId}` → `{job}` → result `{suggestions:[{materialId,materialTitle,sectionId}]}` |
| | uploadFile → POST /workflow/jobs/phase3/files(FormData taskId+file) → `{job}` |
| job 流 `re()` | stream(id,{signal,onSnapshot,onEvent}) / get(id)→`{job}` / getActive / getLatestPhase3(taskId) / cancel / retry(均 POST .../{id}/cancel|retry) |
| 版本 `tt()` | getCurrent(taskId) → `{state:{inputVersion:{id},phase2Version:{id},phase3Version:{id,version_no},phase2Stale,phase3Stale}}` |
| | publishPhase3 → POST /workflow/versions/phase3 `{taskId,phase2VersionId,materialUsages:[{materialId,status:"adopted",sectionIds:[id]}],reviewReport}` → `{version:{id,version_no}}` |
| projectStore | loadMaterials/addMaterial(布尔成败)/updateMaterial/removeMaterial/saveProject/enterTextCreation; 读 materials/input{title,requirements,researchMethod}/sections{id,title,level}/statisticsFileId/statisticsVariables/variables/materialReviewReport/phase/三版本 id/materialAllocation/activeSectionId/project{title,logicFlow} |
| taskList | currentTaskId/globalTasks/loadNode("sections"|"materials")/saveCurrentNode; localStorage `lastTask_workflow` 兜底找 workflow 任务 id(148-157) |

**Job 流事件类型**(4657-4675): `literature.group_completed` / `literature.group_recovered` payload `{index,total}`

## 4. 素材对象全貌(跨组件统一)
`{id("mat_"+ts 兜底), type: literature|data|table|theory|image|chart|document, title, caption, content, sectionId, wordCount, createdAt, imageDataUrl, analysisMethod, tableData:{columns,rows}, metadata:{references[],generatedBy,analysisType}, source:{sourceStatus:{ncpssd?,wanfang?: completed|failed|empty}}, references:[{title,author,source,journal,year,volume|volumn,issue|num,pages|page,doi,abstract,gbRef,citation_str,raw,coreBadge}]}`
文献引用 content 内嵌格式: `1.【题目】X【作者】X【来源】X【年份】X【DOI】X【引用】X【摘要】X`(多条分段)

## 5. 辅助 Agent 契约(data-assistant 属性)
容器(4120-4135 声明, 5129-5160 绑定): async-busy/async-reason/material-count/unassigned-count/phase3-published/material-review-complete/phase2-ready/phase2-version-id/phase3-plan-state(running|ready|executing|completed|failed|none)/phase3-plan-confirmed/phase3-task-state/phase3-task-operation/phase3-materials-ready/phase3-publish-ready
控件 data-assistant-control: materials_smart_generate/materials_review/materials_allocate/materials_add_{key}/materials_import_{route}/materials_confirm_plan/workflow_confirm_materials(trigger publish_materials, success phase_changed_or_materials_published)

## 6. 样式要点
全部 **Tailwind 工具类**(无自定义主题, 仅 scopeId data-v-70a58c25 于 MaterialList); 品牌色=**红**(bg-red-500/600 主按钮、text-red-600); 页面 max-w-5xl 单列; 卡片 `bg-white border border-gray-200 rounded-lg|x1 shadow-sm|xl`; 弹层遮罩 fixed inset-0 z-[50]/[70]/[80] bg-black/20|30|60; spinner `border-2 border-gray-300 border-t-red-500 animate-spin`; 进度条 bg-red-600; 变量角色色点 5 色(bg-red-600 自变量/600→gray-600 因变量/500 中介/400 调节/300 控制); 文献平台徽章 bg-blue-50 text-blue-600; 三线表 .three-line-table + 自定义全局 css; 空态 "text-center py-8 text-gray-400"; hover 显现删除 opacity-0 group-hover:opacity-100
