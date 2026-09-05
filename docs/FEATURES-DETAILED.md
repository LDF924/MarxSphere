# MarxSphere 功能规格详解

> 本文档是 MarxSphere 的完整功能规格说明。所有功能均已在 Web 界面（41+ 视图）或桌面端实现并验证。

---

## 〇、产品定位（核心问题 · 创新点 · 目标用户）

### 核心问题 / 痛点

高校教学与科研相互割裂、且都缺乏 AI 工具支撑：

- **教学端**：个性化学习规划、作业辅导、学情诊断、教师备课等教育场景缺乏 AI 工具支撑；
- **科研端**：文献检索难（海量文献跨库的概念演变、观点交锋、理论继承难以发现）、研究链路难（选题、调研、论证、写作缺乏领域化方法论工具）、实证落地难（问卷设计、信效度检验、回归分析等统计建模门槛高）。

教与研共用同一套知识体系，却互不打通、各缺工具。

### 创新点

1. **教学科研一体化底座**——教育 Agent 直接复用科研级推理（52 步可解释链路）与四源检索，学生辅导用科研级知识、教师备课用研究级文献，教学与科研数据互通；
2. **知识底座可迁移**——同一套「文献入库 → 知识图谱 → 教学路径」管线，换文献即换学科领域，覆盖人文社科各方向；
3. **四源异构融合检索**——SAG 事件（主知识轴）+ Graphiti 超边（跨文档关联）+ Cognee 切片（段落级）+ PG 向量（领域切片）四源异构，RRF 融合 + 领域加权，各源分工明确而非堆砌；
4. **可审计推理**——52 步推理每步带检索来源与真实 token 消耗，回答可溯源到文献，非黑箱。

### 目标用户

| 用户群体 | 场景 |
|---|---|
| 高校师生（研究生/学者） | 文献研读、理论溯源、论文选题与写作 |
| 政经/农经方向科研人员 | 实证分析（问卷/回归）、政策研究 |
| 课程教学人员 | AI+教育辅导、学习规划、教师备课 |
| AI Agent 开发者 | 接入 MarxSphere 推理/检索/教育能力（MCP/API） |

---

## 一、导航与工作区（41 视图 · 6 大分类）

### 导航结构（Mega Menu）

| 分类 | 视图 | 说明 |
|---|---|---|
| **对话推理** | 对话 / 推理 / Ask检索 | AI 交互核心 |
| **科研中心** | 文献库 / 外部检索 / 场景 / 教育 / 实证研究 / PDF2Obsidian / 政经C刊科研 / 写作语料库 | 科研全流程 |
| **知识中心** | 知识页 / 记忆 / PG入库 / Graphiti入库 / Cognee入库 / 图谱 / 数据源 | 知识沉淀 |
| **政策资料** | 政策库 / 资料库 | 政策与资料 |
| **技能工具** | 技能 / MCP | 工具扩展 |
| **系统管理** | Jobs / 任务 / Agent控制台 / Trace / 评测 / 告警 / Inbox / 账户计费 / 运营管理 / 文档中心 | 运维管理 |

### 工作区细节

- **ProjectRail 侧栏**：项目列表（创建/重命名/归档/删除）、MCP 会话列表、项目切换
- **活动面板**：推理过程步骤流 / 模型日志（浏览器缓存持久化，可清空）
- **设置**：AI 提供方配置（LLM/Embedding/Rerank 模型 + 密钥，密钥不回显）、语言切换（中/英）、API 令牌管理

---

## 二、推理与检索

### 2.1 52 步深度推理链路（`推理` 视图）

**执行流程**（52 步，条件触发）：

| 阶段 | 步骤 | 说明 |
|---|---|---|
| 问题解析 | 1-5 | 问题分类 → 意图识别 → 术语变体 → 拆分子问题 → 实体抽取 |
| 粗检索 | 6-11 | Cognee HYBRID（17 路）→ RAG 补全 → 图遍历 → 关系三元组 → 摘要检索 → 子问题推理 |
| 精炼 | 12-17 | 上下文扩展 → 时序分析 → PG 实体补漏 → PG 向量 → CHUNKS 词法 → 语义检索 |
| 深化 | 18-23 | 实体直查 → 实体精炼 → 概念搜索 → 文献蒸馏 → 领域知识 → 实体邻居 |
| 图谱 | 24-31 | Graphiti 社区检索 → 超边向量检索 → 超边结构检索 → 关系事件 → 事件链 → 溯源验证 |
| 融合 | 32-42 | 去重 → 加权融合 → 证据排序 → 冲突检测 → 假设生成 → 假设验证 |
| 生成 | 43-48 | 综合论证 → 引用标注 → 结论提炼 |
| 自愈 | 49-52 | 自评打分 → 低分反思 → 归因定位 → 重新生成 |

