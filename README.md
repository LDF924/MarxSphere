<p align="center">
  <img src="docs/assets/marx-logo-512.png" alt="MarxSphere" width="200" />
</p>

# MarxSphere 马研星环

**AI 驱动的马克思主义理论研究科研中枢** — 从文献检索、知识图谱到 AI Agent 与桌面端的完整科研工作台。

> 底层基于 SAG（event-centric retrieval）构建：`chunk → event → entities` 的事件中心检索结构，
> 多跳召回能力在 HotpotQA / 2WikiMultiHop / MuSiQue 上 Recall@2 平均 79.30%（较 HippoRAG 2 提升 11.16pp）。

---

## 功能总览

### 🧠 推理与检索
- **52 步推理链路**：问题分类 → 大纲 → 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈
- **Ask 18 步检索流水线**：多臂召回 → 加权 RRF → Boost 链 → 重排，全程可视化逐步展开
- **三库知识图谱**：Graphiti（社区/超边）+ Cognee（实体/切片）+ PostgreSQL pgvector（向量）

### 📚 科研场景（65 个场景 · 8 大阶段）
选题构思 → 文献调研 → 证据检索 → 数据分析 → 论文写作 → 图表制作 → 评审发表 → 系统自动化
覆盖马理论研究全流程：经典文本研究、学术研究、论文写作、质量检查、理论思辨、政经 C 刊选题方法论等。

### 🤖 AI Agent（50+ 能力项）
- 任务编排、多轮循环、失败回流、人工审批门
- 25+ 工具：实证分析真跑 / 代码沙箱 / 网页抓取 / PDF 解析 / MCP 打通 / 主动研究
- 记忆层（OpenViking）、规划记忆、技能蒸馏、轨迹评测、成本看板
- 插件热加载、OAuth、流式推理、会话图分叉

### 🖥 桌面端（Electron + NSIS）
- 单进程架构：内置后端 + 前端，`node dist/src/index.js` 同时服务 API 与静态页面
- 首次启动全量引导：一键启动 PostgreSQL / Neo4j 检测 / Python 探测 / LLM 密钥配置
- 自动端口避让、崩溃自动重启、进程树清理

### 🎯 实证研究工作台
问卷生成 → 信效度检验 → 诊断 → LLM 插补 → 回归分析（M1-M6 渐进控制）→ 证据账本 → 质量闸门

---

## 快速开始

### 1. 环境要求
- Node.js ≥ 20
- PostgreSQL 16 + pgvector（推荐 Docker：`docker compose up -d`）
- （可选）Python 3.12 + venv（推理 MCP 池 / 实证分析）
- （可选）Neo4j（Graphiti 11001 / Cognee 11003，图谱增强）

### 2. 安装与初始化

```bash
git clone <your-repo-url>
cd SAG-main
cp .env.example .env      # 填入 LLM / Embedding API key
npm install
npm run db:setup          # 迁移 + 种子数据
npm run dev               # WebUI http://localhost:5173, API http://localhost:4173
```

### 3. 生产模式

```bash
npm run build
npm start                 # http://localhost:4173
```

### 4. 桌面端

```bash
npm run build:desktop     # 生成 NSIS 安装包 release/MarxSphere Setup <ver>.exe
npm run dev:desktop       # 开发态启动 Electron
```

---

## 配置

`.env` 关键项（完整见 `.env.example`）：

```env
DATABASE_URL=postgres://user:pass@localhost:5432/sag_lite
LLM_API_KEY=sk-xxx            # OpenAI 兼容接口
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=qwen-plus
EMBEDDING_API_KEY=sk-xxx
EMBEDDING_BASE_URL=https://api.302ai.cn/v1
EMBEDDING_MODEL=text-embedding-3-large
RERANK_MODEL=qwen3-rerank
HTTP_PORT=4173
```

可选增强配置：`COGNEE_PYTHON`（推理 MCP venv 路径）、`EMPIRICAL_PYTHON`（实证分析 venv）、
`AGENT_EDGE_PATH`（浏览器工具）、`NEO4J_PASSWORD`（图谱凭据）。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Vite 8 + Tailwind CSS |
| 后端 | Fastify 5 + TypeScript（全栈 TS） |
| 数据 | PostgreSQL + pgvector + 全文检索 + SQL 多跳 |
| 图谱 | Neo4j（Graphiti 社区/超边 + Cognee 实体/切片） |
| Agent | MCP SDK + 自主编排 + 工具注册表 |
| 桌面 | Electron + electron-builder（NSIS） |
| 模型 | OpenAI 兼容 LLM / Embedding / Rerank API |

## 目录结构

```text
src/
  ai/                 LLM/Embedding/Rerank 客户端
  api/                HTTP API + 推理链路
  services/           Agent / 实证 / 知识图谱 / 评测服务
  db/                 连接、迁移、仓储、向量工具
web/
  src/                React WebUI（34 视图 · Mega Menu 导航）
electron/             桌面端主进程 / 引导页
scripts/              Python runner / 评测脚本 / 工具脚本
migrations/           PostgreSQL schema（80+ 迁移）
test/                 单元测试（154 项）
docs/                 文档
```

## 测试

```bash
npm test                # 154 项单元测试
npm run typecheck       # 前后端类型检查
```

## License

MIT License — 见 [LICENSE](LICENSE)。

## 合规披露

📋 [开源合规披露](docs/OPEN-SOURCE-DISCLOSURE.md) — 完整披露：运行依赖 / 风险提示（模型幻觉、数据缺失、接口异常）/ 商业 API 使用与费用 / 闭源模型与替代方案 / Agent 框架 / 多模态能力 / 运行验证 / **数据治理（数据来源与授权、知识库构建与错误处理、用户数据脱敏与删除、Agent 上下文与记忆管理）**。

> ⚠️ **重要提示**：本系统依赖商业 LLM/Embedding API（按 token 计费），所有 AI 生成内容**可能产生幻觉**，研究结论须核验原始文献。详见 [披露文档](docs/OPEN-SOURCE-DISCLOSURE.md) 第 2、4、5 节。
