# StatisticsView 源码解码(StatisticsView-C1S4N5xA.js, 68KB, 闭源 Vue3)
子组件: StatisticsJobControls/StatisticsFileUploader; 主视图内联(组件名 Statistics)

## 方法目录(17 方法 = 4 组数组拼接)
- A 数据基础: descriptive描述统计/frequency频数分析/classify分类汇总/transform数据转换/filter数据筛选
- H 推断统计: t-test/anova/multivariate-anova/correlation/crosstab/nonparametric/normality
- we 回归建模: regression(OLS)/logistic-regression
- Le 信效度&高级: reliability(信度α)/efa(EFA因子分析)/mediation-moderation(中介/调节)
- state: tool="descriptive" 默认; selectedVars=Set; toolParams={}; result={tables,charts,warnings,metadata}; resultVersionId
- desc 全表(17 条见 StatisticsView-desc.txt 原始)
- **有配置变量的方法**: Be=!["crosstab","regression","logistic-regression","multivariate-anova","mediation-moderation","filter"].includes(tool) → 这些方法不走变量选择
- **id 列自动排除**: $e() 正则 /^(id|uuid|identifier|case[_-]?id|subject[_-]?id)$/i → ANOVA 变量候选过滤; 变量搜索 varSearchQuery 名字 contains
- **新建分析确认**: "开始新分析？当前分析数据将清空。"(confirm 弹层, title 新建分析) → 挂 task(createTaskWithTitle "未命名数据分析","statistics")+清 localStorage+重置
- 状态: backend connected/error/unknown → "后端已连接/后端未启动/检测中..."
- 结果渲染: 三线表 three-line-table(顶/底线)/chart-title/导出条 item-export-bar/loading-overlay bg-white/85

## 请求契约(rt()): {tool, fileId, fileName, variables, selectedVars, toolParams, varSearchQuery, resultVersionId}