**特性**：
- 每步可视化：当前步骤金色高亮、token 实时显示、检索来源可追溯
- 两种模式：template（固定模板）/ adaptive（自适应跳步）
- 53 题 32 指标评测综合分：**0.884**

### 2.2 Ask 18 步检索流水线（`Ask检索` 视图）

**流水线**：向量化 → 别名消解 → 实体抽取 → 实体召回 → 关系召回 → 事件关联 → 标题向量 → 多查询变体 → 图遍历 → 事件详情 → 事件扩展 → 意图分类 → 加权 RRF → Cosine 重打分 → Boost 链 → 去重 → LLM 重排 → 回取切片

**特性**：18 步逐步点亮 + 每步 token 显示；答案带编号引用（点击回看切片）；支持多项目检索

### 2.3 三库知识图谱

| 库 | 数据规模 | 存储 | 能力 |
|---|---|---|---|
| **Graphiti** | 领域文献库：大规模实体/切片/社区/超边/关系图谱 | Neo4j 11001 | 社区发现、超边推理、五层蒸馏 |
| **Cognee** | 31,253 实体、248,417 关系、11,550 切片 | Neo4j 11003 + LanceDB | 实体关系路径、17 种检索策略 |
| **PG pgvector** | 7,550 切片向量（1024 维） | PostgreSQL | 向量检索 + 全文检索（BM25） |

**图谱可视化**（`图谱` 视图）：实体/事件节点拖拽、缩放、点击展开邻居、双击详情、方向推断

### 2.4 17 种检索策略

HyDE / 实体提升 / 关键词加权 / 事件扩展 / 时序分析 / 概念搜索 / 文献蒸馏 / 多查询变体 / 图遍历 / 关系三元组 / 子问题推理 / RAG 补全 / 语义检索 / 实体直查 / 超边向量 / 超边结构 / 社区检索

---

## 三、科研场景工作台（66 场景 · 8 大研究阶段）

### 场景分组（S01-S66）

| 阶段 | 场景 ID | 代表场景 | 专属算法 |
|---|---|---|---|
| 选题构思 | S01-S15 | 概念溯源、学派脉络、观点对比、争鸣还原、学者谱系 | 师承共现 / 观点聚类 / 时间线 / 高频词 |
| 文献调研 | S16-S25 | 经典文本研究、互文对照、晦涩阐释、版本校勘 | 概念溯源算法 |
| 证据检索 | S26-S35 | 学科前沿、实证研究 | 前沿检测 |
| 数据分析 | S36-S45 | 理论思辨拓展（前提反思/跨学科/理论现实联结/创新识别/体系建构） | 前提信号词库 / 学科映射 / 案例 embedding 匹配 / 命题张力 |
| 论文写作 | S46-S55 | 问题凝练、框架设计、论证补全、方法适配、反方视角、综述生成、段落扩写、学术要件、引文格式化、语体适配 | 覆盖矩阵 / 模板匹配 / 断层度 / 方法映射 / 五段模板 / 口语检测 / 三格式生成器 / 语体规则库 |
| 图表制作 | S56-S60 | 学术图表、可视化 | 图表模板库 |
| 评审发表 | S61-S65 | 概念一致性、引文核查、逻辑自洽、学术不端、格式适配 | 易混淆概念库 / N-gram 重合度 / 循环论证正则 / 格式规则库 |
| 系统自动化 | S66 | 政经 C 刊科研（四步法选题） | 选题矩阵 / 期刊匹配 |

**场景工作台**：每个场景 = 业务描述 + 能力徽章 + 动作（跳转视图 / 调用技能）+ 全屏工作台（输入 → 算法执行 → 输出）

