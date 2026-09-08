# SocialSci Vue 还原 — 后端契约差距与前端适配决定(2026-09-08 侦察结论冻结)

> 来源: 后端侦察(server.ts 逐行映射) + 前端 React api.ts(sag_token) + requireUser JWT 机制。
> 原则: 前端"1:1 还原闭源契约形态"→ 适配层(shared/services.ts)落我方端点; 语义等价即映射,
> 不等价/缺失才补端点(补点清单 = 本节标注"补")。每模块落地时按此表逐条对账。

## 0. 鉴权(前端直打后端的前提)
- 我方 requireUser = `Authorization: Bearer <JWT>`(authService.verifyToken), 登录后前端存 `localStorage.sag_token`。
- 闭源前端 header = `Bearer skf_auth_token`(localStorage 键 skf_auth_token)。
- **前端适配层决定**: readToken() = `skf_auth_token` || 回退 `sag_token`。父 React 登录态(sag_token)天然可用;
  闭源键(skf_auth_token)兼容旧快照/自动化注入。无 token → 401 → 广播 auth-expired, 由宿主提示登录。
- 本机豁免(127.0.0.1)→ dev 直连无鉴权; 生产外网需 Web 登录 JWT。
- SocialSci 路由响应错误格式 `{error: string | {code,userMessage,message}}`。

## 1. 已等价/已对齐(直接映射, 不补端点)
| 闭源契约(前端要打) | 我方端点 | 备注 |
|---|---|---|
| POST /api/clarify/generate | /api/clarify/generate(L10537) | ✅ 同形 |
| GET /api/research/versions/task/{tid}/current → state{inputVersion,phase2Version,phase3Version,phase2Stale,...} | GET /api/research/versions/current(L10545, projectId query) | ⚠️ 形近(projectId 系); M5 适配层把 taskId→projectId |
| POST /api/review/jobs + GET /api/review/jobs?limit + GET /:id + SSE /:id/stream + control(cancel/retry) | 同前缀(L9549-9597) | ✅ SSE 事件 review.started/status/delta/completed 更细; 缺 failed/cancelled 事件→由轮询终态兜底 |
| GET /api/review/journals(+CRUD) POST /parse /standards(+CRUD+default+parse) | 同前缀(L9617-9696) | ✅ 前端正则 6 类归槽在前端做(parse 只是回显+AI 辅助) |
| POST /api/review/export-report(html 打印) | POST /api/review/jobs/:id/export-html(L9608) | 前端打后者, response html |
| 审稿 Word 导出(闭源前端 docx 拼装) | POST /api/review/jobs/:id/export-word(L9599, python 通道) | 采用后端出口(省前端 docx 批注复杂度); 若需前端版再补 |
| POST /api/files/extract-text(multipart FormData) | 同前缀(L10380, **base64 JSON** {filename,base64,mime}) | 前端适配层自动读 file→base64→发 JSON; pdf 后端暂无解析→前端 pdfjs 提取后走 text 分支? — 详见 M2 决策 |
| POST /api/files/upload(multipart) + GET /api/files/:id/profile + GET /:id/content | 同前缀(L10408-10470, base64 JSON) | ✅ fileId=`file_<uuid>`; 前端统一 blob→base64 上传 helper |
| POST /api/viz-jobs + GET list + GET /:id + cancel + retry + versions | /api/viz/jobs(L9725-9763) 前缀 viz/jobs | 适配层路径改写 viz-jobs→viz/jobs |
| GET /api/viz-jobs/:id/stream(SSE after=N 重放) | GET /api/viz/jobs/:id/stream(L9748, viz_job_events after=N) | ✅ 事件表驱动重放, 前端 event: 13 类 |
| POST /api/editor/v1/documents CRUD + lock/unlock + versions/restore | /api/editor/v1/documents(L9822-9926) | ✅ content_hash 乐观锁 409 已有 |
| POST /api/editor/v1/ai/jobs + /:id/stream(delta/model/done/error) + cancel + retry | 同(L9929-9954) | ✅ 断点续传 retry 已有 |
| GET /api/viz2/status(30s 心跳) | ❌ 无 | 前端降级: 打 /health 判定在线(后端 /health whitelist) |
| 任务历史卡: GET /api/research/history | 同(L9050) | ✅ 6 真源聚合 |

