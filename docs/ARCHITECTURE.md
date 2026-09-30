# SocioSeek 系统架构（2026-09-29 更新）

> SocioSeek 全链路架构：52 步推理 + 四源检索 + AI Agent 编排（158 工具）+ 18 大科研工作台 + AI+教育，当前真实状态。

## 1. 整体架构 — 七层管道

```
用户 Query (HTTP / SSE / MCP / 桌面端)
        │
        ▼
┌─ ① 交互层 ────────────────────────────────────┐
│ 外壳 React 49 视图（Mega Menu 6 分类 + 命令面板）│
│ Vue 子应用 /soc/（写作舱/编排/评审/绘图/编辑器/统计）│
│ 桌面端 Electron · MCP Server(10 工具) · REST   │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ② 推理链路层（52 步 · reason-steps.ts 为唯一真源）──┐
│ 分类/意图/术语/拆题(1-4) → Cognee 粗检索(5-18)      │
│ → Graphiti 精炼(19-27) → 超边知识层(28-32)          │
│ → 融合生成/假设/自评/自愈(33-52)                    │
│ 另: 自适应模式 21 算子注册表(adaptive-operators)     │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ③ 检索层（四源混合 RRF + Cosine 重排 0.7/0.3）────┐
│ SAG 事件(内容向量·标题向量·BM25 三臂 RRF)           │
│ Graphiti 超边/社区(hybrid_search_entities, 11001)   │
│ Cognee 切片(cognee_search, 11003 + LanceDB)         │
│ PG 向量/词法(pgvector 1024 + BM25 + source_chunks)  │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ④ Agent 编排层 ──────────────────────────────┐
│ 规划→选工具→执行→reflect→replan(≤3轮)           │
│ 158 工具(102 Agent + 56 视图) · 191 编排能力     │
│ 5 层安全 · 5 层记忆 · 插件系统 · 执行租约         │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ⑤ 科研工作台层（18 大科研工作台，Vue + React 面板）────┐
│ 研途写作舱 · 课题流程编排 · 论文质量评审 · 成果可视化 │
│ 学术文本工作台 · 数据分析台 · 实证工作台 · 文献管理   │
│ 写作语料库 · 文档中心 · 外部服务密钥 / 扫描件 OCR     │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ⑥ AI+教育层（122 教育路由 + 39 学习引擎顶层路由）──┐
│ 六能力/自适应四层/作业闭环/BKT/先修图                │
│ 苏格拉底五步打磨/思政审核/自动闭环/多模态             │
└──────────────┬────────────────────────────────┘
               ▼
┌─ ⑦ 数据层 ────────────────────────────────────┐
│ PG+pgvector(1024维) │ Neo4j(Graphiti 11001 / Cognee 11003) │ LanceDB │
└───────────────────────────────────────────────┘
```

**规模**：300 服务文件（44 `agent-*` + 9 教育服务 + 13 学习引擎服务 + 论文/研究/评审 14 文件）· 982 路由（Fastify 全量注册，含 122 教育 + 39 学习引擎顶层）· 165 迁移 · 49 前端视图 · 158 工具 · 209 科研技能 · 191 编排能力 · 78 科研场景(16 组) · 1293 测试

## 2. 推理链路（52 步）

入口 `InferenceService.reason()`。步序真源是 `src/services/reason-steps.ts` 的 `REASON_STEPS`（后端权威表，同时是 `retrieve_steps.step_no` 的取值域，随详情下发给前端——前端不再自带静态副本）。

| 段 | 步号 | 内容 |
|---|---|---|
| Stage 0-1 分类 + 大纲 | 1-4 | 问题分类 · 意图识别 · 术语变体 · 拆分子问题 |
| Stage 2 Cognee 粗检索 | 5-18 | 实体抽取 · Cognee HYBRID · RAG补全 · 图遍历 · 关系三元组 · 摘要检索 · 子问题推理 · 上下文扩展 · 时序分析(条件) · PG实体补漏 · PG向量 · CHUNKS词法 · 语义检索 · 实体直查 |
| Stage 3 Graphiti 精炼 | 19-27 | 实体精炼 · 概念搜索 · 文献蒸馏 · 领域知识 · 实体邻居 · 段落回溯 · 论文溯源(条件) · DeepWalk扩展(条件) · 关系查询(条件) |
| Stage 3.5 超边知识层 | 28-32 | 超边向量检索 · 超边实体导向 · 超边BM25 · 三路RRF融合 · 时间衰减 |
| Stage 4 融合生成 | 33-52 | Compiled Truth · 多查询变体 · HyDE扩展 · 意图调配额 · 三臂RRF · Cosine重打分 · Boost链 · 超边配额 · LLM重排 · 压缩段落 · COT推理 · Agentic搜索 · 生成假设 · 自评校验 · 置信评估 · 溯源标注 · 回写知识页 · 失败降级 · 快速回退 · 响应返回 |

