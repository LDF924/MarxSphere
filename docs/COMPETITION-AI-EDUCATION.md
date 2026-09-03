# GOAI 无界应用｜Boundless Agents 赛道参赛方案（AI+教育赛题）

> **项目名称**：MarxSphere — 面向个性化学习的「教育 Agent 工作台」
> **赛道**：赛道二｜无界应用 Boundless Agents — **AI+教育**
> **版本**：V1.0 ｜ **日期**：2026-08-20
> **文档用途**：复赛（8.25–9.3 提交）更新版项目方案，含目标场景、产品流程、Agent 架构、数据来源与合规、评测指标、Demo 演示脚本与落地计划。
> **关联材料**：代码仓库 [LDF924/MarxSphere](https://github.com/LDF924/MarxSphere) ｜ 数据与合规 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)、[OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md) ｜ 评测标准 [SCORING_STANDARD.md](SCORING_STANDARD.md)

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

**产品形态定位：原科研工作台完整保留、不分角色、人人可用；新增独立的「AI+教育」入口，教育能力全部内聚其中，不改造原系统。**

```
┌──────────────────────────────────────────────────────────────┐
│  主工作台（原科研能力原样保留，人人可用，不做任何改动）              │
│  对话推理 / 科研中心 / 知识中心 / 政策资料 / 技能工具 / 系统管理     │
├──────────────────────────────────────────────────────────────┤
│  顶部导航栏新增 Tab：AI+教育 ────────────────────────────    │
│  ┌─────────────┬─────────────┐                              │
│  │ 学生端       │ 教师端       │  ← 下拉子 Tab              │
│  │ 「我的学习」 │「教师工作台」 │                             │
│  └─────────────┴─────────────┘                              │
└──────────────────────────────────────────────────────────────┘
```

- **Web 端**：`web/src/App.tsx` 顶部导航栏新增 **「AI+教育」Tab**（下拉两个子 Tab：学生端「我的学习」/ 教师端「教师工作台」），教育能力（原 `EducationPanel` 六大能力 + 冲刺期新增编排/技术/多模态/合规/资产）**散布在这两个子页面中**；原科研视图（33 视图）不动、不分角色、人人可用；
- **API**：Fastify 4173，`/api/education/*` 共 **33 个教育路由**（V382–V388）——仅教育路由，原科研路由不受影响；
- **桌面端**：Electron 可打包运行（NSIS 安装包）。

> **现状与差距（如实说明）**：当前教育能力集中在单一「教育 Education」视图（六大能力平铺），无学生端/教师端分角色页面。冲刺期将教育能力重组为顶部「AI+教育」Tab + 双子 Tab 形态（§2.7），**原科研工作台完全不动**。

### 2.2 六大核心场景（覆盖赛题全部重点验证项）

| # | 场景 | 对应赛题验证项 | API 入口 | 核心输出 |
|---|---|---|---|---|
| 1 | 个性化学习规划 | 个性化学习 | `POST /api/education/learning-plan` | 分阶段学习计划 `{stages, totalWeeks, adaptation, knowledgeGap}`，基于知识基础与每周可投入时间动态调整 |
| 2 | 作业辅导 | 作业辅导 | `POST /api/education/tutoring` 及 `/api/education/homework/*` | **完整作业闭环：题目解析（分步提示不直接给答案）→ 作业答疑（追问式）→ 错题归集 → 同类变式训练 → 掌握度联动**，详见 2.4 |
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

### 2.4 作业辅导完整闭环（赛题重点，V385）

作业辅导不止「答一道题」，而是覆盖**作业批改 / 错题解析 / 习题生成 / 答疑**高频场景的完整闭环（`homework-help-service.ts` + `teaching-assistant-service.ts` ③）：

```
① 题目解析 solveQuestion   文本/拍照/公式/图表 4 模式，hint/guided/full 三级提示
     → 分析考点 + 分步提示 + 易错点 + 同类练习建议（默认 hint，不直接给答案）
② 作业答疑 homeworkQnA     学生描述卡点与尝试 → 追问式引导（2-3 个递进追问，绝不直接给答案）
③ 错题归集 recordWrongQuestion  写入错题本 wrong_questions，自动溯源该知识点
     → 联动 recordAnswer 下调掌握度（knowledge_mastery -0.25）
④ 习题生成 generateVariant   基于错题生成 2-3 道同类变式题（同知识点/难度或略高/思维增量），
     → 存入 variant_questions，错题 variant_count+1
⑤ 练习反馈 → recordAnswer  变式题作答回写 answer_history，掌握度按 加权平滑 更新
     → 答对后 markWrongMastered 将错题标记已掌握
⑥ 作业批改 gradeSubmission（教师侧）  客观题规则自动判分（字符串匹配/数字容差），
     主观题 LLM 辅助评阅（评分参考 + 修改意见 + 得分点分析），输出总分与百分制
⑦ 班级学情汇总 classSummary（教师侧）  聚合全班错题与薄弱点 → 共性教学盲区
⑧ 教师命题 generateExam   按知识点筛选 + 难度调节生成分层试卷（配评分标准）
```

**闭环验证**：一条完整任务链路 = `solve`（讲解）→ `qna`（答疑）→ `wrong`（归集错题）→ `variant`（变式训练）→ `record-answer`（掌握度更新）→ `diagnosis`（学情联动）→ `lesson-plan`（教师备课），每一步可追溯到路由、服务与知识库引用。

> **现状与差距（如实说明）**：当前闭环的**数据采集依赖人工输入**——学情、学习需求、作答均需学生/教师主动调用 API 传参后落库（`answer_history` / `learning_pace` / `wrong_questions` / `knowledge_mastery` / `study_plans`）。自动聚合能力已具备（`diagnostic-service.ts` 从这些表自动产出薄弱点/行为分析/风险预警），但**尚无自动采集（系统主动记录学习过程）与自动迭代（计划随数据自动更新）**——诊断报告生成后不会自动回流到学习计划。**端到端自动闭环是本方案复赛冲刺期的核心增量**，设计见 §2.6。

### 2.5 完整任务闭环示例（学情驱动学习路径）

```
学生作答 → recordAnswer 建模 → getStudentProfile 画像
  → diagnosis 学情诊断（薄弱点+归因） → learningPlan 计划动态调整
  → tutoring 辅导（分步提示） → homework/variant 同类题变式训练
  → recordAnswer 再建模（掌握度更新） → adaptivePush 下一阶段内容
```

每一环都调用知识库检索与（或）52 步推理，结果带引用溯源与置信度。

### 2.6 端到端自动闭环（复赛核心增量，冲刺期落地）

把「人工喂数据」升级为「系统自动采集 → 自动诊断 → 自动迭代方案」：

```
┌─ 自动采集（agent-education.ts 事件钩子）──────────────────────────┐
│  交互事件（辅导/答疑/变式训练） → 自动写 answer_history            │
│  会话时长/间隔 → 自动写 learning_pace                             │
│  错题 → 自动写 wrong_questions（无需人工 recordWrongQuestion）     │
│  计划执行 → 自动更新 study_plans.progress                          │
└──────────────┬─────────────────────────────────────────────────┘
               ▼ 自动诊断（周期触发：每次会话后 / 每日 / 每周）
  汇总 → locateGaps（薄弱点） + behaviorAnalysis（行为）
       → diagnosticReport（报告） + predictRisk（风险预警）
               ▼ 自动迭代（诊断结果回流，无需人工再调）
  风险/薄弱点 → 计划重排（learning-plan 按 weak[] 自动调整）
             → 内容重推（adaptivePush 自动补微课/变式）
             → 陪伴干预（motivate 自动触发：连续错题/数据不足）
               ▼ 效果验证（闭环自证）
  掌握度变化曲线 / 错题清零率 / 计划完成率 → 生成「自动闭环周报」
```

**落地要点**：
- **自动采集**：在教育服务入口（`solveQuestion`/`homeworkQnA`/`generateVariant`/`adaptivePush` 等）挂事件钩子，作答与交互自动落库——学生无需显式提交；
- **自动诊断**：会话结束后台任务周期触发 `locateGaps`+`behaviorAnalysis`+`predictRisk`（复用 V386 规则引擎，无需新造）；
- **自动迭代**：诊断结果（`weak[]`/`riskLevel`）自动回流 `learning-plan` 重排计划、`adaptivePush` 重推内容、`motivate` 触发干预——计划不再等人工修改；
- **自动验证**：以掌握度变化、错题清零率、计划完成率等指标生成周报，形成「采集→诊断→迭代→验证」自证闭环；
- **安全边界**：自动采集仅限学习过程数据（不采集个人信息/录音录像），写入需经 5 层安全策略审计；自动迭代不替代人工确认（计划变更推送给学生确认）。

### 2.7 学生端 / 教师端分角色页面（复赛冲刺期落地）

> **产品形态**：顶部导航栏新增 **「AI+教育」Tab**，下拉两个子 Tab —— 学生端「我的学习」、教师端「教师工作台」。**原科研工作台（33 视图）不做任何改动、不分角色、人人可用**；教育能力全部内聚在「AI+教育」Tab 内。

| 子 Tab | 页面内能力（散布布局） | 专属流程 |
|---|---|---|
| **学生端「我的学习」** | 学习计划 / 作业辅导（分步提示不直接给答案）/ 错题本 + 变式训练 / 学情画像 + 诊断报告（学生版）/ 学习进度 / 学习陪伴 / 每日复盘 | 学习计划跟踪、苏格拉底辅导会话、错题变式闭环、`companion/review` 复盘 |
| **教师端「教师工作台」** | 备课教案 / 命题组卷 / 作业批改 / 班级学情汇总 / 分层教学 | 备课-命题-批改-学情汇总教研闭环、班级共性盲区定位 |
| **公共（两子 Tab 均可见）** | 教育知识库检索 / 思政内容审核结果 / 教育复用资产（模板、示例课程、案例库） | — |

**能力散布原则**：冲刺期新增的所有能力（编排层、自动闭环、BKT/图谱/路径、多模态、合规、复用资产）**分别散布**到学生端/教师端对应页面——学习类进「我的学习」，教学类进「教师工作台」；两页共享教育服务与数据层（同一 `/api/education/*` 33 路由）。

**角色数据隔离**：学生端不可见班级他人学情（§4.2 权限隔离）；教师端仅看聚合班级数据，不暴露学生个人标识（`student_id` 匿名化）。

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

> **现状与差距（如实说明）**：当前 Agent 编排是**通用科研调度逻辑**（52 步推理 + 44 通用工具），教育能力的接入点是 `view_education_profile`（学情画像，只读）与 `deepReason()`（52 步推理）——**尚无教育场景专属的引导式编排层**。引导式交互的雏形（不直接给答案、追问式答疑）目前内嵌在 `solveQuestion` / `homeworkQnA` 的 prompt 里，未升级为 Agent 层闭环。**这是本方案的差异化创新点，也是复赛冲刺期的主攻方向**，设计见 §3.5。

### 3.5 教育专属 Agent 闭环（复赛创新点，冲刺期落地）

在通用编排之上新增**教育 Agent 编排层**（`src/services/agent-education.ts`，复赛冲刺期实现），把「苏格拉底式提问、阶梯式启发、错题-知识点联动、学习进度追踪」做成教育场景特有的编排闭环：

```
┌─ 教育 Agent 编排层（agent-education.ts）─────────────────────┐
│  意图识别 → 教育任务规划（教学法选择） → 工具编排 → 递进交付 → 评估反馈  │
│     │ 苏格拉底式提问    │ 阶梯式启发      │ 错题-知识点联动   │ 进度追踪   │
└──────────────┬─────────────────────────────────────────────┘
               ▼ 调用既有教育服务（不重复造轮子）
  education-service / adaptive-learning-service / homework-help-service
  / diagnostic-service / teaching-assistant-service / study-companion-service
               ▼
  PostgreSQL(answer_history / knowledge_mastery / wrong_questions
             / variant_questions / study_plans / study_reviews)
```

**① 苏格拉底式提问（socratic）**：不直接给答案，连续追问引导学生自己推出结论——「你觉得配方的关键一步是什么？→ 如果系数不是 1 呢？→ 试试把 x² 系数变成 1？」；追问轮次上限 3，超限给提示不揭底，学生答对立即确认并给同类题。

**② 阶梯式启发（scaffolded hints）**：`solveQuestion` 的 `hintLevel`（hint→guided→full）升级为编排层的阶梯状态机——先给方向提示，卡住再给操作步骤，仍卡住才给完整解析；每级记录学生是否跃级求助（评估辅导有效性）。

**③ 错题-知识点联动（wrong-to-mastery）**：错题归集 → 溯源知识点 → 掌握度下调 → 变式题验证 → 掌握度回升，全链路自动；编排层在每次诊断/计划调整时**读错题本 + 掌握度**做联动决策（如「配方法」连续错 3 次 → 下次计划自动插入该知识点微课）。

**④ 学习进度追踪（progress tracking）**：`study_plans.progress` 与 `answer_history` 驱动——按计划项完成率、知识点掌握度变化、变式题正确率生成进度报告，并在学习陪伴/复盘（`dailyReview`）中引用真实学习痕迹。

**⑤ 教育记忆（复用 5 层记忆第 1/4 层）**：学生交互轨迹（追问是否奏效、易错点、卡点模式）沉淀为情景记忆与防错规则，形成「这个学生该怎么教」的个性化画像——这是与通用科研 Agent 最大的不同。

**⑥ 安全边界**：教育编排遵守 5 层安全框架（Guardian 策略 + 审批门）；「不直接给答案」「不替代教师/学校评价」写进编排层策略文件（`agent-education.policy`），任何工具调用不可越界。

**⑦ 角色化编排（复用 §2.7 学生端/教师端子 Tab）**：编排层按子 Tab 切换工作流——「我的学习」会话走苏格拉底/阶梯/陪伴策略（面向学习个体），「教师工作台」会话走备课/命题/批改/班级学情聚合（面向教研）；角色数据隔离（学生不可见他人学情，教师仅聚合数据）。

**与 §2.6 自动闭环的关系**：§3.5 的编排层（苏格拉底/阶梯/错题联动/进度追踪）是「怎么教」，§2.6 的自动闭环是「数据怎么自动流」——编排层挂事件钩子自动采集 → 诊断服务自动聚合 → 结果自动回流编排层重排计划/重推内容，两层构成完整端到端教育闭环。

### 3.6 教育服务模块（33 个 API 路由）

| 模块 | 服务文件 | 能力数 | 路由前缀 |
|---|---|---|---|
| 核心六能力 | `education-service.ts` | 6 | `/api/education/*` |
| 自适应学习 | `adaptive-learning-service.ts` | 5 | `/api/education/adaptive/*` |
| 作业辅导（闭环） | `homework-help-service.ts` | 6（`solveQuestion` 文本/拍照/公式/图形 4 模式 + 三级提示；`recordWrongQuestion` 错题归集；`generateVariant` 同类变式生成；`homeworkQnA` 追问式答疑；错题本/标记掌握） | `/api/education/homework/*` |
| 学情诊断 | `diagnostic-service.ts` | 4（`locateGaps` 漏洞定位/`behaviorAnalysis` 行为分析/`diagnosticReport` 报告/`predictRisk` 风险预警，均从 `answer_history`/`wrong_questions`/`learning_pace`/`knowledge_mastery` 自动聚合） | `/api/education/diagnostic/*` |
| 教师助手 | `teaching-assistant-service.ts` | 4（教案/命题组卷 `generateExam`/**作业批改 `gradeSubmission`**/班级学情汇总） | `/api/education/teach/*` |
| 学习陪伴 | `study-companion-service.ts` | 7 | `/api/education/companion/*` |
| Obsidian 学习库 | — | 2 | obsidian search/save |

**作业辅导链路路由**：`/api/education/homework/solve`（题目解析）→ `/homework/qna`（答疑）→ `/homework/wrong`（错题归集）→ `/homework/variant`（变式生成）→ `/homework/wrong-list` / `/wrong-mastered`（错题本）→ `/api/education/adaptive/record-answer`（掌握度联动）→ 教师侧 `/api/education/teach/grade`（批改）/ `teach/exam`（命题）/ `teach/class-summary`（班级学情）。

### 3.7 模型与部署

- **模型**：DeepSeek 原生（推理/生成）+ Embedding MAAS；LLM Judge DeepSeek v4-flash（qwen-plus 兜底）——商业 API 使用环节、费用假设、替代方案（可切换任意 OpenAI 兼容端点）见 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)；
- **部署**：本地 Docker 一键起（PostgreSQL 16 + pgvector、Neo4j、LanceDB），`npm run dev` 开发（Web 5173 / API 4173），生产 `npm start`，Electron 桌面端打包；
- **可复现**：`npm test`（154 项单元测试）、`npm run typecheck`、评测脚本见第 5 节。

