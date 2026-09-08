# QuickModeView 源码解码(QuickModeView-DJU6Ms4b.js, 285KB, 闭源 Vue3)
组件: AgentFlowNode/AgentFlowCanvas/QuickModeView; data-assistant: experimental=可视化DAG编排模式(开发中预览)

## AgentFlowNode(DAG 节点)
- props: {id, data, selected}
- **节点结构**: [index 序号][module 徽标][node-menu "..."][title strong][progress 进度条 i width=progress%]
- **state class**: is-{data.state||"draft"} + is-selected/is-locked/is-system-start
- **xyflow 连接柄**: hasTarget!==false → Handle type=target, position=vertical?Top:Left(layout 垂直/水平)

## AgentFlowCanvas
- props: nodes/edges/expanded/fitRequest/locked/editable/overlayOpen; emits: node-selected/expand/pane-context-menu/node-context-menu/graph-changed
- xyflow(nodeTypes: {agent: AgentFlowNode}); **pane 右键菜单 + node 右键菜单**(context menu); fitView/screenToFlowCoordinate; 实例 id random
- 右键坐标转 flow 坐标(SCF) → emit context menu

## 实施进度(2026-09-09 会话 4 末)
- M6 基础版 17d3085(5 主节点自动管线 + 持久化 + 状态恢复)
- [x] 右键菜单(pane 空白→加模块 4 类/新建空白; node→详情/删除, 系统节点禁删)— 提交 223c0bf, 浏览器实测(加统计分析 5→6 节点、删除回 5)
- [x] 消息卡体系(提交 6b8f919: text/question 双态(目标/已识别/选项单选/缺失补齐)/plan 步骤卡/progress/node-update/artifact 产物卡; 浏览器实测 4 类渲染+选项交互)
- [x] 开始门覆盖层+锁定横幅(提交 f959dcb: canvas-start-gate "工作流已准备/开始自动执行"; 实测 gate→running 隐藏+锁定横幅)
- [x] 轮询推 node-update 完成卡+进度持久化(提交 c97bd55: 每阶段完成卡去重 + running 期 saveGraph; 实测信息录入完成卡)
- [x] 意图对话引擎(提交 6859c12: 主题/对象/方法/边界规则提取 + ≤2 轮追问(missingInputs 集中补齐) + plan 卡确认 + 特殊命令(新建/暂停/恢复/状态/帮助) + 意图主题启动; 实测提取→plan→开始执行全链)
- [x] artifact 产物卡(提交 09ce5c3: phrase5 完成回读 merged 字数 + 查看关联节点定位抽屉; 实测)
- 待续(小): standalone 模块真实 job 路由(statistics/viz/review 已各自独立模块, QuickMode 内仅展示) / localStorage 会话草稿 Zi 持久化(intakeRound)