### 标注工作区
框选高亮 / 下划线 / 笔记 + 笔记收纳栏（localStorage 持久化 + 导出 Markdown）

---

## 四、AI Agent 子系统（60+ 能力项 · 65 通用工具 + 112 教育路由 + 32 学习引擎顶层）

### 4.1 编排核心

| 能力 | 实现 |
|---|---|
| 决策循环 | 规划 → 选工具 → 执行 → reflect → replan（≤3 轮） |
| 任务 DAG | LLM 拆解子任务 → 依赖编排 → 队列并发（信号量 max 2）→ 进度 SSE |
| 失败处理 | 工具超时熔断（30s）→ 重试退避（指数）→ 失败回流 → 错误分类 |
| 人工审批门 | 高影响工具 approval 事件 → 超时自动拒绝（G6 调度器 30min） |
| checkpoint | 每轮快照（loop/plan/failures）→ 重启续跑 |
| token 预算 | 任务级 400K token 上限，超预算终止 |
| 恢复 | 队列持久化 → 重启 recoverAfterRestart |

### 4.2 工具矩阵（87 通用工具 = 65 Agent 工具 + 22 视图；教育工具经 /api/education/* 112 路由 + 学习引擎顶层 32 路由接入）

| 类别 | 工具 | 说明 |
|---|---|---|
| **认知检索** | `sag_search` / `sag_retrieve` / `sag_get_event` / `sag_ingest` / `sag_reason` / `concept_trace` / `policy_search` | 领域检索/概念溯源/政策检索/深度推理 |
| **文档** | `pdf_parse` / `attachment_read` / `summarize` / `review_output` / `file_read` / `file_write` | PDF 解析/附件阅读/摘要/评审/文件读写 |
| **执行** | `run_code`（Python 沙箱 3 级）/ `runtime_exec`（持久运行时）/ `run_command` / `apply_patch` / `todo_update` | 代码执行/命令/补丁/待办 |
| **网络** | `web_search` / `web_fetch` / `github_repo` / `code_search` | 网页搜索/抓取/GitHub/代码搜索 |
| **多模态** | `image_analyze` / `audio_transcribe` | 图片理解/音频转写 |
| **实证** | `empirical_analysis` | 问卷→回归全管道真跑 |
| **编排** | `agent_subagent` / `llm_write` | 子 Agent 派发/LLM 写作 |

**安全**：`DENY_TOOLS` 黑名单（file_delete/data_purge/external_publish/payment）+ 白名单审批 + LRU 缓存（检索类工具）+ 权限四级

### 4.3 记忆与学习

| 能力 | 实现 |
|---|---|
| 短期记忆 | conversation_context 会话摘要注入（记忆投毒审查拦截注入） |
| 长期记忆 | OpenViking（偏好/经验/历史交互，recall/commit/remember 三钩子） |
| 战略记忆 | 项目目标约束注入（Agent 控制台） |
| 技能蒸馏 | EDV 抽取 → 新技能注册 |
| 轨迹评测 | 计划遵循度 / 工具准确率 / 推理质量（judge 打分） |
| 学习闭环 | 反思 → 归因 → 最小 diff 补丁 → bad case 回流 |
| 遗忘 | 记忆维护定期归档/冲突检测/重复合并 |

### 4.4 治理与扩展

- 权限：reader / analyst / manager / admin + 租户隔离（JWT）
- 成本：token 实时统计（成本看板）、租户配额
- 插件热加载（plugins/ 目录监听）、OAuth（Google/GitHub 授权登录）
- 会话图分叉（checkpoint 分支）、消息线程、时间感知、身份注入

---

## 五、实证研究工作台（10 大功能）

| 功能 | 细节 |
|---|---|
| 问卷生成 | 主题 → 结构化问卷（变量名/题型/选项编码表自动生成，最多 120 题） |
| 问卷识别 | 导入已有问卷文本 → 结构解析 |
| 信效度检验 | Cronbach's α / KMO / Bartlett 球形检验 |
| 问卷诊断 | 题项质量、问题检测 |
| LLM 插补 | 论文复现级缺失值处理（三分类插补：数值/分类/文本） |
| 变量敲定 | 反 hallucinate 白名单 + 坐标读系数 |
| 分析管道 | 描述统计 → 相关分析 → 回归建模 |
| 回归分析 | M1-M6 渐进控制、固定效应、稳健性检验 |
| 证据账本 | 每次分析留痕（数据/代码/结果），可复现 |
| 质量闸门 | 发布前质量检查 |