各步带 `trigger` 条件（时序类问题/图遍历稀疏/超边层开启/多跳推理等），非条件步全跑。每阶段写入 `retrieve_steps` 日志（真实 token + cacheHit 可审计）。

**两种模式**：`template`（固定 52 步，默认，评测口径）与 `adaptive`（LLM 动态选算子）。自适应走 `src/services/adaptive-operators.ts` 的 **21 算子注册表**，分 5 组：prep(1) / cognee(6) / graphiti(7) / fusion(4) / gen(3)，按 `dependsOn` + `condition` 组合执行，短问题 4-6 算子而非固定 52 步。

**问题分类**：四路分调（`inference-service.ts` 的 PROFILES），按问题类型选检索配置。

## 3. 检索架构（四源混合）

`SearchService.search()`（RRF 融合 + Cosine 重排 0.7×normRrf + 0.3×cosine）：

| 源 | 作用 | 技术 |
|---|---|---|
| SAG 事件 | 主知识轴（Compiled Truth ×2.0 boost） | 内容向量 + 标题向量 + BM25 三臂 RRF（k=60） |
| Graphiti 超边 | 跨文档语义关联/社区聚合 | `hybrid_search_entities` MCP，Neo4j 11001 |
| Cognee 切片 | 段落级 HYBRID | `cognee_search`，Neo4j 11003 + LanceDB |
| PG | 向量/词法 + 教育知识库切片 | pgvector 1024 维 + BM25 + `source_chunks` |

**可配置源**：`src/services/retrieval-sources.ts` —— PG / Graphiti / Cognee 三库任意组合（全关/单开/任两/全开），前端开关 + localStorage 持久化，Ask 与推理两条链路各自独立配置。

**Ask 链路（18 步）**：多臂召回 → 加权 RRF → Boost 链 → Cosine 重排 → LLM 重排，前端实时逐步点亮（`AskPanel.tsx`）。

**RRF 实现**：`src/services/rrf.ts`，`score(item) = Σ_arm 1/(k + rank_arm(item))`，k 默认 60，带回 `contributions` 与 `armsHit` 供调试。

## 4. AI Agent 编排

- **158 工具**（102 Agent + 56 视图）。工具已按域拆到多个模块：`agent-tool-router`(49) / `agent-view-tools`(33) / `agent-review-tools`(23) / `agent-orch-tools`(19) / `agent-editor-tools`(18) / `agent-viz-tools`(10)，运行时经 `buildAgentTools()` 汇总。计数以运行时注册表为准（`scripts/doc-facts.ts`）。
- **191 编排能力**（`capability-registry.ts`）：**29 条端点型 `WORKBENCH_CAPABILITIES`** + 运行时导出的工具，分 **12 个分类**（检索/推理/写作/实证/统计/审稿/绘图/编辑/格式/引文/经典/教育/知识/文件/通用），每条带 cost(light/medium/heavy) 与产物类型。
- **5 层安全**：Guardian 策略(拒绝熔断) / 3 级沙箱 / 网络审批(SSRF) / 审批门(三级链: Hook→Guardian→User + 缓存) / 凭证隔离
- **5 层记忆**：情景(`agent-episodic-memory`) / 战略(`strategic-memory-service`) / 技能蒸馏(`agent-skill-distill`) / 防错规则(`prevention-rules-service`) / 语料库(`writing-corpus-service`)；另有 OpenViking 长期记忆(`openviking-memory.ts`)
- **插件系统**：A1 工具插件（`agent_plugins` 表）/ A2 服务接口（Llm/Sandbox/Guard Provider）/ A3 前端注册表（`viewRegistry.tsx`）
- **外部服务**：OAuth（GitHub 适配器）/ 多 Agent 协作（动态角色 + 协商循环）/ 会话图 + checkpoint 分叉
- **Agent 编排增强**: 预算/时间提醒注入(窗口去重) · Mid-turn 压缩不终止(滚动窗口) · Elicitation 暂停协调 · Stop/PreToolUse/PostToolUse/PermissionRequest/SessionStart 钩子 · 世界状态 diff(reflectLog 增量) · Steer 转向输入 · Mailbox 双通道 · 挂起检查点 · 评审会话隔离(read-only 暴露矩阵) · 共享上下文 LRU · 全链路插桩审计

