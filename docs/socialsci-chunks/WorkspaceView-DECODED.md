# WorkspaceView 组件源码解码(WorkspaceView-Baf0x_1H.js, 闭源 Vue3)
组件: SectionNavItem/SectionGenerator/MaterialCard/WorkspaceView; MarkdownEditor 独立 chunk(2.7KB 包装)

## data-assistant
- workflow_phase4_generate_all(批量) / workflow_phase4_enter_finalize(进合稿)

## SectionGenerator(单章生成卡)
- props: section/generating/disabled/disabledReason/streamContent
- 状态徽标: generating=bg-amber-100 text-amber-700 "生成中..."; generated=bg-green-100 text-green-700 "已生成"; 其他=bg-gray-100 "待生成"
- 主按钮: flex-1 px-4 py-2 bg-slate-800 text-white "执行智能体开始思考" / generating→spinner+"正在思考..." / disabled 显示 disabledReason
- 生成中: 旁"取消"红 ghost; generated: "重新思考" border 灰

## WorkspaceView 主体
- 左章树 SectionNavItem(标题+状态点+进度); 中=SectionGenerator+MarkdownEditor(streamContent 流式正文/本地 content)+skill_prompt 可编辑区(过滤 建议字数/Phase 1 budget/Child word allocation 行); 右 MaterialCard 素材筛选(re=按 activeSection+children 过滤 materials, materialFilter all/type)
- 进度: generated 一级数/总数 → 百分比 round; 未完成数 X 用于门禁
- **busy 聚合文案**: batchGenerating=正在批量生成章节/sectionGenerating=正在生成章节内容/materialGenerating=正在生成素材/skillThinking|mainAIThinking=正在进行结构化分析; busy 时操作→warning "…请等待完成后再操作"
- **进合稿门禁(je)**: 无一级 → "请先确认章节清单，再进入合并定稿"; 有未完成 → "还有 X 个一级章节未完成，全部完成后再进入合并定稿" → enterMergePhase()
- 返回素材: Pe() 带 busy 门禁 → /workflow/materials
- 结构化分析按钮: ue()=generateSkillsForSections
- 自动保存: skill_prompt/content 变更 → saveProject 500ms 防抖
- 字数/子节完成计数/结构化摘要(正则同 ce08dc1)
