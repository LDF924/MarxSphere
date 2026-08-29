<p align="center">
  <img src="docs/assets/marx-logo-512.png" alt="MarxSphere" width="200" />
</p>

<p align="center">
  <a href="README-EN.md">English</a> · <strong>中文</strong> · <a href="https://ldf924.github.io/MarxSphere/">📚 文档站</a>
</p>

<p align="center">
  <a href="https://github.com/LDF924/MarxSphere/actions"><img src="https://img.shields.io/github/actions/workflow/status/LDF924/MarxSphere/ci.yml?branch=main&label=CI&logo=github" alt="CI" /></a>
  <a href="https://github.com/LDF924/MarxSphere/actions"><img src="https://img.shields.io/badge/tests-263%20passed-green" alt="Tests" /></a>
  <a href="https://github.com/LDF924/MarxSphere/blob/main/BENCHMARK.md"><img src="https://img.shields.io/badge/eval-0.884-blue" alt="Eval" /></a>
  <a href="https://github.com/LDF924/MarxSphere/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-blue" alt="License" /></a>
</p>

# MarxSphere 马研星环

**AI 驱动的教学科研一体化平台** — 一个 AI Agent 承载科研与教学全能力：科研端（文献检索、知识图谱、52 步推理、科研场景工作台、实证分析）+ 教育端（个性化学习规划、作业辅导、学情诊断、教师备课）。

教学与科研共用同一套知识体系与推理底座，数据互通。

基于事件中心检索结构（`chunk → event → entities`）构建：以事件为语义单元组织文献知识，通过多跳召回发现跨文献的概念演变与观点关联。

**RAG 架构**：SAG 事件中心混合检索增强生成 —— **SAG（事件检索）+ Graphiti（超边/社区）+ Cognee（HYBRID 切片）+ PG（向量/词法）四源融合**，配合 52 步推理链路实现可溯源、可审计的科研问答与个性化辅导。

---

## 功能总览

> 📖 **完整功能规格**：见 [docs/FEATURES-DETAILED.md](docs/FEATURES-DETAILED.md)（52 步推理逐步表 / 66 场景清单 / 44 工具矩阵 / 10 实证功能 / 桌面端细节 / 评测指标）

### 🏗 系统架构

![MarxSphere 系统架构](docs/assets/marxsphere-architecture.svg)

### 🖼 界面速览

| | | |
|---|---|---|
| **AI 对话**（默认首页） | **52 步推理** | **Ask 检索** |
| ![AI 对话](docs/assets/sag-assistant.png) | ![推理](docs/assets/sag-reason.png) | ![Ask](docs/assets/sag-ask.png) |
| **知识图谱** | **文献库** | **科研场景工作台** |
| ![图谱](docs/assets/sag-graph.png) | ![文献库](docs/assets/sag-literature.png) | ![场景](docs/assets/sag-scenarios.png) |
| **Agent 控制台** | **实证研究工作台** | **评测体系** |
| ![Agent](docs/assets/sag-agent-console.png) | ![实证](docs/assets/sag-empirical-research.png) | ![评测](docs/assets/sag-eval.png) |

> 全部 36 张视图截图见 [docs/assets/](docs/assets/)（33 个 tab + 子视图全覆盖）。

### 💬 AI 对话（默认首页）

> 进入系统即达的 AI 会话页，支持一句话调度系统全部能力。

