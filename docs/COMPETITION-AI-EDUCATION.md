# GOAI 无界应用｜Boundless Agents 赛道参赛方案（AI+教育赛题）

> **项目名称**：MarxSphere 马研星环 — 面向个性化学习的「教育 Agent 工作台」
> **赛道**：赛道二｜无界应用 Boundless Agents — **AI+教育**
> **版本**：V1.0 ｜ **日期**：2026-08-20
> **文档用途**：复赛（8.25–9.3 提交）更新版项目方案，含目标场景、产品流程、Agent 架构、数据来源与合规、评测指标、Demo 演示脚本与落地计划。
> **关联材料**：代码仓库 [LDF924/MarxSphere](https://github.com/LDF924/MarxSphere) ｜ 数据与合规 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)、[OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md) ｜ 评测标准 [SCORING_STANDARD.md](SCORING_STANDARD.md)

---

## 1. 目标场景与用户痛点

### 1.1 赛题定位（手册 4.3.4 摘录）

AI+教育赛题要求围绕**个性化学习与教学辅助**构建教育 Agent，重点验证：**个性化学习、作业辅导、学情诊断、教师备课和学习陪伴**。边界要求：体现「因材施教」，避免简单题库问答、标准答案生成器或泛聊天陪伴工具；如涉及学生数据、作业数据、测评数据或学习记录，应使用公开数据、模拟数据或经授权脱敏数据，不得替代教师、学校或专业机构的最终教育评价。

### 1.2 目标用户与核心痛点

| 用户 | 痛点 | MarxSphere 的解法 |
|---|---|---|
| **学生（个体学习者）** | 学习计划静态难坚持；作业遇阻直接找答案而非学会；不清楚自己的知识薄弱点 | 个性化学习规划 + 分步提示式作业辅导 + 学情诊断 + 学习陪伴 |
| **教师** | 备课耗时；分层教学难落地；作业批改与学情汇总负担重 | 教师备课 Agent（大纲/活动/案例/板书/作业/分层方案）+ 班级学情汇总 |
| **自学者 / 终身学习者** | 资料堆砌无路径；外文文献阅读门槛高；学习节奏无人校准 | 预习/复习、阅读与语言学习、自适应节奏推送 |

### 1.3 为什么需要 Agent（而非聊天机器人）

本赛题所需能力**无法用单轮问答或 Prompt 演示覆盖**：

- **任务闭环**：从「作业辅导」到「错题变式训练」到「学情更新」再到「学习计划动态调整」，是一条跨服务、多轮、有状态的任务链路；
- **知识增强**：课程辅导必须检索知识库（PG `source_chunks` 切片 + 四源混合检索）并**带引用溯源**，而不是模型直接生成；
- **记忆与个性化**：`answer_history` / `knowledge_mastery` 表 + 学生记忆召回（recallStudentMemory）支撑「因材施教」；
- **工具调用**：52 步推理链路（问题分类→四路分调→多源检索→假设→评估→反思）+ 44 工具 Agent 编排（含 `view_education_profile` 学情画像工具）；
- **多轮交互**：学习陪伴、错题本、学习计划跟踪均为多轮有状态对话。

---

## 2. 产品流程（用户视角）

### 2.1 产品形态

- **Web 端**：`web/src/App.tsx` 主工作台 33 视图中的「教育 Education」视图（[web/src/components/EducationPanel.tsx](../web/src/components/EducationPanel.tsx)），与对话推理、推理工作台、Agent 控制台、Trace 链路可视化同屏打通；
- **API**：Fastify 4173，`/api/education/*` 共 **33 个教育路由**（V382–V388）；
- **桌面端**：Electron 可打包运行（NSIS 安装包）。

### 2.2 六大核心场景（覆盖赛题全部重点验证项）

| # | 场景 | 对应赛题验证项 | API 入口 | 核心输出 |
|---|---|---|---|---|
| 1 | 个性化学习规划 | 个性化学习 | `POST /api/education/learning-plan` | 分阶段学习计划 `{stages, totalWeeks, adaptation, knowledgeGap}`，基于知识基础与每周可投入时间动态调整 |
| 2 | 课程辅导 | 作业辅导 | `POST /api/education/tutoring` | **分步骤提示 + 错因分析 + 知识点回顾 + 同类题训练**（不是直接给答案），52 步推理 + 引用溯源 |
| 3 | 学情诊断 | 学情诊断 | `POST /api/education/diagnosis` | `{mastered, weak[], rootCauses, actionPlan, summary, progress}` 学情分析报告 |
| 4 | 预习复习 | 个性化学习 | `POST /api/education/preview-review` | 预习单/复习单，知识库驱动 |
| 5 | 教师备课 | 教师备课 | `POST /api/education/lesson-plan` | 完整教案 `{lessonTitle, objectives, classFlow, caseMaterials, assessment, homework}` |
| 6 | 学习陪伴 | 学习陪伴 | `POST /api/education/companion` | `{empathy, advice, followUp, encouragement, resources}` 共情陪伴 + 行动建议 |

### 2.3 自适应学习四层（"因材施教"的引擎）

`src/services/adaptive-learning-service.ts`（V384）：

1. **学情建模** `recordAnswer`：写入 `answer_history`，加权平滑更新 `knowledge_mastery`（正确 +0.15 / 艰难答对 +0.2 / 错误 −0.25；掌握度分级 mastered ≥0.7 / 模糊 ≥0.4 / 未掌握）；
2. **学情画像** `getStudentProfile`：掌握度汇总 + 薄弱点/优势点 + 最近 20 条作答；
3. **自适应内容推送** `adaptivePush`：薄弱点→微课/例题/拓展，已掌握→拔高，经学生记忆召回 + LLM 生成；
4. **节奏适配** `paceAdapt`：规则驱动（掌握率 ≥0.6→难/60min，≥0.3→中/45min，否则易/30min）。

### 2.4 完整任务闭环示例（学情驱动学习路径）

```
学生作答 → recordAnswer 建模 → getStudentProfile 画像
  → diagnosis 学情诊断（薄弱点+归因） → learningPlan 计划动态调整
  → tutoring 辅导（分步提示） → homework/variant 同类题变式训练
  → recordAnswer 再建模（掌握度更新） → adaptivePush 下一阶段内容
```

每一环都调用知识库检索与（或）52 步推理，结果带引用溯源与置信度。

---

## 3. Agent 架构与技术路线

### 3.1 系统总览

```
用户 → Web(React 教育视图) / 桌面端(Electron) / API
     → Fastify API (4173)
     → 52步推理链路 (inference-service.ts)
        问题分类(四路分调 PROFILES) → Cognee 粗检索 → Graphiti 精炼
        → PG 词法 → 超边增强 → 融合 → 假设 → 评估 → 反思(自愈)
     → 四源混合检索 (search-service.ts RRF)
        SAG 事件 + Graphiti 超边/社区 + Cognee 切片 + PG 向量/词法
     → AI Agent 编排 (44 工具 · 5 层安全 · 5 层记忆)
     → 教育服务 (六大能力 + 自适应四层 + 作业辅导/诊断/备课/陪伴)
数据: PostgreSQL 16 + pgvector(1024d) · Neo4j(Graphiti/Cognee) · LanceDB
```

### 3.2 52 步推理链路

入口 `InferenceService.reason()`（[src/services/inference-service.ts](../src/services/inference-service.ts) L450，由 [src/api/reason-handler.ts](../src/api/reason-handler.ts) 分发）。关键阶段：

1. **问题分类**（四路分调 PROFILES）→ 2. **Cognee 粗检索**（stage2）→ 3. **Graphiti 精炼**（stage3）→ 4. **PG 全文**（stage4）→ 5. **超边增强**（stage3.5）→ 6. **多源融合** → 7. **假设生成** → 8. **评估** → 9. **反思自愈**（V80：template → expandQuery → HyDE → reasonFast 逐级升级）。

- 每一阶段写入 `retrieve_steps` 日志（**真实 token 消耗可审计**）；
- 教育能力通过 `deepReason()`（[education-service.ts](../src/services/education-service.ts) L28）与 `sag_reason` 工具接入同一链路；
- 可选 `mode: "adaptive"` 路径：24 算子注册表 `ADAPTIVE_OPERATORS`（outline / pg_arm / cognee_hybrid / extract_entities / g_chunk / g_literature …），算子化编排。

### 3.3 四源混合检索（知识增强）

`SearchService.search()`（[src/services/search-service.ts](../src/services/search-service.ts) L79），RRF 融合 + 余弦重排（0.7 RRF + 0.3 cosine）：

| 源 | 作用 | 技术 |
|---|---|---|
| SAG 事件检索 | 主知识轴（Compiled Truth ×2.0 加权） | 内容向量 + 标题向量 + BM25 三臂 RRF |
| Graphiti 超边/社区 | 跨文档语义关联、社区聚合 | `hybrid_search_entities` MCP 调用，Neo4j 11001 |
| Cognee 切片 | 段落级 HYBRID 检索 | `cognee_search`，Neo4j 11003 + LanceDB 1024d |
| PG 向量/词法 | 教育知识库切片（`source_chunks` ILIKE + pgvector） | `retrieveChunks`（教育服务专用，topK 15） |

### 3.4 Agent 编排（44 工具 · 5 层安全 · 5 层记忆）

- **44 工具**：26 个基础 Agent 工具（`sag_search / sag_reason / web_search / run_code / image_analyze / audio_transcribe / empirical_analysis / …`，注册于 [agent-tool-router.ts](../src/services/agent-tool-router.ts) `buildAgentTools`）+ 18 个视图工具（含 **`view_education_profile` 学情画像工具** → `getStudentProfile`）+ 插件工具；风险分级 safe / review / deny（`DENY_TOOLS`）；
- **5 层安全**：① Guardian 策略文件（风险×授权 → allow/deny/review）② 3 级沙箱（只读/工作区写/全量）③ 网络审批（SSRF 白名单拒绝）④ 审批门（四态 + 自主级别 suggest/auto-edit/full-auto）⑤ 凭证隔离（`maskCredentials`）；
- **5 层记忆**：① 情景记忆（研究轨迹）② 战略记忆（任务目标约束）③ 技能蒸馏（EDV 评审）④ 防错规则（反馈沉淀）⑤ 语料库（文本/概念/逻辑/句式四子库）。

### 3.5 教育服务模块（33 个 API 路由）

| 模块 | 服务文件 | 能力数 | 路由前缀 |
|---|---|---|---|
| 核心六能力 | `education-service.ts` | 6 | `/api/education/*` |
| 自适应学习 | `adaptive-learning-service.ts` | 5 | `/api/education/adaptive/*` |
| 作业辅导 | `homework-help-service.ts` | 6（`solveQuestion` 支持 文本/拍照/公式/图形 4 模式 + 分级提示） | `/api/education/homework/*` |
| 学情诊断 | `diagnostic-service.ts` | 4 | `/api/education/diagnostic/*` |
| 教师助手 | `teaching-assistant-service.ts` | 4 | `/api/education/teach/*` |
| 学习陪伴 | `study-companion-service.ts` | 7 | `/api/education/companion/*` |
| Obsidian 学习库 | — | 2 | obsidian search/save |

### 3.6 模型与部署

- **模型**：DeepSeek 原生（推理/生成）+ Embedding MAAS；LLM Judge DeepSeek v4-flash（qwen-plus 兜底）——商业 API 使用环节、费用假设、替代方案（可切换任意 OpenAI 兼容端点）见 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)；
- **部署**：本地 Docker 一键起（PostgreSQL 16 + pgvector、Neo4j、LanceDB），`npm run dev` 开发（Web 5173 / API 4173），生产 `npm start`，Electron 桌面端打包；
- **可复现**：`npm test`（154 项单元测试）、`npm run typecheck`、评测脚本见第 5 节。