### 4.1 工程纵深（2026-09-05，OpenSquilla 移植）

| 能力 | 实现 | 落点 | 开关 |
|---|---|---|---|
| 成本可审计账本 | 轮级真实用量(模型/端点/cacheHit) + cost_source 三态 + 按模型单价 | `llm_usage_ledger`(105 迁移) + `cost-ledger-service.ts` | 即时生效 |
| 三档路由 + 本地 ML 分类器 | lite(单点快答)/standard(默认)/deep(深链); 规则优先 + LightGBM(180 标注, acc 0.938) 只升级 deep | `router_audit`(106 迁移) + `tier-router-service.ts` + `scripts/ml-router/` | `ROUTER_ENABLED=1` |
| 任务执行租约 | DB 级 lease(holder+fencing token+TTL 心跳), 断线接管 | agent_tasks exec_lease_*(107 迁移) + `agent-task-queue.ts` | 即时生效 |
| 记忆 Dream 凝练×3 | 记忆候选 + 技能蒸馏 + MetaSkill DAG 提案, 均隔离区人工审; 候选带支撑证据 | `dream-consolidation-service.ts` + `meta-skill-propose-service.ts` | 默认开 |
| B5 集成路由 | 多模型并行成稿 + aggregator 融合(证据校准); 渐进/超时截断/预设 | `b5-ensemble-service.ts` + 盲标评测脚本 | `B5_ENABLED=1` |
| 沙箱安全 | 删除前备份 `.trash`(3GiB); 网络禁环回回连 | `agent-tool-router.ts` file_write/checkNetworkAccess | 即时生效 |

## 5. 开源能力融入

| 能力 | 来源 | 融入方式 | 落点 |
|---|---|---|---|
| PDF/文档双模式转换 | mineru-go | 源码直用 vendor + TS 适配 | `pdf_convert` 工具（Agent 轻量 ≤10MB≤20页 / Precision 精准, 扫描件 OCR） |
| 研究选题打磨 | good-question | 源码直用技能 | S01/S04 场景 + 教育五步打磨 stress 注入 |
| 公文起草 | gongwen-draft | 源码直用技能 | `gongwen_draft` 工具（23 文种, 先查先核再写） |
| 视频学习笔记 | bili-note/dy-note | 源码直用技能 | `video_note` 工具（B站/抖音 → Markdown 素材池） |
| 元分析 | easymeta | 方法论移植 | 实证方法 `meta_analysis`（固定/随机效应+Q/I²/τ²+HK+森林/漏斗图） |
| 英文文献 OA | instsci | 源提炼 vendor | `view_openalex_search` / `view_oa_lookup`（OpenAlex+Unpaywall, 国内可达） |
| Markdown 清洗 | scansci-pdf | 源提炼 vendor | `cleanMarkdown()`（变音符号折叠+NFC+替换字符审计） |
| 科学叙事 | good-story | 源码直用技能 | `view_truth_narrative`（六段张力结构+证据阶梯） |
| 图表数字化 | thu-digitizer | 源码直用技能 | `view_chart_digitize`（两阶段: 预检→坐标确认→CSV） |
| 引文三维核验 | citation-lab | 方法论移植 | `POST /api/citations/verify`（元数据真伪/语境相关性/断言支持度） |
| 论文分享链接 | frowang `/s/:token` | 模式借用 | `paper-share-service.ts`（分享链接 + 导入接收方文献库, 不复制论文） |

## 6. 科研工作台层（2026-09 新增）