- **会话管理侧边栏**：全部历史对话列表，支持新建（Ctrl+K）/ 重命名 / 删除 / 置顶，可折叠为图标窄条
- **消息流**：用户 / AI 气泡分区，AI 回复支持代码块语法高亮、KaTeX 公式、Mermaid 图表、chart JSON 可视化、引用来源徽章、工具调用折叠卡，长回复滚动浏览
- **思考过程**：DeepSeek 思考链（reasoning_content）独立固定块展示（DeepSeek 式「已深度思考」折叠区），实时滚动展开；思考强度三档可选（low / high / max）
- **Agent 工具循环**：LLM 自主规划 → 选择工具 → 执行 → 循环（≤12 轮，深度模式 20 轮）→ 流式回答；工具链面板展示每步（中文名 + 数据源 + 耗时 + 决策思考）
- **44 工具自主调度**：26 个 Agent 工具（检索/推理/实证/写作/代码/联网/图片/文件/**教育能力**）+ 18 个视图工具（政策库/知识页/文献库/图谱/任务/评测/告警等，33 视图能力全覆盖）——教育 Agent 对话中可直接调用 `education_service` 触发学习规划/辅导/诊断/备课等能力
- **命令语法**：`/` 弹出技能命令面板（190+ 个技能全量浏览搜索）；`@skill:技能名 任务` 加载技能执行；`@tool:工具名 任务` 强制指定工具
- **底部输入区**：多行输入（Enter 发送 / Shift+Enter 换行）、模型下拉切换（DeepSeek / Qwen 全系）、联网开关（web_search 注入）、深度模式开关（轮次 12→20）、思考强度三档、附件上传（图片/PDF/Word/Excel/PPT/文本，服务端解析文字注入 LLM）
- **图片视觉识别**：SenseNova 多模态模型（免费额度每 5 小时 1500 次），DeepSeek 纯文本模型经视觉桥接获得"眼睛"（配置 SENSENOVA_API_KEY 启用）
- **浅色 / 深色双主题**：header 一键切换，localStorage 持久化
- **空会话首屏**：欢迎语 + 热词建议（点击即问）+ 核心功能入口（Ask 检索 / 52 步推理 / 实证工作台）

### 🤖 AI Agent（50+ 能力项 · 44 工具 · 5 层安全 · 5 层记忆）

> 50 项 Agent 特性全部吸收。完整能力档案见 [docs/AGENT-CAPABILITIES.md](docs/AGENT-CAPABILITIES.md)。

**① 核心编排架构**

| 能力 | 实现 |
|---|---|
| 决策循环 | 规划 → 选工具 → 执行 → reflect → replan（最多 3 轮） |
| 协商修订 | 主管审阅工人产出 → 发修订指令 → 重新产出（确定性规则兜底） |
| 计划验证 | 缺 write/retrieve 步骤自动补齐；目标歧义先澄清（assessGoalClarity） |
| 计划确认 | 执行前展示计划，人工确认后才执行（`POST /tasks/:id/confirm-plan`） |
| checkpoint | 每轮落快照（loop/plan/failures），重启续跑（迁移 069） |
| token 预算 | 任务级 400K token 上限，超预算自动终止 |
| 任务 DAG | LLM 拆解子任务 → depends_on 依赖编排 → 队列并发（信号量）→ 进度 SSE |
| 失败处理 | 工具超时熔断（90s）→ 指数重试退避 → 失败回流 → 错误分类（可恢复/不可恢复） |

**② 工具矩阵（26 个 Agent 工具；另有 18 个视图工具，合计 44）**

| 类别 | 工具 | 工程特性 |
|---|---|---|
| 认知 | sag_reason / sag_retrieve / sag_search / sag_get_event / concept_trace / policy_search / review_output / summarize / llm_write | 并行执行、LRU 缓存（50 条/5min）、参数 schema 校验、分派追踪、fallback 链 |
| 行动 | empirical_analysis（实证真跑）/ run_code（3 级沙箱）/ run_command / apply_patch / file_read / file_write / web_search / web_fetch / sag_ingest / github_repo / runtime_exec | 超时熔断、降级链 |
| 多模态 | image_analyze（图片理解）/ audio_transcribe（音频转写） | 附件预处理压缩 |
| 协作 | agent_subagent（外部 Agent 派发）/ attachment_read / code_search / todo_update | 子进程治理（防孤儿） |

**③ 安全（5 层）**

1. **Guardian 策略文件**（可编辑热更新）——风险 × 授权 → allow / deny / review
2. **3 级沙箱**——read-only（禁网）/ workspace-write（预授权）/ full-access（白名单代理）
3. **网络审批**——SSRF 高危直接拒绝，白名单外域名需人工确认
4. **审批门**——高危工具四态（approve/edit/reject/respond）+ 自主级别（suggest/auto-edit/full-auto）
5. **凭证隔离**——凭据脱敏存储（sk-\*\*\*\*）、沙箱环境剔除 API Key

**④ 记忆（5 层）**

- **情景记忆**：研究轨迹，可检索遗忘
- **战略记忆**：项目目标约束注入
- **技能蒸馏**：EDV 评审（含工具用法），自动沉淀新技能
- **防错规则**：用户反馈/评测失败自动沉淀（负评转规则）
- **语料库**：四大子库（文本/概念/逻辑/句式），Agent 写作自动注入

**⑤ 调度与运维**

- 队列并发（优先级 enterprise/pro/free）+ DAG 依赖
- 会话恢复（前缀锚点 + 跨会话检索）
- 设置持久化（预设/自主级别/沙箱级别落库 + 启动恢复）
- 诊断面板（LLM 并发/队列/SSE/内存/子进程）
- hooks 生命周期（7 事件：注册/注销/超时隔离）
- **主动研究**：每日自主巡检（失败任务/评测回退/热点 → 新研究任务）
- **反馈闭环**：👍👎 → 防错规则 + 记忆回流
- 通知（完成告警 + toast）+ 自省报告 + 失败恢复建议

**⑥ Agent 评测**

- 回归评测集（gold 任务 + 故障注入：429/超时/降级）
- 24h 自动回归 + 通过率告警
- 轨迹级指标：计划遵循度 / 工具准确率 / 推理质量（judge 打分）
- 学习曲线 + 成本审计（token 实时统计）

**⑦ 学习闭环**：反思 → 归因 → 最小 diff 补丁 → bad case 回流 → 评测再验证（V294-V297 全打通）

**⑧ 工程加固（Agent 可靠性 4 件套）**

| 能力 | 实现 |
|---|---|
| **引文核查**（citation-service.ts） | 本地文献引文提取与验证（原文级溯源，防伪造引用） |
| **分层上下文压缩**（context-compressor.ts） | 五层组合：工具结果预算控制 → 噪声删除 → API 层微压缩 → 归档式摘要 → 全量压缩；80% 阈值触发 + 批量压缩 + [COMPRESSED] 防重复标记 |
| **故障分类学**（error-recovery-map.ts） | 分类规则 + 恢复策略映射；核心原则："第一判断不是要不要重试，而是值不值得重试"（纯函数可单测） |
| **熔断器**（circuit-breaker.ts） | 每条恢复路径独立熔断 + 终止上限 + 死亡螺旋防护（错误路径禁用会再次调用模型的副作用逻辑） |

### 🧠 推理与检索

**52 步深度推理链路**（`推理` 视图）
- 全链路可展开：问题分类 → 意图识别 → 术语变体 → 拆分子问题 → 实体抽取 → Cognee 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈
- 每步可视化：当前步骤高亮、token 消耗实时显示、检索来源可追溯
- 支持 template / adaptive 两种推理模式，条件触发（子问题并行、时序分析、PG 实体补漏）

**Ask 18 步检索流水线**（`Ask检索` 视图）
- 多臂召回：向量化 → 别名消解 → 实体抽取 → 实体/关系召回 → 事件关联 → 标题向量 → 多查询变体 → 图遍历
- 融合排序：加权 RRF → Cosine 重打分 → Boost 链 → 去重 → LLM 重排 → 回取切片
- 答案带编号引用，点击回看原始切片；右侧 18 步流水线逐步点亮
- **与 52 步推理的关系**：两者共用同一四源检索内核（SAG 事件 + Graphiti + Cognee + PG）。Ask 是**轻量快速检索**（18 步 ≈ 10 秒级），52 步是**深度推理**（含假设生成/自评自愈/Agentic 搜索，≈ 230 秒）——同一问题可用 Ask 快速预览、52 步深入论证

**三库知识图谱**（`图谱` 视图）
- Graphiti：501 篇文献蒸馏、21,337 实体、1,085 知识社区、11,702 超边关系
- Cognee：31,253 实体、248,417 关系、11,550 切片（Neo4j 11003）
- PG pgvector：7,550 切片向量（1024 维）+ 全文检索
- 图谱可视化：实体/事件节点拖拽、缩放、点击展开、双击详情

**17 种检索策略**：HyDE / 实体提升 / 关键词加权 / 事件扩展 / 时序分析 / 概念搜索 / 文献蒸馏等

### 🔬 52 步推理链路完整架构（SAG + Graphiti + Cognee + PG 四源 + 超边知识层）

**核心定位**：事件中心的多源混合检索增强生成（Multi-Source Hybrid RAG），超越 HyperGraphRAG 的超边知识层。

**四源检索**：

| 检索源 | 内容 | 代码依据 |
|---|---|---|
| **SAG 事件检索** | 事件中心结构（chunk→event→entities）、图遍历 2 层展开、SQL 递归多跳、RRF 三臂融合（内容向量/标题向量/BM25） | `search-service.ts` |
| **Cognee** | HYBRID_COMPLETION 论文切片召回（17 路粗检索：向量/词法/图遍历/三元组/摘要/子问题/时序/实体直查…） | `inference-service.ts` stage2 |
| **Graphiti** | 实体精炼 / 概念搜索 / 文献蒸馏 / 领域知识 / 实体邻居 / 段落回溯 / 论文溯源 / DeepWalk / 关系查询 | `inference-service.ts` stage3 |
| **超边知识层**（V166+，超越 HyperGraphRAG） | 超边向量检索 / 超边实体导向 / 超边 BM25 / 三路 RRF 融合 / 时间衰减 | `inference-service.ts` stage3.5 |
| **PG pgvector** | 向量 1024 维 + CHUNKS 词法 + 全文检索 + SQL 多跳 | `inference-service.ts` stage2/4 |

**52 步完整链路**（template 模式；adaptive 模式由 LLM 动态选算子）：

```
Stage 0-1 分类+大纲（4步）: 问题分类 → 意图识别 → 术语变体 → 拆分子问题
Stage 2   Cognee 粗检索（14步）: 实体抽取 → Cognee HYBRID → RAG补全 → 图遍历
          → 关系三元组 → 摘要检索 → 子问题推理 → 上下文扩展
          → 时序分析(触发) → PG实体补漏 → PG向量 → CHUNKS词法 → 语义检索 → 实体直查
Stage 3   Graphiti 精炼（9步）: 实体精炼 → 概念搜索 → 文献蒸馏 → 领域知识 → 实体邻居
          → 段落回溯 → 论文溯源(触发) → DeepWalk扩展(触发) → 关系查询(触发)
Stage 3.5 超边知识层（5步, V166+）: 超边向量检索 → 超边实体导向 → 超边BM25
          → 三路RRF融合 → 时间衰减
Stage 4   融合生成（20步）: Compiled Truth → 多查询变体 → HyDE扩展(触发) → 意图调配额
          → 三臂RRF → Cosine重打分 → Boost链 → 超边配额(触发) → LLM重排 → 压缩段落
          → COT推理(触发) → Agentic搜索(触发) → 生成假设 → 自评校验 → 置信评估
          → 溯源标注 → 回写知识页(触发) → 失败降级(触发) → 快速回退(触发) → 响应返回
```

**融合链路**：多臂召回 → 加权 RRF（意图调 k + Compiled Truth ×2.0 boost）→ Cosine 重打分 → Boost 链 → 去重 → LLM 重排 → 回取切片 → 生成（带编号引用溯源）。

**21 个可消融算子**：检索栈 12 个（compiled_truth/title/cosine/dedup/alias/relational/expansion/graph_traversal/multi_query/rerank 等）+ 推理链路 9 个（outline/expand/candidate_papers/cognee_arm/graphiti_arm/pg_arm/entity_extract/hypothesis/evaluate）——消融实验可逐项验证各组件贡献。

**推理模式**：template（固定 52 步，评测基线口径）/ adaptive（LLM 动态选算子，短问题 4-6 步快速回答）。

### 📚 科研场景工作台（66 场景 · 8 大阶段）

**完整场景清单（S01-S66，每个场景含业务描述 + 能力徽章 + 分步引导 + 全屏工作台）**：

| 阶段 | 场景（S 编号） |
|---|---|
| **选题构思**（S01-S10） | 研究方向生成 / 科学头脑风暴 / 研究设计规划 / 开题报告规划 / 文献综述 / 系统性文献检索 / 外部学术检索 / 研究证据包 / 论文对比矩阵 / 引文溯源 |
| **文献调研**（S11-S20） | 文献关系图谱 / 政策文本检索 / 科学问答（RAG）/ 多跳推理链 / 教学与科研答疑 / 全文证据查找 / 研究方向趋势扫描 / 计量实证分析 / 因果推断 / 宏观经济建模 |
| **数据分析**（S21-S30） | 统计推断与检验 / 学术论文写作 / 文献综述写作 / 论文润色与改写 / 引用管理 / 科研图表设计 / 可视化与幻灯片 / 同行评审模拟 / 投稿前检查 / 审稿意见回应 |
| **论文写作**（S31-S40） | 基金申报 / 外部文献入库衔接 / 知识库自动化 / Obsidian 资料管理 / 文档管理 / 核心概念溯源与语义演变 / 文本论证结构拆解 / 多文本互文对照 / 晦涩文本阐释辅助 / 版本校勘与文本差异 |
| **理论思辨**（S41-S50） | 学派脉络全景梳理 / 核心观点对比分析 / 学术争鸣脉络还原 / 学者思想谱系构建 / 学科前沿动态追踪 / 研究问题凝练与空白识别 / 研究框架与论证结构设计 / 论证链条补全与逻辑校验 / 研究方法适配建议 / 反方视角与反驳意见生成 |
| **论文产出**（S51-S60） | 高质量文献综述生成 / 学术段落扩写与润色 / 规范化学术要件生成 / 引文与参考文献格式化 / 多场景语体适配 / 概念一致性校验 / 引文准确性核查 / 逻辑自洽性检查 / 学术不端风险提示 / 格式规范适配 |
| **理论拓展**（S61-S66） | 理论前提反思 / 跨学科视角拓展 / 理论与现实联结 / 理论创新点识别 / 理论体系建构 / 政经C刊选题 |

**每个场景** = 业务描述 + 独有能力徽章 + 动作（跳转推理/Ask/技能/知识页）+ 全屏工作台（输入 → 算法执行 → 输出），分步引导含具体工具指引（如 S01：推理工作台 → research-ideation 技能 → idea-evaluator → Ask 检索 → 推理验证 → 知识页沉淀）。

政经 C 刊科研方法论：四步法选题 / 选题矩阵 / 悖论选题 / 概念命名 / 跨学科 / 模板检测 / 编辑校验 / 外审翻译 / 期刊匹配（80 本马理论期刊库）

### 🎓 领域研究引擎（经典文本 / 学术研究 / 政经C刊 / AI+教育）

**经典文本研究**（S36-S40，`classical-text-service.ts`）——马理论文本研究专用 5 大能力：
- **概念溯源**：核心概念的历史演变追踪（semanticDrift 语义漂移检测）
- **论证结构拆解**：论点/论据/推理链自动标注（alignParagraphs 段落对齐）
- **互文对照**：跨文本段落级相似对照（lcsDiff 最长公共子序列）
- **晦涩文本阐释**：难句/概念逐层解读
- **版本校勘**：不同版本文本差异比对
- 专属算法（lcsDiff/alignParagraphs/semanticDrift）纯算法实现，**不消耗 LLM token**

**学术研究**（S41-S45，`academic-research-service.ts`）——学术全景 5 大能力：
- **学派脉络全景**：学派发展脉络梳理
- **核心观点对比**：不同学者观点对照（观点聚类算法）
- **学术争鸣还原**：争鸣事件时间线还原（争鸣时间线算法）
- **学者思想谱系**：师承关系链构建（师承关系提取算法）
- **学科前沿动态**：研究热点与前沿识别（高频词统计）
- 复用：检索（ILIKE+embedding）+ entities 图谱 + LLM 归纳

**政经 C 刊科研**（S66，`cjournal-service.ts`）——基于八篇马理论 C 刊选题方法论整合：
- **四步法选题**：时代问题 → 政经对象 → 经典理论 → 中间机制（理论接口映射表）
- **选题矩阵**：核心概念 × 关系对象 交叉生成选题
- **悖论选题**：悖论式命题生成
- **编辑三标准校验**：选题价值/创新性/可行性自动评估
- **期刊匹配**：80 本期刊库（南核 67/C扩 9/北核 4）自动推荐
- **2026 布局种子库**：预置年度选题方向

**AI + 教育**（112 教育路由 + 32 学习引擎顶层，`education-service.ts` 等 19 服务）——教育 Agent 工作台（顶部「AI+教育」Tab，学生端/教师端双角色），深度联动 52 步推理链路：
- **六大核心能力**：个性化学习规划 / 课程辅导（分步提示非给答案）/ 学情诊断 / 预习复习 / 教师备课 / 学习陪伴
- **教育专属 Agent 闭环**：苏格拉底式提问 / 阶梯式启发 / 错题-知识点联动 / 学习进度追踪 / 五步打磨（记录→发散→验证→聚焦→压力测试）/ 想法卡 / 步骤追问
- **作业辅导闭环**：题目解析（4 模式）/ 错题归集 / 变式生成 / 作业批改 / 错题报告 / 课堂讨论 / 随堂测验 / 课堂总结
- **教育专属技术**：BKT 认知诊断（p(掌握) 推断）/ 知识点先修图 + 拓扑路径规划 / 思政内容四维核验 + Compiled Truth 权威校准
- **端到端自动闭环**：自动采集 → 自动诊断 → 自动迭代 → 自动验证周报
- **教育多模态**：作业拍照识别 / 口语测评 / 板书识别
- **教育复用资产**：场景模板 / 教学案例库 / 示例课程 / 外部资源源（学校资源库/公开平台接入），按角色空间隔离
- **教育反馈闭环（V397）**：学生/教师端右下角反馈浮标（赞/踩+备注）→ `edu_feedback` 表 → 满意率/负评热点统计 → 自动改进建议（低分指标 + 负评驱动）
- **教育评测 12 项指标（V397）**：技术 6 项（BKT AUC / 学情诊断 F1 / 路径无逆序 / 批改准确率 / 思政核验 / 闭环完成率）+ 教学效果 6 项（掌握度提升 / 辅导前后对照 / 备课效率 / 批改效率 / 规划覆盖率 / 用户满意度）——评测工作台可视化 + 自动改进建议
- 实现：52 步推理链路 + 四源检索 + 引用溯源 + 记忆注入；AI 对话可一句话调用（`education_service` 工具 83 动作）

**自适应学习系统**（V384，`adaptive-learning-service.ts`）——四层能力：
- **学情建模**：答题历史 → 知识点掌握度（已掌握/模糊/未掌握），平滑更新
- **自适应内容推送**：薄弱点 → 微课/例题/拓展；学有余力 → 拔高
- **节奏适配**：按掌握度调整习题难度/时长（避免简单重复/难度过载）
- **分层教学**：同一知识点按水平输出不同版本讲解（基础/进阶/挑战）

**学习引擎**（V386-V393，借鉴 TraitTutor 源码移植，[docs/LEARNING-ENGINE.md](docs/LEARNING-ENGINE.md)）——证据驱动的自适应学习闭环：
- **学习者事件账本 + BKT 概念掌握**：append-only 账本 + 强证据闸门（仅服务端判分更新 BKT）+ 诚实读（未校准不显示数字）+ 时间衰减读投影 + 离线校准脚本
- **版本化学习计划链**：只重规划未开始尾部（已开始前缀不可变）+ supersede 审计链 + 组件状态机
- **确定性组件选择器**：BKT 四阶段分支（目标地图→概念讲解→起点判断→引导练习+校准→迁移挑战→主动回忆）
- **材料分析快照**：学科/难度/概念候选/页证据/模态适配 + augmentation 补充决策
- **产物审查三态机 + 一材多工件**：needs_review→确认→挂载（课程/抽认卡/测验共享学习包），答案服务端持有
- **间隔重复复习队列**：4 类知识间隔序列 + 跳档/退档/重置 + 错误未修复优先
- **Compass 记忆治理**：偏好三态 + 90 天 TTL + 候选确认门 + 删除即重建
- **学习意图双层路由 + Quota Rotation 网关 + 组件白名单**
- **全屏学习画布**：路径/组件/"为何此步"证据同屏；E9 学习引擎面板 + 产物中心
- AI 对话一句话调用（`education_service` 工具新增 plan-chain/intent/material-analyze/pref-*/reviews-* 动作）

