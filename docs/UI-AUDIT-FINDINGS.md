# MarxSphere vs SocialSci UI 组件/交互差距审计(T1-T18)

> 2026-09-06 · 审计方法: 逆向 A侧(Vue编译产物 6模块+28chunk) vs B侧(React components 9核心)
> 审计范围: 布局骨架(另见布局agent报告) + 组件资产 + 状态驱动文案 + 交互逻辑

## 对照清单(按差距大小)

| # | A侧(闭源)交互 | B侧现状 | 差距 |
|---|---|---|---|
| T1 | 悬浮助手全链路页面感知(data-assistant-control 40个埋点+async状态+代点击) | FloatingAssistantFAB仅静态规则表推荐 | 核心缺口 |
| T2 | busy分级文案链(6级人话: batch/section/material/skillThinking/AIThinking→"正在批量生成章节"等) | 全是裸busy+spinner | 大 |
| T3 | 章节导航X/Y+红色进度条+缺N章门禁文案 | 无整体进度无门禁 | 中-大 |
| T4 | 智能体分步结构化卡(识别变量→构建框架→生成指导3步) | 无(节点仅变色) | 大 |
| T5 | TipTap富文本+Word批注层+Mermaid插入 | 裸textarea | 大 |
| T6 | 审稿流式即时维度卡(总分实时跳动) | 完成才setResult | 中 |
| T7 | 素材卡来源/GBRef引用/批量粘贴解析核对/AI审视 | 有卡无解析无审视 | 大 |
| T8 | 批量回滚体系(全部/本次+原因文案) | 有API无UI | 中 |
| T9 | Editor 6功能页(检查/改写/题名摘要/引用格式/模板/图表)+逐条采纳 | 仅检查+润色 | 中 |
| T10 | 首页模块卡带统计 | HomePanel有 | 弱 |
| T11 | 目录模板库(16模板一键插入)+字数分配 | PaperOutline有树无模板库 | 弱-中 |
| T12 | SSE断流恢复态明示 | 仅连接失败重试 | 弱 |
| T13 | Word导入即看原版式 | 仅元数据 | 中 |
| T14 | 侧栏计数徽章/脉动点 | 无层级徽章 | 弱 |
| T15 | 历史中心点击恢复+清除阻断 | 已对齐(ResearchHistoryPanel) | 弱-已对齐 |
| T16 | 输入引导表单(目录录入/方法选择/模板) | 仅prompt建项目 | 中 |
| T17 | 站内统一confirm弹层 | window.confirm | 弱 |
| T18 | 管理控制台全功能 | AdminPanel已有 | 需深审 |

## B侧领先(反向)
DagWorkbench画布乐观锁/节点回滚、VizAgent会话版本时间线、MaterialsDrawer六类素材、AskPanel持久化步骤栈、FloatingAssistantFAB(教育域EduFeedbackFAB先例)

## 状态驱动文案链(A侧核心, 供实现参考)
- workspace busy: batchGenerating→"正在批量生成章节" | sectionGenerating→"正在生成章节内容" | materialGenerating→"正在生成素材" | skillThinking/mainAIThinking→"正在进行结构化分析" | else→"当前操作处理中"
- 章节按钮4态: generating→"正在思考..." | disabled→disabledReason | 默认→"执行智能体开始思考"
- 批量按钮3态: "生成中(cur/total)" | "重生成全部" | "智能全局思考"
- 门禁: "还有N个一级章节未完成,全部完成后再进入合并定稿" | "请先确认章节清单" | "尚未发布正式输入版本"
- 审稿: "已有审稿任务正在运行" | "审稿已完成但报告格式异常"
- 素材: "当前有素材任务正在执行" | "生成素材执行计划" | "正在编排素材..." | "请先完成章节结构"

## 落地优先级(建议)
T1→T2+T3→T4→T5→T7→T6→T8→其余按量

## 布局骨架审计(13视图, agent报告摘要)

主流程页共用窄幅居中骨架 `workflow-page max-w-5xl/4xl mx-auto px-6 py-8`:
- 信息录入: 顶部大纲树编辑器 + 6字段组卡(主题/字数/框架/方法grid-3/文件拖拽/澄清QA) + 底部CTA
- 素材准备: 工具条(智能生成/审视/编排3主按钮) + 手动添加/模块导入卡 + 素材清单(checkbox+目标章节select) + 2弹窗(计划确认)
- 科研架构: 状态卡(三态徽标+typewriter+Step x/3) + 框架概览(变量卡grid/假设ul/方法pills) + 章节写作指导卡列表 + 底部确认CTA
- 章节创作: **三栏**(左章节导航树+进度条 / 中标题+正文字数+结构化分析区(变量/框架/指导)+正文textarea / 右素材库)
- 合并定稿: 单列设置长表单(标题/摘要/关键词/正文/参考文献) + merge-timeline弹窗
- 审稿: 配置段(slider严格度/刊物select/标准chips/额外要求) + 上传段(拖拽Word/PDF/TXT) + 评分卡结果
- 绘图: 聊天式(goal-rule面板 + thinking折叠 + 对话流 + 图输出卡 + composer + CSV拖拽)
- 知识库: 双栏(对话流 / 证据侧栏+citation-popover) 
- 编辑器: 三栏(顶bar+左文档rail+右AI面板可resize, 6功能页)
- QuickMode DAG: 左vue-flow画布 + 右agent-panel(会话卡片流+composer)
- 统计: 双栏(左方法树/变量选择 + 右结果报表/图表/Word/PDF导出)
- 悬浮助手: fixed z-50 全站常驻+宠物形象+billing-notice
- 全局壳: site-header(logo/导航/用户下拉/hamburger)

**对照结论**: 我们的DagWorkbench已覆盖 QuickMode左画布+右面板, 但主流程(录入→架构→创作)是分离面板非三栏连续工作流; 编辑器三栏(文档rail+AI右面板)我们无AI侧栏多功能页。

## 落地进度
- T2 running任务分级文案: 已落地(7c71777)
- T3 章节进度条+门禁: 已落地(cd03189)
- T4 执行步骤stage/current/total: 已落地(3a880a8)
- T6 审稿流式实时评分卡: 已落地(21303b0)
- 待: T5富文本/T7素材卡解析/T8回滚UI/T11模板库等
