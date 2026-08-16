# MarxSphere 开放平台 · Overview

MarxSphere 是面向科研场景的 AI Agent 平台：多源知识检索（PG 向量 / Cognee / Graphiti 三库混合）+ 52 步深度推理链路 + 自我改进评测闭环。

本文档面向**想把 MarxSphere 推理/检索能力接入到自己 Agent（Claude Code / Codex 等）的开发者**。

## 一、平台能力

| 能力 | 说明 |
|---|---|
| **深度推理** | 52 步推理链路（大纲→多源检索→假设→评估→反思），支持 template / adaptive 两种模式 |
| **多源检索** | PG 向量 + Cognee 语义 + Graphiti 图谱三库混合，17 种检索策略（HyDE/实体提升/关键词加权等） |
| **知识库** | 501 篇资本治理学术论文（入库中），带论文原文切片 + 实体图谱 |
| **文档入库** | 任意文本/Markdown 自动切片 + 向量化 + 实体抽取，入库后可被检索 |
| **自愈闭环** | 检索失败自动降级（V80），低分回答自动反思重生成（V294 归因驱动） |

## 二、接入方式总览

| 方式 | 适合场景 | 快速开始 |
|---|---|---|
| **MCP Server**（推荐） | Claude Code / Codex 等标准 Agent | [quickstart.md](quickstart.md) |
| **REST API** | 自研应用 / 脚本 | [api-reference.md](api-reference.md) |
| **Skill**（Claude Code） | 轻量引导 Claude 手动调 API | 已有 `marx-sag` 等 7 个 skill |

## 三、认证

MarxSphere 对外接口使用 **Bearer Token** 认证（格式 `sag_xxx`）：

- 获取：MarxSphere 前端 → 设置 → **对外 API 令牌** → 新建
- 权限粒度：`reason`（推理/搜索）/ `search`（检索）/ `ingest`（文档入库）
- 规则：**localhost 请求豁免**（本机开发免认证）；外部 IP 强制 Token（无 Token → 401，权限不足 → 403）
- 安全：服务端只存 Token 的 sha256 哈希；Token 可单独撤销，撤销后立即失效

## 四、环境要求

| 组件 | 说明 |
|---|---|
| SAG 服务 | `MARXSPHERE_PREVIEW=1 npx tsx src/index.ts`（端口 4173） |
| PostgreSQL | Docker 容器 `sag_lite_postgres`（pgvector，5540 端口） |
| 知识库 | 论文已入库（`sag_documents` 工具可查） |

## 五、集成指南

- [快速开始（MCP 接入）](quickstart.md)
- [API 参考](api-reference.md)
- [集成指南：Claude Code](integrations/claude-code.md)
- [集成指南：Codex CLI](integrations/codex-cli.md)
- [Cookbook：真实任务示例](cookbook.md)

## 六、支持

- 问题反馈：项目 Issues / 会话直接问
- 相关：`API-INTEGRATION.md`（根目录简版）、[Sciverse 官方文档](https://sciverse.opendatalab.com/docs)（我们参考的模式）