### 🖥 桌面端（Electron + NSIS）

- 单进程架构：`node dist/src/index.js` 同时服务 API + 前端（零额外依赖）
- 首次启动全量引导：一键启动 PostgreSQL（**有 Docker 用 Docker，无 Docker 自动装本地 PostgreSQL 便携版**）/ Neo4j 检测 / Python 系统探测 / LLM 密钥配置
- 自动端口避让（4173→4183）、崩溃自动重启、进程树清理（taskkill /T）
- 依赖自解压：node_modules.zip 首启自动解压（Expand-Archive 优先 + 递归容错，干净环境不再失败）

### 🎯 实证研究工作台（10 大功能）

**端到端工作流**：`数据上传 → 问卷生成/识别 → 信效度检验 → 诊断 → LLM 插补 → 变量敲定 → 分析管道 → 回归建模 → 证据账本 → 质量闸门`

| 功能 | 细节 |
|---|---|
| 问卷生成 | 主题 → 结构化问卷（变量名/题型/选项编码表自动生成，最多 120 题） |
| 问卷识别 | 导入已有问卷文本 → 结构解析 |
| 信效度检验 | Cronbach's α / KMO / Bartlett 球形检验 |
| 问卷诊断 | 题项质量分析、问题检测 |
| LLM 插补 | 论文复现级缺失值处理（三分类插补：数值/分类/文本） |
| 变量敲定 | 反 hallucinate 白名单 + 坐标读系数 |
| 分析管道 | 描述统计 → 相关分析 → 回归建模 |
| 回归分析 | OLS 渐进控制（M1-M6）/ 面板回归 / Logit-Probit 二值模型（系数表 + 95%CI + 边际效应 + R²） |
| 证据账本 | 每次分析留痕（数据/代码/结果），可复现 |
| 质量闸门 | 发布前质量检查 |