---

## 六、桌面端（Electron + NSIS）

| 能力 | 细节 |
|---|---|
| 单进程架构 | `node dist/src/index.js` 同时服务 API + 前端静态资源 |
| 端口管理 | TCP connect 预检 → 自动递增（4173→4183）→ AGENT_API_BASE 联动 |
| 首次引导 | 一键启动 PG（docker compose）→ Neo4j 检测 → Python 系统探测 → LLM 配置 |
| 崩溃恢复 | 健康轮询 → 后端退出自动重启（3s）→ 错误页展示 |
| 进程清理 | taskkill /T 进程树（含 Python MCP 子进程） |
| 依赖自解压 | node_modules.zip（39MB）首启 bsdtar 解压 |
| 单实例锁 | 二次启动聚焦已有窗口 |

---

## 七、评测体系

| 模块 | 指标 |
|---|---|
| 双轨评测 | 规则评分 + LLM judge（32 指标：检索 A / 答案 B / 推理 C / 效率 D） |
| 回归集 | 16 题轨迹前缀回归集 + 故障注入 |
| 学习引擎 | 显著性 / 归因 / 轨迹前缀 / 校准（kappa=1.0）/ 模型替换 |
| Agent 评测 | 计划遵循度 / 工具准确率 / 推理质量 / 学习曲线 |
| 闭环 | 反思 → 归因 → 最小 diff 补丁 → bad case 回流 → 评测再验证 |

---

## 八·〇、工程纵深能力

> 全部开关默认关，评测 PASS 后逐个启用，不破坏 0.884 基线。服务端审计端点在运营管理面板可视化。

### 8.0.1 成本可审计账本（`#运营管理 → 平台成本审计`）

| 能力 | 细节 |
|---|---|
| 轮级用量明细 | `llm_usage_ledger`(105 迁移)：每次 LLM 调用一条(模型/端点/输入输出/cacheHit/成本) |
| 成本来源三态 | `cost_source`: provider_billed(厂商实扣, 预留) / estimate(默认估算) / byok(用户自付 key, 零平台成本) |
| 按模型单价 | `llm_model_prices`：in/out 分价(元/1M)，启动 seed 默认，admin 可调 |
| 埋点覆盖 | 推理 52 步全部 fetchLlm 调用 + 搜索链/对话链 llm-client(真实模型名) |
| 顺带修复 | 计费恒 flash 定价 bug + stream 路由漏 JWT 计费(chargeUserForReasonTask 共用) |

### 8.0.2 三档成本路由 + 本地 ML 分类器（`#运营管理 → 三档路由决策审计`）

| 能力 | 细节 |
|---|---|
| 三档语义 | lite(单点快答≤60字概念/事实) / standard(52 步全链路, 默认) / deep(政策法条/引证核验/比较/综述/理论对接/机制分析) |
| 本地分类器 | 人工标签 LightGBM(180 条, 二分类 lite/deep acc 0.938)；特征: 手写 51 维 + TFIDF-SVD 100 |
| 保守融合 | 规则强 deep 优先 → ML 自信判 deep 升级(prob≥0.65) → 其余规则默认；**只升级不降级**(方向安全) |
| 决策审计 | 每轮落 `router_audit`(106 迁移)，运营面板按档位/来源可视化 + lite 省幅估算 |
| 评测门 | `scripts/tier-router-eval.sh`(独立输出不污染基线, 支持 EVAL_QUESTIONS 子集) |
| 资产 | `scripts/ml-router/`(训练/推理/标注全套) + `data/ml-router/`(本地, 不入 git) |

### 8.0.3 B5 多模型集成路由（难档 opt-in, `B5_ENABLED=1`）

