# 集成指南：Claude Code

把 MarxSphere 的 52 步推理/多源检索/文档入库能力接入 Claude Code。

## 1. 前置条件

- SAG 服务在跑：`MARXSPHERE_PREVIEW=1 npx tsx src/index.ts`（4173）
- 本机开发免 Token；外部部署需先建 Token（见 [quickstart](quickstart.md) 第二步）

## 2. 注册 MCP Server

### 项目级（推荐）

在**项目根目录**创建 `.mcp.json`：

```json
{
 "mcpServers": {
 "sag": {
 "command": "npx",
 "args": ["tsx", "scripts/sag-mcp-server.ts"],
 "cwd": "<SAG_ROOT>"
 }
 }
}
```

Claude Code 在该目录下启动时自动加载。

### 命令行注册（全局可用）

```bash
claude mcp add sag npx tsx scripts/sag-mcp-server.ts --cwd SAG_ROOT
```

### 外部部署配置

```json
{
 "mcpServers": {
 "sag": {
 "command": "npx",
 "args": ["tsx", "scripts/sag-mcp-server.ts"],
 "cwd": "<SAG_ROOT>",
 "env": {
 "SAG_API_URL": "https://your-server.example.com",
 "SAG_API_TOKEN": "sag_xxx"
 }
 }
 }
}
```

## 3. 重启并验证

重启 Claude Code 会话，然后：

1. 输入 `/mcp` 查看 sag 是否连接成功
2. 问 Claude：**"列出知识库里有哪些文档（用 sag_documents）"**
3. 问 Claude：**"用 sag_reason 分析资本下乡的非粮化原因"**

## 4. 使用技巧

### 让 Claude 正确选择工具

| 任务 | 推荐工具 | 提示语示例 |
|---|---|---|
| 深度推理/多跳分析 | `sag_reason` | "用 sag_reason 深入分析…" |
| 快速查证据/事实 | `sag_search` | "用 sag_search 找关于…的论文片段" |
| 导入新论文 | `sag_ingest` | "把这段论文内容入库（sag_ingest）" |
| 查看知识库 | `sag_documents` | "看看库里有什么文档" |

### 与现有 skill 的关系

项目已有 `marx-sag` 等 7 个 skill（描述性引导）。MCP server 提供**工具级**接入，两者互补：
- Skill：告诉 Claude MarxSphere 有什么能力、怎么理解推理链路
- MCP：让 Claude 直接调用工具，拿回结构化结果

### 注意事项

- `sag_reason` 是重操作（52 步链路，单次约 1-10 分钟），让 Claude 只在需要深度推理时使用
- 简单事实查证优先 `sag_search`（秒级返回）
- 答案中带 `（PG实体·高 / Cognee·中 来源）` 标记 = 有论文原文依据；无标记部分可能是模型推断，注意甄别

## 5. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `/mcp` 显示 sag 未连接 | 服务没起 / 路径不对 | 确认 4173 在跑；检查 `cwd` 路径 |
| 调用报 `SAG API 401` | Token 无效/未配置 | 检查 `SAG_API_TOKEN`；在设置页重建 |
| 调用报 `SAG API 403` | 权限不足 | Token 需含 `reason`/`ingest` 权限 |
| 调用超时 | 推理链路长 | 重试；或改用 `sag_search` |
| 返回"错误: 缺少 query" | 参数传错 | 检查调用参数 |