**技术实现**：Python 沙箱执行（`empirical_runner.py` 多脚本委托分发：信效度/插补/数据管道/回归/诊断），300s 超时保护，结果含 LaTeX 表格 + SVG 系数图。

### 🏛 政策与资料

- **政策库**：本地政策目录树浏览 + **gov.cn 实时检索**（经 gov-cn-policy MCP：`get_latest_policies` 检索 + `get_policy_fulltext` 抓正文，一键存入本地政策库）
- **资料库**：Obsidian 课题库浏览（目录树 + md/PDF/图片/Office 内联预览 + 下载）
- **知识页**：Compiled Truth（最佳理解，可人工重写）+ 时间线（证据轨迹，只追加）
- **记忆管理**：记忆统计卡（总数/归档/冲突/向量化）+ 最近记忆列表 + 睡眠学习报告（10 秒轮询）
- **写作语料库**：四大子库（文本范例 / 核心概念 / 论证逻辑 / 词汇句式），支持粘贴积累 + LLM 辅助提取 + 打标签检索 + 写作前调取
- **学术期刊库**：80 本马理论期刊（南核 67 / C扩 9 / 北核 4），级别筛选 + 热点展开 + 一键填入选题四步法

### 🛠 自研 Skill 体系（10 个，全部开源）