## 2. 形异义近(适配层改写, 不补端点)
| 闭源 | 我方 | 适配 |
|---|---|---|
| GET /api/tasks?module=X / GET /api/tasks/:id / POST /api/tasks | /api/research/tasks(L9025-9048, projectId query + module 列) | 适配层: 无项目时自动 createProject 当任务容器; module 表列过滤; "taskId"="projectId"(workflow 域)或 research_tasks.id |
| PUT /api/tasks/:id saveSnapshot{phase,status,phaseLabel,snapshot} | PUT /api/research/projects/:pid/workbench(L10525) | 适配层 saveTaskSnapshot→workbench 23 键池 |
| GET/PUT /api/tasks/:id/nodes/:key {nodeData} | GET/PUT /api/research/projects/:pid/nodes/:key(L9313-9331) | nodeKey 直映射(input/sections/materials/workspace/finalize/viz_chat/viz_data 均现成) |
| POST /api/tasks/:id/switch | research_projects.current_task_id 语义 | 适配层 project 级切换(L10461 /tasks/default 兜底) |
| POST /api/workflow/versions/phase1 {taskId,title,outline,...10 字段} | POST /api/research/projects(建项目/标题)+ PUT nodes/input + publish /api/research/projects/:pid/publish(L9369) | M5 适配: publishPhase1 = 写 input 节点 + publish → research_versions snapshot |
| GET /api/workflow/versions/task/:tid/current | GET /api/research/versions/current(L10545) | state 字段→阶段版本(phase2/3 stale 逻辑对齐) |
| POST /api/workflow/jobs/phase2 / phase4/sections / phase4/batch / phase5/{merge,review,revise} | POST /api/research/tasks jobKind={phase2?不适用,phase4_batch,merge,review,revise}(L9195-9278) | **语义=创建 research_task + 调度泵(researchExec 2s)执行**; 无逐字节 SSE → 前端轮询 research_tasks.progress/result + 快照节点回读 |
| GET /api/workflow/jobs/phase4/version/{vid}/sections?sectionIds= | research_nodes sections 节点 + research_versions snapshot | 前端从 nodes/sections payload.sections[] 读回 |
| POST /api/workflow/jobs/{id}/cancel\|pause\|resume\|retry | POST /api/research/tasks/:taskId/control(L9295) | ✅ |
| POST /api/workflow/jobs/phase3/{material-plan,literature-search,table-generate,theory-generate,review,allocate,files} | /api/research/tasks jobKind=literature-search/theory-generate/table-generate + /api/research/materials/*(L9415-10540) | job 创建语义对齐; 产物=research_materials(kind citation/theory/data_result) |
| POST /api/workflow/versions/artifacts/import | POST /api/research/artifacts/import(L10349, contentHash 幂等) | ✅ 路径改写 |
| GET /api/workflow/jobs/phase5/task/{tid}/latest(-review) | research_tasks 按 project+jobKind 取最新 + project 列(merged_*/review_result) | 适配层读 project 聚合 |
| POST /api/workflow/jobs/phase5/version/{vid}/activate | POST /api/research/projects/:pid/versions/:version/activate(L9385) | 适配层 |
| POST /api/ai/navigation/intent + research-session + /agent/dispatch + main/analyze(SSE) 全系 | ❌ 大部分无(仓库只有 LOCAL_ONLY /api/ai/execute + openai 兼容) | **补(供 Quick 意图对话)**: 单端点 /api/research/ai-intent(无头 LLM 解析) — 见补点#4 |
| POST /api/dag/tasks/{id} GET+PUT(graph) + plan + run + dag/jobs + pause/resume/cancel/retry | research_projects.canvas(L8986-9015) + research_tasks + /engine/run(L9532) | **适配层 DAG**: canvas PUT=nodes/edges 持久化; plan=nl 前端内置; run=createTask(phase1-5 jobKind)+调度; job 轮询 research_tasks |
| POST /api/statistics-jobs + GET /api/statistics-jobs/:id + cancel/retry + 700ms 轮询 | ❌ /api/statistics-jobs 只有 artifacts(L10238-10289); 语义在 /api/empirical/run(L4594) | **适配层 statistics**: /api/statistics-jobs 创建 → 后端补薄代理(见补点#3)或前端直打 empirical/run 映射参数 |

## 3. 后端补点清单(前端直打闭源形, 语义无等价 → 补薄端点)
1. **POST /api/editor/v1/documents/import**(multipart/base64 docx → {html,title}): 闭源 Word 导入; 我方 extractDocxText 只出纯文本 → 补"docx→html(段落/标题保留)"文本启发转换。
2. **POST /api/editor/v1/documents/:id/export**(html+format_options → docx blob): 闭源导出; 前端可改用 paperExport 纯前端构建器(**推荐, 不补后端**) — M1 决定。
3. **POST /api/statistics-jobs**(创建+查询+cancel+retry 代理): 转 /api/empirical/run — M3 实施时评估(empirical/run 契约若同 semantics 则适配层直打, 不补)。
4. **POST /api/research/ai-intent**(Quick 意图路由无头版): body{message,context,profile,history} → {data:{...}} — M6 实施时补(若不补, 前端本地规则兜底: 关键词→选项, 主题→确认执行 → 任务要求"意图引擎 API 对齐" → 补)。
5. **GET /api/dag/tasks/:id** 返回形状与前端契约对齐(可选: 直接复用 projects) — M6 实施时定。

## 4. SSE 事件差异(前端处理规则)
| 域 | 闭源事件 | 我方实际 | 前端适配 |
|---|---|---|---|
| review | review.completed/failed/cancelled/status | review.started/status/delta/completed + 终态经 job 查询 | EventSource 收 completed→收敛; failed/cancelled→无事件, 靠 getJob 终态判定(轮询 1.2s 兜底已实现) |
| editor-ai | delta/model/done/error | 同形(delta/model/done/error, ai-job-service) | ✅ 1:1 |
| viz | 13 类(plan/delta/thinking/tool_status/tool/chart/svg/code/critique/critique_fix/error/done/viz.completed) | 后端触发事件(viz_job_events): 取决于 viz-job-service 执行器实现; 前端 event 分发表照闭源保留 | ✅ 前端照 13 类解析; 后端没发的事件前端自然不显示 |
| workflow phase4/5 | phase4.section_delta/section_completed / phase5.merge_delta/status/completed | ❌ research_tasks 无逐事件表 | 前端轮询 progress{current,total,stage} 600ms + 终态读 nodes/sections·finalize; 状态条 UI 保留(打字机用 section 结果直接注入? 由轮询快照内容驱动) |
