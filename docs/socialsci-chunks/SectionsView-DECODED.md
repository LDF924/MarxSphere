# SectionsView 组件源码解码(SectionsView-C4lM9Tih.js, 闭源 Vue3)

## data-assistant phase2 状态属性(页面根)
data-assistant-phase2-sections-count / level-one-count / generated-skill-count / generated-metadata-count / metadata-complete / skill-step / error / complete

## 动作埋点
- 重新生成: control=workflow_phase2_regenerate trigger=regenerate_phase2_structure success=phase2_complete async=true
- 确认架构: control=workflow_phase2_confirm trigger=confirm_phase2_structure success=route_change:/workflow/materials

## setup 核心逻辑
| 项 | 解码 |
|---|---|
| 完成计数 | C=有 aiSkill 的一级章数; D=aiSkill 含 writingGoal/keyPoints/childSections 的章数; H=全部 D≥k.length → 完成 |
| 3 步定义 | Q=[{1: 变量识别(定性=因素识别)},{2: 框架分析},{3: Skill 生成}] |
| **定性方法变量角色** | 定量: 自变量蓝/因变量红/中介琥珀/调节紫/控制灰; **定性: 影响因素蓝/结果表现红/中间机制琥珀/情境条件紫/背景因素灰** |
| 框架分析解析 | stepAnalysisTexts[2] → ```json conceptModel.hypotheses```(id+statement+logic) 或正则 H1./假设N 提取; 兜底 变量推断 "X 对 Y 有显著影响" |
| typewriter | skillStreamText 每 20ms 追加 chunk(8~40 字自适应)逐字流式; skillThinking 结束直接全量 |
| SSE 注入窗 | window.__rfSSEVariables(variables)/__rfSSESkills(skills) — 悬浮助手/外部驱动 |
| 恢复 | mount: currentTaskId 存在 → loadNode("sections") + resumeActiveWorkflowJob()(断线恢复 job!) |

## 文案常量
变量识别/因素识别(定性)/框架分析/Skill 生成/取消/重新生成/确认科研架构/返回修改
