# 闭源科研工作流(Workflow)前端解码 — 索引总览

> 目录: `.claude/socialsci-probe/full/`。覆盖闭源 Vue3 科研写作系统全部 6 个分步工作流视图 + QuickModeView 新入口 + 共享 API 层。
> 解码文件均为 prettier 格式化后 chunk, 行号以 `formatted/` 下文件为准。

## 文档清单

| 文件 | 覆盖 chunk | 内容 |
|---|---|---|
| `decoded-workflow-quick.md` | QuickModeView-DJU6Ms4b.js(18020 行) | 可视化 DAG 编排(AgentFlowNode/AgentFlowCanvas/QuickModeView 三组件)、vue-flow 布局引擎、Phase1-5 自动管线、意图路由对话、**共享 API 契约全表**(Q0/Vt/ga/Fs/G0/sn SSE 等)、路由表、行号勘误表 |
| `decoded-workflow-materials.md` | MaterialsView-CW_9_w3K.js(5820 行) | 素材准备 Phase3: 10 组件树、智能生成计划(执行计划确认层)、文献检索/表格/理论生成、统计直连 fetch、审视/编排/上传/发布版本 |
| `decoded-workflow-workspace-finalize.md` | WorkspaceView-Baf0x_1H.js(2706 行) + FinalizeView-Br8-MIOb.js(1748 行) | Phase4 章节生成(单节/批量/回滚快照/SSE) + Phase5 合稿(merge→review→revise 三轮、引用编号重建、导出 docx/pdf/md/html、时间轴) |
| `decoded-workflow-sections-input.md` | SectionsView-C4lM9Tih.js + InputView-DwlhRWpv.js | Phase2 科研架构(变量识别/假设/字数分配) + Phase1 信息录入(目录编辑器/模板) — **见下方占位, 同批产出** |
| `decoded-editor-review.md`(既有) | EditorView-CaKgg_bg.js + ReviewView-B4QyxKEn.js + LibraryHome | 学术编辑器(TipTap)与论文审稿模块 |
| `decoded-stats-viz.md`(既有) | StatisticsView + VizView + ChartRenderer | 数据分析与科研绘图模块 |
| `css-decode/css-styles-decoded.md`(既有) | 全部视图 CSS | QuickModeView(含 agent-flow-node/vue-flow 语义类)/Materials/Workspace/Finalize/Editor/Review 等 |

## 双产品线路由(共享模块 L17495-17645)

```
/workflow(WorkflowHome) ─ 传统分步入口
  /workflow/input      → InputView      Phase1 信息录入/大纲
  /workflow/sections   → SectionsView   Phase2 章节结构(变量/假设/字数)
  /workflow/materials  → MaterialsView  Phase3 素材准备
  /workflow/workspace  → WorkspaceView  Phase4 章节正文创作
  /workflow/finalize   → FinalizeView   Phase5 合稿定稿导出
/workbench/quick       → QuickModeView  可视化 DAG 一键自动执行(meta: quickAgent)
/statistics /viz /review /editor /knowledge /history /admin ...
```

## 关键共享机制(跨全部视图, 详见 decoded-workflow-quick.md §4)

1. **请求层**: 共享 `q()` → base `/api`, Bearer `skf_auth_token`(localStorage), 401 全局过期广播; 错误 `{error,code,status}`
2. **SSE 协议**: job 创建 → GET `/api/workflow/jobs/{id}/stream`; 业务事件 `phase4.section_delta/section_completed`、`phase5.merge_delta/merge_status/merge_completed`、`phase5.review_delta/review_completed`、`literature.group_completed/group_recovered`、通用 `job.snapshot{status,currentStep,result}`; ai 域 sn() 另支持 reasoning/status/variables/skills/ref_item/assignments/done
3. **阶段版本链**: publishPhase1(versions/phase1) → phase2(章节) → publishPhase3(versions/phase3 + materialUsages) → phase4VersionId(sections) → phase5VersionId(activate 切换修订) → isFinalized; 每阶段 getCurrent 校验前序版本 stale
4. **任务持久化**: task store + project store(saveProject 防抖 500ms + saveCurrentNode 双通道); localStorage `lastTask_workflow`(DAG 恢复)/`dag_intake_context`(Quick 会话草稿)
5. **data-assistant-* 探针**: 每页根容器与关键控件带 data-assistant-control/state 属性(trigger/success/async 标注), 供外部 Agent 驾驶

## 复刻顺序建议
1. 先读 `decoded-workflow-quick.md` §0/§4(模块边界+API 全契约, 是所有视图的底座)
2. 按 Phase1→5 顺序读 sections-input → materials → workspace-finalize
3. DAG 自动执行模式以 quick.md §3.3 启动管线为准(创建任务→publishPhase1→save→plan→run→800ms 轮询)