### 3.8 教育专属技术创新路线（现状如实 + 冲刺期最小实现）

> 核实现状：当前教育核心确为通用科研 RAG 能力（52 步推理 + 四源检索）之上的业务封装，**认知诊断模型、教育知识图谱、路径规划算法三项专属技术目前缺位**（`knowledge_mastery` 为加权平滑规则、`predictRisk` 为阈值规则引擎、`learningPlan` 为 LLM 生成、`previewReview` 的 `prerequisites` 仅 prompt 字段）。以下为**复赛冲刺期最小实现 + 后续扩展**的技术路线，为参赛差异化技术深度。

| 技术方向 | 现状（如实） | 冲刺期最小实现（8.25–9.3） | 后续扩展（决赛/赛外） |
|---|---|---|---|
| **认知诊断模型** | 无模型，`knowledge_mastery` 加权平滑（±0.15/-0.25）+ `predictRisk` 阈值规则 | **BKT 贝叶斯知识追踪**：`knowledge_mastery` 已有 `attempts/correct_count/score` → 实现 `p(掌握)` 隐状态推断（先验 0.5、猜/滑参数校准），输出「预测下次答对概率」 | DINA 认知诊断（Q 矩阵题目-知识点映射）、IRT 双参数、多知识点联合诊断 |
| **教育知识图谱** | 无结构化图谱；`concept_trace` 为马理论概念溯源（非教育）；`previewReview` prompt 有 `prerequisites` 字段（未落表） | **知识点先修图**：`knowledge_points` 表（`name/subject/level`）+ `kp_edges` 表（`from/to/type: prerequisite|related`），迁移文件落地；基于 `kp_edges` 做「先修缺失检测」（学习某点前未掌握其先修 → 提示） | 接入 Graphiti 超边（复用 500 篇文献图谱）、知识点-教材-题目三层图谱、概念语义边 |
| **学习路径规划算法** | 无算法，`learningPlan` LLM 生成 + `paceAdapt` 规则（≥0.6→难/60min） | **知识拓扑排序 + 能力约束**：基于 `kp_edges` 先修图做拓扑排序生成有序路径，按 `knowledge_mastery` 过滤已掌握节点，输出「先修-目标」最短学习链 | 个性化最优路径（掌握度+时间+兴趣多目标）、间隔重复调度（对错题/薄弱点按遗忘曲线排期） |
| **多模态识别** | 通用能力已有：`image_analyze`（OCR/chart/describe，走 SenseNova 视觉模型）、`audio_transcribe`（whisper 沙箱）——但**未与教育场景打通**，`solveQuestion` 的 photo 模式是用户手动贴 OCR 文本，无作业图片直拍识别 | 教育多模态打通（作业图片识别 / 口语测评 / 板书识别），详见 §3.9 | 语音辅导、多模态评测（音-文-图联合） |

