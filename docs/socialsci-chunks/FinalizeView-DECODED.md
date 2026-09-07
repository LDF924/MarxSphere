# FinalizeView 组件源码解码(FinalizeView-Br8-MIOb.js, 闭源 Vue3)

## data-assistant 动作链(全)
- 直接合稿: control=workflow_merge_direct trigger=select_direct_merge success=merge_mode_direct
- 降AIGC: control=workflow_merge_aigc trigger=select_aigc_merge success=merge_mode_aigc
- 强度档: trigger=select_aigc_tier success=aigc_tier_selected
- 合稿: control=workflow_phase5_merge trigger=merge_full_paper success=merge_complete async
- 审稿: control=workflow_phase5_review trigger=review_full_paper success=review_complete
- 修订: control=workflow_phase5_revision(触发/成功值截断)

## 核心逻辑
- **模式/强度 state**: R=("normal"|"deAIGC") 即直接/降AI; $=("light"|"medium"|"heavy") 轻度/中度/重度降重; me=[{light:轻度降重},{medium:中度降重},{heavy:重度降重}]
- **5 步流程条**: E=[合并正文/语言润色/整理参考文献/生成元信息/完成(论文合并完成)] — 静态条+step 状态对象 A={show,current,total,status}
- **进入页**: loadNode("finalize")+loadMaterials(taskId)+pe()we() 恢复现场; mergedFullText/title 变更 → saveProject+saveCurrentNode(500ms 防抖 saveProject)
- **合稿校验链 ge()**: ①无 task→"请先创建并保存工作流任务" ②无内容章节→"没有已生成内容的章节可供合稿" ③有未完成一级→"还有 X 个一级章节未完成，不能合稿" ④取 phase4VersionId(state.phase4Stale→报"请先完成当前 Phase 4 正文生成，再进行合稿") → 重置全部产物字段 → createPhase5Merge({taskId,phase4VersionId,enableDeAIFyMerge:mode==="deAIGC"}) → 轮询 job
- **合稿成功回调 Z()**: 解析结果 → be(stream 写入) → fe(mergedFullText+mergedReferences+sections+materials 重建正文/参考文献) → xe 清洗 → 各字段落 store → saveProject+saveCurrentNode
- **审查**: reviewGenerating/reviewStreamContent + createPhase5Review → 审查完成 toast; 断线"审查任务恢复失败"提示(恢复语义)
- **修订**: 修订中/修订稿已采用(覆盖 mergedFullText)/采用失败提示 — 与 P-A 已实施的 revise 语义同构
- 导出: exportStatus/exportedFormat/exportedFileName/exportedAt + 导出失败兜底
