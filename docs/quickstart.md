# 快速开始（MCP 接入）

5 分钟把 MarxSphere 推理/检索/教育能力接入 Claude Code / Codex / DeepSeek Harness。

## 第一步：确保 SAG 服务在跑

```bash
cd SAG_ROOT
MARXSPHERE_PREVIEW=1 npx tsx src/index.ts
```

验证：浏览器打开 `http://localhost:4173` 能看到界面。

## 第二步：获取 API Token（外部部署时）

本机开发（localhost）**免 Token**，直接跳到第三步。

外部部署（服务器/多用户）时需要：
1. 打开 MarxSphere 前端 → **设置** → **对外 API 令牌**
2. 点"新建令牌"，填写名称（如 `claude-code-prod`），勾选权限（推理/搜索/入库/**教育**）
3. 复制生成的 `sag_xxx` 明文（**只显示一次**，请立即保存）

## 第三步：配置 MCP Server

### Claude Code

方式 A：项目级配置文件（推荐，跟随项目走）

```json
// 项目根目录 .mcp.json（或 .claude/mcp.local.json）
{
 "mcpServers": {
 "sag": {
 "command": "npx",
 "args": ["tsx", "scripts/sag-mcp-server.ts"],
 "cwd": "<SAG_ROOT>",
 "env": {
 // 外部部署时取消注释：
 // "SAG_API_URL": "https://your-server.example.com",
 // "SAG_API_TOKEN": "sag_xxx"
 }
 }
 }
}
```

方式 B：命令行注册（全局）

```bash
claude mcp add sag npx tsx scripts/sag-mcp-server.ts --cwd SAG_ROOT
```

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.sag]
command = "npx"
args = ["tsx", "scripts/sag-mcp-server.ts"]
env = { SAG_API_URL = "http://localhost:4173" }
```

完整示例见 `codex-config.toml.example`。

### DeepSeek Harness

```yaml
# deepseek-harness agent 配置
mcp_servers:
 sag:
 command: npx
 args: ["tsx", "scripts/sag-mcp-server.ts"]
 cwd: "<SAG_ROOT>"
```

> 三个框架共用同一 MCP 入口 `scripts/sag-mcp-server.ts`——SAG 的 MCP 层框架无关。

## 第四步：验证

重启 Claude Code / Codex / Harness 后，向它提问：

> "用 sag_documents 看看知识库里有哪几篇论文"

或直接：

> "分析一下资本下乡对农户土地流转的影响机制（用 sag_reason）"

**教育能力验证**（Web UI 或 REST）：

> 浏览器打开 `http://localhost:5173` → 顶部导航「**AI+教育**」→ 学生端/教师端
> 或 `curl -X POST localhost:4173/api/education/agent/socratic -H "Content-Type: application/json" -d '{"subject":"政治经济学","question":"为什么说价值规律是商品经济的基本规律？"}'`

## 下一步

- [API 参考](api-reference.md) —— 底层 REST 接口（含 `/api/education/*` 教育路由）
- [Cookbook](cookbook.md) —— 真实任务示例
- [Claude Code 集成](integrations/claude-code.md) / [Codex 集成](integrations/codex-cli.md) / [DeepSeek Harness 集成](integrations/deepseek-harness.md)
