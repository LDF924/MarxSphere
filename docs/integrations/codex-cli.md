# 集成指南：Codex CLI

把 MarxSphere 的推理/检索能力接入 OpenAI Codex CLI。

## 1. 前置条件

- SAG 服务在跑：`MARXSPHERE_PREVIEW=1 npx tsx src/index.ts`（4173）
- 本机开发免 Token；外部部署需先建 Token（见 [quickstart](quickstart.md)）

## 2. 配置 MCP Server

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.sag]
command = "npx"
args = ["tsx", "scripts/sag-mcp-server.ts"]
```

> 注意：`scripts/sag-mcp-server.ts` 是项目相对路径，需在 `SAG_ROOT` 下运行。
> 如果 Codex 工作目录不是 SAG 项目，建议用绝对路径或全局安装。

### 本机（推荐写法）

```toml
[mcp_servers.sag]
command = "cmd"
args = ["/c", "cd", "<SAG_ROOT>", "&&", "npx", "tsx", "scripts/sag-mcp-server.ts"]
env = { SAG_API_URL = "http://localhost:4173" }
```

### 外部部署

```toml
[mcp_servers.sag]
command = "cmd"
args = ["/c", "cd", "<SAG_ROOT>", "&&", "npx", "tsx", "scripts/sag-mcp-server.ts"]
env = { SAG_API_URL = "https://your-server.example.com", SAG_API_TOKEN = "sag_xxx" }
```

完整示例见仓库根目录 `codex-config.toml.example`。

## 3. 验证

重启 Codex CLI 后：

```
codex
> 用 sag_documents 看看知识库里有什么
> 用 sag_search 找关于土地流转的论文
```

## 4. 使用技巧

- 让 Codex 处理**学术/政策类问题**时，明确指定用 `sag_reason`（它会自动检索论文原文后推理）
- 快速事实查证用 `sag_search`（秒级）
- 新论文材料用 `sag_ingest` 入库，之后所有 Agent 都能检索到

## 5. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| Codex 报 MCP server 启动失败 | 路径/命令问题 | 确认工作目录与 npx 可用；用 `cmd /c` 写法 |
| 工具调用返回空 | 服务没起 | 确认 4173 在跑 |
| `401`/`403` | Token 问题 | 检查 `SAG_API_TOKEN` 与权限 |