MarxSphere 的 10 个自研 Skill 已随仓库开源（`skills/` 目录），覆盖"文献获取 → 转换 → 清洗 → 入库 → 检索 → 推理 → 科研调度"全流水线：

| Skill | 功能 | 在流水线中的位置 |
|---|---|---|
| **cnki** | 知网批量下载（PDF + 引文网络：参考文献/引证/共引/同被引）| ① 文献获取 |
| **pdf2obsidian** | PDF 批量转换 Obsidian（1化6：original/摘要/术语表/问答/index/信息 + MinerU 集成）| ② 转换 |
| **md-clean** | 论文 MD 清洗（6化4：裁剪 frontmatter、剔除 index/信息文件）| ③ 清洗（入库准备） |
| **marx-ingest-all** | 三库一键入库（PG + Graphiti + Cognee 同步）| ④ 入库 |
| **marx-cognee-ingest** | Cognee 批量入库（30 篇/批、断点续传、完整性校验、成本估算）| ④ 入库 |
| **marx-graphiti-ingest** | Graphiti 批量入库（6 阶段：实体抽取/蒸馏/向量化/消歧/超边，原子 checkpoint + 34 坑审计）| ④ 入库 |
| **marx-cognee** | Cognee 知识图谱检索（17 种策略：HYBRID/语义/图遍历…）| ⑤ 检索 |
| **marx-graphiti** | Graphiti 知识检索（五层蒸馏 + 社区发现 + 超边推理，23 个 MCP 工具）| ⑤ 检索 |
| **marx-sag** | SAG 推理工作台（52 步链路 + token 采集 + 评测，30 题均值 0.870 基线）| ⑥ 推理 |
| **marx-agent** | Agent 总入口（52 步推理 + Ask 检索 + 66 场景 + 190+ 技能统一调度）| ⑦ 科研调度 |

