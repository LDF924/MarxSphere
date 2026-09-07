# EditorView 源码解码(EditorView-CaKgg_bg.js, 697KB, 闭源 Vue3)
组件: TopBar/SideBar/AIPanel/VersionHistory; 渲染含 katex(数学)+marked+purify

## AIPanel
- props: {editor}
- **5 tab**: check(全文检查 4 模式+检查结果)/local(本地工具)/title(题名摘要)/citation(引用格式)/format(格式模板)
- tab 初始 c="check"; "检查结果" h 常量
- **统一 AI 端点**: /api/editor/v1/ai/jobs(检查/改写/生成全走 job)
- **Markdown+LaTeX 渲染**: streamingContent 处理 $$/\[ \]/\( \) 数学块 → 双渲染(检查结果/改写预览)
- 图表默认类型 m="mermaid_flowchart"(mermaid 流程图!)
- isLoading → streamingContent||"正在整理建议..." 流式占位
- **格式预设**: formatPresets/formatPresetKey/activeFormatPreset(composable, 期刊模板)

## 全文检查 4 模式(确认)
全文逻辑检查/章节衔接检查/变量-方法-结论一致性/投稿前检查(与 DOM 一致, P-C 已对齐)

## TopBar/SideBar
- 自动保存防抖 + **heartbeat**(文档锁续期); 文档 CRUD; 版本历史 VersionHistory