**与既有架构的关系**：三项专属技术**不替换** 52 步推理/四源检索（通用 RAG 继续作为知识底座），而是作为教育场景的**专属智能层**叠加——认知诊断输出进 `predictRisk`/`diagnosis`，知识图谱供 `solveQuestion` 溯源与 `learningPlan` 选路径，路径规划替换 `learningPlan` 的纯 LLM 生成（LLM 降为参数解释与内容生成）。

### 3.9 教育多模态能力路线（现状如实 + 冲刺期落地）

> 核实现状：通用多模态能力已具备——`image_analyze` 工具（OCR 文本提取 / 图表结构化 / 综合描述，走 SenseNova 视觉模型，未配置 `SENSENOVA_API_KEY` 时降级提示）、`audio_transcribe` 工具（whisper 沙箱转写，本地不可用时返回元数据+安装指引）、`attachment_read`（图片 LLM 视觉描述）。但**均未与教育场景打通**：`solveQuestion` 的 photo 模式是「拍照描述的 OCR 文本」——用户需手动粘贴文本，**无作业图片直拍识别**；**口语测评、板书识别**不存在。以下为教育多模态打通路线。

| 教育多模态能力 | 现状（如实） | 冲刺期最小实现（8.25–9.3） | 后续扩展（决赛/赛外） |
|---|---|---|---|
| **作业图片识别** | `solveQuestion` photo 模式仅接收 OCR 后文本（用户手动贴） | 打通链路：`image_analyze`(ocr) → 图片路径直传 `solve` → 文字/公式/图表题目解析；教育面板支持上传图片直接辅导 | 公式 OCR 结构化为 LaTeX 后再解析、手写体识别、多图（书本+草稿）联合 |
| **口语测评** | `audio_transcribe` 仅转写（无评分） | 口语回答录音 → whisper 转写 → LLM 按「发音/流畅度/内容」维度评分 + 改进建议（`companion` 场景） | 发音评分（音素级）、跟读纠音、多轮口语对话测评 |
| **板书识别** | 不存在 | 板书照片 → `image_analyze`(ocr) → 结构化要点 + 错漏检测（教师备课/复习场景） | 实时板书跟随、板书-教案对齐 |
| **语音辅导** | `audio_transcribe` 通用 | 语音提问 → 转写 → 走 `tutoring`/`qna` 辅导链路 | 多轮语音对话辅导 |

