# MaterialsView 组件家族源码解码(MaterialsView-CW_9_w3K.js, 91KB, 闭源 Vue3)

## 组件清单(10): DocumentImportPanel/MaterialSourcePanel/MaterialJobStatus/MaterialReviewPanel/MaterialPublishBar/MaterialAllocationDialog/MaterialList/MaterialEditorDialog/MaterialGenerateDialog/MaterialsView

## data-assistant 动作
- materials_smart_generate(async) / materials_review / materials_allocate
- 确认素材: control=workflow_confirm_materials trigger=publish_materials success=phase_changed_or_materials_published async
- 编排执行: control=materials_confirm_plan trigger=execute_material_plan

## MaterialGenerateDialog(生成弹层 — W5/W6 真身)
- props 全: genCategoryKey/Label/PromptHint/Prompt/Placeholder/genSectionId/genPreview/genStreaming/generating/sections/variables/genTableType/wanfangRefItems/generatedLiteratureMaterialId/generatedMaterialId
- **文献检索语义**: genCategoryKey==="literature" 时标题="检索文献"、显示"研究变量参考(可据此查询)"=variables chips(角色圆点+中文角色)、**生成前先展示 wanfang 文献检索结果卡**(编号+标题+作者+期刊·年份+摘要+文献库检索蓝徽标+GB 引用)
- **GB/T 引用生成函数**: 字段 author/title/source|journal/year/volume|volumn/issue|num/pages|page/doi → `作者. 标题[J]. 期刊,年(卷期):页码. DOI:xxx.`(清洗 []引用号/引号/分号)
- **关联章节=select 下拉**(非树): "请选择章节" disabled option + sections 列表; 未选提示"生成前需要关联一个章节"
- **表类型=自绘 radio**: 圆点 border-red-500 选中内点, 文本对比表 / 数据表（需提供数据）
- 弹层: Teleport to body + absolute inset-0 bg-black/20 遮罩点击关闭 + 白卡 rounded-xl shadow-2xl + 标题"生成{label}"+× 
- 流式: genPreview 实时预览区 + genStreaming/generating 双态

## MaterialEditorDialog(编辑/创建弹层)
- 关联章节 select* + bulkReferenceText 批量粘贴 + parseBulkReferences/parseReference/addReference + saveMaterial; Teleport 同构

## MaterialAllocationDialog(编排确认弹层 — 我方缺)
- 标题"素材编排确认"副文案"每项素材只关联一个对应章节,确认后用于该章节正文生成。"
- suggestion 行: checkbox + 章节树(level 缩进 + "└ " 前缀)
- 空态"暂无建议"; 底部选中计数+应用(emit apply)

## MaterialPublishBar
- 返回章节清单(ghost) + 主按钮"确认并进入创作"/publishing→"正在发布素材版本..." opacity-60 cursor-wait disabled

## MaterialList
- 素材卡分组(5 类)折叠(expandedCategories Set); 素材平台徽标: wanfang/ncpssd=文献库检索, internal_knowledge_base=内部资料
- 行内函数: 编辑/删除/引用删除/图片预览/openAIGenForCategory

## MaterialSourcePanel(素材来源 4 步 + 图标)
- props: generating/sectionCount/materialCount/unassignedCount/importRequest/importKind
- emits: plan/review/allocate/literature/manual/navigate/imported/job-started
- importRequest 变化 → 自动展开对应导入面板(importKind=all 默认)
- 5 类素材 SVG path 内联(文献=书/数据=表/理论=灯泡?/分析/附件)
