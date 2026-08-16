# Agent 子系统 API 参考（G17）

> SAG AI Agent 子系统全部 HTTP 端点。基址：`http://localhost:4173`（生产按环境配置）。
> 鉴权：`Authorization: Bearer <sag_xxx 令牌>`（`SAG_AUTH_ENABLED=true` 时；localhost 豁免）。
> 错误格式：`{ error: string, code: string }` — `code` 取值 `AGENT_NOT_FOUND` / `AGENT_FORBIDDEN` / `AGENT_BAD_REQUEST` / `AGENT_AWAITING_APPROVAL` / `AGENT_FILE_TOO_LARGE` / `AGENT_INTERNAL_ERROR` 等。

## 任务（Task）

### POST /api/agent/tasks — 创建任务
```json
{ "goal": "研究剩余价值率演变", "projectId": "uuid?", "parentTaskId": "uuid?", "userId": "uuid?" }
```
→ `{ task }`（状态 `planning`，LLM 已拆解子任务计划）

### GET /api/agent/tasks?offset=0&limit=20 — 任务列表（G12 分页）
查询参数：`projectId` / `parentTaskId` / `offset`(默认0) / `limit`(默认20, 上限100)
→ `{ tasks, page: { offset, limit, hasMore } }`
JWT 存在时仅返回本人任务（admin 返回全部）。

### GET /api/agent/tasks/:id — 任务详情
→ `{ task }`（含 plan/currentStep/progress/result/reflectLog/approvalRequest/成本/评委分）

### POST /api/agent/tasks/:id/run — 入队执行
→ `{ ok, taskId, queued, priority }`（走 `agentTaskQueue` 并发控制；`AGENT_QUEUE_CONCURRENCY` 默认 2）
优先级：enterprise=3 / pro=2 / free=1（JWT 用户按 plan）。

### POST /api/agent/tasks/:id/control — 干预
```json
{ "action": "pause" | "resume" | "cancel" }
```
→ `{ task }`

### POST /api/agent/tasks/:id/approve — 审批高危步骤（四态）
```json
{ "approve": true, "note": "?", "action": "approve" | "edit" | "reject" | "respond", "editArgs": {} }
```
`edit`：改参数后继续；`reject`：跳过该步；`respond`：回复理由注入计划。

### POST /api/agent/tasks/timeout-approvals — 审批超时处理
```json
{ "maxWaitMinutes": 60 }
```
→ `{ result: { timedOut, reason } }` — 超时按拒绝处理（绝不自动放行）。

### DELETE /api/agent/tasks/:id — 删除任务

### GET /api/agent/tasks/:id/stream — SSE 流式进度
事件：`snapshot`（初始快照）/ `task`（状态）/ `step`（步骤）/ `reflect`（循环评估）/ `exec_log`（实时日志）/ `tool_start|tool_complete|tool_error`（工具卡片）/ `done`。
`Last-Event-ID` 支持断线续传（环形缓冲 100 条）。

### GET /api/agent/tasks/:id/export — 导出 Markdown 报告

### POST /api/agent/tasks/from-template — 模板创建
```json
{ "templateId": "lit_review|empirical|policy|concept|cjournal_topic|cjournal_trend|cjournal_paradigm", "goal": "..." }
```

## 编排（Orchestrate）

### POST /api/agent/orchestrate — 主管-工人编排（G8 走队列）
```json
{ "goal": "复杂研究目标", "projectId": "?" }
```
→ `{ ok, taskId, queued, priority }` — 后台主管拆包 → 并行工人 → 主管汇总 → 自动评审。

### GET /api/agent/messages?taskId= — Agent 消息流（主管↔工人）
### GET /api/agent/workers?parentTaskId= — 工人任务列表
### POST /api/agent/cleanup-tables — 消息/工人表 TTL 清理
```json
{ "days": 30 }
```
→ `{ messagesDeleted, workersDeleted }`（cutoff 参数化，无注入风险）

## 对话记忆（Chat Memory）

### POST /api/agent/chat — 对话式指挥
```json
{ "message": "帮我研究X", "sessionId": "?" }
```
意图：`create`（创建任务）/ `continue`（续作，沿用上轮目标）/ `history` / `clear`。响应含 `sessionId`（首轮返回，后续持有延续语境）。

### GET /api/agent/chat/history?sessionId= — 会话历史
### DELETE /api/agent/chat/history?sessionId= — 清空会话

## 执行日志（Exec Logs）

### GET /api/agent/logs?taskId=&action=&status= — 执行日志（分页 limit/offset）
### GET /api/agent/logs/span-tree?taskId= — span 树（parent_id/span_type/conversation_id 层级）
### GET /api/agent/logs/cost-summary?taskId= — 任务成本摘要（token/费用）
### GET /api/agent/logs/audit-report — 审计报表（分工具成本/成功率）

## 评测（Eval）

### GET /api/agent/eval-suite?category=gold — 评测集列表
### POST /api/agent/eval-suite — 新增评测条目（name/category/goal/expected_*）
### POST /api/agent/eval-suite/run — 运行回归评测
```json
{ "category": "gold", "fault": "none|rate_limit|timeout|degraded", "limit": 10 }
```
### GET /api/agent/eval-suite/history — 历史运行记录
### GET /api/agent/eval-report — 汇总评测报告
### DELETE /api/agent/eval-suite/:id — 删除评测条目

## 技能（Skills）