**合规注意**：口语测评涉及学生语音录音——冲刺期默认**仅本地处理 + 会话后即删**，不落库不训练；采集前明示学生并给「不使用语音」备选（与 §4 合规边界一致）。

---

## 4. 数据来源与合规

> 完整披露见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（第三方源码披露）与 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)（开源/依赖/模型披露）。本节为复赛「数据来源与合规说明」摘要。

### 4.1 数据类型与来源

| 数据类型 | 来源 | 授权/合规状态 |
|---|---|---|
| 学习计划 / 学情 / 作答记录 | **模拟数据**（学生可自录练习答案，默认本地存储） | 模拟数据，无真实个人信息；边界见 4.3 |
| 知识库切片（`source_chunks`） | 公开学术文献与公开教材类文本 | 公开数据；第三方披露见 THIRD_PARTY_NOTICES |
| 教学语料（教师备课输入） | 用户（教师）自行提供 | 用户自备数据，系统仅本地处理 |
| 知识图谱（Graphiti/Cognee） | 由公开文档自动抽取构建 | 公开数据派生，实体/关系为机器抽取 |
| 学生语音（口语测评，规划中） | 学生自愿录音 | **仅本地处理 + 会话后即删，不落库不训练**，明示后采集 |

> **现状与差距（如实说明）**：通用合规机制已具备（日志 `sanitizeLine` 脱敏、`/api/education` 权限门（`ALLOWED_PERMS`）、凭证隔离 `maskCredentials`、5 层安全 Guardian 策略），但**教育专属合规设计缺失**——学生隐私/学情数据保护无专门说明，缺数据分级、最小化采集、权限隔离的教育化设计。以下 4.2–4.5 为复赛「教育数据合规设计」补充。