**流水线全景**：`cnki 获取 → pdf2obsidian 转换 → md-clean 清洗 → marx-*-ingest 三库入库 → marx-cognee/marx-graphiti 检索 → marx-sag 推理 → marx-agent 调度`

**技能系统（Web 端）**：技能注册表（约 190+ 项动态扫描）+ 触发词 + Skillify 固化 + 自动更新检测 + GitHub 发现。

### 📊 评测体系（多源融合的实证验证）

**评测方法**：双轨评测（规则评分 + LLM judge 三轮回合取中位数）、53 题 4 类题型（概念定义 15 / 事实检索 13 / 多跳推理 14 / 政策评估 11）、31 评分项 + overall。

**31 项指标**（[完整定义](docs/SCORING_STANDARD.md)）：

| 维度 | 指标 | 权重 |
|---|---|---|
| A 检索质量（12） | context_recall / precision / relevancy / entity_utilization / mrr / ndcg / diversity / cross_doc_coverage / json_contamination / **paper_hit / paper_recall@k / source_grounded** | 0.40 |
| B 答案质量（9） | correctness / completeness / relevancy / faithfulness / hallucination_rate / consistency / citation_f1 / conciseness / readability | 0.35 |
| C 推理质量（3） | cot_quality / reasoning_depth / multi_hop_accuracy | 0.25 |
| D 性能（7） | 3 段延迟 / 端到端 / token 效率 / Neo4j+PG 查询数 | 观测 |

**53 题评测分数**（`evaluation/eval_32metrics.json` + `perq.json` 每题明细）：

| 指标 | 分数 |
|---|---|
| **overall 综合** | **0.884** |
| A 检索质量 | 0.795 |
| B 答案质量 | **0.985** |
| C 推理质量 | 0.886 |
| 通过率 | **53/53（100%）** |
| 最高/最低 | Q40 概念定义 0.965 / Q39 政策评估 0.753 |

**多源融合的实证（为什么四源缺一不可）**——53 题实际检索贡献分布：

| 检索源 | 贡献占比 |
|---|---|
| **Graphiti**（实体/蒸馏/段落） | **37.4%** |
| **PG**（向量/实体补漏） | **36.7%** |
| **Cognee**（切片/粗检索） | **22.8%** |
| 论文定位 | 3.1% |