| 能力 | 细节 |
|---|---|
| 并行成稿+聚合 | 多模型(默认 2 strong+1 cheap 锚点)并行作答 → aggregator 融合(检索证据校准分歧点) |
| 渐进呈现 | `runB5EnsembleProgressive`: 成稿逐份到达即回调(先到先得), 不干等最慢 |
| 超时截断 | `B5_DRAFT_TIMEOUT_MS`(默认 60s)每稿独立, 慢候选截断记 timedOut 不拖轮 |
| 预设/自定义 | `B5_PRESET=default\|openrouter\|tokenrhythm` + `B5_SQUAD` 自定义优先 |
| 智能直连 | `shouldUseB5`: 难题(长/引证/比较/机制)才 B5, 简单题直连省成本 |
| 盲标评测 | `scripts/b5-vs-single-eval.sh`(judge 锚定 3=基准 + 盲序) |

### 8.0.4 任务执行租约（跨进程防双跑）

| 能力 | 细节 |
|---|---|
| DB 级租约 | agent_tasks `exec_lease_holder/token/until`(107 迁移)：原子 SQL 易主(空闲/过期) + fencing token 递增 |
| 心跳 | 每轮循环续期(默认 TTL 120s)；断线 TTL 过期后新实例接管(重启不自动续) |
| 接线 | queue pump 出队先抢租约(抢不到重排队) + runAgentTask 入口抢/挂起释放/出口释放; 租约丢失静默退出不动状态 |

### 8.0.5 记忆 Dream 空闲凝练×3（`#记忆巩固` + `#Agent控制台-技能库` + `MetaSkill 提案区`）

| 通道 | 说明 |
|---|---|
| 记忆候选 | 反复成功任务 → 隔离区 → accept 写战略记忆(带支撑证据明细) |
| 技能蒸馏 | 高频任务 → auto-propose → 技能库 pending(EDV 验证后人工 accept/reject) |
| MetaSkill DAG | 高频目标 → LLM 组装声明式工作流 → data/dag-proposals → 审阅区 accept 注册可跑 |
| 调度 | 每日 dream 定时器零额外定时器并跑三通道; `SAG_DREAM_SKILL_PROPOSE=0` 关; 均不自动 accept |

### 8.0.6 沙箱安全加固

| 能力 | 细节 |
|---|---|
| 删除前备份 | file_write delete → 原文件/目录备份 `agent_workspace/.trash/`(时间戳, >512MB 不备份, 总量 3GiB 轮转最旧) |
| 禁环回回连 | `checkNetworkAccess`: 127.0.0.1/localhost/0.0.0.0 默认全拦(修 SSRF — 外部 web 工具原可回打 4173)；`allowLoopback` 仅服务端内部自调 |

### 8.0.7 契约测试网

| 范围 | 测试文件 |
|---|---|
| SQL 仓储契约 | `test/repository-contract.test.ts`(图遍历 CTE/真相检索/名称召回/租约 SQL 形状) |
| 成本账本契约 | `test/cost-ledger.test.ts`(INSERT 映射/byok 零成本/聚合降级) |
| 路由契约 | `test/tier-router.test.ts`(档位规则/ML 开关/混合决策) |
| B5 契约 | `test/b5-ensemble.test.ts`(预设阵容/智能直连判定) |

---

## 八·五、论文格式智能评测（2026-09-03 新增 · `#format-eval`）

| 能力 | 细节 |
|---|---|
| 检测模板 | 6 内置模板(本科/硕士/博士毕业论文、职称论文、期刊 GB/T 7714、技术报告), 支持学校自定义模板 JSON 内联(localStorage 持久化) |
| 规则引擎(纯代码) | 8 类 20+ 条确定性规则: 标题层级跳变/编号体系不符、摘要字数、关键词个数与分隔符、章节缺失/重复、引文标注风格与混用、参考文献序号跳号与引用越界、图表编号跳号、乱码/超长/标点混用 — 行级定位 |
| LLM 审校层 | 摘要四要素/术语一致性/标题措辞/内容归属错位 — 失败自动降级不阻塞规则结果 |
| 评分 | 100 − 5×error − 2×warning − 0.5×info, 违规清单按严重度色阶+行号+修改建议 |
| 输入 | .md/.txt 上传或全文粘贴(Word 复制) |
| API | GET /api/format-eval/templates · POST /api/format-eval/check(规则引擎必跑 + LLM 可选) |

## 八、运维与扩展

