# SAG Agent 能力总览（2026-08-16 终版）

> AI Agent 子系统完整能力归档。对标 OpenAI Codex + DeepSeek Harness 开源实现，50 项特性全部吸收。

## 一、核心架构

| 层 | 能力 | 实现 |
|---|---|---|
| 决策循环 | 规划→选工具→执行→reflect→replan（最多3轮） | `agent-task-service.ts` |
| 协商修订 | 主管审阅工人产出→发修订指令→重新产出（确定性规则兜底） | `agent-orchestrator.ts` |
| 计划验证 | 缺 write/retrieve 步骤自动补齐；目标歧义先澄清 | `planWithLlm` + `assessGoalClarity` |
| 计划确认 | 执行前展示计划，确认后才执行 | `POST /tasks/:id/confirm-plan` |
| checkpoint | 每轮落快照（loop/plan/failures），重启续跑 | 迁移 069 |
| token 预算 | 任务级 400K token 上限，超预算终止 | `AGENT_TASK_TOKEN_BUDGET` |

## 二、工具（23 个）

| 类别 | 工具 |
|---|---|
| 认知 | sag_reason / sag_retrieve / sag_search / sag_get_event / concept_trace / policy_search / review_output / summarize / pdf_parse |
| 行动 | run_code(3级沙箱) / run_command / web_fetch / web_search / file_read / file_write / apply_patch / empirical_analysis / sag_ingest |
| 协作 | agent_subagent(外部Agent) / attachment_read / code_search / todo_update |

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
AGENT_AUTONOMY=suggest|auto-edit|full-auto   AGENT_PRESET=academic|data|writing|coding
AGENT_SANDBOX_PROFILE=read-only|workspace-write|full-access
AGENT_TASK_TOKEN_BUDGET=400000   AGENT_TASK_TIMEOUT_MS=600000
AGENT_TOOL_TIMEOUT_MS=90000      AGENT_QUEUE_CONCURRENCY=2
AGENT_LLM_CONCURRENCY=8          AGENT_PROACTIVE_RESEARCH=1
AGENT_IDENTITY=...               AGENT_TOOL_WHITELIST=...  AGENT_NET_WHITELIST=...
```

## 八、迁移（068-076）

```
068 语料库四表  069 checkpoint   070 凭证   071 会话前缀
072 消息线程    073 任务依赖DAG  074 反馈    075 设置持久化
076 执行日志元数据
```

## 九、与开源对标

| 维度 | 对齐 |
|---|---|
| OpenAI Codex | 工具 registry/parallel、3级沙箱、guardian 策略、compact 预算、approval modes、AGENTS.md、网络审批、分派追踪、turn 元数据、prewarm |
| DeepSeek Harness | goal-round checkpoint、subagent 调外部Agent、hooks、preset、apply_patch、todo、spill、subprocess、session-query、feedback、credentials |
| SAG 独有 | 三库知识图谱检索、学术语料库、四层记忆、实证工作台、主动研究、65 科研场景 |

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
08-07  P2 任务规划器基础 → 08-15 V391-396 Agent 体系（40+ 能力）
08-16  审计 26 项补齐（迁移 067）→ 行动工具 5 项（9→16 工具）
08-16  学术语料库（四大子库+Agent 注入）→ 白屏修复+ErrorBoundary
08-16  借鉴 Codex/DSH 5 项（registry/沙箱3级/checkpoint/外部Agent/guardian）
08-16  差距 A-T 20 项 → 收尾（UI/文档/单测）→ 50 项特性终版
```