> **结论**：单一检索技术最多只能覆盖约 1/3 的检索需求——纯向量 RAG 会丢失图谱关系（37%），纯 GraphRAG 会丢失切片级语义（23%），纯词法检索会丢失向量语义（37%）。**只有 SAG 事件结构 + Graphiti 超边 + Cognee 切片 + PG 向量四源融合，才能达到 0.884 的综合分**。这是整个科研工作台的基石——正是基于如此强大的知识检索增强，才能出色完成 66 个科研场景的各类学术任务。

**Agent 轨迹评测**：计划遵循度 / 工具准确率 / 推理质量（judge 打分）+ 学习曲线
**学习引擎**：显著性 / 归因 / 轨迹前缀 / 校准（kappa=1.0）/ 模型替换基建
**消融体系**：21 个可消融算子（检索栈 12 + 推理链路 9），`scripts/ablation-eval.ts` 可逐项验证组件贡献
**单元测试**：263 项全绿

---

## 快速开始

> 🚀 完整部署（Docker / systemd / Nginx / 故障排查）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

### 1. 环境要求
- Node.js ≥ 20
- PostgreSQL 16 + pgvector（**有 Docker 用 Docker：`docker compose up -d`；无 Docker 自动装本地 PostgreSQL**——`npm run deploy` 或桌面端引导页自动处理）
- （可选）Python 3.12 + venv（推理 MCP 池 / 实证分析）
- （可选）Neo4j（Graphiti 11001 / Cognee 11003，图谱增强）

### 2. 安装与初始化

```bash
git clone https://github.com/LDF924/MarxSphere.git
cd MarxSphere
npm run deploy          # 🚀 一键部署：自动装 Node → 起数据库（有 Docker 用 Docker，无 Docker 自动装本地 PostgreSQL）→ 装依赖 → 迁移 → 种子数据 → 启动 http://localhost:4173
```

> 或者手动分步：`cp .env.example .env`（填入 LLM/Embedding Key）→ `npm install` → `docker compose up -d`（无 Docker 用 `node scripts/deploy.mjs` 自动装本地 PG）→ `npx tsx src/db/migrate.ts` → `npm start`
> 完整说明见 [部署指南](docs/DEPLOYMENT-GUIDE.md)（含 Windows 虚拟机测试方法）

> **PDF2Obsidian（可选）**：`cd vendor/pdf2obsidian && pnpm install && pnpm -r --filter "./packages/**" build && cd ../..`

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

### 数据源配置（文献库 / 政策库 / 资料库）

三个「库」页面读取的是**本地文件夹**（递归扫描 PDF/MD 文件），通过环境变量指定路径——**不需要安装 Obsidian**，指向任意本地文件夹即可：

```env
# 文献库：学术期刊 PDF 目录（按主题分子目录更佳，扫描后标记已入库）
LITERATURE_DIR=D:\我的文献\学术期刊
# 政策库：政策/著作文档目录（任意目录树）
POLICY_DIR=D:\我的文献\政策资料
# 资料库：文档库根目录（目录树浏览 + 内联预览）
VAULT_ROOT=D:\我的文献
```

> **说明**：
> - **未配置时**默认扫描 `~/1.Obsidian Vault`（开发者本机路径）——不存在则页面为空，但 **Ask 检索 / 52 步推理不受影响**（用仓库自带种子语料）

### 📚 种子语料（clone 即体验检索）

仓库自带 **50 篇评测金标同源文献**（`examples/seed-corpus/`，1化6 产物：全文+摘要+术语表+问答），无需任何私有文献即可体验四源检索：

```bash
npm run quickstart        # 启动服务后
npx tsx examples/seed-corpus/ingest-seed-corpus.ts   # 一键入库 50 篇
# 然后 Ask 检索 / 52 步推理即可检索这批语料
# 可用 evaluation/gold_dataset.json 的 53 题金标验证检索质量（npx tsx scripts/eval-32-metrics.ts）
```

> 语料为公开学术期刊论文（含出处），仅用于功能演示；若持有其中某篇版权需移除，请在 Issue 说明。
> - **推荐结构**：文献库下按主题分子目录（如 `资本下乡/`、`乡村振兴/`），每个 PDF 命名 `标题_作者.pdf`
> - **Obsidian 可选**：配合 `pdf2obsidian` 技能将 PDF 转 Markdown 后浏览；不装也能直接用 PDF
> - 完整路径变量见 `.env.example` 底部说明

---

## 核心能力一览

