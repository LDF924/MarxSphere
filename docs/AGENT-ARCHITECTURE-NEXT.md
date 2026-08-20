# MarxSphere Agent 架构演进（2026-08-21 更新）

> **本文档记录 Agent 架构方向的实现状态**——大部分方向已落地（含代码/迁移/路由证据），仅标注「规划中」的为剩余演进项。

## 状态总览

| 方向 | 状态 | 证据 |
|---|---|---|
| A 插件系统 | ✅ **已实现**（A1/A2/A3 全部落地） | `agent-plugin-service.ts` + 迁移 058 + `agent-provider-abstraction.ts` + `viewRegistry.tsx`（前端面板注册表） |
| B 外部服务 OAuth | ✅ **已实现** | `agent-oauth.ts`（GitHub 适配器已落地）+ 迁移 077/078 + 路由 `/api/agent/oauth/:provider/*` |
| C 多模态深度 | ✅ **大部分实现** | `image_analyze`（OCR/chart/describe）+ `audio_transcribe`（whisper）+ `agent-pdf-tool.ts`（MinerU 6 阶段管线） |
| D 多 Agent 协作 | ✅ **已实现**（D1 动态角色 / D2 协商循环） | `agent-orchestrator.ts` 动态角色定义 + negotiateWorkerRevisions |
| E 推理时优化 | ✅ **已实现**（E1 动态并发 / E2 SSE 流式 / E3 缓存） | `llm-common.ts` adaptiveCap + server.ts 7 处 SSE + lastUsage cacheHit |
| F 持久化会话图 | ✅ **已实现** | `agent-session-graph.ts`（会话→任务→工具→产出图谱 + **checkpoint 分叉** `forkTaskFromCheckpoint`） |

## 方向 A：插件系统 ✅

**现状**：工具/服务已插件化——`agent-plugin-service.ts` 管理插件注册（`agent_plugins` 表，含 `def_hash` 去重），`agent-file-plugins.ts` 按文件类型分发。

- A1 工具插件化：✅（插件表 + 注册；工具仍以 buildAgentTools 为主，热加载为后续）
- A2 服务插件化：✅（`agent-provider-abstraction.ts`——LlmProvider/SandboxProvider/GuardProvider 接口 + 默认实现作兼容层）
- A3 前端插件化：✅（`viewRegistry.tsx` 面板注册表——`registerView()` 一行注册即自动挂载导航与渲染；App.tsx 渲染先查注册表，未命中回退硬编码 switch，零回归）

## 方向 B：外部服务 OAuth ✅

**现状**：Agent 可代表用户调用外部服务——`agent-oauth.ts` 通用 OAuth2 客户端（authorization_code 流），**首个适配器 GitHub 已落地**（读公开仓库/issue），接口可扩展飞书/Notion。

- B1 OAuth 授权框架：✅（`/api/agent/oauth/:provider/start|callback` + token 加密存储 + refresh_token 续期）
- B2 服务适配器：✅ GitHub 已落地；接口 `AuthProvider / ApiClient` 可扩展
- B3 授权工具：✅（oauth 状态/授权引导）

## 方向 C：多模态深度 ✅（大部分）

**现状**：
- C1 图片理解管线：✅ `image_analyze`（OCR 文本提取 / 图表结构化 JSON / 综合描述）+ `agent-pdf-tool.ts`（MinerU 6 阶段：upload→mineru→normalize→translate→obsidian_export→quality_check）
- C2 音频/视频：✅ `audio_transcribe`（whisper 沙箱转写，不可用时降级提示）
- C3 多模态工具：✅（图表数据提取供实证分析）
- **教育多模态**（2026-08 新增）：作业拍照识别 / 口语测评（三维评分）/ 板书识别（`education-multimodal.ts`）

## 方向 D：多 Agent 深度协作 ✅

**现状**：`agent_subagent` 工具（调外部 Agent 子进程——Claude Code CLI 桥，借鉴 DSH subagent 模式）+ 主管拆包 + 工人固定角色 + 协商修订。

- D1 动态角色：✅（`agent-orchestrator.ts` 动态角色定义——角色=提示词+工具集，非固定 4 类；主管按需选用预置角色库）
- D2 长对话协作：✅（`negotiateWorkerRevisions` 协商循环——产出-反馈-修订）
- D3 协作市场：✅（预置专家角色库已部分存在：审稿人/方法论专家/领域专家）

## 方向 E：推理时优化 ✅

- E1 动态并发：✅（`llm-common.ts` adaptiveCap 按延迟自动升降：>LATENCY_HIGH_MS 降并发，<LATENCY_LOW_MS 回升）
- E2 流式推理：✅（server.ts 7 处 `text/event-stream`：Agent 任务流 `/api/agent/tasks/:id/stream` + 前端 `readSseStream` 通用消费器）
- E3 缓存：✅（DeepSeek prompt cache 命中采集 `lastUsage.cacheHit`）

## 方向 F：持久化会话图 ✅

**现状**：`agent-session-graph.ts`——
- F1 会话图：✅（会话→任务→工具→产出可视化图谱，`/api/agent/session-graph`）
- F2 会话分叉：✅（`forkTaskFromCheckpoint`——从任意 checkpoint 分叉新会话，DSH replay/fork 模式）
- F3 会话归档：✅（TTL 已有，扩展归档到文件）

## 推荐路线（剩余项）

```
长期: B2 更多服务适配器（飞书/Notion 等）
```

**判断标准**：每阶段完成 → 跑全量评测（154 测试）+ 真实场景验证 → 决定是否继续。

## 风险

| 风险 | 缓解 |
|---|---|
| OAuth token 泄露 | 加密存储 + 沙箱隔离（token 不注入执行环境） |
| 插件注入恶意工具 | 插件签名校验 + 工具审批门（risk=review）+ Guardian 审查 |
| 多模态成本 | 图片压缩预处理 + 缓存（已有）+ 按需调用 |
| 架构重构破坏现有功能 | 接口抽象兼容层（旧实现作默认 Provider） |
