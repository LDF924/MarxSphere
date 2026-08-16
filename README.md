<p align="center">
  <img src="docs/assets/marx-logo-512.png" alt="MarxSphere" width="200" />
</p>

# MarxSphere 马研星环

**AI 驱动的马克思主义理论研究科研中枢** — 从文献检索、知识图谱到 AI Agent 与桌面端的完整科研工作台。

基于事件中心检索结构（`chunk → event → entities`）构建：以事件为语义单元组织文献知识，通过多跳召回发现跨文献的概念演变与观点关联。

---

## 功能总览

> 📖 **完整功能规格**：见 [docs/FEATURES-DETAILED.md](docs/FEATURES-DETAILED.md)（52 步推理逐步表 / 66 场景清单 / 26 工具矩阵 / 10 实证功能 / 桌面端细节 / 评测指标）

### 🧠 推理与检索

**52 步深度推理链路**（`推理` 视图）
- 全链路可展开：问题分类 → 意图识别 → 术语变体 → 拆分子问题 → 实体抽取 → Cognee 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈
- 每步可视化：当前步骤高亮、token 消耗实时显示、检索来源可追溯
- 支持 template / adaptive 两种推理模式，条件触发（子问题并行、时序分析、PG 实体补漏）

**Ask 18 步检索流水线**（`Ask检索` 视图）
- 多臂召回：向量化 → 别名消解 → 实体抽取 → 实体/关系召回 → 事件关联 → 标题向量 → 多查询变体 → 图遍历
- 融合排序：加权 RRF → Cosine 重打分 → Boost 链 → 去重 → LLM 重排 → 回取切片
- 答案带编号引用，点击回看原始切片；右侧 18 步流水线逐步点亮

**三库知识图谱**（`图谱` 视图）
- Graphiti：501 篇文献蒸馏、21,337 实体、1,085 知识社区、11,702 超边关系
- Cognee：31,253 实体、248,417 关系、11,550 切片（Neo4j 11003）
- PG pgvector：7,550 切片向量（1024 维）+ 全文检索
- 图谱可视化：实体/事件节点拖拽、缩放、点击展开、双击详情

**17 种检索策略**：HyDE / 实体提升 / 关键词加权 / 事件扩展 / 时序分析 / 概念搜索 / 文献蒸馏等

### 📚 科研场景工作台（66 场景 · 8 大阶段）

| 阶段 | 覆盖场景 |
|---|---|
| 选题构思 | 概念溯源、学派脉络、理论思辨拓展（前提反思/跨学科/创新识别） |
| 文献调研 | 经典文本研究、观点对比、争鸣还原、学者谱系 |
| 证据检索 | 互文对照、晦涩阐释、版本校勘 |
| 数据分析 | 实证研究（问卷生成/信效度/回归）、教育辅导 |
| 论文写作 | 综述生成、段落扩写、学术要件、引文格式化、语体适配 |
| 图表制作 | 学术图表、可视化模板 |
| 评审发表 | 概念一致性、引文核查、逻辑自洽、学术不端检测、期刊匹配 |
| 系统自动化 | Agent 任务编排、自主研究 |

政经 C 刊科研方法论：四步法选题 / 选题矩阵 / 悖论选题 / 概念命名 / 跨学科 / 模板检测 / 编辑校验 / 外审翻译 / 期刊匹配（80 本马理论期刊库）

### 🤖 AI Agent（50+ 能力项 · 26 工具）

**编排核心**
- 决策循环：规划 → 选工具 → 执行 → reflect → replan（最多 3 轮）
- 任务 DAG：LLM 拆解子任务 → 依赖编排 → 队列并发（信号量限流）→ 进度 SSE 流式推送
- 失败处理：工具超时熔断（30s）→ 重试退避 → 失败回流 → 错误分类（可恢复/不可恢复）
- 人工审批门：高影响工具需人工确认（approval 事件）→ 超时自动拒绝
- checkpoint 快照：每轮落盘（loop/plan/failures），重启续跑

**工具矩阵（26 个）**

| 类别 | 工具 |
|---|---|
| 认知 | sag_reason / sag_retrieve / sag_search / sag_get_event / concept_trace / policy_search / review_output / summarize / pdf_parse |
| 行动 | 实证分析真跑（Python 沙箱）/ 代码沙箱（3 级隔离）/ 文件读写 / 网页抓取（Edge headless）/ MCP 工具调用 / 主动研究 |
| 多模态 | image_analyze（图片理解）/ audio_transcribe（音频转写） |
| 系统 | 计划确认 / 任务通知 / 工具缓存（LRU）/ 会话检索 / 凭证管理（脱敏） |