---

## 4. 数据来源与合规

> 完整披露见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)（第三方源码披露）与 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)（开源/依赖/模型披露）。本节为复赛「数据来源与合规说明」摘要。

### 4.1 数据类型与来源

| 数据类型 | 来源 | 授权/合规状态 |
|---|---|---|
| 学习计划 / 学情 / 作答记录 | **模拟数据**（学生可自录练习答案，默认本地存储） | 模拟数据，无真实个人信息；边界见 4.3 |
| 知识库切片（`source_chunks`） | 公开学术文献与公开教材类文本 | 公开数据；第三方披露见 THIRD-PARTY-NOTICES |
| 教学语料（教师备课输入） | 用户（教师）自行提供 | 用户自备数据，系统仅本地处理 |
| 知识图谱（Graphiti/Cognee） | 由公开文档自动抽取构建 | 公开数据派生，实体/关系为机器抽取 |

### 4.2 脱敏与隐私保护

- 学生画像字段**仅含学科掌握度数值与作答记录**，不含姓名、学号、联系方式等个人标识；不采集生物特征、录音录像；
- 作答数据本地存储于 PostgreSQL（`answer_history` / `knowledge_mastery`），支持按会话清理；不向任何第三方传输；
- 凭证隔离（`maskCredentials`）：API Key 仅存于本地 `.env`，日志经 `sanitizeLine` 脱敏，不随日志/评测输出泄露；
- 网络访问经 SSRF 白名单审批，外部检索仅白名单域名。

