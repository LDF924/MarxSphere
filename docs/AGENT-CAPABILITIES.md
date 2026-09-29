# MarxSphere Agent 能力总览

> AI Agent 子系统的完整能力归档。对标 OpenAI Codex + DeepSeek Harness 开源实现。
>
> **规模（由 `npm run docs:check` 持续校准）**：**158 个 agent 工具**（102 通用 + 56 视图）
> ｜**191 项编排能力**（可从编排画布调度的全集）｜教育专属 Agent（13 个教育服务文件、122 教育路由 + 学习引擎顶层 39）。
>
> ⚠ 本文只写**能力面**。工具名与中文标签的**真源**是运行时的 `/api/agent/tools`
> （前端不再持有清单 —— 曾经手抄过一份，烂掉了 37/74）。要列当前全量工具：
> `curl -s localhost:4173/api/agent/tools -H "Authorization: Bearer <token>"`

## 一、核心架构

| 层 | 能力 | 实现 |
|---|---|---|
| 决策循环 | 规划→选工具→执行→reflect→replan（最多3轮） | `agent-task-service.ts` |
| 协商修订 | 主管审阅工人产出→发修订指令→重新产出（确定性规则兜底） | `agent-orchestrator.ts` |
| 计划验证 | 缺 write/retrieve 步骤自动补齐；目标歧义先澄清 | `planWithLlm` + `assessGoalClarity` |
| 计划确认 | 执行前展示计划，确认后才执行 | `POST /tasks/:id/confirm-plan` |
| checkpoint | 每轮落快照（loop/plan/failures），重启续跑 | 迁移 069 |
| token 预算 | 任务级 400K token 上限，超预算终止 | `AGENT_TASK_TOKEN_BUDGET` |
| 工具权限分级 | reader / analyst / manager 三档；**未登记的工具缺省要 manager** | `TOOL_MIN_ROLE`（`agent-tool-router.ts`） |
| 写工具隔离 | `WRITE_TOOLS` 白名单；只读会话拿不到写工具 | `agent-tool-router.ts` |
| 任务租约 | 跨进程防双跑 | 迁移 071+ |

## 二、工具族（按模块分，共 158）

工具**分散在 7 个模块**，不是单个文件 —— 数工具时别只数 `agent-tool-router.ts`（那样会少算一半）：

| 模块 | 覆盖 |
|---|---|
| `agent-tool-router.ts` | 基础域：检索 / 推理 / 行动 / 协作 / 教育 / 文件 |
| `agent-view-tools.ts` | 知识域视图 + **上传文件正文（fileId → 文本）** |
| `agent-review-tools.ts` | 论文质量评审（建/重审/取消 + 期刊库 + 标准库 + 导出） |
| `agent-viz-tools.ts` | 成果可视化工坊（建任务/数据集/产物/转素材/模型） |
| `agent-editor-tools.ts` | 学术文本工作台（文档 CRUD + 版本 + 14 个 AI 动作 + 图表 + 导出 Word） |
| `agent-orch-tools.ts` | 课题流程编排（能力表/运行/事件流/图 CRUD/单步/控制/恢复） |
| 插件 | `data/plugins/*.ts` 热加载（`agent_plugins` 表） |

代表性能力（**不是全量**，全量见 `/api/agent/tools`）：

| 类别 | 例子 |
|---|---|
| 认知 | `sag_reason` / `sag_retrieve` / `sag_search` / `concept_trace` / `policy_search` / `pdf_parse` |
| 教育 | `education_service`（learning-plan / tutoring / diagnosis / lesson-plan / socratic / grade / bkt-track 等 15 动作） |
| 行动 | `run_code`（3 级沙箱）/ `run_command` / `web_fetch` / `web_search` / `file_read` / `apply_patch` / `empirical_analysis` / `sag_ingest` |
| 协作 | `agent_subagent` / `attachment_read` / `code_search` / `todo_update` |
| **写作舱** | `view_research_*`（项目/素材/证据/假设/大纲/投稿台账）+ `research_proposal_generate` / `research_component_generate` |
| **文件** | `view_review_files` / `view_file_text`（**按 fileId 取正文**）/ `ocr_file` / `view_ocr_job` |