### 4.2 教育数据合规设计（复赛补充，冲刺期落地）

**① 数据分级与最小化采集**

| 分级 | 数据 | 采集策略 |
|---|---|---|
| 学习行为（低敏） | `answer_history` / `learning_pace` / `knowledge_mastery` / `wrong_questions` | 仅存学科掌握度数值与作答记录，**不含姓名、学号、联系方式等个人标识**；默认匿名 `student_id`（`default` 匿名会话） |
| 教学交互（中敏） | 辅导/备课/陪伴对话记录 | 按会话保存，可一键清理；不进评测语料 |
| 语音（高敏） | 口语测评录音 | **仅本地处理 + 会话后即删，不落库不训练**；明示学生 + 「不使用语音」备选 |

**② 数据脱敏**：日志经 `sanitizeLine`（敏感信息正则 → `[REDACTED:type]`）；评测输出经 `maskCredentials` 凭证隔离；学生标识默认匿名化，真实身份不进入日志/评测/报告。

**③ 权限隔离**：`/api/education` 权限门（`ALLOWED_PERMS` 含 `education`）——无该权限的调用直接拒绝；教育编排遵守 5 层安全 Guardian 策略（风险×授权 → allow/deny/review）；学生与教师数据按角色隔离（学生不可见班级他人数据）。

**④ 生命周期管理**：作答/错题数据支持按会话清理；语音数据会话后即删；学情数据保留期策略（模拟数据默认 30 天，可配置）；不向任何第三方传输。

**⑤ 合规自证清单**（冲刺期落地，供复赛提交）：数据分级表、采集范围声明（学生端明示）、清理/删除操作演示、权限隔离测试用例、语音处理合规说明。

### 4.3 边界与风险提示（教育行业要求）

- **不替代教师/学校/专业机构的最终教育评价**：诊断结果仅作学习参考，系统内置「辅助学习不替代教师/学校评价」边界声明（`education-service.ts` 文件头）；
- **不做标准答案生成器**：作业辅导默认分步提示、错因分析与同类题训练，不直接给最终答案；
- 高风险/不确定性输出附带置信度与引用来源；模型幻觉风险在文档与产品界面均有提示；
- 本项目双许可证 **AGPL v3 + 商业授权**（非 MIT），复用本项目代码须遵守对应许可证条款。

### 4.4 第三方披露摘要（手册 9 节要求）

- 基础架构源自 **SAG**（Zleap-AI, MIT）：search-service / inference-service / MCP server；
- **GBrain**（MIT）：boosts / rrf / alias / sanitize 移植；**PDF2Obsidian**（MIT, vendor/）；
- 设计参考 OpenAI Codex / DeepSeek Harness / wisp-science / HyperGraphRAG；
- 开源依赖与许可证详见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；依赖清单、模型调用环节与费用假设见 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)。

### 4.5 思政内容合规机制（马理论/思政教育专属，复赛补充）

> 核实现状：检索层已有**权威校准**——Compiled Truth 知识页命中事件 ×2.0 boost（`gbrain-boosts.ts`，意图适配+消融验证）；`review_output` 质量评审工具（问题/建议/评分 0-1）；知识页 `source_hint` 来源标注；C 刊服务含思政期刊风格匹配。但**输出级内容审核与权威校准缺失**（`review_output` 为通用质量评审，非意识形态/表述准确性核验）。以下为冲刺期补充的思政合规机制。

**① 检索级权威校准（已有）**：Compiled Truth 知识页（由马理论经典文献沉淀）在检索融合时 ×2.0 加权，优先命中权威来源；`source_hint` 标注每条引用的来源。

**② 输出级内容审核（冲刺期新增 `content-audit-service.ts`）**：教育/思政输出交付前过四维核验（LLM Judge + 规则双通道）——
- **意识形态核验**：是否与马理论基本原理、党的创新理论表述一致；是否出现偏离、歪曲、错误引用；
- **表述准确性**：专有名词/术语/历史事件表述是否准确（对照知识库权威源）；
- **引用真实性**：引用是否真实存在、页码/版本是否对应（防模型幻觉）；
- **边界提示**：对不确定/争议性内容输出置信度 + 引导人工核实，不替代思政教师/专业机构。

**③ 权威校准规则（冲刺期新增）**：输出含马理论概念时，强制检索 Compiled Truth 知识页对照校验（`searchCompiledTruth` 已具备），不一致则回退生成并标注「以权威文献为准」。

**④ 审核分级（冲刺期新增）**：低风险（学习陪伴/复习）→ 自动四维核验；中风险（辅导/备课）→ 核验 + 置信度标注；高风险（学情诊断/思政课内容）→ 核验 + 人工确认提示，不替代教师判断。

**⑤ 安全边界**：所有教育输出遵守「辅助学习不替代教师/学校评价」+「思政内容不替代专业机构/教师最终判断」双重边界；审核结果可追溯（审计日志留存）。

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
| BKT 预测准确率 | BKT 预测下次答对概率 vs 实际作答的 AUC / 准确率 | 模拟作答序列（预设掌握/未掌握）回放 |
| 路径规划合理性 | 拓扑路径无先修逆序率；计划覆盖目标知识点比例 | 先修图约束检查 + 人工评分 1–5 |
| 辅导有效性 | 分步提示后学生正确作答率提升 | 前后对照（提示前 vs 提示后） |
| 作业批改准确率 | 客观题规则判分与标准答案一致率；主观题评分与人工评阅相关性 | 模拟作业集（客观+主观）对照人工评分 |
| 习题生成质量 | 变式题与错题同知识点率、难度分布合理率 | 人工评分 1–5（30 道变式题抽检） |
| 引用溯源率 | 辅导/诊断输出带知识库引用的比例 | 脚本统计 citations 字段 |
| 任务闭环完成率 | 完整链路（辅导→变式→诊断→计划调整）可跑通比例 | 端到端脚本 × 5 场景 |
| 数据脱敏检查 | 日志/评测输出无学生标识、无敏感字段泄漏 | 脚本扫描日志 + 人工抽检 |
| 权限隔离测试 | 无 `education` 权限的调用被拒率 100% | 权限用例（有/无权限 × 各教育路由） |
| 思政内容核验 | 输出含马理论概念时，意识形态/表述/引用核验通过率 | 思政专项测试集（含易错表述）20 例 + 对照权威源 |
| 合规检查 | 输出含「不替代教师评价」等边界声明比例 | 脚本检查 + 人工抽检 |