### 4.3 边界与风险提示（教育行业要求）

- **不替代教师/学校/专业机构的最终教育评价**：诊断结果仅作学习参考，系统内置「辅助学习不替代教师/学校评价」边界声明（`education-service.ts` 文件头）；
- **不做标准答案生成器**：作业辅导默认分步提示、错因分析与同类题训练，不直接给最终答案；
- 高风险/不确定性输出附带置信度与引用来源；模型幻觉风险在文档与产品界面均有提示；
- 本项目双许可证 **AGPL v3 + 商业授权**（非 MIT），复用本项目代码须遵守对应许可证条款。

### 4.4 第三方披露摘要（手册 9 节要求）

- 基础架构源自 **SAG**（Zleap-AI, MIT）：search-service / inference-service / MCP server；
- **GBrain**（MIT）：boosts / rrf / alias / sanitize 移植；**PDF2Obsidian**（MIT, vendor/）；
- 设计参考 OpenAI Codex / DeepSeek Harness / wisp-science / HyperGraphRAG；
- 开源依赖与许可证详见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)；依赖清单、模型调用环节与费用假设见 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)。

---

## 5. 评测指标与验证

### 5.1 现有评测基线（检索/推理质量）

- **RAGAS v3 评测**（[scripts/eval-32-metrics.ts](../scripts/eval-32-metrics.ts)）：31+ 评分项（A 组 12 项 0.40 / B 组 9 项 0.35 / C 组 3 项 0.25 / D 组 7 项 0.00），LLM Judge DeepSeek v4-flash（qwen-plus 兜底），3 并发，5 合并策略（max 默认）；
- **53 题金标集**（`data/gold_dataset.json`），Kappa 校准门 ≥0.7（当前 1.000）；
- **基线总分 0.884**（BENCHMARK.md）；52 步推理链路真实 token 审计（`retrieve_steps`）；
- **154 项单元测试**，前后端 typecheck 门禁。