工程特性：并行执行（registry）、LRU 缓存（50条/5min）、超时熔断（90s）、参数 schema 校验、分派追踪、fallback 链、降级链。

## 三、安全（5 层）

1. **Guardian 策略文件**（可编辑热更新）— 风险×授权→allow/deny/review
2. **3 级沙箱** — read-only(禁网) / workspace-write(预授权) / full-access(白名单代理)
3. **网络审批** — SSRF 高危直接拒绝，白名单外域名需人工确认
4. **审批门** — 高危工具四态（approve/edit/reject/respond）+ 自主级别（suggest/auto-edit/full-auto）
5. **凭证隔离** — 凭据脱敏存储（迁移070）、沙箱环境剔除 API Key

## 四、记忆（5 层）

- 情景记忆（研究轨迹，可检索遗忘）
- 战略记忆（项目目标约束）
- 技能蒸馏（EDV 评审，含工具用法）
- 防错规则（用户反馈/评测失败自动沉淀）
- **语料库**（四大子库：文本/概念/逻辑/句式，Agent 写作自动注入）

## 五、调度与运维

- 队列并发（优先级 enterprise/pro/free）
- **DAG 依赖**（depends_on，前置完成后才执行）
- 会话恢复（前缀锚点 + 跨会话检索）
- 设置持久化（预设/自主级别/沙箱级别落库+启动恢复）
- 诊断（LLM 并发/队列/SSE/内存/子进程）
- hooks 生命周期（7 事件，注册/注销/超时隔离）
- 主动研究（每日自主巡检：失败任务/评测回退/热点→新研究任务）
- 反馈闭环（👍👎→防错规则+记忆回流）
- 通知（完成告警+toast）+ 自省报告 + 失败恢复建议
- 子进程治理（超时自动清理防孤儿）

## 六、评测

- 回归评测集（gold 任务 + 故障注入：429/超时/降级）
- 24h 自动回归 + 通过率告警
- 学习曲线 + 成本审计 + 轨迹级指标

## 七、环境变量（关键）

```
AGENT_AUTONOMY=suggest|auto-edit|full-auto AGENT_PRESET=academic|data|writing|coding
AGENT_SANDBOX_PROFILE=read-only|workspace-write|full-access
AGENT_TASK_TOKEN_BUDGET=400000 AGENT_TASK_TIMEOUT_MS=600000
AGENT_TOOL_TIMEOUT_MS=90000 AGENT_QUEUE_CONCURRENCY=2
AGENT_LLM_CONCURRENCY=8 AGENT_PROACTIVE_RESEARCH=1
AGENT_IDENTITY=... AGENT_TOOL_WHITELIST=... AGENT_NET_WHITELIST=...
```

## 八、迁移

Agent 子系统的迁移从 068 起，**至今已到 165**（全库迁移总数见 `npm run docs:check` 的输出）。
早期那批（与本文件同期的）：

```
068 语料库四表 069 checkpoint 070 凭证 071 会话前缀
072 消息线程 073 任务依赖DAG 074 反馈 075 设置持久化
076 执行日志元数据
```

⚠ 上面只是**当时**这一批；后续的（OAuth 隔离、插件签名、运行事件流、密钥台账、文件正文…）
没有在这里续写 —— 迁移真源是 `migrations/` 目录本身，不在本文里维护一份副本。

## 九、与开源对标

