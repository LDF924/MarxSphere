# MarxSphere 开源合规披露

> 本文档按开源合规要求，对本项目的运行方式、风险边界、模型依赖、商业 API 使用等进行完整披露。

---

## 1. 运行入口、依赖、配置、样例与部署

### 运行入口

| 模式 | 命令 | 说明 |
|---|---|---|
| 开发 | `npm run dev` | 前端 Vite (5173) + 后端 Fastify (4173) |
| 生产 | `npm run build && npm start` | 编译后单进程服务 (4173) |
| 桌面端 | `npm run build:desktop` | Electron + NSIS 安装包 |
| MCP 服务 | `npm run mcp` | 标准 I/O MCP Server |
| 测试 | `npm test` | 154 项单元测试 |
| 数据库 | `npm run db:setup` | 迁移 + 种子数据 |

### 依赖说明

- **Node.js ≥ 20**（全栈 TypeScript）
- **PostgreSQL 16 + pgvector**（必需，`docker compose up -d` 一键启动）
- **Python 3.12 + venv**（可选：推理 MCP 池 / 实证分析）
- **Neo4j**（可选：Graphiti 11001 / Cognee 11003 图谱增强）
- 全部 npm 依赖见 `package.json`，环境变量见 `.env.example`

### 样例输入输出

- `scripts/demo-ingest.ts` — 文档入库演示
- `scripts/demo-search.ts` — 多路检索演示
- `scripts/demo-agent.ts` — Agent 任务演示
- `scripts/问卷演示数据*.csv` — 实证分析示例数据（随机生成，seed=42，非真实数据）

### 部署说明

1. `cp .env.example .env` 并填入 API keys
2. `docker compose up -d`（PostgreSQL + pgvector）
3. `npm install && npm run db:setup`
4. `npm run build && npm start`

---

## 2. 风险提示（重要）

### 模型幻觉
- 本系统所有 LLM 生成内容（推理结论、摘要、问卷生成、Agent 输出）**可能产生幻觉**（编造事实、张冠李戴、过度自信）
- 推理链路中的检索结果**仅供参考**，最终结论须由使用者核验原始文献
- 实证分析中的 LLM 插补结果**不可替代实地调查数据**

### 数据缺失
- 知识库内容取决于用户导入的文献——**未入库的领域可能检索不到或回答不准确**
- 图谱检索（Graphiti/Cognee）未就绪时自动降级为 PG 向量检索，**召回质量下降**
- 评测金标集（`data/*.json`）为内部构建，**不构成任何领域基准**

### 接口异常
- 第三方 API（LLM/Embedding/图谱）**不可用时自动降级**：本地 fallback / 降级检索，输出质量可能显著下降
- 端口冲突自动递增（4173→4183），服务自愈巡检每 60s 运行

### 业务边界
- 本系统是**科研辅助工具**，不提供法律/政策/投资等专业意见
- 问卷生成、信效度检验为**统计工具输出**，不构成调查方法学建议
- Agent 的自主执行受权限分级（reader/analyst/manager）与人工审批门约束，**高影响操作需人工确认**

---

## 3. 依据、置信度与人工确认

### 引用溯源
- 推理答案带**编号引用**，点击可查看原始 chunk（`检索结果 → 切片证据` 可追溯）
- Ask 检索流水线展示 18 步完整 trace（每步的召回来源与分数）
- 52 步推理链路全程可视化（每步 token 消耗与检索来源）

### 置信度
- 检索结果带**分数排序**（RRF 加权分 / Cosine 相似度）
- 评测系统输出 32 项指标（检索质量 A / 答案质量 B / 推理质量 C / 效率 D）
- Agent 轨迹评测含计划遵循度 / 工具准确率 / 推理质量 judge 打分

### 人工确认机制
- Agent 任务支持**人工审批门**（approval 事件，高影响工具需确认）
- 自主研究生成的任务可被人工取消/暂停
- 评测金标（gold）由人工标注，不依赖模型自评

---

## 4. 商业 API 使用披露（重要）

本系统**依赖多家商业 API**，开源运行需要您自行购买/配置密钥：

| API | 用途 | 默认配置 | 费用假设 |
|---|---|---|---|
| LLM（DeepSeek / 阿里云 MaaS / OpenAI 兼容） | 推理/生成/评测 | `LLM_BASE_URL` + `LLM_API_KEY` | 按 token 计费，费用因模型而异 |
| Embedding（阿里云 MaaS 等） | 向量化 | `EMBEDDING_BASE_URL` + `EMBEDDING_API_KEY` | 按 token 计费 |
| Rerank（qwen3-rerank 等） | 重排 | `RERANK_BASE_URL` | 按调用计费 |
| Sciverse（可选） | 外部学术检索 | `SCIVERSE_API_TOKEN` | 按查询配额 |