| 能力 | 细节 |
|---|---|
| 告警中心 | alerts 表 + 巡检 tab + 全局 toast（降级/熔断/反思实时记录） |
| 自愈 | 巡检（60s）→ 卡死检测 → 重启 → 告警 |
| 运营管理 | 用户列表/用量/审计日志/计划管理（admin） |
| 计费 | 余额/充值/订阅/账单/用量（JWT） |
| MCP Server | stdio 8 工具，Claude Code/Codex 直连 |
| PDF2Obsidian | 三栏工作台：上传 → PDF 预览 → 六产物（original/摘要/术语表/问答/index/信息） |
| 技能系统 | 技能注册表（201 项动态扫描）+ 触发词 + Skillify 固化 + 自动更新检测 |
| 数据源 | 29 个外部源（已接入/可接入/需注册分类） |

## 九、AI+教育（顶部「AI+教育」Tab · 112 教育路由 + 32 学习引擎顶层）

### 9.1 学生端「我的学习」

| 能力 | 路由 | 说明 |
|---|---|---|
| 苏格拉底五步打磨 | `agent/polish`（diverge/verify/focus/stress）+ `agent/decompose` + `agent/follow-up` | 记录→发散→初步验证（知识库密度）→聚焦→压力测试，逐步解锁 + 跳步降级警告 + 完成度 0/5 + 示例想法模板 + 想法卡（多想法并行）+ 导出对话 |
| 苏格拉底式提问 | `agent/socratic` / `socratic-continue` | 连续追问引导（3 轮上限），不直接给答案 |
| 阶梯式启发 | `agent/scaffold` | hint → guided → full 三级提示 |
| 作业辅导闭环 | `homework/solve` / `wrong` / `variant` / `qna` + `agent/wrong-to-mastery` | 解析→答疑→错题归集→变式→掌握度联动 |
| 自适应学习 | `adaptive/record-answer` / `profile` / `push` / `pace` / `layered` | 学情建模/画像/推送/节奏/分层 |
| 自动闭环 | `loop/hook-answer` / `diagnose` / `iterate` / `report` | 自动采集→诊断→迭代→周报 |
| BKT 认知诊断 | `cognitive/bkt-track` / `bkt-diagnose` | p(掌握) 隐状态推断 + 预测答对概率 |
| 学习进度追踪 | `agent/progress` | 计划完成率 + 掌握度变化 |
| 认知维度 / 千人千策 / 复习提醒 | `student/cognitive-dims` / `recommend` / `review-reminder` | 布鲁姆六维 / 专业背景推荐 / 艾宾浩斯遗忘曲线 |
| 阅读语言 / 编程教育 | `lang/*`（reading/vocab/writing/record）+ `coding/*`（decompose/tutor/interview/path） | 精读/润色/任务拆解/代码辅导/面试准备 |
| 学习陪伴 | `companion/*` | 计划/答疑/激励/复盘 |

### 9.2 教师端「教师工作台」

| 能力 | 路由 | 说明 |
|---|---|---|
| 备课辅助 | `teach/syllabus` / `lesson` / `courseware` / `layered` | 课程大纲/教案/课件（含配图建议）/分层设计 |
| 作业与考试 | `teach/questions`（基础/提升/拓展）/ `exam`（组卷）/ `grade`（批改）/ `wrong-report`（错题报告）/ `class-summary`（班级学情） | 完整教研闭环 |
| 课堂互动 | `teach/discussion` / `quiz` / `lecture-summary` | 讨论题/随堂测验/课堂总结 |
| 思政内容审核 | `audit/content`（四维核验）/ `calibrate`（Compiled Truth 校准） | 意识形态/表述/引用/边界 |
| 知识点先修图 | `kg/check-prereq` / `plan-path` / `validate-path` | 先修缺失检测/拓扑路径/逆序校验 |
| 多模态 | `multimodal/blackboard` / `speech-assessment` / `photo-solve` | 板书识别/口语测评/作业拍照 |
| 数据合规 | `compliance/classification` / `status` / `cleanup-student` / `cleanup-expired` | 数据分级/状态/清理 |

### 9.3 反馈闭环与教育评测