| 维度 | 对齐 |
|---|---|
| OpenAI Codex | 工具 registry/parallel、3级沙箱、guardian 策略、compact 预算、approval modes、AGENTS.md、网络审批、分派追踪、turn 元数据、prewarm |
| DeepSeek Harness | goal-round checkpoint、subagent 调外部Agent、hooks、preset、apply_patch、todo、spill、subprocess、session-query、feedback、credentials |
| SAG 独有 | 三库知识图谱检索、学术语料库、四层记忆、实证工作台、主动研究、66 科研场景 |

## 十、验证状态（2026-08-16）

| 项 | 状态 |
|---|---|
| 单元测试 | 148/148 通过（22 文件：工具路由/LLM重试/语料库/高级函数等） |
| 类型检查 | 后端 `tsc --noEmit` ✓ 前端 `web/tsc --noEmit` ✓ |
| 迁移 | 068-076 全部应用成功（5540 库实测） |
| 端到端 | demo-agent.ts 实测跑通（创建→执行→日志→清理） |
| 浏览器 | 4173 生产构建含全部新面板（写作语料库/Guardian/Hooks/设置） |

## 十一、API 统计（60+ 端点）

- 任务 12 / 编排 4 / 对话记忆 5 / 执行日志 4 / 评测 6 / 技能 5
- 情景记忆 3 / 插件定时 5 / 队列曲线 2 / 模板 1
- 安全（Guardian/凭证/图片）7 / 自主预设设置 6 / 生命周期运维 8 / 工作流计划恢复 4

## 十二、演进史（2026-08 关键里程碑）

```
08-07 P2 任务规划器基础 → 08-15 V391-396 Agent 体系（40+ 能力）
08-16 审计 26 项补齐（迁移 067）→ 行动工具 5 项（9→16 工具）
08-16 学术语料库（四大子库+Agent 注入）→ 白屏修复+ErrorBoundary
08-16 借鉴 Codex/DSH 5 项（registry/沙箱3级/checkpoint/外部Agent/guardian）
08-16 差距 A-T 20 项 → 收尾（UI/文档/单测）→ 50 项特性终版
```

## 教育专属 Agent 编排

在通用编排（**158 工具**）之上新增**教育场景专属闭环**：

| 能力 | 服务/路由 | 说明 |
|---|---|---|
| 苏格拉底式提问 | `agent-education.ts` `socraticStart/Continue` | 连续追问引导（3 轮上限），不直接给答案 |
| 阶梯式启发 | `scaffoldedTutoring` | hint → guided → full 三级提示状态机 |
| 错题-知识点联动 | `wrongToMastery` | 错题→溯源→掌握度下调→变式→回升 |
| 学习进度追踪 | `learningProgress` | 计划完成率 + 掌握度变化 + 变式正确率 |
| 五步打磨 | `polishStep`（diverge/verify/focus/stress）| Hazel 式：记录→发散→初步验证（知识库密度）→聚焦→压力测试 |
| 子问题拆解 | `decomposeQuestions` | 从 Problem Statement 拆 2-4 个子问题 |
| 步骤追问 | `followUpPolish` | 对任一步输出苏格拉底式追问 |
| 想法卡 | `idea-cards/*`（list/create/update/delete）| 多想法并行管理（Hazel 式） |
| 教育策略校验 | `checkEducationPolicy` | 「不直接给答案」「不替代教师评价」边界 |
| BKT 认知诊断 | `cognitive-diagnosis.ts` | p(掌握) 贝叶斯推断 + 预测答对概率 |
| 知识点先修图 | `knowledge-graph-edu.ts` | kp_points/kp_edges + 拓扑路径规划 |
| 思政内容审核 | `content-audit-service.ts` | 四维核验（意识形态/表述/引用/边界）+ Compiled Truth 校准 |
| 自动闭环 | `auto-learning-loop.ts` | 钩子采集→自动诊断→回流迭代→周报 |
| 教育合规 | `education-compliance.ts` | 数据分级/清理/保留期/状态 |
| 教育多模态 | `education-multimodal.ts` | 作业拍照/口语测评/板书识别 |