### 5.2 教育场景评测方案（复赛新增，建议）

| 维度 | 指标 | 方法 |
|---|---|---|
| 学情诊断准确率 | 诊断出的薄弱点与模拟答案真实错因的匹配率 | 模拟答案集（含预设错因）30 题 × 3 学科 |
| 辅导有效性 | 分步提示后学生正确作答率提升 | 前后对照（提示前 vs 提示后） |
| 计划合理性 | 计划覆盖目标知识点比例 | 人工评分 1–5 |
| 引用溯源率 | 辅导/诊断输出带知识库引用的比例 | 脚本统计 citations 字段 |
| 任务闭环完成率 | 完整链路（辅导→变式→诊断→计划调整）可跑通比例 | 端到端脚本 × 5 场景 |
| 合规检查 | 输出含「不替代教师评价」等边界声明比例 | 脚本检查 + 人工抽检 |

---

## 6. Demo 演示脚本（教育场景完整任务链路）

> 对应复赛必交材料「可运行 Demo / Demo 视频」：展示用户输入 → Agent 处理 → 工具/知识库调用 → 结果交付 → 异常处理 → 效果验证。

**准备**：`npm run dev`（或 `docker compose up -d` + `npm run db:setup`），浏览器打开 http://localhost:5173，进入「教育」视图。

