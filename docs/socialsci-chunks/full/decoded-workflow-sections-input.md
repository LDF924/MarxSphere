# 闭源 Vue3 科研工作流解码 —— SectionsView(科研架构 Phase 2) + InputView(信息录入 Phase 1)

> 来源: `formatted/SectionsView-C4lM9Tih.js`(1604 行) + `formatted/InputView-DwlhRWpv.js`(1472 行)
> 页面自身均无直接 fetch, 请求全经共享模块 `index-xpWAkSSw.js` 服务对象/store action。行号为各自文件行号。

---

# A. SectionsView(科研架构, Phase 2 视图)

文件 1604 行单组件: `__name:"SectionsView"`(L211) → `export { Gt as default }`(L1604)。无 props/emits/子组件, 全屏路由页(route /workflow/sections, fixedLayout)。

## A0. Import 别名解析(共享模块导出身份)
`le`=vn(project/workflow 主 store) / `ie`=tt(taskList store) / `V`=C0(GlobalErrorBar store) / `re`=onMounted / `ae`=onActivated / `ne`=onUnmounted / `R`=ref / `c`=computed / `W`=addToast / `de`=nextTick; 渲染机械: ve/Ae/J/qe/Ce/Xe/kt/We/Dn(openBlock/createElementBlock/createBaseVNode/toDisplayString/unref/createTextVNode/createCommentVNode/Fragment/renderList)

## A1. Setup 状态(L212-241)
- store: `e=le()`, `y=ie()`(L213-214)
- 本地仅: `T=ref(null)` typewriterArea DOM; `x=ref("")` 打字机已显文本; `b` setTimeout 句柄
- store 字段语义(共享模块 L15595+): sections(level/title/parentId/children/order/aiSkill/skill_prompt/content)/variables/stepAnalysisTexts{1,2,3}(step1=变量或因素/step2=框架分析含 conceptModel/step3=Skill)/skillThinking/skillStep(0-3)/skillStepDone{step}/skillStepMsg/skillStepDetail/skillError{step,message,detail,canRetry,code}/skillStreamText/skillReasoningText/input{title,outline,totalWordCount,researchMethod}/project{logicFlow}/hasSampleFiles/phase2VersionId

## A2. 组件结构(全部单文件渲染, 行号)
- **页头**(L450-478): h1"科研架构"; 副题 title("未命名项目"兜底)+" — 确认科研架构后进入创作工作台。 "; 统计 "共 N 章" + 子节
- **AI 分析横幅卡**(L479-853)三态(红失败/深灰思考/绿完成):
  - 文案: "AI 分析完成" / "AI 正在分析中" / "科研架构生成失败"; thinking 有"取消"→cancelSkillGeneration(L590)
  - 错误体(L599-636): "Step {n} 执行失败"+error.message+detail; canRetry→"重新生成"→retrySkillGeneration(L628)
  - 3 步进度条(L640-769): 步骤表 Q(L329-333)=[{定性?因素识别:变量识别},{框架分析},{Skill 生成}]; 圆/色函数 X(381-387)+Y(388-394)
  - 打字机思考区(L770-832): 标题 "{生成中|思考中} · Step {n}/3"; 空态灰斜体"准备分析..."
  - 完成条(L833-849): "分析完成,章节写作指导已生成"
- **科研框架概览**(L854-1122): 变量/因素识别卡网格(角色 pill 色 K(role)+name+description+measurement 量规); 研究假设列表(仅定量); 研究逻辑 project.logicFlow + 研究方法 pill + "已由你选择/已根据标题和目录自动识别"(L1112-1116)
- **缺失警告条**(L1123-1151): amber "还有 N 章缺少写作指导,当前科研架构尚未生成完整。" + "重新分析" workflow_phase2_regenerate → generateSkillsForSections()
- **章节树**(L1152-1529): 每行 getSectionNumber(i) 色块(1 红/2 灰/3 浅灰)+ 标题缩进 (level-1)*12px; **一级章扩展详情**(仅 aiSkill 存在):
  - 标签 {hasSampleFiles?"参考框架":"AI 写作指导"}(L1246-1250) + type 徽 + **字数徽标 "{wordCount} 字(Phase 1 分配)"**(L1257-1266)
  - frameworkSource(amber): 文件 refFile/原文结构 originalStructure/变量替换 variableMapping/分析框架 extractedModel
  - chapterDraft(绿"草稿预览")/writingGoal/keyPoints/notes/connection("衔接:")
  - 无 aiSkill: "AI 正在分析该章节…"(thinking) 或 "该章写作指导尚未生成"