### GET /api/agent/skills — 技能列表（status 过滤）
### POST /api/agent/skills/distill — 从任务蒸馏技能
```json
{ "taskId": "uuid", "goal": "...", "result": "...", "toolsUsed": [] }
```
### POST /api/agent/skills/:id/validate — EDV 评审（consensus/votes）
### GET /api/agent/skills/recall?query= — 技能召回（规划注入用）
### DELETE /api/agent/skills/:id — 删除技能

## 情景记忆（Episodic Memory）

### GET /api/agent/episodic-memory — 记忆列表
### POST /api/agent/episodic-memory/forget — 遗忘低价值记忆
### POST /api/agent/episodic-memory/consolidate — 记忆整理

## 插件 / 定时任务

### GET /api/agent/plugins / POST /api/agent/plugins — 插件列表/注册
### GET /api/agent/plugins/:id/approval — 插件工具审批
### DELETE /api/agent/plugins/:id — 删除插件
### GET /api/agent/scheduled / POST /api/agent/scheduled — 定时任务列表/创建
```json
{ "goal": "...", "cron": "0 9 * * *" }
```
### DELETE /api/agent/scheduled/:id — 删除定时任务

## 学习曲线 / 队列状态

### GET /api/agent/learning-curve — 技能学习曲线（随评测轮次提升）
### GET /api/agent/queue — 队列状态 `{ queued, running, maxConcurrent, items }`

## 任务模板

### GET /api/agent/templates — 模板列表（lit_review 等 7 个）

## 安全（Guardian / 凭证 / 沙箱）

### GET /api/agent/guardian/policy — 查看安全策略文件（热更新）
### POST /api/agent/guardian/review — 工具调用判定预览
```json
{ "tool": "run_code", "args": { "profile": "full-access" }, "authorization": "high" }
```
→ `{ decision: { verdict, riskLevel, authorization, reason } }`

### POST /api/agent/guardian/reload — 重载策略文件
### GET /api/agent/credentials — 凭证列表（脱敏视图, value 永不返回）
### POST /api/agent/credentials — 新增/更新凭证 `{ name, kind, value, hint }`
### DELETE /api/agent/credentials/:name — 删除凭证
### POST /api/agent/image/prepare — 附件图片大小检查（>1MB 提示压缩）

## 自主级别 / 预设 / 设置

### GET /api/agent/autonomy — 当前自主级别（suggest/auto-edit/full-auto）
### POST /api/agent/autonomy — 切换自主级别 `{ level }`（持久化）
### GET /api/agent/presets — 预设列表（academic/data/writing/coding）
### POST /api/agent/presets — 切换预设 `{ id }`（持久化）
### GET /api/agent/settings — 运行时设置（预设/自主级别/沙箱）
### GET /api/agent/memory-usage — 内存使用（rss/heap/external/uptime）

## 生命周期 / 运维

### GET /api/agent/hooks — 钩子列表（task_start/tool_after 等 7 事件）
### POST /api/agent/hooks — 注册钩子 `{ event, name }`
### DELETE /api/agent/hooks/:id — 注销钩子
### GET /api/agent/diagnostics — 运行时诊断（LLM 并发/队列/SSE/会话/hooks/工具/预设/DB）
### GET /api/agent/subprocesses — 子进程状态（防孤儿管理）
### POST /api/agent/proactive-research — 手动触发主动研究巡检
### POST /api/agent/feedback — 任务反馈 `{ taskId, feedback: 1|-1, note }`（负评自动转防错规则）
### GET /api/agent/feedback/stats — 反馈统计
### GET /api/agent/sessions/search?q= — 会话全文检索（跨会话找回历史研究）

## 工作流 / 计划 / 恢复

### GET /api/agent/workflows — 工作流模板（文献综述/概念溯源/实证分析）
### POST /api/agent/workflows/:id/run — 运行工作流 `{ goal }`
### POST /api/agent/tasks/:id/confirm-plan — 计划确认（拒绝→cancelled/确认→running）
### GET /api/agent/exec-logs 新增 model/metadata 字段（轮次元数据）

## 架构级（A-F: 插件/OAuth/多模态/协作/推理/会话图）

### GET /api/agent/session-graph?sessionId= — 会话图（会话→任务→工具 图谱）
### POST /api/agent/tasks/:id/fork — checkpoint 分叉（计划复制, 独立演进）
```json
{ "goal": "分叉新目标(可选)" }
```
### POST /api/agent/llm/stream — LLM 流式推理（SSE 逐块推送）
```json
{ "prompt": "...", "model": "?", "maxTokens": 1000 }
```
→ SSE: `data: {"delta":"..."}` ... `data: {"done":true,"text":"完整文本"}`

### GET /api/agent/oauth/:provider/start — 开始 OAuth 授权（返回跳转 URL）
### GET /api/agent/oauth/:provider/callback — 授权回调（存 token, 加密）
### GET /api/agent/oauth/accounts — 已授权账号列表（脱敏）
### DELETE /api/agent/oauth/:provider/:account — 撤销授权
### GET /api/agent/plugins/files — 文件插件列表（plugins/ 目录）
### POST /api/agent/plugins/files/:name/register — 文件插件注册（哈希签名）
### GET /api/agent/providers — 服务抽象 Provider 状态（LLM/沙箱）

## 插件工具（plugins/ 目录, 热加载）

- 任意 `.ts` 文件导出 `tools` 数组 = Agent 工具（无需重启）
- 示例: plugins/demo-calculator.ts（calc 计算器）
- 注册流程: 文件扫描 → 哈希签名 → 白名单确认 → 生效