| 工作台 | 前端视图 | 路由前缀 | 能力 |
|---|---|---|---|
| **研途写作舱** | `paper-outline`（Vue） | `/api/research`(106) + `/api/paper-outline`(4) | 六步阶段化研究（选题界定→框架设计→研究实施→文献与资料→章节写作→统稿定稿）· 素材/证据/假设/发现四本台账 · 证据块注入正文（数字取自库列不复述）· 正文数字核验 · 要件生成（摘要/关键词/结论/讨论）· 申报稿四类（开题/基金/伦理/预注册）· 降 AIGC 三档 · docx/pptx 导出 · 整包 ZIP 导出 · 中期检查/结项验收 |
| **课题流程编排** | `dag-workbench`（Vue） | `/api/orchestrator`(16) | 自然语言 → 可执行 DAG（LLM 生成 4-9 步枚举类型，强制首尾 goal/deliverable，再映射到真实能力 id）· 真 DAG 拓扑执行 · 单步执行 / 整条执行 / 暂停续跑(从 DB 快照重建) · 事件流回放（`orchestrator_run_events` 追加不覆盖，12 种事件，游标增量拉）· 7 个内置模板 · 成本量级预估 |
| **论文质量评审** | `review-lab`（Vue） | `/api/review`(23) + `/api/research/.../review-responses` | 分段审稿(1800-4000 字/段, 断线续传 + lease 心跳) · 逐维度评分卡(7 维 30 分制 → 聚合 0-100 + A+..D) · 原文批注(highlightText + type + dimension；可导出 Word/HTML) · 三档严格度 + 自定义要求 · 期刊库 80 本（`cjournal_journals` 并入，投稿须知可批量解析成规则）· 外部审稿意见逐条回应 + 回应信 · 录用后事务(版权/OA/校样) |
| **成果可视化工坊** | `plot-agent`（Vue） | `/api/viz`(16) | 对话式出图五段循环(plan→analyze_data→chart→critique→critique_fix ≤2 轮) · 期刊版式预设 6 档(nature-single/double, science-single, ieee-double, cn-core, slide) · 产物 PNG + SVG 双写 · 一键转素材(`kind='figure'`) · 长任务持久化 + 断线重放 · 无真实数据时明标"示意"水印 |
| **学术文本工作台** | `editor`（Vue） | `/api/editor/v1`(21) | 在线写稿(TipTap + docx 导入) · 版本链 + 回档 + content_hash 乐观锁 · 选区改写 7 模式(condense/de-template/polish/proofread/journal-style/humanize/expand) · 题名候选(5 个 + 推荐 + 理由) · 摘要/关键词生成 · 全文检查多档 · 引文检查(consistency/format) · AI Job 容器(SSE + 冻结积分) |
| **数据分析台** | `statistics`（Vue） | `/api/statistics-jobs`(9) + `/api/jupyter`(5) | 上传 CSV/Excel 真跑统计（独立 venv: pandas/scipy/statsmodels）· 17 种方法（描述/频数/分类/变换/筛选/t 检验/ANOVA/多元方差/相关/交叉表/非参数/正态/回归/logistic/信度/EFA/中介调节）· SSE 可恢复 + 取消/重试 · 结果一键写回正文(`kind='table'`) · Jupyter 单元执行（持久变量 + 图表回传） |
| **实证工作台** | `empirical-research` | `/api/empirical/*` | 问卷生成/识别/信效度(α/KMO)/诊断/LLM 插补/变量敲定/分析管道/回归(M1-M6)/证据账本/质量闸门 + 元分析 |
| **文献管理与入库** | `literature`/`imports`/`sciverse` | `/api/literature`(7) · `/api/zotero`(4) · `/api/rss`(3) · `/api/s3`(3) · `/api/ssh`(4) | 本地文献库扫描 + 知网/万方/维普浏览器代抓(CDP 借登录态) · Zotero 导入导出 + 浏览器插件 · RSS/arXiv 订阅 · S3 云同步(SigV4 手写) · SSH 隧道代理远程 API · 论文分享链接 |
| **写作语料库** | `corpus` | `/api/writing-corpus`(4) | 四大子库（文本范例/核心概念/论证逻辑/词汇句式）· 种子 25 条 · 三入口（手动/agent 沉淀/PDF 提取）· 写作时按模块召回注入 |
| **文档中心** | `docs` | `/api/docs` | 扫描 `docs/` 全量 **60 份**文档（11 组分类，未归类落「其他」；启动时扫一次）· 免鉴权白名单 · `test/docs-index.test.ts` 守卫（全覆盖/无死链/无僵尸条目） |
| **外部服务密钥** | 设置面板 | `/api/service-tokens`(5) | 密钥真源在 DB（`.env` 为初始值+兜底）· 到期日从 JWT 载荷解（解不开返回 null 不猜）· 现场校验打远端（日期 ≠ 事实）· 5 档状态 · 每天巡逻三档告警（日期/事实/校验失败，按日历日去重）· 仅本机可达(`LOCAL_ONLY_PREFIXES`) · 脱敏只出末 6 位 |
| **扫描件 OCR** | 写作舱/文献 | `/api/ocr`(5) | MinerU precision 模式（`ocr:true` 强制）· 语言默认 `ch` · 内存 Map + `ocr_jobs` 表重启恢复 · 每用户并发 2 · 异步 job（execFileSync 阻塞 600s 不能进 HTTP handler） |