**记忆与学习**
- 记忆层（OpenViking）：偏好/经验/历史交互三钩子（recall/commit/remember），推理注入
- 记忆投毒审查：拦截"要求执行动作"类注入内容
- 技能蒸馏（EDV）、轨迹评测、反思 → 归因 → 最小 diff 补丁 → bad case 回流
- 学习曲线：连续 N 天完成率/步骤成功率趋势可视化

**治理与扩展**
- 权限分级：reader / analyst / manager / admin 四级
- 工具白名单审批、租户配额、成本看板（token 实时统计）
- 插件热加载（plugins/ 目录）、OAuth 接入、会话图分叉、消息线程

### 🖥 桌面端（Electron + NSIS）

- 单进程架构：`node dist/src/index.js` 同时服务 API + 前端（零额外依赖）
- 首次启动全量引导：一键启动 PostgreSQL（Docker）/ Neo4j 检测 / Python 系统探测 / LLM 密钥配置
- 自动端口避让（4173→4183）、崩溃自动重启、进程树清理（taskkill /T）
- 依赖自解压：node_modules.zip 首启 bsdtar 自动解压（安装包 159MB）

### 🎯 实证研究工作台（10 大功能）

1. **问卷生成**：主题 → 结构化问卷（变量名/题型/编码表自动生成）
2. **问卷识别**：导入已有问卷 → 结构解析
3. **信效度检验**：Cronbach's α、KMO、Bartlett 球形检验
4. **问卷诊断**：题项质量分析、问题检测
5. **LLM 插补**：论文复现级缺失值处理（三分类插补）
6. **变量敲定**：反 hallucinate 白名单 + 坐标读系数
7. **分析管道**：描述统计 → 相关 → 回归全流程
8. **回归分析**：M1-M6 渐进控制、固定效应、稳健性检验
9. **证据账本**：每次分析留痕（数据/代码/结果可复现）
10. **质量闸门**：结果发布前的质量检查

### 🏛 政策与资料

- **政策库**：本地政策目录 + gov.cn 实时检索（一键存入）
- **资料库**：Obsidian 课题库浏览（md/PDF/图片/Office）
- **知识页**：Compiled Truth（最佳理解，可重写）+ 时间线（证据轨迹，只追加）
- **记忆管理**：记忆统计/归档/冲突检测/向量化/睡眠学习报告
- **写作语料库**：文本范例 / 核心概念 / 论证逻辑 / 词汇句式四大子库

### 📊 评测体系

- 双轨评测（规则 + LLM judge）、32 项指标（检索 A / 答案 B / 推理 C / 效率 D）
- Agent 轨迹评测：计划遵循度 / 工具准确率 / 推理质量
- 学习引擎：显著性 / 归因 / 轨迹前缀 / 校准（kappa=1.0）/ 模型替换基建
- 154 项单元测试覆盖

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
  src/                React WebUI（33 视图 · Mega Menu 导航）
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

## 文档与可验证材料

| 材料 | 位置 |
|---|---|
| 📘 项目概述（目标用户/痛点/功能/Agent思路/技术路线/创新/价值） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) |
| 📘 使用说明（环境/部署/权限/流程/样例/输出/注意） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) 第 2 节 |
| 📘 技术架构（模型/Agent/工具/RAG/上下文/工作流/数据流/架构图） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) 第 3 节 |
| 📘 合规披露（数据/风险/商业API/闭源模型） | [docs/OPEN-SOURCE-DISCLOSURE.md](docs/OPEN-SOURCE-DISCLOSURE.md) |
| 🔧 接口文档（HTTP API / MCP） | [docs/api-reference.md](docs/api-reference.md) / [docs/agent-api.md](docs/agent-api.md) |
| 🖥 桌面端安装包 | `npm run build:desktop` → `release/MarxSphere Setup <ver>.exe` |
| 🐳 数据库容器 | `docker compose up -d`（pgvector/pgvector:pg16） |
| 📊 运行截图 | [docs/assets/](docs/assets/)（对话/文档/图谱/架构 4 张） |
| 📈 评测报告样例 | `cross_judge_report.md` / `significance_report.md` / `tp_report.md` / `kappa_report.md` |
| ✅ 单元测试 | `npm test`（154 项） |
| 🎬 演示脚本 | `scripts/demo-ingest.ts` / `demo-search.ts` / `demo-agent.ts` |
| 📄 示例数据 | `scripts/问卷演示数据*.csv`（随机模拟，seed=42） |