| 能力 | 路由/文件 | 说明 |
|---|---|---|
| 使用反馈（学生/教师） | `POST /api/education/feedback` | 学生端/教师端右下角 FAB：赞/踩+备注，自动带角色/场景，脱敏落库（`edu_feedback` 表） |
| 反馈统计 | `GET /api/education/feedback/stats` | 满意率、按场景/角色聚合、负评热点 top5（教学效果指标 ⑫ 数据源） |
| 教育评测（12 项） | `GET /api/education/eval`（`education-eval-service.ts`） | 技术 6 项（BKT/诊断/路径/批改/思政/闭环）+ 教学效果 6 项（掌握度/辅导对照/备课效率/批改效率/规划覆盖/满意度） |
| 自动改进建议 | 同上（suggestions 字段） | 低分指标（BKT<0.75 等）+ 负评热点 → 高/中优先级改进建议，评测工作台展示 |

### 9.4 学习引擎（自适应学习闭环）

> 完整文档: [docs/LEARNING-ENGINE.md](docs/LEARNING-ENGINE.md) · 调研: [docs/TRAITTUTOR-REVIEW.md](docs/TRAITTUTOR-REVIEW.md)

| 能力 | 路由/文件 | 说明 |
|---|---|---|
| 学习者事件账本 | `learning-evidence-service.ts`（迁移 096） | append-only 账本 + void amendment + 幂等键；强证据闸门（仅服务端判分+可靠归属进 BKT）；诚实读（未校准/观察<3 不显示数字）；时间衰减读投影 |
| BKT 概念掌握 | 同上（`bktUpdate`） | 贝叶斯后验更新（transition/guess/slip/prior），4 档定性状态（insufficient/needs_support/developing/supported） |
| BKT 离线校准 | `scripts/calibrate-bkt.ts` | 约束随机搜索 2 万候选 + 学生级 5 折 + 质量门（log-loss 优于基线才写校准工件） |
| 版本化计划链 | `learning-plan-service.ts`（迁移 097） | 只重规划未开始尾部 + supersede 审计链 + 组件状态机（依赖前置校验） |
| 确定性组件选择器 | `learning-selector-service.ts` | 源码移植 select/_stage：BKT 四阶段分支 + 评估-校准成对 + 孤儿评估抑制 + 14 组件中文文案 |
| 产物审查三态机 | `material-review-service.ts`（迁移 098） | needs_review→confirmed/discarded；未确认不可挂载不可评分；审查历史可审计 |
| 材料分析快照 | 同上 | 学科/难度/概念候选/页证据/模态适配 + augmentation 补充决策（LLM 判定+启发式降级恒 true） |
| 一材多工件 | 同上（`attachArtifactToPlan`） | courseware/flashcards/quiz 挂载到学习计划，仅 confirmed 经 generation_id，投影剥答案键 |
| 组件白名单 | 同上（`validateComponentInstance`） | 类型/字段白名单 + 答案键物理缺席 + 可执行标记拒绝 + 违规降级文本页 |
| 间隔重复复习 | `spaced-repetition-service.ts`（迁移 100） | 4 类间隔序列 + 连中 2 跳 2 档/答错退 1 档/连错 2 重置 + 错误未修复优先 |
| Compass 治理 | `education-compass-service.ts`（迁移 099） | 偏好三态 + 90 天 TTL + 候选确认门（≥2 证据）+ 删除即重建 + 边界声明 |
| 意图双层路由 | `education-intent-service.ts` | 5 类注入扫描（中英双语）+ LLM 分类 + 低置信度 fail-closed + 附件不进分类器 |
| Quota Rotation 网关 | `llm-common.ts`（`callLlmWithRotation`） | 总 deadline + per-model 熔断 + 配额/认证立即轮换 + 错误摘要 |
| 全屏学习画布 | `web/src/components/LearningCanvas.tsx` | 路径/组件/"为何此步"同屏 + 挂载折叠 + 状态推进（幂等/409 自愈/依赖锁定） |
| 前端入口 | `web/src/components/EducationPanel.tsx`（E9 学习引擎 + 产物中心） | 材料分析/意图路由/复习队列/Compass/熔断 5 tab + 确认/丢弃/挂载 |
| Agent 接入 | `agent-tool-router.ts`（education_service） | 新增 plan-chain/intent/material-analyze/pref-*/reviews-* 动作 |
