# 闭源 Vue3 科研工作流解码 —— WorkspaceView(文本创作/章节生成 Phase 4) + FinalizeView(合稿定稿 Phase 5)

> 来源: `formatted/WorkspaceView-Baf0x_1H.js`(2706 行) + `formatted/FinalizeView-Br8-MIOb.js`(1748 行)
> 两者均无直接 fetch( / localStorage, 请求全部经共享模块 `index-xpWAkSSw.js` 服务对象。

---

# A. WorkspaceView(章节生成工作台)

导出: L2705-2706 `nn = Oe(Us, [["__scopeId","data-v-2b778b5d"]])` → `export { nn as default }`(scoped 样式 scopeId `data-v-2b778b5d`)。根组件无 props/emits。

## A1. 组件树

### 1) SectionNavItem(L64-230)
- props: `section{Object,req}`/`isActive{Boolean,false}`/`expanded{Boolean,false}`/`hasChildren{Boolean,false}`; emits: `["select","toggle"]`
- setup: `V=computed(取 section.content 长度)`(L76); 子节缺失回退 `{id,title:"...",level:2,status:"",content:""}`; 选中时调 `$.setActiveSection(真实section)`(L86-89 store 注入)
- 模板: 整行点击 emit select; 展开箭头 emit toggle(.stop); 标题 `paddingLeft:(level-1)*12px`; 一级章节号=红底数字块(getSectionNumber), 二级=右对齐灰数字; 选中态 `bg-red-50 border-l-2 border-red-500`; 状态圆点: generated=绿实点(L178-179)/generating=琥珀 animate-pulse(L181-182); 一级有内容→下行灰字 `字数`; 有 children 且展开→递归 SectionNavItem(children 为 id 数组查 store)

### 2) SectionGenerator(L243-373)
- props: section/generating/disabled/disabledReason/streamContent; emits: generate/regenerate/cancel
- 状态胶囊: generating→琥珀"生成中..."/generated→绿"已生成"/否则灰"待生成"(L261-280)
- 主按钮(L283-338): disabled=`generating||disabled||!useBackend`; 文案= "正在思考..."(spinner)/disabledReason||"请稍后操作"/"执行智能体开始思考"; 生成中红色描边"取消"(L339-350); generated 时灰"重新思考"(L352-367)

### 3) MaterialCard(L395-615)
- props: material; emits: click/insert/remove(父只绑 insert/remove)
- 静态映射表: 类型→图标字符(L401-414 theory/data/case/method/literature/image/chart/table/other)、类型→中文标签(L415-428 理论/数据/案例/方法/文献/图片/图表/表格/其他)、配色三组蓝/emerald/琥珀/紫/indigo/rose/orange/cyan/灰(L429-470)
- 展示: 标题缺省"未命名素材"、类型胶囊、wordCount 字、有 sectionId→琥珀警告"已关联"(L513-535); hover 右上两钮: 插入"插入到章节"/删除"删除素材"; 摘要 line-clamp-2

### 4) 根 WorkspaceView(L735 起)
- setup 注入: `e`=主 store、`a`=AI store、`$`=settings store、`V`=toast、`k`=task store、`U`=router、`A`=workflow job API、`J`=getTaskState/syncToAIStore、`Je`=AI 控制器(generateMaterial SSE)、`Xe`=marked、`Ze`=debounce500
- state: `_`(743-748) showMainAIPanel 双向 computed("结构化指导/关闭结构化指导"); `p=ref(false)` 素材生成弹窗; `C=ref("")` 素材 SSE 流内容; `M=ref({type:"theory",prompt:""})` 素材表单; `O=debounce(e.saveProject,500)`; `v=computed(e.activeSection)`; `Z=null` 当前单节 job id; `T/P/K` 批量快照/成功 id 集/累计字数
- computed: `le`(754-761) 当前节字数(生成中用 streamContent.length); `pe`(762-780) 写作指导值——skill_prompt 剔除含 `建议字数|目标字数|字数目标|Phase 1 budget|Phase 1 child budgets|Child word allocation` 的行; `we`(784-791) 编辑器内容=生成中 streamContent 否则 content; `Se`(797) 节索引; `F`(804) 一级章节; `W`(805) 一级 generated 数; `Ie/$e`(806-812) 子节总数/有内容数; `X`(813) 未完成一级数; `Te`(814-818) 进度%; `B`(819-826) busy=4 个 generating||mainAIThinking; `ne`(827-837) busy 文案 正在批量生成章节/正在生成章节内容/正在生成素材/正在进行结构化分析/当前操作处理中; `ce`(850) 可进合稿=不忙&&一级>0&&未完成=0; `re`(851-860) 素材过滤: 选中节只留 [activeSection,...children] 关联 + materialFilter 类型筛
- 关键方法: `ye`(781) 写作指导写 store+防抖存; `ke`(792-796) 正文编辑(同节生成中忽略回写); `de`(838-849) 重置任务状态+J.syncToAIStore; `L`(864-868) busy 门禁 toast warning `"{ne},请等待完成后再操作"`; `Pe`(869-871) →/workflow/materials; `je`(872-887) 进合稿门禁(无一级→"请先确认章节清单,再进入合并定稿"; 未完成→"还有 N 个一级章节未完成,全部完成后再进入合并定稿")→enterMergePhase(); `Y`(891-958) 正文→结构化摘要: 分段→【关键结论】(结果表明/显示/本文…/综上)/【关键数据】(增长了/占比%)/【核心论点】(假设|H\d|命题)/【遗留问题】(局限|不足|待进一步), 总长截 800 字

## A2. 业务逻辑

### 节状态机
`pending(待生成)` → `generating(生成中)` → `generated(已生成)`; 失败/取消回 pending; 批量回滚按快照恢复

### 单节生成 `me`(989-1078)
门禁: busy 拒; level!==1→info "子节内容随父章节一起生成"; 无 taskId 或 !phase3VersionId→warning "请先发布有效的 Phase 3 素材版本"。→ AI store 置态 → `A.createPhase4({taskId, phase3VersionId, sectionIds:[r.id], sectionSnapshots:ge([r.id])})` → 挂 `A.stream(job.id)`, 仅 `phase4.section_delta` 且 payload.sectionId===当前节才追加 → 流毕非 completed → A.get 轮询 → 仍败 → getPhase4Stages 找 failed 阶段取 error(兜底"章节生成失败")→ 无 result.phase4VersionId→"正文任务未返回有效的 Phase 4 正式版本" → getPhase4Sections 全节回填 → toast `"{title}生成完成"`

### 批量生成 `Me`(1090-1318)
- 一级全 generated 有内容 → `window.confirm("所有章节已有正文。重新生成将覆盖当前内容,确定要继续吗?")`
- 深快照 `T={sections,materials,workflow{phase,textFlow,merged*,mergeGenerated,isFinalized,reviewResult,checklist},timestamp}`(L1114-1131) → 目标节全置 pending, checklist 六项置 false → AI store batchGenerating + batchProgress{current,total,generatedChars,failed,failedSections,phase:"正文"}
- `createPhase4Batch({taskId,phase3VersionId,sectionIds,sectionSnapshots})` → stream: job.snapshot 用 result.sections.length 推进度; `phase4.section_delta` 累字; `phase4.section_completed{sectionId,content}` 立即落库(含 summary)
- 失败路径: **整批还原 T 快照** + toast "批量生成失败,已恢复生成前的阶段和内容"; 成功: "批量生成完成,共 N 个章节"/部分 "批量生成完成,N/M 个成功"
- `Fe`(1319-1356) 全部回滚; `Ae`(1357-1399) 只回滚本次成功节(P)

### 恢复(onMounted 1467-1550)
`loadNode("workspace")`+loadMaterials; `A.getLatestPhase4(taskId)`: running/queued→相关节置 generating+重挂 stream; completed→de()+getPhase4Sections 回填+rebuildRelations(), 一级全有内容→textFlow.status="completed"; failed/cancelled→de()+节回 pending

### 主控 AI 面板(消费 AI 侧 skills 事件, 不发起)
thinking 三态: 3 步进度(识别研究变量/构建研究框架/生成写作指导); 完成: 绿色变量胶囊+琥珀"章节逻辑关系"+写作指导卡片(aiSkill.type 胶囊+writingGoal+keyPoints); 空闲: 灯泡+"尚未进行结构化分析"+"开始分析(变量、框架、写作指导)"按钮

### 素材生成弹窗(2530-2695)
类型 select(理论/数据/案例/方法/文献素材)+生成要求 textarea+红主按钮(materialGenerating?"思考中...":"执行智能体开始思考")+流式结果 markdown+"保存到素材库"绿钮。保存: id="mat_"+Date.now(), title=prompt 前 50 字, summary=流内容前 100 字, sectionId 绑当前节, toast "素材已保存"

## A3. API 契约(WorkspaceView)

| 动作 | 端点(共享模块) | 请求体/响应(视图行号) |
|---|---|---|
| 章节恢复 | GET /api/workflow/jobs/phase4/task/{taskId}/latest | resp `{job:{id,status,sectionIds,result:{phase4VersionId}}}`(L1476) |
| 单节生成 | POST /api/workflow/jobs/phase4/sections | body `{taskId,phase3VersionId,sectionIds:[id],sectionSnapshots}`(L1003-1008) |
| 状态流 | GET /api/workflow/jobs/{id}/stream(SSE) | 事件 `phase4.section_delta{sectionId,content}`、`job.snapshot` |
| 作业查询 | GET /api/workflow/jobs/{id} | `{job:{status,error{message},result:{phase4VersionId}}}` |
| 阶段查错 | GET /api/workflow/jobs/phase4/task/{tid}/stages | `{stages:[{sectionId,stage,status,error{message}}]}`(L1031-1035) |
| 拉正文 | GET /api/workflow/jobs/phase4/version/{vid}/sections?taskId=&sectionIds=a,b | `{sections:[{sectionId,content}]}` |
| 批量生成 | POST /api/workflow/jobs/phase4/batch | body 同单节+全目标 sectionIds; 事件另有 `phase4.section_completed{sectionId,content}` |
| 取消 | POST /api/workflow/jobs/{id}/cancel | |
| 素材生成 | POST /api/ai/material/generate(SSE sn) | body `{modelConfig:{temperature,maxTokens},toolType:literature→"reference"否则"text",query,count:5,prompt,targetSectionId:节title}`(L1410-1418) |

## A4. WorkspaceView 数据流/探针

- 父子: SectionNavItem emit select/toggle→setActiveSection/toggleSectionExpand; SectionGenerator generate/regenerate→me / cancel→Ge; MaterialCard insert→Re(正文尾追加)/remove→Ne
- watch e.sections deep(L1551-1558): phase===4 → saveProject+saveCurrentNode
- SSE 监听事件: `phase4.section_delta`/`phase4.section_completed`/`job.snapshot`
- 任务态镜像 J: {generating:{batch,section},meta:{sectionGeneratingId,batchProgress},aiThinking,aiThinkingText,currentTask}(L840-849 等)
- data-* 探针(根 1566-1583): phase4-workspace/phase4-generation-complete/phase4-review-required/top-level-count(等 4 数)/async-busy/async-reason; 控件锚点 workflow_phase4_generate_all(L1712)/workflow_phase4_enter_finalize(L1778)

## A5. WorkspaceView 样式语义类
根 `workflow-page workspace-container flex pb-8`; 左栏 w-72 border-r; 右栏 w-72 border-l bg-gray-50/50 头 sticky+backdrop-blur; 业务主色类 `workflow-outline-primary`(L1614 蓝 #1e4d8c/#9bb8d8 描边系)与 `workflow-material-primary`(L2435 小按钮); 进度条 h-full bg-red-500; 语义块 bg-green-50/red-50/blue-50/amber-50 + markdown-body; MaterialCard `group relative bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-red-200` hover 操作 opacity-0 group-hover:opacity-100; 素材弹窗 fixed inset-0 z-[70] 卡片 w-96; 编辑器 max-w-4xl; 状态胶囊 amber-100/green/gray

---

# B. FinalizeView(合稿定稿)

导出 L1748 `ns as default`; __name FinalizeView(L166); **无 scopeId**(依赖全局 merge-timeline 系/animate-spin-slow); 无子组件(MarkdownEditor/PaperPreview/docx/FileSaver 均 import 复用)。

## B1. setup state(172-246)
- 注入: 主 store/AI store/toast/task store/版本 API `O`/job API `k`/U 文本渲染 helper
- `N=ref(false)` 预览弹窗; `C=debounce(saveProject,500)`
- `X`(174-182) 打印页眉=首篇有内容章节 number||order||title
- `w=ref(0)` 时间轴步骤; `V=ref("")` 步骤消息; `z=ref({})` 步骤到达时刻表; `P` 延迟定时器
- 步骤常量 `E`(228-234): ①合并正文 ②语言润色 ③整理参考文献 ④生成元信息 ⑤完成
- `R=ref("normal")` 合并模式; `$=ref("medium")` 降AIGC强度; `D`(死代码从未置 true); `M=ref(false)` 修订生成中; `S=ref(null)` 待采用修订稿{title,abstract,keywords,body,references,phase5VersionId}; `K` 查看差异; `A` 进度对象(死代码, 真实进度走时间轴)
- 强度 `me`(242-246): light 轻度降重/medium 中度降重/heavy 重度降重

## B2. 业务逻辑

### 合稿门禁与三轮(merge→review→revise)
`ge`(255-319): 无 taskId→"请先创建并保存工作流任务"; 无有内容章→"没有已生成内容的章节可供合稿"; 有空一级→"还有 N 个一级章节未完成,不能合稿"; getCurrent: phase4Stale 或无 phase4Version.id→"请先完成当前 Phase 4 正文生成,再进行合稿"。清理旧产物 → `createPhase5Merge({taskId, phase4VersionId, enableDeAIFyMerge: R==="deAIGC"})`(**强度档未随请求发送, 只上 data 属性**)
- 模式: 直接合稿 normal / 降AIGC合稿 deAIGC(提示"降重可能会影响整体论文质量,请自行斟酌")
- 结果应用 `Z`(320-339): 解析→**引用编号重建 `fe`**: 正文 `§REF_a_b§` 占位符→顺序 `[n]`(去重映射 L424-427), 从 materials type=literature 且含 references[].gbRef 项按出现序拼 `"[n] gbRef"`; 表格重编号 `xe`: `**表N[.、：:]xxx**`→`**表N xxx**`; mergeGenerated=true/isFinalized=false
- 元数据解析器 `be`(450-485) 三档: 对象直取; 标记文本 `【题目】【摘要】【关键词】【正文】【参考文献】`; Markdown 兜底 `# 标题/## 摘要/关键词[：:]/## 参考文献`
- 流事件 `Q`(340-377): `phase5.merge_delta{content}` 累加; `phase5.merge_status{step,message}`→H(step)+V; `phase5.merge_completed{data}` 暂存; job.snapshot queued/running/pausing→w=currentStep; completed→s=result.data; 轮询 get 校验; 成功→Z+H(5)+toast "论文合并完成"
- 合并中 UI: "正在合并论文"+纵向时间轴 5 节点左右交替(is-left 奇偶), 完成=琥珀白勾/当前=旋转描边环 spinner/未到=灰圈; 进度条高度 (w-1)/(len-1)
- 恢复 `pe`(378-400): getLatestPhase5 completed 且有 data→直接应用; 进行中→续接 Q

### 全文审查(review 轮)
`ve`(486-515): getCurrent→phase5Stale 或拿不到→"请先完成当前合稿,再执行全文审查"→ `createPhase5Review({taskId, phase5VersionId})` → 流 `phase5.review_delta{content}`(琥珀块内联)/`phase5.review_completed{reviewReport}` → 写 e.reviewResult(绿块) toast "全文审查完成"; `we`(546-570) getLatestPhase5Review 恢复。入口文案: "AI 将对全文进行深度润色与质量提升…"

### 修订轮(revise)+版本激活
`he`(571-613): 校验 phase5Version → `createPhase5Revision({taskId, phase5VersionId, reviewReport})` → completed → `S={...result.data, phase5VersionId}` toast "修订稿已生成,请检查后再采用" → 琥珀提示条 "修订稿已生成,正文 {N} 字。当前合稿未被替换。" + 查看差异(K, whitespace-pre-wrap text-[10px]) / 采用修订稿
`ye`(614-640): `activatePhase5Version(taskId, versionId)` POST /workflow/jobs/phase5/version/{vid}/activate body {taskId} → 覆盖当前合稿字段 → "修订稿已采用"

### 终稿元数据编辑(mergeGenerated 态 1171-1382)
琥珀横幅"合并完成"+"重新合稿"; 5 受控编辑区: 论文标题(input text-lg font-bold)/摘要(textarea rows=4)/关键词(placeholder "关键词1;关键词2;关键词3")/正文(**MarkdownEditor** min-height 500 max-height 60vh, render-opts:{materials}, paper-meta 全量)/参考文献(mono textarea rows=8)

### 导出 `_e`(649-727)
- 门禁: 无 mergedFullText→exportStatus="failed"+"没有可导出的内容"; 文件名 title 净化 `[\\/:*?"<>|]→_`, pdf 后缀名仍是 docx(先出 Word)
- 格式(store exportFormat, 默认 md): docx→paperExport 构建器→Packer.toBlob→FileSaver `${name}.docx`; pdf→docx+info "已导出 Word 文档,请在 Word 中完成排版后选择"另存为 PDF""; md/html→拼 `# 标题/## 摘要/**关键词：**/正文/## 参考文献`, html 走 `Se()`: `**表N …**` 行提升 .rf-table-caption + 完整 A4 印刷 CSS(SimSun 12pt/SimHei 标题/170mm 版心/main>h1 居中 18pt)
- 收尾: exportStatus="completed"+exportedAt+**isFinalized=true**+toast "导出成功:{name}.{fmt}"

### 预览/材料
`预览全文`→N=true Teleport to body: paper-print-running-header(首个有内容章名)+PaperPreview(全量 props)+hidden 打印原始块; 参考卡: 格式 select(Markdown/Word/HTML/PDF(先导出 Word))+绿"导出论文"+"预览全文"+"返回工作台"→/workflow/workspace
材料恢复=挂载 loadMaterials(206) + 合稿引用重排消费(gbRef)

## B3. API 契约(FinalizeView)

| 动作 | 端点 | 请求/响应(行号) |
|---|---|---|
| getCurrent | GET /api/workflow/versions/task/{tid}/current | `{state:{phase4Version:{id},phase4Stale,phase5Version:{id},phase5Stale}}` |
| merge | POST /api/workflow/jobs/phase5/merge | `{taskId,phase4VersionId,enableDeAIFyMerge}`(306-310) |
| 流/查询 | GET /api/workflow/jobs/{id}/stream / GET /api/workflow/jobs/{id} | 事件 merge_delta{content}/merge_status{step,message}/merge_completed{data}/job.snapshot{status,currentStep,result{data}} |
| 恢复 | GET /api/workflow/jobs/phase5/task/{tid}/latest | `{job:{status,currentStep,result:{data}}}` |
| review | POST /api/workflow/jobs/phase5/review | `{taskId,phase5VersionId}`; 事件 review_delta{content}/review_completed{reviewReport} |
| 审查恢复 | GET /api/workflow/jobs/phase5/task/{tid}/latest-review | |
| revise | POST /api/workflow/jobs/phase5/revise | `{taskId,phase5VersionId,reviewReport}` → job.result{data,phase5VersionId} |
| 激活 | POST /api/workflow/jobs/phase5/version/{vid}/activate | body `{taskId}`(13409-13413) |

## B4. FinalizeView 数据流/探针
- 时间轴节流 `H`(401-418): 连续两步间隔<2s 用定时器补齐(防 SSE 秒级快进动画不可见); 完成强置 H(5)
- watch mergedFullText/mergedTitle(210-223) phase===5 防抖保存
- 恢复双保险: 挂载 pe(合稿)+we(审查)
- data-*: async-busy(mergeGenerating||reviewGenerating||M||D||exportStatus==="running")/export-status/format/file-name/exported-at/export-download-feedback/merge-mode/humanize-tier/phase5-* 计数; 控件: workflow_merge_direct|aigc(+trigger/success 对 select_direct_merge→merge_mode_direct 等)、workflow_aigc_tier_{light|medium|heavy}、workflow_phase5_merge→merge_full_paper→merge_complete、workflow_phase5_review→review_full_paper→review_complete、workflow_phase5_revision→generate_phase5_revision→phase5_revision_visible、workflow_export_format、workflow_export_paper→export_paper→export_status:completed(均 data-assistant-async="true")

## B5. FinalizeView 样式语义类
根 `workflow-page max-w-5xl mx-auto px-6 py-8 pb-16`; 空态 hero 琥珀方块图标; 模式分段 `inline-flex bg-gray-100 rounded-xl p-1`; 主按钮琥珀系 `bg-amber-600 shadow-lg shadow-amber-200`; 合稿时间轴全局类 `merge-timeline/__track/__progress/__items/__item.is-left/__marker/__content` + `animate-spin-slow`(非 scoped 全局); 合并后栅格 `grid max-w-7xl lg:grid-cols-3`(左 col-span-2); 字段卡 bg-white rounded-xl border p-5; 审查琥珀流/绿结果 `p-3 rounded-lg max-h-80 overflow-y-auto markdown-body text-xs`; 预览弹层 `paper-preview-modal fixed inset-0 z-[80]` + shell w-[900px] max-w-[95vw] h-[85vh] + scroll; 打印专用 paper-print-running-header/page-number

## 双视图共同要点(复刻提示)
1. 阶段产物版本链: phase3VersionId(素材)→phase4VersionId(正文, getPhase4Sections 拉回)→phase5VersionId(合稿, activatePhase5Version 切换修订)→isFinalized+exportStatus 终态
2. 每轮后台 job 标准模式: POST 创建 → SSE stream(section_delta/section_completed 或 merge_*/review_* 事件) → 流毕 get 轮询确认 → getLatestPhaseX 挂载恢复(双保险)
3. 大批量操作前深快照 + 失败整批还原/成功可回滚是 Workspace 批量生成的核心 UX; window.confirm 覆盖确认
4. 所有写操作防抖 500ms 落库; 保存走 saveProject + saveCurrentNode 双通道
5. data-assistant-* 探针贯穿两页, 供外部 Agent 通道(state 契约可复刻)