---

## 6. Demo 演示脚本（教育场景完整任务链路）

> 对应复赛必交材料「可运行 Demo / Demo 视频」：展示用户输入 → Agent 处理 → 工具/知识库调用 → 结果交付 → 异常处理 → 效果验证。

**准备**：`npm run dev`（或 `docker compose up -d` + `npm run db:setup`），浏览器打开 http://localhost:5173，进入「教育」视图。

### 场景一：作业辅导完整闭环（学生，赛题核心演示）

覆盖「题目解析 → 答疑 → 错题归集 → 变式训练 → 掌握度更新」全链路，对应复赛要求的完整任务链路：

1. **题目解析**：学生发题「请帮我讲讲一元二次方程的配方法，我这一步总是算错」→ `homework/solve`（默认 hint 模式）→ `deepReason()` 进入 52 步推理（问题分类 → 知识库检索 `source_chunks` 配方法切片 → Graphiti 超边关联同类知识点 → 生成）；
2. **结果交付（不直接给答案）**：考点拆解 + 分步提示 + 易错点 + 同类练习建议，附知识库引用与置信度；
3. **追问答疑**：学生回复「我卡在配方后开方这一步」→ `homework/qna` → 追问式引导（2-3 个递进追问，肯定已尝试部分）；
4. **错题归集**：学生仍算错 → `homework/wrong` 写入错题本，自动溯源「配方法」知识点，`record-answer` 将掌握度下调 0.25；
5. **变式训练（习题生成）**：`homework/variant` 基于错题生成 2 道同类变式题（同知识点、难度略高、思维增量）；
6. **掌握度更新**：变式题作答 → `adaptive/record-answer` 回写（答对 +0.15）→ `homework/wrong-mastered` 标记已掌握；
7. **学情联动**：`diagnosis` 输出 `{mastered, weak[], rootCauses, actionPlan}`，`adaptive/push` 推送下一阶段微课；
8. **效果验证**：页面展示「配方法：模糊 0.4 → 掌握 0.7」掌握度变化 + 错题本记录；Trace 视图展示 52 步推理链路与 token 消耗。

### 场景二：作业批改 + 班级学情（教师）

1. **输入**：教师上传 5 份学生作业（混合客观题/主观题）；
2. **批改**：`teach/grade` → 客观题规则自动判分（字符串匹配/数字容差），主观题 LLM 辅助评阅（评分参考 + 修改意见 + 得分点分析），输出总分与百分制；
3. **班级学情**：`teach/class-summary` 聚合全班错题与薄弱点 → 定位班级共性教学盲区；
4. **命题组卷**：`teach/exam` 按知识点筛选 + 难度调节生成分层试卷（含评分标准）；
5. **交付**：批改结果 + 班级盲区报告 + 试卷，均可导出/复制。

### 场景三：教师备课 → 分层教学（教师）

1. **输入**：「请帮我准备《价值规律》一课的教案，45 分钟，班级基础一般」；
2. **Agent 处理**：`lesson-plan` → 知识库检索 + 52 步推理 → 输出 `{lessonTitle, objectives, classFlow, caseMaterials, assessment, homework}`；
3. **分层**：`adaptive/layered` 对同一知识点生成 基础/进阶/挑战 三档内容；
4. **异常处理演示**：故意输入缺参数（如缺学科），展示结构化错误提示与引导补全；
5. **交付**：教案含案例素材与板书结构，可导出/复制。

### 场景四：个性化学习规划（学生/自学者）

1. **输入**：「我每周只有 4 小时，想 3 个月学完《政治经济学批判》导言，怎么规划？」
2. **Agent 处理**：`learning-plan` → 学生记忆召回（历史学习记录）+ 知识库检索 → 分阶段计划 `{stages, totalWeeks, adaptation, knowledgeGap}`；
3. **动态调整**：配合诊断结果（weak[]）自动重排下一阶段优先级；
4. **交付**：可执行时间表 + 每阶段学习资源（含引用）。

### 场景五：学习陪伴（多轮交互）

1. **输入**：「最近学《资本论》第一卷好难，有点想放弃」（连续第 3 轮对话）；
2. **Agent 处理**：`companion` 携带 `history` 上下文 → 共情回应 + 行动建议 + 资源推荐；
3. **交付**：`{empathy, advice, followUp, encouragement, resources}`，引导回到学习计划。

**Demo 视频要点**：每个场景控制在 1–2 分钟；重点录制 ① 完整任务闭环（作业辅导 8 步全链路优先）② **教育专属 Agent 编排（苏格拉底式提问/阶梯式启发/进度追踪，§3.5）** ③ **端到端自动闭环（§2.6：自动采集→自动诊断→自动迭代，建议优先）** ④ 引用溯源/置信度展示 ⑤ 52 步推理 Trace 可视化 ⑥ 学情画像（`view_education_profile`）与掌握度变化 ⑦ 一次异常输入处理。

### 场景六：教育专属 Agent 编排（差异化亮点，冲刺期新增）

1. **输入**：学生在学习规划视图说「我想学一元二次方程，但不知道从哪里开始」；
2. **苏格拉底式提问**：编排层不直接给答案——「你知道方程和式的区别吗？→ 如果有一堆数和一个未知数，怎么把它变成方程？→ 试试把『x²=9』变成方程」；
3. **阶梯式启发**：学生卡住 → `solveQuestion` 按 hint→guided 逐级给提示，每级记录是否跃级求助；
4. **错题-知识点联动**：首次作答错误 → 错题归集 → 「配方法」掌握度下调 → 编排层自动在计划中插入微课 + 变式题；
5. **学习进度追踪**：`study_plans.progress` 更新 → 进度报告显示「配方法：模糊 0.4 → 掌握 0.7，错题 2→0」；
6. **交付**：下一次会话自动复用苏格拉底策略（学生记忆沉淀「该生适合引导式」），体现教育专属闭环。