### 场景一：作业辅导 → 错题变式 → 学情诊断（学生）

1. **输入**：学生发问「请帮我讲讲一元二次方程的配方法，我这一步总是算错」；
2. **Agent 处理**：`tutoring` → `deepReason()` 进入 52 步推理（问题分类 → 知识库检索 `source_chunks` 配方法切片 → Graphiti 超边关联同类知识点 → 生成）；
3. **工具调用**：知识库检索 `retrieveChunks(topK=15)` + 学生记忆召回 `recallStudentMemory`；
4. **结果交付**：分步骤提示（不直接给答案）+ 错因分析 + 知识点回顾 + 同类题训练建议，附引用与置信度；
5. **闭环**：学生完成 `homework/variant` 变式训练 → `adaptive/record-answer` 更新掌握度；
6. **学情诊断**：`diagnosis` 输出 `{mastered, weak[], rootCauses, actionPlan}`，`adaptive/push` 推送下一阶段微课；
7. **效果验证**：诊断报告 + 掌握度变化（如「配方法：模糊 0.4 → 掌握 0.7」）在页面展示；Trace 视图展示 52 步推理链路与 token 消耗。

### 场景二：教师备课 → 分层教学（教师）

1. **输入**：「请帮我准备《价值规律》一课的教案，45 分钟，班级基础一般」；
2. **Agent 处理**：`lesson-plan` → 知识库检索 + 52 步推理 → 输出 `{lessonTitle, objectives, classFlow, caseMaterials, assessment, homework}`；
3. **分层**：`adaptive/layered` 对同一知识点生成 基础/进阶/挑战 三档内容；
4. **异常处理演示**：故意输入缺参数（如缺学科），展示结构化错误提示与引导补全；
5. **交付**：教案含案例素材与板书结构，可导出/复制。

### 场景三：个性化学习规划（学生/自学者）

1. **输入**：「我每周只有 4 小时，想 3 个月学完《政治经济学批判》导言，怎么规划？」
2. **Agent 处理**：`learning-plan` → 学生记忆召回（历史学习记录）+ 知识库检索 → 分阶段计划 `{stages, totalWeeks, adaptation, knowledgeGap}`；
3. **动态调整**：配合诊断结果（weak[]）自动重排下一阶段优先级；
4. **交付**：可执行时间表 + 每阶段学习资源（含引用）。

### 场景四：学习陪伴（多轮交互）

1. **输入**：「最近学《资本论》第一卷好难，有点想放弃」（连续第 3 轮对话）；
2. **Agent 处理**：`companion` 携带 `history` 上下文 → 共情回应 + 行动建议 + 资源推荐；
3. **交付**：`{empathy, advice, followUp, encouragement, resources}`，引导回到学习计划。

**Demo 视频要点**：每个场景控制在 1–2 分钟；重点录制 ① 完整任务闭环 ② 引用溯源/置信度展示 ③ 52 步推理 Trace 可视化 ④ 学情画像（`view_education_profile`）与掌握度变化 ⑤ 一次异常输入处理。

