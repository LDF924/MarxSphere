# 贡献指南（Contributing）

感谢你愿意为 MarxSphere 贡献！本指南帮助你理解项目结构与协作流程。

> ⚖️ **提交即同意**：通过提交 Pull Request 或 Commit，即表示您同意
> [CONTRIBUTOR-LICENSE-AGREEMENT.md](CONTRIBUTOR-LICENSE-AGREEMENT.md)
> （贡献者许可协议）的条款——您的贡献可被用于项目商业运营，且项目可在 AGPL 家族内修订协议。


## 项目速览

- **技术栈**：全栈 TypeScript（Fastify 5 + React 19 + Vite 8 + Electron）
- **数据层**：PostgreSQL 16 + pgvector（1024 维）+ Neo4j（Graphiti 11001 / Cognee 11003）
- **核心架构**：事件中心多源混合 RAG（SAG + Graphiti 超边 + Cognee + PG），配套 52 步推理链路与 AI Agent 编排
- **文档入口**：先读 [README.md](README.md) 和 [AGENTS.md](AGENTS.md)

## 开发环境

```bash
cp .env.example .env        # 配置 LLM/Embedding API key
docker compose up -d        # PostgreSQL 16 + pgvector
npm install
npm run db:setup            # 迁移 + 种子数据
npm run dev                 # 开发: WebUI 5173 / API 4173
```

## 代码约定

1. **ESM 模块**：后端 import 必须带 `.js` 后缀（`from "./foo.js"`）
2. **环境变量**：新增变量需同步 `src/config/env.ts`（zod 校验）与 `.env.example`
3. **数据库迁移**：幂等 SQL（`create if not exists`），文件编号递增（migrations/）
4. **TypeScript 严格模式**：前后端 `npm run typecheck` 零错误
5. **测试**：新增功能配 Vitest 测试，`npm test` 全绿

## 提交流程

1. **Fork** 仓库到你的账号
2. **创建分支**：`git checkout -b feat/你的功能名`
3. **开发**：遵循上述约定
4. **验证**：
   ```bash
   npm run typecheck
   npm test
   ```
5. **提交**：清晰的中文/英文 commit message（参考现有历史）
6. **PR**：描述改动内容、动机、验证结果；评测相关改动请附评测分数对比

## Issue 规范

- **Bug 报告**：环境信息（Node 版本/OS）+ 复现步骤 + 期望 vs 实际行为
- **功能建议**：场景描述 + 现有方案不足 + 建议实现
- 使用中文或英文均可

## 评测相关（重要）

涉及检索/推理/评测的改动，请运行主评测脚本并对比分数：

```bash
npx tsx scripts/eval-32-metrics.ts   # 53 题 31 指标, 基线 0.884
```

**分数不应退化**。若分数下降，请在 PR 中说明原因与权衡。

## 开源协议

本项目 MIT 许可。贡献即视为同意你的代码以 MIT 协议发布。