### 场景七：端到端自动闭环（赛题核心增量，冲刺期新增）

1. **自动采集（无需人工输入）**：学生连续 3 天在辅导/变式训练中作答，系统自动写 `answer_history` / `learning_pace` / `wrong_questions`——**学生从未主动提交过学情**；
2. **自动诊断**：第 3 天会话结束，后台任务自动触发 `locateGaps` + `behaviorAnalysis` + `predictRisk` → 发现「配方法」正确率 25%、畏难点信号；
3. **自动迭代**：诊断结果自动回流 → `learning-plan` 重排（插入配方法微课 + 变式题）、`adaptivePush` 重推内容、`motivate` 触发鼓励干预——**无需人工修改计划**；
4. **自动验证**：第 7 天自动生成「自动闭环周报」——掌握度变化曲线、错题清零率、计划完成率，页面展示闭环自证；
5. **安全边界演示**：展示采集范围提示（仅学习过程数据）+ 计划变更需学生确认的审批环节。

### 场景八：教育专属技术深度（差异化，冲刺期新增）

1. **认知诊断（BKT）**：学生连续作答后，展示「预测下次答对概率」曲线（BKT 推断 `p(掌握)` 随作答迭代），与规则平滑结果对比，体现模型化诊断优于加权规则；
2. **知识点先修图**：展示「配方法」的 `kp_edges` 先修关系（一元一次方程 → 因式分解 → 配方法），学习前自动检测先修缺失并提示「先修「因式分解」未掌握，建议先学」；
3. **路径规划算法**：`learningPlan` 按先修图拓扑排序生成有序学习链（跳过已掌握节点），展示「先修-目标」最短链；
4. **交付**：技术架构页展示 BKT 公式 + 图谱表结构 + 拓扑算法，评委可深入技术实现。

### 场景九：教育多模态（差异化，冲刺期新增）

1. **作业图片识别**：学生**拍照上传**作业题 → `image_analyze`(ocr) 提取题目 → 直传 `solve` 辅导（展示「拍照→解析→分步提示」全链路，无需手动贴文本）；
2. **口语测评**：学生朗读英文段落录音 → `audio_transcribe` 转写 → LLM 按发音/流畅度/内容三维评分 + 改进建议；
3. **板书识别**：教师上传课堂板书照片 → `image_analyze`(ocr) 结构化要点 + 错漏检测；
4. **合规演示**：展示「语音仅本地处理、会话后即删」提示 + 「不使用语音」备选开关。

### 场景十：教育数据合规（赛题必查项，冲刺期新增）

1. **数据分级展示**：展示学习行为/教学交互/语音三级数据分级表，说明各自采集策略；
2. **最小化采集演示**：匿名 `student_id`（default）会话下作答，展示日志无个人标识（`sanitizeLine` 脱敏生效）；
3. **权限隔离演示**：用无 `education` 权限的凭证调用 `/api/education/*`，展示被拒；切换有权限凭证调用成功；
4. **数据清理演示**：一键清理会话作答/错题数据，展示清理前后学情归零；语音数据会话后即删；
5. **思政内容审核演示**：输入含马理论概念的辅导请求，展示输出前四维核验（意识形态/表述准确性/引用真实性/边界提示），并对照 Compiled Truth 权威源校准；
6. **合规自证交付**：复赛提交的「数据来源与合规说明」文档即本方案 §4 章节 + THIRD_PARTY_NOTICES + OPEN-SOURCE-DISCLOSURE。

### 场景十一：顶部「AI+教育」Tab · 学生端/教师端子 Tab（教育产品常规形态，冲刺期新增）

1. **入口**：顶部导航栏新增「AI+教育」Tab，下拉两个子 Tab（学生端「我的学习」/ 教师端「教师工作台」）；
2. **原科研工作台不动**：展示主工作台（对话推理/科研中心/知识中心等）原样保留、人人可用——教育 Tab 是纯新增，不改造原系统；
3. **学生端演示**：进入「我的学习」——学习计划跟踪、苏格拉底辅导会话、错题变式闭环、每日复盘；尝试访问班级他人学情 → 被权限隔离拒绝；
4. **教师端演示**：进入「教师工作台」——备课、命题、批改、班级学情汇总，班级共性盲区定位（不暴露学生个人标识）；
4. **交付**：展示两角色同一教育服务的差异化工作流，体现教育产品常规形态与场景代入感。

---

## 7. 落地计划

### 7.1 复赛冲刺（8.25–9.3）

| 周 | 工作项 | 产出 |
|---|---|---|
| 8.25–8.28 | ① 教育专属 Agent 编排层（§3.5）落地 ② 端到端自动闭环（§2.6）落地 ③ **教育专属技术最小实现（§3.8：BKT 认知诊断 / 知识点先修图 / 拓扑路径规划）** ④ **教育多模态打通（§3.9：作业图片识别 / 口语测评 / 板书识别）** ⑤ **教育数据合规落地（§4.2：数据分级/脱敏检查/权限隔离测试/生命周期清理）** ⑥ **思政内容审核落地（§4.5：四维核验 + Compiled Truth 校准）** ⑦ **顶部「AI+教育」Tab + 学生端/教师端子 Tab（§2.7，原科研工作台不动）** ⑧ 教育 Demo 数据/模拟答案集补齐 ⑨ 教育场景评测脚本（第 5.2 节）落地 | 编排层 + 自动闭环 + 专属技术 + 多模态 + 合规 + 内容审核 + 角色界面代码 + 评测结果 |
| 8.29–8.31 | ⑩ **教育复用资产打包（§7.4：场景模板/示例课程/教学案例库/模拟数据 + seed 脚本）** ⑪ Demo 视频录制（场景一/二/六/七/八/九/十/十一为主）⑫ 方案 PPT/PDF 按复赛 4 项必交材料整理 ⑬ 运行说明 README/部署文档核对 ⑭ 合规说明核对（数据来源/边界/第三方披露/思政内容，含语音处理） | 资产包 + 视频初稿 + 提交材料包 V1 |
| 9.1–9.3 | ⑮ 全链路回归（评测不退化、154 测试通过）⑯ 最终提交 | 提交材料包 V2 |