- **底部**(L1530-1595): 主按钮"确认科研架构,进入素材准备"(thinking 或 `_` 时禁; spinner"AI 分析中,请稍候…")→Z(395-415); 次按钮"返回修改"→/workflow/input(L1591)

## A3. computed 语义(L216-240, 275-333)
- k=一级章数; L=子节总数; C=有 aiSkill 一级数; D=aiSkill 有内容(writingGoal/keyPoints/childSections)数; **H=metadata-complete**=!thinking&&k>0&&D>=k
- $=max(0,k-C) 缺指导数; **`_`=!thinking&&C>0&&$>0**(未完整→禁确认+警告)
- B/I=流式文本/流式中; w=researchMethod==="qualitative" 定性词表切换
- 角色色板: 定量(自变量 blue/因变量 red/中介 amber/调节 purple/控制 gray, L355-361); 定性(影响因素/结果表现/中间机制/情境条件/背景因素, L362-368)

## A4. 业务逻辑
- **假设解析 j()**(L281-321): 定性返回 []; stepAnalysisTexts[2] 优先级: ①```json 块 conceptModel.hypotheses[]→`{id}:{statement}({logic})`; ②行正则 /^H\d+[.、:：]/、/^假设\d+/、/^[（(]H\d+[)）]/; ③兜底 "X 对 Y 有显著影响"(role=自变量/因变量 配对)
- **打字机**(L242-274): watch 流增量 20ms tick, chunk=clamp(8..40, ceil(剩余/20)); thinking 结束全显
- **字数分配**: 客户端不计算占比——总字数 input.totalWordCount 由 InputView 输入并在 publishPhase1 传递; AI 分配至各 aiSkill.wordCount 仅展示 "N 字(Phase 1 分配)"; store sc() 组装 skill_prompt(写作目标/要点/子节重点/注意/**建议字数**/衔接/草稿)
- **恢复 F()**(L334-343): 注册 window.__rfSSEVariables/__rfSSESkills 全局回调(写 e.variables/applySkillsData) → loadNode("sections") → resumeActiveWorkflowJob(store: 查 active/latest phase2 job 续连 SSE)
- **确认 Z()**(L395-415) + store confirmSections(Pp L16856-16876): sections 空→"请至少添加一个章节"; `_`→"科研架构尚未生成完整,请先重新分析"; 无任务→createTaskWithTitle(title,"workflow"); → getCurrent 校验 phase2Version 非 stale("科研架构尚未形成有效正式版本") → 回填 inputVersionId/phase2VersionId → phase=3 → /workflow/materials
- 生命周期: onMounted/onActivated→F(); onUnmounted 清定时器+置空回调(L344-354)

## A5. data-assistant-phase2-* 钩子(L421-448)
async-busy(skillThinking)/async-reason/phase2-sections-count/phase2-level-one-count/phase2-generated-skill-count(C)/phase2-generated-metadata-count(D)/phase2-metadata-complete(H)/phase2-skill-step/phase2-error/phase2-complete

## A6. SectionsView 样式类
`workflow-page max-w-5xl mx-auto px-6 py-8 pb-16`; 状态卡 rounded-xl border + red-200/red-50|slate-200/white shadow|green-200/green-50; 卡头 bg-red-600|slate-700|green-600 text-white; 变量卡 border rounded-xl hover:border-indigo-300; 角色 pill 5 色 bg-blue-500/red-500/amber-500/purple-500/gray-500 text-white text-[11px]; 假设圆徽 bg-purple-100 text-purple-700; 章行 1 级 bg-white/子 bg-gray-50; 字数徽 bg-blue-50 text-blue-600 border-blue-200; 框架源 bg-amber-50/80 border-amber-200; 草稿 bg-emerald-50/80 border-emerald-200; 确认按钮 bg-red-600 hover:bg-red-700 禁用 bg-gray-300

---

# B. InputView(信息录入, Phase 1 视图)

1472 行两组件: OutlineEditor(L125-573, scopeId **data-v-e03bb037**, L574 Ct=di) + InputView(L616-1471) → `export { ce as default }`(L1472)。

## B0. Import 别名
Y=vn(主 store)/K=tt(taskList)/tt=C0(GlobalErrorBar)/G=__vitePreload/H=watch/S=ref/X=computed/R=addToast/A=vModel/D=withDirectives/U=withModifiers/J=createVNode/q=onMounted

**文件解析管道**(L38-90): st(txt FileReader)/Q(docx→mammoth 动态)/rt(pdf→pdfjs+worker); 分发表 nt={txt,doc,docx,pdf}(L83); ot() 分发, 不支持抛"不支持的文件格式: .{ext}(支持 .txt/.docx/.pdf)"。**注意**: accept 含 .md 但分发表无 md(不一致点)

## B1. OutlineEditor 组件
- props: modelValue String=""; emits: update:modelValue/change(L127-128)
- state: 中文数字 w("一".."二十")/u=ref([]) 树/v 回写抑制/E id 计数
- 方法: b() id="o"+seq+"_"+Date.now(); k() 空骨架=3 空一级各带 2 空子节; **L() 大纲文本→树解析**(L171-225): 7 类标题正则定层级——`#~######`(cap3)、`1.2.3` 点层级(cap3)、`1.`(1级)、`第X章/节`(章=1节=2)、`一、`(1)、`（一）`(2)、缩进 bullet(≥4 空格3/≥2 空格2/否则1); 只保留 1/2 两级; **B() 序列化**(L226-243): `"{中文数}、{title}"` + 子节 `"  {章}.{节} {title}"`
- watch modelValue(L244-258): 空→k(); v 真跳过; 否则 L(a)||k()
- p()(L259-263): v=true → emit update:modelValue+change
- M/O/P/z/j: 加一级/加子节(自动展开)/删一级/删子节/上下移一级(L264-284)
- **$() 插入模板**(L285-304): 固定五章大纲——引言(1.1 问题提出与研究缘起/1.2 研究目的与意义/1.3 核心概念界定)/文献综述与分析框架(2.1-2.3)/现状描述或案例呈现(3.1 数据来源与研究对象/3.2 主要特征与发展趋势)/问题分析与对策建议(4.1 存在的主要问题及成因/4.2 对策建议与路径选择)/结语(5.1 主要结论/5.2 研究局限与展望)。与主 store insertTemplate(bp L15844-15880)文本一致
- W() 清除; N computed 计数 "{a} 个一级 · {n} 个二级"
- 工具栏(319-357): "+ 一级章节"/"插入模板"(workflow_outline_insert_template)/"清除目录"; 列表每章行: 红中文序号+input(placeholder"输入一级标题")+操作(+ 添加子节/折叠▼▶/↑↓op-btn/✕); 子节行 {章}.{节} 灰号 + op-btn-sm ✕; 空态 "目录为空,请添加章节或插入模板"+空态按钮(workflow_outline_insert_template_empty)
- **无拖拽排序、无字数/类型列**——纯 title 编辑, level=1/2 由树位置隐含