---

## 7. 落地计划

### 7.1 复赛冲刺（8.25–9.3）

| 周 | 工作项 | 产出 |
|---|---|---|
| 8.25–8.28 | ① 教育 Demo 数据/模拟答案集补齐 ② 教育场景评测脚本（第 5.2 节）落地 ③ Demo 视频录制（场景一/二为主） | 评测结果 + 视频初稿 |
| 8.29–8.31 | ④ 方案 PPT/PDF 按复赛 4 项必交材料整理 ⑤ 运行说明 README/部署文档核对 ⑥ 合规说明核对（数据来源/边界/第三方披露） | 提交材料包 V1 |
| 9.1–9.3 | ⑦ 全链路回归（评测不退化、154 测试通过）⑧ 最终提交 | 提交材料包 V2 |

### 7.2 若入围决赛（9.10 公布，9 月中旬线下路演）

- 现场路演材料：产品故事线（学生/教师双视角）+ 3 分钟 Demo 精剪 + 技术深挖备答（52 步推理/四源 RRF/自适应四层）；
- 加分项：教育场景金标集扩充至 60+ 题、双模态（拍照/语音）演示、多学科扩展（数学/英语/编程）。

### 7.3 后续迭代（赛外）

- **教育知识库**：接入国家智慧教育平台公开资源、OpenStax 等开放许可教材，扩充学科切片；
- **多模态**：拍照识题（`homework/solve` 已支持 photo 模式）、语音辅导（`audio_transcribe` 已具备）；
- **数据合规增强**：学生数据最小化采集 + 保留期自动清理 + 家长/教师知情流程。

---

## 8. 附录

### 8.1 复赛提交材料清单对照（手册 6.2）

| 必交材料 | 本方案对应 |
|---|---|
| 更新版项目方案（PPT/PDF） | 本文档（可转 PDF/PPT） |
| 可运行 Demo / Demo 视频 | 第 6 节脚本 + 演示视频（录制中） |
| 代码仓库/等价工程材料 | [LDF924/MarxSphere](https://github.com/LDF924/MarxSphere)，含运行入口、依赖、配置、示例数据、部署与测试方法 |
| 数据来源与合规说明 | 第 4 节 + THIRD-PARTY-NOTICES.md + OPEN-SOURCE-DISCLOSURE.md |

### 8.2 关键文件索引

| 文件 | 作用 |
|---|---|
| [src/services/education-service.ts](../src/services/education-service.ts) | 教育六大能力（V382） |
| [src/services/adaptive-learning-service.ts](../src/services/adaptive-learning-service.ts) | 自适应学习四层（V384） |
| [src/services/homework-help-service.ts](../src/services/homework-help-service.ts) | 作业辅导（V385，4 模式识别） |
| [src/services/diagnostic-service.ts](../src/services/diagnostic-service.ts) | 学情诊断（V386） |
| [src/services/teaching-assistant-service.ts](../src/services/teaching-assistant-service.ts) | 教师助手（V387） |
| [src/services/study-companion-service.ts](../src/services/study-companion-service.ts) | 学习陪伴（V388） |
| [src/services/inference-service.ts](../src/services/inference-service.ts) | 52 步推理链路 |
| [src/services/search-service.ts](../src/services/search-service.ts) | 四源混合检索 RRF 融合 |
| [src/services/agent-tool-router.ts](../src/services/agent-tool-router.ts) | Agent 工具注册（44 工具） |
| [web/src/components/EducationPanel.tsx](../web/src/components/EducationPanel.tsx) | 前端教育视图 |
| [scripts/eval-32-metrics.ts](../scripts/eval-32-metrics.ts) | 评测脚本（53 题基线 0.884） |
| [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | 第三方源码披露 |
| [docs/OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md) | 开源/依赖/模型/合规披露 |