### 7.2 若入围决赛（9.10 公布，9 月中旬线下路演）

- 现场路演材料：产品故事线（学生/教师双视角）+ 3 分钟 Demo 精剪 + 技术深挖备答（52 步推理/四源 RRF/自适应四层）；
- 加分项：教育场景金标集扩充至 60+ 题、双模态（拍照/语音）演示、多学科扩展（数学/英语/编程）。

### 7.3 后续迭代（赛外）

- **教育专属 Agent 编排扩展**：编排层开放自定义教学法插件（如费曼学习法、案例教学），教育记忆跨会话沉淀；
- **自动闭环增强**：采集面扩展（答题时长、卡点停留、阅读行为），自动迭代增加「不打扰」策略（低风险信号不触发干预，避免过度打扰）；
- **教育知识库**：接入国家智慧教育平台公开资源、OpenStax 等开放许可教材，扩充学科切片；
- **多模态增强**：公式 OCR 结构化为 LaTeX、手写体识别、发音评分（音素级）、多轮口语对话测评、板书实时跟随；
- **数据合规增强**：数据分级与生命周期审计工具（自动扫描学情数据保留期、超期自动清理）、家长/教师知情流程、合规基线自动化检查（对接 5.2 数据脱敏/权限隔离指标）；
- **思政内容审核增强**：审核规则库扩充（权威表述词表、易错表述对照）、审核结果可视化审计台、与思政期刊 C 刊语料联动校准；
- **角色页面扩展**：家长端（学习报告/陪伴监督）、教务端（班级总览/教研计划），「AI+教育」Tab 内继续加子 Tab；角色权限粒度细化（每能力独立授权）。

### 7.4 教育复用资产（开放/复用价值，冲刺期落地）

> 核实现状：通用资产已具备（`source_chunks` 知识库切片、知识页 `knowledge_page`/`knowledge_page_drafts` 表、demo 脚本），但**教育场景模板/示例课程/教学案例库缺位**。对应手册 1.3「鼓励形成可开放、可复用的应用模板、工具组件、示例数据或技术文档」与评审维度「复制、迁移或推广潜力」。以下为冲刺期资产计划。

| 资产 | 形态 | 复用对象 | 冲刺期落地（8.25–9.3） |
|---|---|---|---|
| **教育场景模板** | `education-templates/` 目录：作业辅导/学情诊断/备课/陪伴各一套示例 JSON + 前端卡片 | 教育从业者 | 每模板附输入样例 + 预期输出 + 路由说明 |
| **示例课程** | 2 门示范课程（如《政治经济学批判导言》《价值规律》）完整切片：`source_chunks` 入库脚本 + 知识页 + 备课教案 | 教师/机构 | `scripts/seed-edu-courses.ts` 一键入库 |
| **教学案例库** | 作业辅导/学情诊断/备课典型用例 10+ 条（含苏格拉底对话、分层教案、诊断报告样例） | 教研团队 | `data/education-cases.json` + 检索入口 |
| **模拟学情数据** | 匿名学生作答序列（预设薄弱点/掌握度轨迹） | 评测/演示/教研 | `data/edu-sim-student*.json`（与 5.2 评测复用） |
| **工具组件** | `view_education_profile` 学情画像工具 + 教育服务 33 路由 API 文档 | 开发者 | 复用现有 44 工具体系，文档化 |

**复用协议**：教育模板/示例课程/教学案例库以本项目 **AGPL v3 + 商业授权** 双许可开放；模板与案例数据不涉学生个人信息（均为模拟数据），可直接复用与二次开发。

---

## 8. 附录

### 8.1 复赛提交材料清单对照（手册 6.2）

| 必交材料 | 本方案对应 |
|---|---|
| 更新版项目方案（PPT/PDF） | 本文档（可转 PDF/PPT） |
| 可运行 Demo / Demo 视频 | 第 6 节脚本 + 演示视频（录制中） |
| 代码仓库/等价工程材料 | [LDF924/MarxSphere](https://github.com/LDF924/MarxSphere)，含运行入口、依赖、配置、示例数据、部署与测试方法 |
| 数据来源与合规说明 | 第 4 节 + THIRD_PARTY_NOTICES.md + OPEN-SOURCE-DISCLOSURE.md |

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
| [src/services/agent-education.ts](../src/services/agent-education.ts) | **教育专属 Agent 编排层（§3.5，复赛冲刺期规划）** |
| [src/services/cognitive-diagnosis.ts](../src/services/cognitive-diagnosis.ts) | **BKT 认知诊断（§3.8，复赛冲刺期规划）** |
| [src/services/knowledge-graph-edu.ts](../src/services/knowledge-graph-edu.ts) | **知识点先修图 + 拓扑路径规划（§3.8，复赛冲刺期规划）** |
| [src/services/content-audit-service.ts](../src/services/content-audit-service.ts) | **思政内容四维核验（§4.5，复赛冲刺期规划）** |
| [scripts/seed-edu-courses.ts](../scripts/seed-edu-courses.ts) | **示例课程入库脚本（§7.4，复赛冲刺期规划）** |
| [data/education-cases.json](../data/education-cases.json) | **教学案例库（§7.4，复赛冲刺期规划）** |
| [web/src/components/EducationPanel.tsx](../web/src/components/EducationPanel.tsx) | 前端教育视图 |
| [scripts/eval-32-metrics.ts](../scripts/eval-32-metrics.ts) | 评测脚本（53 题基线 0.884） |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | 第三方源码披露 |
| [docs/OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md) | 开源/依赖/模型/合规披露 |
