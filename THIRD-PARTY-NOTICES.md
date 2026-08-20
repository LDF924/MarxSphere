# Third-Party Notices（第三方代码使用声明）

MarxSphere（AGPL v3 + 商业授权双许可）使用了以下第三方开源项目的源码/设计。本文件按开源合规要求披露全部来源与许可证。

## 一、架构级来源

### SAG2 / SAG（事件中心检索架构底座）

- **项目**：SAG — A new SOTA for RAG（事件中心检索架构）
- **仓库**：https://github.com/Zleap-AI/SAG
- **用途**：MarxSphere 的核心检索架构（chunk → event → entities 事件中心结构、multi-search 多路检索流水线、MCP 工具集 sag_search/sag_ingest_document/sag_get_event 等）
- **涉及文件**：`src/services/search-service.ts`、`src/db/repositories.ts`、`src/db/vector.ts`、`src/services/inference-service.ts`、`src/mcp/server.ts`
- **许可证**：**MIT License**（Copyright (c) Zleap-AI）— 见附录

## 二、移植源码（含代码注释声明）

### GBrain（garrytan/gbrain）

- **用途**：检索增强纯函数（RRF 加权融合 / boost 系数 / Compiled Truth / 9-phase jobs / 别名消歧）
- **涉及文件**：`src/services/gbrain-boosts.ts`、`rrf.ts`、`alias.ts`、`sanitize.ts`、`truth-service.ts`、`jobs-service.ts`、`step-docs.ts` 等 20+ 文件
- **许可证**：MIT License（Copyright (c) garrytan）— 见下文附录

### PDF2Obsidian（yeora26/PDF2Obsidian）

- **用途**：PDF → Obsidian 完整管线（MinerU 解析 → 规范化 → 翻译 → Obsidian 导出）
- **涉及文件**：`vendor/pdf2obsidian/`（完整内置，含 LICENSE）
- **许可证**：MIT License（Copyright (c) 2025 PDF2Obsidian Contributors）

## 三、借鉴设计（思路参考，代码独立实现）

| 来源 | 借鉴功能 | 涉及文件 | 说明 |
|---|---|---|---|
| **OpenAI Codex** | Guardian 策略审查 / 工具注册表 / 沙箱分级 / approval modes | `src/services/agent-guardian-service.ts`、`agent-tool-registry.ts`、`code-sandbox-service.ts`、`agent-autonomy.ts` 等 | 仅 API 形态借鉴，代码独立实现 |
| **DeepSeek Harness（DSH）** | credentials / hooks / preset / feedback 包模式、"Everything is a Plugin" 插件体系 | `src/services/agent-credentials.ts`、`agent-hooks.ts`、`agent-presets.ts`、`agent-feedback.ts`、`agent-file-plugins.ts` 等 | 仅设计模式参考（MIT）|
| **wisp-science**（xuzhougeng/wisp-science）| Python 持久运行时 / 远程计算上下文 | `src/services/agent-persistent-runtime.ts`、`agent-remote-exec.ts`、`agent-tool-router.ts` 等 | 概念对应，独立实现 |
| **HyperGraphRAG** | 超边知识层（对比参照） | `src/services/inference-service.ts` | 仅思路参照 |

## 四、外部服务集成（进程/API 调用，非内置代码）

| 服务 | 用途 | 许可证 |
|---|---|---|
| **Cognee**（topoteretes/cognee）| 检索层（Neo4j 11003 + LanceDB，17 路检索策略）| Apache-2.0 |
| **Graphiti**（getzep/graphiti）| 图谱检索层（五层蒸馏 / 超边 / 社区）| Apache-2.0 |
| **OpenViking**（volcengine/OpenViking）| 长期记忆服务（REST API v0.4，自演化上下文数据库）| AGPL-3.0 |
| **MinerU**（opendatalab/MinerU）| PDF 解析引擎（PDF2Obsidian 的核心管线，`mineru` 命令调用）| AGPL-3.0 |
| **China-Central-Policy-MCP** | 政策检索 MCP 服务（spawn + stdio 握手）| 待确认 |
| **OpenAlex** | 学术文献检索（api.openalex.org）| CC0（API 使用）|
| **World Bank OKR** | 世界银行开放数据（openknowledge.worldbank.org）| CC BY 4.0 |
| **Sciverse** | 学术检索 API（api.sciverse.space，SCIVERSE_API_TOKEN）| 商业 API |
| **CNKI 知网** | 文献检索（kns.cnki.net，CDP 代理 + Edge headless）| 商业网站 |
| **Claude Code CLI** | 外部 Agent 子进程桥（agent_subagent）| Anthropic 商业工具 |

### Python 运行时库（scripts/ 调用）

| 库 | 用途 | 许可证 |
|---|---|---|
| PyMuPDF | PDF 解析 | **AGPL-3.0**（双许可）|
| python-docx | Word 解析 | MIT |
| openpyxl | Excel 解析 | MIT |
| python-pptx | PPT 解析 | MIT |
| pandas / numpy | 实证分析 | BSD-3-Clause |
| neo4j 驱动 | 图谱查询 | Apache-2.0 |

## 五、npm 依赖（43 项：26 运行时 + 17 开发）

| 协议 | 数量 | 代表包 |
|---|---|---|
| MIT | 36 | fastify / react / react-dom / mermaid / katex / pg / pino / zod / electron / vite 等 |
| Apache-2.0 | 4 | neo4j-driver / class-variance-authority / @playwright/test / typescript |
| ISC | 2 | d3-force / lucide-react |
| BSD-2-Clause | 1 | dotenv |

> 注：26 个直接依赖中 MIT 21 / Apache-2.0 2（class-variance-authority、neo4j-driver）/ ISC 2 / BSD-2-Clause 1；完整依赖见 `package.json`。

## 六、其他

- **Contributor Covenant v2.1**（CC BY 4.0）：`CODE_OF_CONDUCT.md` 改编自其全文（已标注）
- **KaTeX 样式**（MIT）/ **highlight.js 样式**（**BSD-3-Clause**）：随 npm 包分发
- **GPL 系运行时组件**（非 npm 依赖）：
  - **Neo4j Community 镜像**（`docker-compose.yml` 11001/11003）— **GPLv3**（以 docker 服务运行、未修改未分发，不触发传染）
  - **PyMuPDF**（Python 解析库）— **AGPL-3.0**（双许可，以进程调用方式使用）
- 无 CDN 字体/外部素材

---

## 附录：MIT License 全文（GBrain 等标注 MIT 的移植代码）

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```
