# HistoryView 源码解码(HistoryView-CG_y34xs.js, 闭源 Vue3)

## 6 模块历史分区(每区=section-header+count+task-grid 卡)
C=[workflow:科研工作流 / review:审稿记录 / statistics:数据分析 / viz:科研绘图 / editor:编辑器文档 / knowledge:知识库查询]
- 卡结构: card-header(phase 徽标+card-title+card-meta)+card-time; 空区 section-empty
- 去重: review 卡按 sidebar_task_id、viz 卡按 source_task_id 与 globalTasks 交叉剔除重复

## 清除全部历史 z()
- confirm 弹层 {title:"清除历史记录", message:"确定清除全部历史记录？此操作不可撤销。"}
- deleteAll → failed 数组处理: reason=ACTIVE_JOB → "N 条仍在运行,请先取消或等待完成"; 其他失败原因合并提示; toast "已删除 X 条,N 条未能删除(...)"
- 成功: globalTasks/tasks/currentTaskId 清空 + 6 模块 localStorage lastTask_* removeItem + location.reload()

## data-assistant
- (页面动作待补, chunk 5.4KB 主要=列表+清除)
