# MarxSphere × 闭源 UI 复杂度逐视图对拍(2026-09-07 T3 系列)

> 方法: 每个闭源复杂视图逐组件拆解 → 我方差距清单 → 原创实现 → build → 真实浏览器验证 → 提交。
> 浏览器驱动 scripts/browser-smoke.mjs(无头 Edge+CDP)。全部实现原创, 不搬闭源代码/文案/像素。

## 已 1:1 对齐实施清单

| # | 闭源视图/组件 | 我方对齐实现 | 提交 | 浏览器实证 |
|---|---|---|---|---|
| T3-1 | phase1→phase2 自动接力(录入门提交即分析) | Wizard onDone 自动 runAnalyze | 005449b | analysis 节点 25s 内自动落库 |
| T3-2 | WorkspaceView 章节创作三栏 | SectionWorkspaceView(左章树+进度条/中标题字数+技能卡指导+执行智能体+批量生成+MD编辑预览/右素材点击注入) | d61cce8 | 5章树+进度0/5+编辑器渲染 |
| T3-3 | ReviewView 原文对照双栏 | ReviewLabPanel"原文对照"子页签(左原文高亮+序号上标可点/右问题抽屉勾销+定位联动) | 43bee51 | 2处高亮上标+清单渲染 |
| T3-4 | PhaseProgressBar(主题chip+阶段圆点) | DagWorkbench 顶 PhaseProgressBar 五段导轨+点击跳转 | 3066b14 | 五阶段全渲染 |
| T3-5 | FinalizeView 合稿独立页 | FinalizeView(五段表单+直接/降AI模式+强度滑块+本地合成+merge任务+审查侧卡+merge-timeline+终稿激活) | 5f817b5 | 五段+审查卡渲染 |
| T3-6 | OutlineEditor 序号/字数分配 | PaperOutlinePanel 序号工具条(无/一、1.1/1. 1.1)+树行字数分配+徽标 | a82c8f1 | 中文序号实证 |
| T3-7 | FloatingAssistant data-assistant 动作埋点 | data-control 补全(审稿 start/upload/export-word, 编辑器 check/import/new) | d0fdaab | — |

## 待续(按感知度, 下一轮候选)
- T5 TipTap 富文本(当前 MD 双窗; TipTap 重, 价值 vs 回归成本需权衡)
- 闭源 16 模板库 vs 我方 5 模板(模板内容扩充)
- 审稿维度配置卡更多滑杆/自定义维度(当前默认6维+标准多选)
- FAB 教育域 EduFeedbackFAB 与全站 FAB 合流

## 验证基线
typecheck 0 错 / vitest 798 全过 / build 通过 / 浏览器冒烟 6 视图零崩溃(每次 build 后可跑 scripts/browser-smoke.mjs 复核)。
