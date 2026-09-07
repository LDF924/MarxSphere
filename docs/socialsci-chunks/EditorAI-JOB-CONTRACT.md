# 闭源 Editor AI job 契约(EditorView-CaKgg_bg.js 解码)

## 端点
- POST /api/editor/v1/ai/jobs body={action,text,context,language:"中文",document_id} → {job_id}
- GET  /api/editor/v1/ai/jobs/{id}/stream → SSE
- POST /api/editor/v1/ai/jobs/{id}/cancel
- POST /api/editor/v1/ai/jobs/{id}/retry
- 另: POST /ai/chart(图表独立), /ai/jobs 相关 Te 服务

## SSE 事件(行解析: event:/data: 每事件两行)
- event: delta → data: {content}  ← 流式累积 onDelta
- event: model → data: {model}
- event: done  → data: {content,...} ← onDone 取 content 全量
- event: error → data: {message, is_retriable} ← onError
- 流错误: !res.ok → onError("后台作业连接失败", true)

## 前端 store(editor-ai)
- activeJobId=localStorage "editor.activeJobId"; 挂载存在 → resumeJob 恢复流; retryJob 重试; cancelJob 取消
- streamAssist(k): {action,text,context,language:"中文",document_id} → onJob(jobId) → stream 轮询
- AbortController signal 贯穿(停止=abort+记录已收内容)

## 我方现状
- 独立同步端点 rewrite/check-fulltext/title-abstract/format-references/chart-code; 无 job 化/无断线恢复/无 cancel-retry