## B2. InputView 主组件
setup(L618-728): s=主 store/f=任务 store/g=error bar; w/u/v 拖拽 refs; E/b/k 拖拽三件(625-635); L(n)(636-650) 逐文件解析→input.sampleFiles.push({name,size,content}), 失败 toast; 完成后 buildSampleContent+autoSaveDraft
- 方法卡 B(L651-670): qualitative 定性研究(案例/访谈/文本分析)/quantitative 定量研究(问卷/实证/统计分析)/mixed 混合方法
- p clarify 开合; M 已答数(672-677); 分类元数据 O/P(678-697) 8 类: scope 范围界定(blue)/concept 概念维度(purple)/method 研究方法(green)/theory 理论基础(orange)/data 数据来源(cyan)/innovation 创新聚焦(pink)/structure 章节逻辑(indigo)/general 补充信息(gray)
- $()(704-706) 展开+fetchClarifyQuestions; W()(707-713) submitAnalysis→toast"章节清单已生成", 失败 g.show; onMounted(726-728) currentTaskId&&loadNode("input")

模板(L725-1469):
1. 研究主题 workflow_research_title(红星必填, placeholder "例如:数字经济背景下中小企业融资困境与对策研究")
2. 字数预估 workflow_total_word_count(number min3000 max50000 step1000 placeholder10000) + 脚注 "字数估算仅计算正文整体工作量(不含摘要、关键词、参考文献等内容),AI智能体将按此字数进行科研分配。"
3. 研究框架: J(Ct) OutlineEditor v-model input.outline + **sr-only textarea workflow_outline 同步**(L891-906, DOM 单真源)
4. 额外要求 workflow_requirements(placeholder: 近3年文献/实证方法/8000-10000字/江苏省中小企业)
5. 研究方法 3 卡 workflow_method_{qualitative|quantitative|mixed} aria-pressed 选中 border-red-500 bg-red-50; 脚注 "如不确定可跳过,系统将根据标题和目录自动识别"
6. 参考文件: 点击/拖拽 dashed(激活 border-red-400 bg-red-50), accept .pdf/.doc/.docx/.txt/.md; 文件行 icon+name+大小+"已读取"绿/"未读取"红+"移除"
7. **agent 引导提问(推荐)**(L1137-1389) 手风琴: 四态——错误(红+"请修正输入内容或稍后重试,不会自动生成替代问题。"/重新生成引导问题)、完成 0 问("AI 未发现需要补充的引导问题。"/重新分析)、0 问未加载("AI 分析我的研究")、loading(spinner+"AI 正在分析你的研究... 调用大模型理解内容并生成针对性问题,最长约 3 分钟")、有问题卡(category pill + importance==="高" 红"核心问题" + question + guidance + input 存 clarifyAnswers[id])
8. 底部: 主按钮 "开始思考科研架构" workflow_submit_analysis(disabled=submitting||!title||!outline; "提交中...")→W(); "返回"→/workflow?home=1(L1455-1458)

