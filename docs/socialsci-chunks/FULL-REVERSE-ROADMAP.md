# FULL-REVERSE-ROADMAP.md — 全量解码实施路线图(2026-09-08)

> 来源: docs/socialsci-chunks/full/decoded-*.md(7 份)。原则: **不分高价值, 全要**。
> 每项: 编号/来源/内容/我方现状/做法。批次推进, 每批 typecheck+vitest+提交。

## 批次 A — 学术编辑器(decoded-editor-review.md §4)
- A1. content_hash 乐观锁: 保存前计算 canonical 排序键 JSON, 变更才 PUT(我方 EditorView 有无?)
- A2. 1200ms 防抖自动保存 + 锁心跳 60s(我方心跳 30s 已有, 核对间隔/冲突事件)
- A3. editor.activeDocumentId localStorage 恢复最后打开文档(我方 curId 无持久化)
- A4. 排版预设 CSS 变量驱动(A4 210mm 视口, 我方 DOC_STYLES 已有, 核对 210mm 纸面)
- A5. AI 结果落文: window CustomEvent ai-apply/ai-insert-chart + 选区原文回读校验(我方 AiEditorPanel 直接插入?)
- A6. AI 面板宽度持久化 ade-ai-panel-width + 拖拽 clamp 340-720(我方面板固定宽?)
- A7. 版本历史: 时间线+回档(我方已有, 核对闭源字段)

## 批次 B — 科研审查(decoded-editor-review.md §2-3)
- B1. LLM 输出五级容错 JSON 解析(直解→剥围栏→括号平衡→字符串修复→rawOutput), 我方后端 parseLlmJson 核对
- B2. 审稿库投稿须知→规则 = 纯前端正则 6 类归槽(字数区间/引用格式/风格/结构/禁用项), 我方后端 AI 解析 → 补前端正则
- B3. 维度保存自动补全模板 {weight:3, thresholds:{90/75/60}, aiInstruction, criteria}
- B4. 批注↔原文定位三态(txt 空白归一/pdf 字符矩阵/docx TreeWalker) — 我方 ReviewLabPanel 原文对照?
- B5. 严格度三档 radio 形态(我方 range slider → radio 组对齐)
- B6. SSE 四事件(review.completed/failed/cancelled/status)+ 断点恢复(我方已 SSE, 核对事件名)

## 批次 C — 数据分析(decoded-stats-viz.md §1)
- C1. 17 方法参数模板低代码结构(字符串模板 + props params/variables + emit update:params deep watch)
- C2. 运行前校验链(逐条 warning: 未上传/未选变量/缺参数), 我方后端校验核对
- C3. Python 异常→中文翻译表(类型不匹配/维度/变量名/缺失值…)
- C4. 三线表 docx 导出(表头上下粗边框/9000DXA 列宽/SimSun 表头)
- C5. 图表 PNG 三级降级导出(plotly.toImage→离屏→html2canvas)
- C6. 结果 plotly 渲染(chart-<i> 容器+responsive)
- C7. 素材导入链(表格→importArtifact snapshot 结构)
- C8. 数值格式(≥1000 或 <0.001 → toExponential(3)/<0.01→4位小数)

## 批次 D — 科研绘图(decoded-stats-viz.md §2)
- D1. SSE 13 事件协议(plan/delta/thinking/tool_status/tool/chart/svg/code/critique/critique_fix/error/done/viz.completed)
- D2. PNG 三态(路径/dataURL/裸 base64)统一 blob 化 — 我方 R9 已 blob, 核对三态
- D3. journalConfig 透传(Nature 默认 89×62.3mm/600dpi/7pt/Arial)+maxToolRounds≤5
- D4. 30s 心跳 /api/viz2/status + chartVersionId 4 层恢复兜底
- D5. markdown 手写正则渲染(评估我方是否需自绘以对齐行为)
- D6. localStorage viz_save/viz_active_job 双写

## 批次 E — 可视化 DAG(decoded-workflow-quick.md §3-4)
- E1. Phase1-5 自动执行主管线(任务创建→publishPhase1→save→plan→run→800ms 轮询对账), 我方 DagWorkbenchPanel 逐节点 → 补自动管线
- E2. 画布三色边体系(manual-edge-/agent-edge- 自动补边)+Kahn 拓扑分层+环路防护
- E3. 消息卡 8 类型(text/question/plan/progress/artifact/node-update…) + 过滤开关
- E4. 意图对话 2 轮集中补齐 UX
- E5. DAG jobs 端点(pause/resume/cancel/retry fromStep)+800ms getJob 对账
- E6. 画布 node data 契约(phase4VersionId 等节点状态字段)

## 批次 F — 素材/创作/合稿(decoded-workflow-materials/workspace-finalize)
- F1. 素材对象全字段(含 source.sourceStatus.ncpssd/wanfang、references gbRef、metadata)
- F2. 文献引用 content 内嵌格式 `1.【题目】…`(我方格式核对)
- F3. data-assistant 探针属性 16 项 + control 16 项(自动化测试可操作性)
- F4. 章卡字数徽标"N 字(Phase 1 分配)"由 phase2 AI 生成 wordCount(我方 SectionWorkspace 核对)
- F5. 批量生成深快照回滚
- F6. 合稿 activate 版本切换修订链(phase5VersionId activate)

## 批次 G — 样式体系(全部文档)
- G1. 品牌红按钮 bg-red-600 全站统一(我方主按钮混用 cyan/rose → 对齐主色)
- G2. 主色深藏青 #1e4d8c 辅助
- G3. 弹层体系 z-[50]/[70]/[80] 分层核对
- G4. 空态文案/徽标体系核对

## 实施状态(2026-09-08 全批次完成)
✅ A1-A6 全部(乐观锁/1200ms/恢复/纸面/事件总线/面板拖拽)
✅ B1-B5 全部(五级容错/正则归槽/radio/空白归一) B3/B6 核对我方已有
✅ C1/C3/C4/C5/C8 实施; C6 记录不实施(我方 SVG 产物架构, plotly 重复) C2 后端已有
✅ D1-D6 全部(viz job 体系: 迁移132+服务 243 行+5 端点+前端 job 化+断线恢复)
✅ E2-E4 全部(三色边/消息卡/2轮追问) E1 后端调度泵已有 E5 四态控制已有 E6 节点 meta 已有
✅ F3 探针实施; F1/F2/F4/F5/F6 核对我方已有(素材表带 source_docs 追溯)
✅ G3 核对我方分层已有; G1/G2 颜色按用户指示跳过
验证: vitest 804/804(基线 799+新增 5), typecheck 双端 0, 全提交 main
