# AGENTS.md — AI Agent 项目指南

本文件为 AI 编码代理（Claude Code / Codex / Cursor 等）提供 MarxSphere 仓库的快速导航与协作规范。

## 项目概览

MarxSphere — AI 驱动的哲学社会科学科研中枢（当前以马克思主义理论为展示语料）。核心是**事件中心的多源混合 RAG**：SAG 事件检索 + Graphiti 超边 + Cognee 切片 + PG 向量四源融合，配套 52 步推理链路与 AI Agent 编排。**另有 AI+教育能力**：顶部「AI+教育」Tab（学生端/教师端双角色），122 教育路由 + 32 学习引擎顶层（教育服务 `src/services/education-*.ts` 等 19 文件），对话可经 `education_service` 工具一句话调用。

## 仓库结构

```
src/                 后端源码（TypeScript ESM, Fastify 5）
  ai/                LLM/Embedding/Rerank 客户端 + MCP 池
  api/               HTTP API + 推理链路（server.ts / reason-handler.ts）
  services/          Agent 编排 / 实证分析 / 知识图谱 / 评测 / 检索服务
  db/                连接 / 迁移 / 仓储 / 向量工具
  ingestion/         文档分块与事件/实体抽取
  mcp/               MCP Server
  observability/     日志 / 模型调用记录
web/                 前端源码（React 19 + Vite 8 + Tailwind, 41+ 视图）
electron/            桌面端（主进程 / 引导页 / 打包）
scripts/             Python runner / 评测脚本 / MCP server / 工具脚本
evaluation/          评测资产（结果 / 金标 / 历史归档）
reports/             评测报告
knowledge-graph/     知识图谱数据
skills/              自研 Skill（10 个, 覆盖文献获取→科研调度）
migrations/          PostgreSQL schema（108 迁移）
test/                单元测试（736 项, Vitest）
docs/                文档
```

## 快速开始

```bash
cp .env.example .env        # 配置 LLM/Embedding API key（必填）
docker compose up -d        # PostgreSQL 16 + pgvector
npm install
npm run db:setup            # 迁移 + 种子数据
npm run dev                 # 开发: 仅 API 4173(无 5173 dev server)
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm test` | 736 项单元测试（Vitest） |
| `npm run typecheck` | 前后端类型检查 |
| `npm run build` | 后端 tsc + 前端 vite 构建 |
| `npm start` | 生产模式（4173） |
| `npm run mcp` | 启动 MCP Server（stdio） |
| `npm run build:desktop` | 打包桌面端 NSIS 安装包 |

## 关键架构约定

### 后端
- **ESM 模块**：所有 import 必须带 `.js` 后缀（如 `from "./foo.js"`）
- **环境变量**：`src/config/env.ts` 用 zod 校验，新增变量需同步 `.env.example`
- **数据库**：pgvector 向量 1024 维（改维度需重建索引）；迁移文件幂等（`create if not exists`）
- **检索架构**：多源混合（SAG 事件 + Graphiti 超边 + Cognee 切片 + PG 向量），融合链路见 README「52 步推理链路」
- **Agent 编排**：`src/services/agent-*`（task-service/orchestrator/tool-registry/eval-service 等 37 个文件），工具注册在 `agent-tool-router.ts`

### 前端
- **视图导航**：`App.tsx` 的 `MainWorkspaceTabs`（41+ 视图, Mega Menu 6 分类），新增视图需同步 `GROUP_DOTS` 色点与分类数组
- **API 调用**：`web/src/lib/api.ts` 统一封装（相对路径 `/api/...`）

### 评测
- 主评测脚本：`scripts/eval-32-metrics.ts`（31 评分项 + overall, 53 题）
- 指标定义：`docs/SCORING_STANDARD.md`（V96: A12+B9+C3+D7）
- 评测数据：`evaluation/eval_32metrics*.json`（0.884 证据）
- 金标集：`data/gold_*.json` + `evaluation/gold_dataset*.json`

## Agent 协作规范

1. **改后端服务** → 跑 `npm run typecheck` + 对应测试
2. **改前端组件** → `cd web && npx tsc --noEmit`
3. **新增环境变量** → 同步 `.env.example` + `src/config/env.ts`
4. **新增数据库表** → `migrations/` 幂等 SQL（编号递增）
5. **评测相关改动** → 跑 `npx tsx scripts/eval-32-metrics.ts` 验证分数不退化
6. **提交前** → `npm test` 736 项全绿

## 外部 Agent 接入（MCP）

MarxSphere 可作为 MCP Server 被 Claude Code/Codex 调用：

```json
{
  "mcpServers": {
    "sag": {
      "command": "npx",
      "args": ["tsx", "scripts/sag-mcp-server.ts"]
    }
  }
}
```

工具：`sag_search`（多路检索）/ `sag_ingest_document`（文档入库）/ `sag_get_event`（事件详情）/ `sag_reason`（深度推理）等 8 个。也可通过 `npm run mcp` 启动自带 MCP Server（23 工具）。

## 安全与合规

- `.env` / 密钥**永不提交**（.gitignore 已防护）
- 日志自动脱敏（`src/services/log-sanitizer.ts`）
- Agent 工具黑名单：file_delete / data_purge / external_publish / payment
- 完整披露见 `docs/OPEN-SOURCE-DISCLOSURE.md`