根(L731-745): workflow-page max-w-4xl + data-assistant-async-busy=submitting||clarifyLoading + async-reason

## B3. 业务链: 提交→AI 分析(store kp 主链)
校验主题 ≥4 字非纯数字/outline 非空/GET health → researchMethod 空则启发式(wp: 关键词计分——定量 34 词含 实证/问卷/回归/显著性/中介效应/驱动因素/影响因素, 定性 17 词; te>=2&&Y>=2→mixed/te>=2→quantitative/否则 qualitative) → 组装澄清问答块(Tp)写回 requirements → **POST /api/projects** → 解析 outline 建 sections → **POST publishPhase1** → phase=2 → 路由 /workflow/sections → **POST createPhase2** + 连 SSE。每次编辑 onInput→autoSaveDraft(localStorage skf_draft)

## B4. API 契约(端点=共享模块, 页面无直 fetch)

| 端点 | 方法/体 → 响应 | 触发 |
|---|---|---|
| /api/health | GET | kp 前置 |
| /api/projects(Uw.create) | POST `{taskId,title,domain,field,outline,requirements,researchMethod,status:"active"}` → `{data:{id}}` | kp L16044-16051 |
| /api/workflow/versions/phase1 | POST `{taskId,title,outline,domain,field,requirements,researchMethod,totalWordCount,sampleContent,sectionsList:[{id,title,level,parentId,order,skill_prompt,requirements,aiSkill,summary}]}` → `{version:{id}}` | kp L16061-16098 |
| /api/workflow/jobs/phase2 | POST `{taskId,inputVersionId}` → `{job}` | kp 尾 L16217-16221 |
| /api/workflow/jobs/active | GET | qo 冲突判定 |
| /api/workflow/jobs/phase2/task/{tid}/latest | GET | Ep 恢复 |
| /api/workflow/versions/task/{tid}/current | GET → `{state:{inputVersion,phase2Version,phase2Stale,...}}` | Ep/Pp |
| /api/workflow/jobs/{id}/retry·cancel | POST | Ap/Ip |
| /api/workflow/jobs/{id}/stream?after=N | GET SSE: job.snapshot 逐帧驱动 skillThinking/Step/variables/result; completed: result.skills→applySkillsData、logicFlow、phase2VersionId; failed→skillError | vi/Rs |
| /api/tasks(Rt.create) | POST `{title:"工作流 · 主题",module:"workflow",status:"in-progress",phase:0}` | createTaskWithTitle |
| /api/tasks/{id}/switch | POST → `{task(含snapshot)}` | createTaskWithTitle |
| /api/tasks/{id}/nodes/{node} | GET/PUT `{nodeData}` (node=input/sections/materials/workspace/finalize) | loadNode/saveCurrentNode |
| /api/clarify/generate | POST `{title,outline,requirements,researchMethod,totalWordCount,sampleContent,modelConfig}` → `{success,data:{questions:[{id,category,question,guidance,importance}]}}`; **180s 客户端 abort** → TIMEOUT | InputView |