### 调用环节
- 每个推理/检索/生成操作都可能产生多次 API 调用（52 步推理 ≈ 多次 LLM 调用 + 多次 Embedding 调用）
- 成本看板可实时查看 token 消耗（`/api/agent/diagnostics`）

### 可替代性与锁定风险
- **协议开放**：所有模型调用走 OpenAI 兼容接口，可替换任意兼容服务商（DeepSeek/通义/Qwen/本地 Ollama 等）
- **Embedding 维度锁定**：pgvector 列固定 `vector(1024)`，更换不同维度的 Embedding 模型需重建向量（见 `EMBEDDING_DIMENSIONS`）
- **无平台锁定**：数据全部存于本地 PostgreSQL/Neo4j，导出即迁移

---

## 5. 闭源模型使用披露

| 模型 | 类型 | 使用范围 | 原因 |
|---|---|---|---|
| qwen-plus / deepseek-v4-flash | 闭源 | 推理/实体抽取/综合回答 | 中文领域效果、成本、速度平衡 |
| qwen3-rerank | 闭源 | 检索重排 | 与检索流水线配合的领域效果 |
| text-embedding-v4 | 闭源 | 向量化 | 中文语义理解效果好 |

### 替代方案
- 所有模型均**可替换**为开源模型（如 Qwen2.5 开源版、BGE 系列 Embedding）——只需改 `.env` 指向兼容端点
- **迁移成本**：Embedding 换维度需重建向量索引（数小时到数天，取决于语料规模）；LLM 替换零成本（改 base_url + model 名）

### 对可复现性的影响
- 闭源模型版本迭代可能导致**评测结果波动**（相同输入不同输出）
- 建议复现时固定模型版本与温度参数（评测系统已记录模型调用日志）

---

## 6. Agent 框架说明

- **框架选择**：自研轻量编排（非 LangChain 类框架），基于任务队列 + 工具注册表 + 状态机
- **任务规划**：LLM 拆解子任务 → 任务 DAG 依赖 → 队列并发执行（详见 `docs/AGENT-CAPABILITIES.md`）
- **工具调用**：26 工具经注册表统一管理（输入 schema 校验 → 白名单审批 → 超时熔断 → 重试退避）
- **状态管理**：任务状态持久化到 PostgreSQL（重启恢复），轨迹 span 树完整记录

## 7. 工具与平台接入

- **调用方式**：HTTP API（`/api/agent/*`）+ MCP Server（`npm run mcp`）+ 外部 Agent 对接
- **权限范围**：四级权限（reader/analyst/manager/admin）+ 工具白名单 + 租户隔离（JWT）
- **返回结果**：结构化 JSON + 流式 SSE（进度实时推送）
- **失败处理**：工具超时熔断 → 重试退避 → 失败回流（任务级）+ 告警中心记录

## 8. 知识增强

- **数据来源**：用户导入的文献（PDF/Markdown/TXT）+ 外部学术检索（Sciverse/CORE/OpenAlex）
- **检索策略**：17 路粗检索（Cognee HYBRID/Graphiti 社区/超边/PG 向量/词法）→ 加权 RRF 融合 → 重排
- **依据引用**：每个答案带来源编号，点击查看原始切片（可追溯）
- **更新机制**：入库管道（PG/Graphiti/Cognee 三库同步）+ 期刊实时同步管道（每 6 小时）+ 记忆层定期整理

---

## 11. 数据、知识库与上下文增强（数据治理）

### 11.1 数据来源、授权与边界

| 数据类型 | 来源 | 更新时间 | 授权 | 适用边界 |
|---|---|---|---|---|
| 用户导入文献 | 使用者自行上传（PDF/MD/TXT） | 上传即处理 | **使用者自有版权材料**；系统不提供盗版文献 | 仅用于个人/机构科研检索 |
| 演示/示例数据 | 脚本生成（`scripts/问卷演示数据*.csv`，seed=42） | 随代码版本 | 随机模拟，无真实个人信息 | 仅用于功能演示，不构成真实调查数据 |
| 评测金标集 | 内部构建（`data/gold_*.json`） | 随代码版本 | 内部语料，**不构成领域基准** | 仅用于内部评测对比 |
| 外部检索结果 | Sciverse / CORE / OpenAlex | 实时查询 | 各平台 API 条款 | 引用须自行核验版权与可引用性 |
| 政策资料 | gov.cn 官方接口 | 实时/每 6 小时同步 | 政府公开信息 | 仅作研究参考，非官方解读 |

**适用边界声明**：本系统是科研辅助工具，知识库内容取决于用户导入；未入库领域可能检索不到或回答不准确；检索结果受第三方 API 数据质量影响。

### 11.2 知识库构建、检索与错误处理

