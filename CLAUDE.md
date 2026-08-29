# CLAUDE.md — Claude Code 项目指南

本文件供 Claude Code（以及兼容的 AI 编码代理）在 MarxSphere 仓库内工作时自动加载。使用前请先阅读 [AGENTS.md](AGENTS.md) 获取完整结构。

## 核心命令

```bash
npm run typecheck   # 前后端类型检查（改代码后必跑）
npm test            # 263 项单元测试
npm run dev         # 开发: WebUI 5173 / API 4173
npx tsx src/index.ts  # 单跑后端
```

## 后端修改要点

- **ESM**：import 必须带 `.js` 后缀（`from "./foo.js"`）
- **环境变量**：改 `src/config/env.ts`（zod）时同步 `.env.example`
- **数据库**：pgvector 1024 维；迁移幂等；`npm run db:migrate` 跑迁移
- **检索**：四源混合架构（SAG 事件 + Graphiti 超边 + Cognee + PG），融合在 `search-service.ts` RRF
- **Agent**：编排在 `src/services/agent-*`（37 文件）；新工具注册到 `agent-tool-router.ts`；教育能力在 `src/services/education-*.ts` 等 12 服务（84 路由），改教育功能需同步前端面板（`web/src/components/Education*Panel.tsx`）与教育路由（server.ts `/api/education/*`）
- **API**：Fastify 路由在 `src/api/server.ts`；错误格式 `{ error, code }`

## 前端修改要点

- **视图**：`web/src/App.tsx` 的 `MainWorkspaceTabs`（33 视图），新视图同步 `GROUP_DOTS` 与分类
- **API 调用**：`web/src/lib/api.ts`（相对路径）
- **组件**：`web/src/components/`（44 个面板）
- 改完跑 `cd web && npx tsc --noEmit`

## 评测改动

- 主评测：`npx tsx scripts/eval-32-metrics.ts`（53 题，基线 0.884）
- **改动检索/推理后必须跑评测验证分数不退化**
- 指标定义：`docs/SCORING_STANDARD.md`

## 常见陷阱

1. **不要杀 node 进程**：用 `taskkill /PID <pid> /T /F`（Windows）或 `kill <pid>`（Linux）
2. **`.env` 永不提交**：密钥只在本地 `.env`
3. **日志脱敏**：打印敏感信息前用 `sanitizeLine`（`src/services/log-sanitizer.ts`）
4. **端口冲突**：4173 被占时服务会 EADDRINUSE 退出——先查占用进程再启动
5. **数据库**：本机 docker 映射 5540（`docker compose up -d`）；若 4173 起不来先查 `/health` 的 `db` 字段

## 架构速览

```
用户 → Web(React) / 桌面端(Electron) / 外部Agent(MCP)
     → Fastify API (4173)
     → 52步推理链路 → 四源检索(SAG/Graphiti/Cognee/PG) → RRF融合 → 生成
     → AI Agent编排(26工具/5层安全/5层记忆) → 任务队列 → 结果
数据: PostgreSQL(向量+词法) + Neo4j(Graphiti 11001/Cognee 11003) + LanceDB
```
