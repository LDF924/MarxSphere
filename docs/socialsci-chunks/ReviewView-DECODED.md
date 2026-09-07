# ReviewView 组件家族源码解码(ReviewView-B4QyxKEn.js, 674KB, 闭源 Vue3)

## 组件(9): ReviewSettings/ReviewInput/ReviewProgress/ReviewResult/ReviewDocxViewer/ReviewPdfViewer/ReviewDetail/ReviewHistoryRail/ReviewView
动作: control=review_new_review

## ReviewSettings
- 严格度 3 档常量: s=[{lax:宽松/仅重大问题},{standard:标准/核心问题},{strict:严格/逐项检查}]  ← value=lax 非我方 loose
- 标准多选: settings.standardIds toggle(store 层)

## ReviewResult(报告核心 UI — 与 P-B 多处差异!)
- **总分配色**: ≥85 #22c55e 绿 / ≥70 #f59e0b 琥珀 / ≥55 #f97316 橙 / else #ef4444 红
- **等级映射**: A+=优秀 / A=优秀 / B+=良好 / B=良好 / C+=及格 / C=及格 / **D=待改进** / fallback=一般  ← D 非"不及格"!
- **总分徽标底色**: ≥85 bg-green-100 text-green-700 / ≥70 amber / ≥55 orange / else red
- 总评 >120 字 → 折叠 + "展开完整评语/收起评语" 红链(120 字阈值!)
- 信息行: "字数: NNN · X 个维度审查"
- **维度卡**: 行1=[名称, "权重 N"] + [score+" 分"(≥80 text-green-600/≥60 amber/red), status 徽标(**pass=通过/warning=待改进/fail=不通过** → bg-green-50 text-green-600 等)] → **进度条 h-full rounded-full transition-all duration-700**(score≥80 bg-green-500/≥60 bg-amber-500/else bg-red-500, width=score%) → summary
- **核心问题区**: h3"核心问题"+(共发现 {issueStats.total} 个)+ 红链"进入原文对照"(emit showDetail); 问题行按 severity 分组徽标
- 重新审稿按钮 emit reReview

## ReviewInput / ReviewProgress
- (含 docx/pdf 双查看器 ReviewDocxViewer/ReviewPdfViewer — pdf.js 渲染)
