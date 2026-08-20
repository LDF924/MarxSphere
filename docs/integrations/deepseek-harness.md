# 集成指南：DeepSeek Harness（DSH）

把 MarxSphere 的推理/检索/工具编排能力接入 **DeepSeek Harness**（DeepSeek 开源 Agent 框架），并说明本仓库对 DSH 设计模式的吸收（credentials / hooks / preset / feedback 包体系）。

## 1. 前置条件

- SAG 服务在跑：`MARXSPHERE_PREVIEW=1 npx tsx src/index.ts`（4173）
- 本机开发免 Token；外部部署需先建 Token（见 [quickstart](quickstart.md)）
- DeepSeek Harness 已安装（`pip install deepseek-harness` 或源码部署）

## 2. 注册 MCP Server

DeepSeek Harness 通过 MCP 协议接入外部工具。在 Harness 的 Agent 配置中注册 SAG MCP Server：

```yaml
# deepseek-harness agent 配置（示例）
mcp_servers:
 sag:
 command: npx
 args: ["tsx", "scripts/sag-mcp-server.ts"]
 cwd: "<SAG_ROOT>"
```

> 与 Claude Code / Codex 使用同一入口 `scripts/sag-mcp-server.ts`——SAG 的 MCP 层是框架无关的，任何支持 MCP 的 Agent 框架均可接入。

## 3. 可用工具（经 MCP 暴露）

SAG MCP Server 暴露的核心能力（与 52 步推理/四源检索对应）：

| 工具 | 作用 |
|---|---|
| `sag_search` | 四源混合检索（SAG 事件 + Graphiti 超边 + Cognee 切片 + PG 向量） |
| `sag_reason` | 52 步推理链路（问题分类 → 多源检索 → 假设 → 评估 → 反思） |
| `sag_ingest` | 文档入库（分块 + 事件/实体抽取） |
| `sag_retrieve` | 指定源检索 |
| 教育工具 | `/api/education/*` 全部能力（学习规划/辅导/诊断/备课/陪伴等） |

## 4. DSH 设计模式吸收（本仓库）

MarxSphere 的 Agent 编排层吸收 DSH 的包模式（**仅设计模式参考，代码独立实现**，详见 [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)）：

| DSH 模式 | MarxSphere 对应实现 | 作用 |
|---|---|---|
| credentials 包 | `src/services/agent-credentials.ts` | 凭证隔离：API Key 仅存本地 `.env`，日志脱敏（`maskCredentials`） |
| hooks 包 | `src/services/agent-hooks.ts` | 工具生命周期钩子（调用前/后/失败事件） |
| preset 包 | `src/services/agent-presets.ts` | 预设角色/场景配置（reader/analyst/manager 等工具角色） |
| feedback 包 | `src/services/agent-feedback.ts` | 反馈沉淀（防错规则/知识页草稿） |
| "Everything is a Plugin" | `src/services/agent-file-plugins.ts` | 文件插件体系（按文件类型分发处理） |

## 5. 验证

```bash
# SAG 侧：MCP server 可启动
npx tsx scripts/sag-mcp-server.ts

# Harness 侧：调一个工具确认链路
# （在 DeepSeek Harness 对话中请求：用 sag_search 检索"剩余价值"）
```

## 6. 使用技巧

- **推理链路**：复杂研究问题走 `sag_reason`（52 步全链路，带引用溯源），简单问答走 `sag_search` 即可；
- **教育能力**：`/api/education/*` 的教育工具可经 HTTP 直接调用（Fastify 4173），不限于 MCP；
- **凭证**：Harness 侧无需配置 SAG 密钥，SAG 的密钥只在 SAG 服务侧持有（凭证隔离）。

## 7. 故障排查

| 问题 | 排查 |
|---|---|
| 工具调用超时 | 52 步推理单次可能 30-120s，Harness 侧调大工具超时 |
| `sag_reason` 无引用 | 检查知识库是否已入库（`npm run db:setup` + 文档入库） |
| MCP 连接失败 | 确认 4173 服务存活（`curl localhost:4173/health`）与 `cwd` 指向 SAG_ROOT |
