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
