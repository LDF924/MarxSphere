# MarxSphere 对外接入（API Token + MCP Server）

> **完整文档已迁移到 [docs/overview.md](docs/overview.md)**（Sciverse 风格三层：Overview → API Reference → 集成指南 + Cookbook）

MarxSphere 推理/检索能力可通过 **MCP Server** 接入 Claude Code / Codex 等 AI Agent。
对标 [Sciverse-Agent-Tools](https://github.com/opendatalab/Sciverse-Agent-Tools) 模式：薄包装 REST API → MCP 工具。

## 快速入口

| 文档 | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 平台总览、接入方式、认证 |
| [docs/quickstart.md](docs/quickstart.md) | 5 分钟快速开始（MCP 接入） |
| [docs/api-reference.md](docs/api-reference.md) | REST API 完整参考（参数/响应/curl） |
| [docs/integrations/claude-code.md](docs/integrations/claude-code.md) | Claude Code 接入指南 |
| [docs/integrations/codex-cli.md](docs/integrations/codex-cli.md) | Codex CLI 接入指南 |
| [docs/cookbook.md](docs/cookbook.md) | 真实任务示例（推理/检索/入库/盘点） |

## 核心组件

| 组件 | 位置 |
|---|---|
| MCP Server（薄包装） | `scripts/sag-mcp-server.ts` |
| Token 服务（sha256 哈希存储） | `src/services/api-token-service.ts` |
| 鉴权中间件（localhost 豁免，外部强制 Bearer） | `src/api/server.ts` |
| Token 表（migration 030） | `migrations/030_api_tokens.sql` |
| 前端管理页 | `web/src/components/ApiTokensPanel.tsx`（设置 → 对外 API 令牌） |
| Codex 配置示例 | `codex-config.toml.example` |

## 一句话流程

MarxSphere 设置页生成 `sag_xxx` Token → 填入 Claude Code `.mcp.json` / Codex `config.toml` → Agent 直接调用 SAG 52 步推理 / 多源检索 / 文档入库。
