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
- 待续: 消息卡 7 kinds(text/question 双选项卡/plan 勾选/progress/artifact/node-update)/ 意图对话(特殊命令+追问+主题判定)/ canvas-start-gate 空态遮罩 / standalone 模块真实 job 路由(statistics/viz/review)