- **构建方式**：文档上传 → 分块（chunking）→ 事件抽取 → 实体抽取 → 向量化（pgvector）→ 三库同步（PG 向量 / Graphiti 社区 / Cognee 切片）
- **检索策略**：17 路粗检索（Cognee HYBRID / Graphiti 社区+超边 / PG 向量 / 词法 BM25）→ 加权 RRF 融合 → Cosine 重打分 → LLM 重排 → 去重
- **引用来源**：答案编号引用 → 点击回看原始切片；18 步检索 trace 全程可视化（召回来源与分数）
- **更新机制**：入库管道自动同步三库；期刊同步每 6 小时；知识页（Compiled Truth）可人工重写
- **错误处理**：
  - 图谱（Graphiti/Cognee）不可用 → 自动降级 PG 向量检索（召回质量下降，界面提示）
  - Embedding/LLM API 失败 → 本地确定性 fallback（提示降级，不静默）
  - 入库失败 → 任务队列重试 + 失败明细可查 + 断点续传

### 11.3 用户数据、脱敏与删除

**个人信息/敏感信息声明**：
- **开源代码库本身不含任何个人信息**（姓名/电话/地址等已在上游清理阶段移除）
- 示例/演示数据为随机生成（seed=42），无真实个人信息
- 系统运行时**可能接触**用户导入的文档内容（含个人信息时由用户自行负责合规）
- 系统**不收集**使用遥测、不上传任何数据到第三方（除用户主动配置的 LLM/Embedding API 调用）
- 若用户导入含个人信息的数据，系统提供：日志脱敏（不落日志）、软删/永久删除、卸载清除

- **日志脱敏**：所有日志输出经 `sanitizeLine/sanitizeObject` 脱敏——**API 密钥、token、个人信息不进系统日志**（`src/services/log-sanitizer.ts`，V310 强制）
- **外部请求脱敏**：HTTP 层对外部请求错误信息脱敏，不暴露内部细节（V348）
- **凭证脱敏**：Agent 凭证管理 API 只返回脱敏视图（`sk-****`），明文仅保存加密存储
- **最小化使用**：系统只在用户主动导入时接触数据；推理仅调用所需切片；外部检索仅发送查询关键词
- **权限控制**：四级权限（reader/analyst/manager/admin）+ 工具白名单 + 租户隔离（JWT）+ 外部令牌只读
- **删除机制**：
  - 项目/文档/会话：UI 删除 → 软删除（归档）→ 永久删除（级联清理切片/事件/实体/向量）
  - 记忆数据：记忆管理面板可归档/删除；会话上下文随会话删除清理
  - 用户数据：卸载应用保留 `%APPDATA%\MarxSphere`，手动删除即完全清除

### 11.4 上下文、记忆与状态管理（Agent）

- **短期记忆**：`conversation_context` 按会话存对话摘要，推理时注入上下文；写入前经**记忆投毒审查**（拦截"要求执行动作"类注入）
- **长期记忆**：OpenViking 记忆层（偏好/经验/历史交互），按 recall/commit/remember 三钩子管理；不存文献内容
- **任务状态**：任务/子任务/轨迹 span 树持久化 PostgreSQL，重启恢复（checkpoint 快照续跑）
- **历史信息**：会话历史可清空/删除；模型调用日志（raw logs）存浏览器本地缓存，可清除
- **遗忘机制**：记忆维护服务定期整理/归档（冲突检测、重复合并）；Agent 设置可关闭记忆注入

## 9. 多模态能力

- **图片理解**：Agent `image_analyze` 工具（多模态模型分析图片内容）
- **音频转写**：`audio_transcribe` 工具（语音→文本）
- **附件处理**：PDF 解析（PDF2Obsidian 集成）、图片预处理（压缩减少 token）
- **网页抓取**：`sag_browse`（Edge headless 抓取 DOM）

## 10. 运行验证

### 截图
- `docs/assets/sag-home.png` — 首页（马克思语录 + 数据总览 + 推理动画）
- `docs/assets/sag-chat.png` — 对话界面
- `docs/assets/sag-reason.png` — 52 步推理链路
- `docs/assets/sag-ask.png` — Ask 18 步检索流水线
- `docs/assets/sag-literature.png` — 文献库
- `docs/assets/sag-graph.png` — 知识图谱探索
- `docs/assets/sag-scenarios.png` — 科研场景工作台
- `docs/assets/sag-empirical-research.png` — 实证研究工作台
- `docs/assets/sag-agent-console.png` — Agent 控制台
- `docs/assets/sag-eval.png` — 评测工作台
- `docs/assets/marxsphere-architecture.svg` — 系统架构图（7 层完整架构）

### 评测指标
- `SCORING_STANDARD.md` — 32 项评测指标定义
- `cross_judge_report.md` / `significance_report.md` / `tp_report.md` — 评测报告样例
- 154 项单元测试（`npm test`）

---

## 声明

本项目按 MIT 许可证开源。**本项目输出的所有研究结论、问卷设计、分析结果仅供科研参考，使用者须对最终成果负责。**