### 6.1 统一文件原语：fileId → 纯文本

`src/services/file-text-service.ts` 的 `ensureFileText(userId, fileId, {force})` —— 把"我上传的这份文件正文是什么"变成一个可复用原语：

- 按后缀分派：文本类短路不碰磁盘 / pdf → pdfjs / docx → mammoth / xlsx → `scripts/xlsx2csv.py`
- **抽过就读库**（`user_files.text` 是缓存），没抽过才现抽并回填；失败也落库(`extraction='failed'`)
- **`needsOcr` 是核心输出**：抽不到 ≠ 没有正文，扫描件(`pageCount >= 3`)要把调用方送去 OCR 通道而不是抛错
- 迁移 164/165；`extraction` 记录来源(native/text-layer/mammoth/ocr/failed)
- 使用方：`GET /api/files/:fileId/text` · agent 工具 `view_file_text` / `ocr_file` / `view_ocr_job` · `review_job_create` 的 fileId 参数（审稿直投上传件）

## 7. AI+教育层（122 教育路由 + 39 学习引擎顶层）

| 模块 | 服务 | 能力 |
|---|---|---|
| 核心六能力 | `education-service.ts` | 学习规划/课程辅导/学情诊断/预习复习/备课/陪伴 |
| 自适应四层 | `adaptive-learning-service.ts` | 建模/画像/推送/节奏/分层 |
| 作业闭环 | `homework-help-service.ts` | 解析/错题/变式/答疑/批改 |
| 教师助手 | `teaching-assistant-service.ts` | 备课/出题/组卷/批改/讨论/测验/总结 |
| 教育编排 | `agent-education.ts` | 苏格拉底/五步打磨/想法卡/追问/策略校验 |
| 认知诊断 | `cognitive-diagnosis.ts` | BKT p(掌握) 推断 |
| 知识图谱 | `knowledge-graph-edu.ts` | 先修图 + 拓扑路径 |
| 自动闭环 | `auto-learning-loop.ts` | 采集→诊断→迭代→周报 |
| 思政审核 | `content-audit-service.ts` | 四维核验 + Compiled Truth 校准 |
| 学习引擎（13 服务） | `learning-*` / `learner-*` / `spaced-*` / `prerequisite-*` / `wiki-*` | 学习计划链 · 学习者状态机 · 学习证据 · 间隔重复 · 先修解析 · 知识页维护 |
| 多模态/合规/学生/语言/编程 | 5 服务 | 拍照/口语/板书 · 数据分级 · 认知维度/千人千策/复习提醒 · 精读润色 · 任务拆解/面试 |

教育能力走 agent 工具 `education_service` 统一路由暴露给对话，不另登记为编排能力端点（避免两套）。

## 8. 评测体系

- **RAGAS v3 评测**（`scripts/eval-32-metrics.ts`）：**31 项评分项 + overall**（A=12 / B=9 / C=3 / D=7），53 题金标集，基线综合分 **0.884**
- **教育评测**（`scripts/eval-education.ts`）：六项指标加权综合（BKT AUC 0.25 / 诊断 F1 0.25 / 路径逆序率 0.15 / 批改准确率 0.15 / 思政核验 0.10 / 闭环完成率 0.10）
- **记忆评测**（`scripts/eval-memory-recall.ts`）：Recall@5
- Kappa 校准门 ≥0.7；1293 项单元测试（Vitest）

## 9. 基础设施

| 组件 | 说明 |
|---|---|
| 后端 | Fastify 5，4173，982 路由注册 |
| 前端 | React 19 + Vite 8（外壳 49 视图）+ Vue 3.5 子应用（`/soc/`，18 个科研工作台视图） |
| 数据库 | PostgreSQL 16 + pgvector（Docker 5540）· Neo4j 11001/11003 · LanceDB |
| 桌面端 | Electron + NSIS（`electron-builder --win nsis`） |
| 模型 | DeepSeek 原生 + Embedding MAAS + Rerank（OpenAI 兼容协议），按角色可分别配置（reason/judge/review/verify/strategy/viz/editor） |
| 自动化 | Minion Job 队列（`MinionJobType` **22 型**，**18 个已注册 handler**）+ 定时巡逻 7 项（rss-refresh / agent-eval-suite / proactive-research / journal-sync / self-heal-patrol / service-token-patrol / task-patrol），均走 `withRunLease` 跨副本租约 |