| 能力 | 说明 |
|---|---|
| 🧠 **52 步推理链路** | 问题分类 → 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈 |
| 🔍 **Ask 18 步检索** | 多臂召回 → 加权 RRF → LLM 重排 → 带编号引用溯源 |
| 🗄 **四源检索** | SAG 事件 + Graphiti 超边/社区 + Cognee 切片 + PG 向量/词法，RRF 融合 |
| 🤖 **AI Agent** | 29 工具自主调度（含 Notebook 图表模板/桌面控制）/ 5 层安全 / 5 层记忆 / 任务 DAG / 审批门 |
| 📚 **科研场景** | 66 场景 × 8 大阶段，全屏工作台 + 专属算法 |
| 📊 **实证工作台** | 问卷生成 → 信效度 → 插补 → 回归（M1-M6）→ 证据账本 |
| 📓 **Notebook 工作台** | 轻量 Jupyter：代码/Markdown 单元格 · 9 种图表模板（三线表/热力图等）· 文件上传 · Restart & Run All |
| 📡 **IM 接入** | 飞书 / 钉钉 / Telegram 机器人远程对话（状态/项目/评测/审批/告警） |
| 🖥 **Computer Use** | 桌面控制：截屏 / 鼠标 / 键盘 / 窗口列表（Agent 可看屏幕操作） |
| 🔀 **模型中立** | DeepSeek / OpenAI / Anthropic Claude / Ollama / 自定义端点自动识别 |
| 🔐 **哈希版本化** | 文献内容判重 · 评测数据指纹 · stale 判定 · 版本历史表 · 数据画像 |
| 🖥 **桌面端** | Electron + NSIS 安装包，首次启动全量引导 |
| 📈 **评测体系** | 53 题双轨评测 0.884 / 177 单测 / 消融 21 算子 / CI+E2E |

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
src/                 后端源码（AI/API/服务/数据库）
web/                 前端源码（33 视图 · Mega Menu 导航）
electron/            桌面端主进程 / 引导页
scripts/             Python runner / 评测脚本 / 工具脚本 / 启动脚本
evaluation/          评测资产（评测结果 / 金标集 / 历史归档）
reports/             评测报告（7 份）
knowledge-graph/     知识图谱数据（实体/映射/规范化字典）
docs/                文档（架构 / 规格 / 披露 / 使用说明）
migrations/          PostgreSQL schema（80+ 迁移）
plugins/             Agent 插件目录
test/                单元测试（263 项）
vendor/              第三方组件（pdf2obsidian）
data/                运行时数据（金标候选等）
```

## 测试

```bash
npm test                # 263 项单元测试
npm run typecheck       # 前后端类型检查
```

## 致谢（AI 辅助开发声明）

本项目由邓富（LDF924）开发。开发过程中使用 **DeepSeek**（LLM 推理/代码生成）与 **Claude Code**（AI 编码代理）辅助编写、审查与调试代码。AI 生成的代码均已由开发者人工审查、测试与验证（263 项单元测试全绿，53 题评测 0.884）。

## License

**AGPL v3 + 商业授权双许可**（保留 Logo、衍生开源、商用需授权）——见 [LICENSE](LICENSE)。

## 合规披露

📋 [开源合规披露](docs/OPEN-SOURCE-DISCLOSURE.md) — 完整披露：运行依赖 / 风险提示（模型幻觉、数据缺失、接口异常）/ 商业 API 使用与费用 / 闭源模型与替代方案 / Agent 框架 / 多模态能力 / 运行验证 / **数据治理（数据来源与授权、知识库构建与错误处理、用户数据脱敏与删除、Agent 上下文与记忆管理）**。

> 📦 **第三方源码使用声明**：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（SAG 底座 MIT / GBrain MIT / PDF2Obsidian MIT / Codex·DeepSeek·wisp 借鉴 / Cognee·Graphiti·OpenViking 集成）。

> ⚠️ **重要提示**：本系统依赖商业 LLM/Embedding API（按 token 计费），所有 AI 生成内容**可能产生幻觉**，研究结论须核验原始文献。详见 [披露文档](docs/OPEN-SOURCE-DISCLOSURE.md) 第 2、4、5 节。

## 文档与可验证材料

| 材料 | 位置 |
|---|---|
| 📘 项目概述（目标用户/痛点/功能/Agent思路/技术路线/创新/价值） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) |
| ❓ 常见问题（FAQ） | [docs/FAQ.md](docs/FAQ.md) |
| 📘 使用说明（环境/部署/权限/流程/样例/输出/注意） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) 第 2 节 |
| 📘 技术架构（模型/Agent/工具/RAG/上下文/工作流/数据流/架构图） | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) 第 3 节 |
| 📘 合规披露（数据/风险/商业API/闭源模型） | [docs/OPEN-SOURCE-DISCLOSURE.md](docs/OPEN-SOURCE-DISCLOSURE.md) |
| 🔧 接口文档（HTTP API / MCP） | [docs/api-reference.md](docs/api-reference.md) / [docs/agent-api.md](docs/agent-api.md) |
| 🖥 桌面端安装包 | `npm run build:desktop` → `release/MarxSphere Setup <ver>.exe` |
| 🐳 数据库容器 | `docker compose up -d`（pgvector/pgvector:pg16） |
| 📊 运行截图 | [docs/assets/](docs/assets/)（首页/对话/推理/Ask/文献/图谱/场景/实证/Agent/评测 10 张） |
| 📈 评测报告样例 | `reports/`（7 份报告）· `evaluation/`（评测结果+金标+历史归档） |
| ✅ 单元测试 | `npm test`（263 项） |
| 🎬 演示脚本 | `scripts/demo-ingest.ts` / `demo-search.ts` / `demo-agent.ts`（命令行演示）· `examples/`（同批示例）· `plugins/demo-calculator.ts`（插件示例）· 前端 `ask-demo` / `reason-demo` / `learning-demo`（界面演示数据）|
| 📄 示例数据 | 问卷：`scripts/问卷演示数据*.csv`（seed=42）· 检索：`examples/seed-corpus/`（50 篇种子语料）· 评测：`evaluation/gold_dataset.json`（53 题金标）· 图谱：`knowledge-graph/` |
| 🕸 知识图谱数据 | `knowledge-graph/`（实体映射/规范化字典） |
