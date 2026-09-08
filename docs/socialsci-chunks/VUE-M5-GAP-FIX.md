# M5 闭源差距补齐清单(用户评审: "M5 和原版差距有些大")

> 来源: 用户 2026-09-08 评审意见 + decoded-workflow-*.md 逐条对照。
> 原则: 核心交互/数据算法/组件形态逐步向闭源对齐, 每视图一批提交。

## A. SectionsView(已提交 fd72e35, 差距集中)
- [x] A1 打字机接线: startTypewriter 已定义但无调用点 → skillStream 来自后端进度时逐帧驱动 + 完成全显
- [x] A2 假设解析 j(): 定性→[]; stepAnalysisTexts[2] 优先级 ①```json conceptModel.hypotheses `{id}:{statement}({logic})` ②行正则 H\d/假设\d+ ③兜底"X 对 Y 有显著影响"(自变量/因变量配对)
- [x] A3 研究方法 pill: 定性/定量徽标 + "已由你选择/已根据标题和目录自动识别" 文案(用户未选手动时)
- [x] A4 变量卡角色 pill 5 色 + measurement 量规 + 假设圆徽(bg-purple-100/purple-700)
- [x] A5 SSE 恢复: window.__rfSSEVariables/__rfSSESkills 回调注册 + 活动 job 续连

## B. MaterialsView(已提交 86c7c93, 闭源 10 组件+2 composable → 我单文件)
- [x] B1 智能生成执行计划确认层: plan{literatureSearch/textTables/dataAnalysis 三数组 checkbox}→确认→逐段执行(jobKind 链)→成功 toast 计数
- [x] B2 文献批量解析器 la(): DOI `10.\d{4,}/` + 年份 `\(?(\d{4})\)?` + APA/GB 混合; 无结果"未识别到有效文献"
- [x] B3 编排弹层 MaterialAllocationDialog: suggestions[无 sectionId] → checkbox+目标章节 select → 应用
- [x] B4 单类生成弹层 MaterialGenerateDialog: 关联章节 select + 表类型 radio + 流式预览 + 保存
- [x] B5 图片预览全屏层; 文献卡来源徽章(文献库检索/内部资料 + sourceStatus completed/empty/failed)
- [x] B6 发布门禁完整文案(未关联 N 个素材)

## C. WorkspaceView(已提交 1eaad17)
- [x] C1 子组件化: SectionNavItem(递归)+SectionGenerator(3 态胶囊+禁用 reason)+MaterialCard(9 类型图标/中文标签/配色)
- [x] C2 主控 AI 面板(结构化指导): 3 步进度(变量/框架/写作指导)+完成态(变量胶囊+逻辑关系+写作指导卡)+空闲灯泡态
- [x] C3 素材生成弹窗: 类型 select + 生成要求 + 流式结果 + 保存到素材库
- [x] C4 节字数徽标"N 字"实时(生成中 streamContent.length)

## D. FinalizeView(已提交 ace4396)
- [x] D1 引用重建 fe 调用: merge 结果 content 的 §REF_a_b§ → 顺序 [n] 去重; materials literature+gbRef 按出现序拼 "[n] gbRef" 表
- [x] D2 表格重编号 xe 调用: **表N[.、：:]xxx** → **表N xxx**
- [x] D3 导出 html: 表题行 **表N…** 提升 .rf-table-caption + 完整 A4 印刷 CSS(SimSun 12pt/SimHei/170mm 版心/主 h1 18pt 居中)
- [x] D4 导出状态 isFinalized=true + exportedAt + toast 带文件名

## E. 全局
- [x] E1 PhaseProgressBar(6 节点: 研究主题→1-5, ppb-* 语义) + 5 视图页头统一挂载
- [x] E2 InputView 方法卡选中红边框边框恢复 + "已根据标题和目录自动识别" 提示

## 实施进度(2026-09-09)
- [x] A1-A5 SectionsView 全部(提交 c7ffebc: 假设三级解析/方法pill/logicFlow/aiSkill 扁平映射/写作指导生成链)
- [x] B1 智能生成执行计划(提交 308bfdc: 后端 material-plan 执行器+端点; 前端三段确认弹层 10 checkbox+逐段执行+计数 toast)
- [x] B2 文献批量解析(提交 2754194: DOI/年份/APA·GB 混合; 弹层内嵌折叠区+预览列表+应用拼装)
- [x] B3 编排弹层(提交 c07f17f: 闭源 MaterialAllocationDialog 形态 — Teleport+章节树 select+计数按钮; POST allocate {projectId}→逐条 adopt; toast "已为 N 个素材关联章节"; 空态"暂无建议"/全关联 info/无章节 warning)
- [x] B4 单类生成弹层(提交 c07f17f: 闭源 MaterialGenerateDialog — 标题(检索文献/生成X)+提示+关联章节 select+表类型 radio(文本对比表/数据表)+job 泵生成→预览→保存到素材库)
- [x] B5 图片全屏预览层 + 文献来源徽章(提交 c07f17f: Teleport z-80 全屏 img; platformType/sourceType 徽章 文献库检索/内部资料 + sourceStatus completed已用/empty无结果/failed失败; 后端 listMaterials 富列 camelCase + meta 展开; exec 文献检索素材打 platformType 标)
- [x] B6 发布门禁文案(提交 c07f17f: 无素材"请先添加素材"; 未关联"还有 N 个素材未关联章节，请先为每个素材选择所属章节" — 与闭源一致)
- [x] C2 主控 AI 面板(提交 26bb8c1: 3 步进度 识别研究变量/构建研究框架/生成写作指导 + 完成态 变量胶囊/章节逻辑关系/写作指导卡 + 空闲灯泡态"尚未进行结构化分析"; 挂左栏"结构化指导"开关 + 分析中 job 恢复续连)
- [x] C3 素材生成弹窗(提交 26bb8c1: 右栏"＋ 生成" → 类型 select 5 类+生成要求 → POST materials/generate → 预览列表 → 保存刷新素材库)
- [x] C4 节字数徽标(提交 26bb8c1: "已生成 N 字")
- [x] D1 引用重建 fe(提交 e549b38: §REF_a_b§→首次出现序 [n] 去重; literature/citation references[].gbRef 出现序拼 "[n] gbRef" 表; 已有参考文献则保留)
- [x] D2 表格重编号 xe(提交 e549b38: **表N[.、：:]xxx** → **表N xxx** 递增)
- [x] D3 HTML 导出(提交 e549b38: 表题行 .rf-table-caption + 三线表 + A4 印刷 CSS SimSun 12pt/SimHei/170mm 版心)
- [x] D4 导出状态(提交 e549b38: isFinalized + exportedAt 持久化)
- [x] E1 PhaseProgressBar(提交 e0e2272: 新建组件 6 节点 ppb-* 语义(研究主题卡+1-5 done/active/pending+metric+连接线); 5 视图页头全挂载, workspace 改列布局)
- [x] E2 方法自动识别提示(提交 e0e2272: InputView "已根据标题和目录自动识别: 定量研究" 提示 + 样式)
- 全部经 vue-tsc 0 错 + 浏览器 5174 实测(素材编排 11 条建议关联/生成弹层两轮 job/图片全屏/徽章三态/发布门禁/主控面板分析完成 5 指导卡/素材生成/引用重建 gbRef 拼表/表格重编号/进度条 5 视图)
- M5 全部 A-E 清单已完成 ✅(会话 3/4 共 6 提交: c7ffebc…e0e2272)


## 会话 3 交接(2026-09-09 续做前置)
### 环境
- worktree cranky-babbage-0a2349; 后端 4173 由 worktree 代码 + 主仓 .env(EMPIRICAL_PYTHON) 运行中; vue dev 5174 运行
- 浏览器(5174)登录态: soc_test; localStorage: sag_token+skf_auth_token 已注入
- 测试项目: 8ddca3d3-9448-44b2-9936-8e2d458b8977('数字普惠金融对中小企业融资约束的影响研究')
  - workbench: phase 4, sections 17 节(5 一级章带正文), merged_* 列已填(合稿产物 7812 字)
  - materials: 11 条(citation 6 + data_result 5); 素材列表 GET /api/research/materials?projectId=<pid>
- 切换视图方式: location.href = "http://localhost:5174/soc/#/workflow/<view>"
- execCommand 填 textarea 在 eval 中可用; preview_fill 也可; 模板 value setter 报 Illegal invocation 时改用 execCommand
- python heredoc 写代码会破坏 
 → 一律用 Read+Edit 工具或文件内容替换(python 只做读/查)
### 已验证契约(改代码前先确认)
- research_tasks: createTask 返回 {task:{id,...}}; jobKind 泵执行; 轮询 GET /api/research/tasks/{id}(progress{stage,current,total}/result/status)
- materials POST → {id}(无嵌套); DELETE /api/research/materials/{id}; allocate: POST /api/research/materials/allocate {projectId}(已有端点, 返回 suggestions?)
- 编排语义(闭源): allocateMaterials → suggestions[{materialId,materialTitle,sectionId}] → 弹层逐条确认 → updateMaterial 设 sectionIds
- workbench GET → {snapshot}; PUT → {snapshot:...}; nodes GET → {node:{payload}}
- skill-cards: GET 列表 + POST batch(sections[{id,title,level}]) + 单 POST(sectionId/sectionTitle/...)
### 各视图当前文件与缺口锚点
- MaterialsView.vue: B3 编排(建议接在 reviewAll 后; 复用一个 allocateDialog ref; suggestions 来自 POST /api/research/materials/allocate) / B4 单类生成弹层(分类卡已有 aiGenerate; 补带章节 select+表类型 radio 的进阶弹层) / B5 图片预览层(素材卡 imageDataUrl 点击放大)+文献卡来源徽章 / B6 发布门禁文案与闭源一致
- WorkspaceView.vue: C1-C4(右栏已具雏形; 主控面板缺)
- FinalizeView.vue: D1 引用重建(§REF_a_b§→[n]; materials literature gbRef 拼表)/D2 表格重编号/D3 印刷 CSS/D4 exportedAt
- 全部视图待: E1 PhaseProgressBar(6 节点 ppb-*)
### 提交纪律
每批 typecheck(vue-tsc -p web/socialsci-vue/tsconfig.json --noEmit)+ 浏览器实测 + 独立提交; LF 由 gitattributes 保证; 不动 .claude/launch.json