## B5. 状态与数据流
- localStorage: `skf_draft`(即时草稿)/`wf_save_{uid}_{taskId}`(阶段快照)/`lastTask_workflow[_uid]`
- 恢复链: InputView onMounted→loadNode("input"); SectionsView onMounted/onActivated→loadNode("sections")→resumeActiveWorkflowJob
- OutlineEditor v-model 环路: 文本→watch 解析为树(抑制位 v)→编辑 p()→emit 序列化→父写 input.outline+autoSaveDraft→watch 遇 v 跳过
- 交 Phase2: submitAnalysis 成功后 store 路由 /workflow/sections 并已同步启动 createPhase2+SSE(SectionsView 只恢复/渲染)
- DOM 钩子: workflow_research_title/total_word_count/outline/requirements/method_{qualitative|quantitative|mixed}/submit_analysis/return_home/outline_insert_template(_empty)

## B6. InputView 样式类
`workflow-page max-w-4xl mx-auto px-6 py-8 pb-16 min-w-0 h-full overflow-y-auto`; 输入 border-gray-300 rounded-lg focus:ring-red-500; 红星 text-red-500; 方法卡 rounded-xl border-2 选中 border-red-500 bg-red-50 shadow-sm; 拖拽 border-2 dashed hover:border-red-300 激活 border-red-400 bg-red-50; clarify 卡 border-gray-200; 主按钮 bg-red-600 disabled:bg-gray-300; OutlineEditor 独立体系: outline-editor border-gray-300 + op-btn/op-btn-danger/op-btn-sm + tree-branch/tree-collapsed/tree-child/tree-child-last + group/child

---

## 两视图协作总览(复刻提示)
1. **InputView(phase1 录入) → submitAnalysis → /api/projects + publishPhase1(10 字段全量快照: title/outline/domain/field/requirements/researchMethod/totalWordCount/sampleContent/sectionsList) → 同步创建 phase2 job 并跳转**
2. **SectionsView(phase2) 是纯消费/展示页**: SSE 全局回调注入 variables/skills → 恢复/续连/重试/取消 job; 展示 3 步进度+打字机思考流+变量卡+假设+每章写作指导(字数由 AI 按 Phase1 totalWordCount 分配为 aiSkill.wordCount, 客户端只展示不计算)
3. **确认门**: confirmSections 校验 getCurrent 的 phase2Version 非 stale → 回填双版本 id → phase=3 → /workflow/materials(数据衔接字段即 inputVersionId + phase2VersionId + sections[含 aiSkill])
4. 目录编辑器 = 大纲 markdown 双向序列化(7 类标题正则, 只收两级) + 内置五章模板; 服务端 nodes/input 快照是恢复真源
