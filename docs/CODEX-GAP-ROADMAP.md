# CODEX-GAP-ROADMAP — SAG 对齐 openai/codex 差距清单与实施路线

> 2026-09-01 基于 openai/codex 开源仓库(codex-rs)深读盘点,与 SAG Agent Loop 逐项比对。
> Codex 为 Rust 实现,架构语言不同 → 不能直接搬 .rs 源码;但**设计模式/阈值/提示词模板**可直接移植。
> 盘点来源: 3 个并行深读报告(核心循环/压缩澄清/工具钩子权限)。

## 差距分级

- **P0 缺失**(SAG 完全没有,直接影响任务质量/成本): 预算提醒注入 / 压缩不终止 / 时间提醒
- **P1 缺失**(SAG 没有,影响交互与安全): Elicitation / Stop钩子 / 审批三级链 / 工具钩子
- **P2 增强**(SAG 有雏形,需对齐 Codex 深度): 世界状态diff / 嵌套调用追踪 / 权限Profile / Agent路径

---

## A. 循环控制层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| A1 | 采样前预压缩 (PreTurn) | turn.rs:1033 token_limit_reached 即压缩(DoNotInject) | 无(仅 reflect/汇总时压缩) | **P0 缺失** | P0 |
| A2 | Mid-turn 滚动压缩 | turn.rs:414-501 上下文超限→压缩→continue,不终止 | 无(超限即失败) | **P0 缺失** | P0 |
| A3 | Rollout 预算提醒注入 | rollout_budget.rs:8 剩余token作为对话消息,窗口去重 | 有硬终止(token预算超限即failed),无提醒注入 | P0 增强 | P0 |
| A4 | Token 预算阈值提醒 | token_budget.rs:110 阈值6_144,每窗口一次,模板注入 | 无 | **P0 缺失** | P0 |
| A5 | 压缩回退提示 (AutoCompactFallbackPrompt) | token_budget.rs:146 零剩余注入降级引导,claim去重 | 无 | P1 缺失 | P1 |
| A6 | 时间提醒注入 | current_time_reminder.rs `<current_time_reminder>` | 无 | **P0 缺失** | P0 |
| A7 | 世界状态按步 diff | mod.rs:3308 merge_patch 只注入变化 | 每轮全量注入 | P2 增强 | P2 |
| A8 | 单请求视图捕获 (StepContext) | mod.rs:3365 上下文/工具/权限同一不可变快照 | 部分(步骤执行时各自取) | P2 增强 | P2 |
| A9 | 上下文超限滚动窗口 (窗口ID链) | turn.rs:461 压缩后开新窗口,ID链进模型上下文 | 无 | P1 缺失 | P1 |
| A10 | follow_up 五源汇聚 | turn.rs:2428 工具调用/end_turn/mailbox/steer | 有(步骤执行完后继续循环) | ✅ 已有 | - |

## B. 输入/挂起层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| B1 | Steer 输入入队 | turn_input.rs:551 回合中用户转向,校验expected_turn_id | 有 pause/resume,无 steer(回合中注入新输入) | P1 缺失 | P1 |
| B2 | Mailbox 双通道 | input_queue.rs 多代理邮件抢占当前回合 | 无(工人结果直接回传) | P2 缺失 | P2 |
| B3 | 回合挂起优雅关停 | turn_suspension.rs:13 先flush再取消,限时优雅退出 | 有 pause(状态置位),无 flush/优雅退出 | P2 增强 | P2 |
| B4 | Elicitation 暂停协调 | elicitation.rs 计数暂停,工具结果等追问完成 | 无 | **P1 缺失** | P1 |

## C. 工具层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| C1 | PreToolUse 钩子输入改写 | hook_runtime.rs:184 updated_input 重写参数 | 无(只有任务级钩子) | **P1 缺失** | P1 |
| C2 | PostToolUse 钩子反馈 | hook_runtime.rs:285 failure_message 替换模型可见输出 | 无 | **P1 缺失** | P1 |
| C3 | 注册表冲突检测 | registry.rs:316 trusted重复panic/external记录collision | 有(ToolRegistry register 冲突抛错) | ✅ 已有 | - |
| C4 | 已执行工具调用追踪(嵌套cell) | executed_tool_calls.rs 五态cell+重放+裁剪 | exec_logs 平铺,无嵌套归属 | P2 增强 | P2 |
| C5 | 审批三级决策链 | approvals.rs:495 Hooks→Guardian→User | 只有人工审批门 | **P1 缺失** | P1 |
| C6 | 审批缓存(命令指纹) | approvals.rs:155 ApprovalCacheKey | 无 | P1 缺失 | P1 |
| C7 | 沙箱+审批升级重试 | orchestrator.rs:125 被沙箱拒→二次审批→升级策略 | 有3级沙箱,无审批联动升级 | P2 增强 | P2 |
| C8 | 工具暴露矩阵 | spec_plan.rs:196 Direct/Deferred/CodeMode 三路暴露 | 无(全部直出) | P2 增强 | P2 |

## D. 钩子层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| D1 | Stop 钩子三target | hook_runtime.rs:375 Stop/SubagentStop/MemoryConsolidation | 无(回合结束无钩子) | **P1 缺失** | P1 |
| D2 | Async 钩子结果回流 | hook_runtime.rs:757 结果经channel注入input_queue | 无 | P1 缺失 | P1 |
| D3 | SessionStart/UserPromptSubmit | hook_runtime.rs:124/660 上下文注入 | 有 task_start/task_end | P2 增强 | P2 |
| D4 | Pre/PostCompact 钩子 | hook_runtime.rs:527/564 | 无(无压缩生命周期) | P2 缺失 | P2 |

## E. Agent 通信层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| E1 | Agent 树控制面+路径解析 | control.rs:445 AgentPath 相对解析 | 有 worker_tasks + agent_messages,无路径树 | P2 增强 | P2 |
| E2 | Spawn 预占 RAII | registry.rs:96 原子限流+回滚 | 有 MAX_WORKERS,无预占 | ✅ 已有 | - |
| E3 | 子代理完成回流 | control.rs:574 终态→InterAgentCommunication Result | 有协商修订(更强) | ✅ 已有 | - |
| E4 | V2 驻留 LRU 卸载 | residency.rs:18 容量满卸载空闲子代理 | worker 短命,无驻留 | P2 缺失 | P2 |
| E5 | 角色覆盖裁剪(非加权) | role.rs:51 只禁用不增加 | 动态角色(可加可减) | ✅ 已有 | - |

## F. 评审层

| # | Codex 能力 | Codex 实现 | SAG 现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| F1 | 独立评审线程+独立模型 | review.rs:7 独立turn/模型/推理强度中间档 | 有 reviewWorkerOutputs(2视角+对抗) | ✅ 已有(更完整) | - |
| F2 | 评审会话工具隔离 | spec_plan.rs:973 评审会话仅3工具 | 无 | P2 缺失 | P2 |
| F3 | Guardian 自动评审(90s超时+拒绝熔断) | guardian/review.rs:797 独立线程,每轮最多3次连续拒绝 | 有 Guardian 策略,无自动评审线程 | P2 增强 | P2 |

---

## 实施状态(2026-09-01 已完成 4 批)

| 批次 | 内容 | commit |
|---|---|---|
| 第一批 | 预算/时间提醒(Rollout 50K/TokenBudget 6_144/时间) + Mid-turn 压缩不终止 + Elicitation 暂停协调 + Stop/PreToolUse/PostToolUse/PermissionRequest 钩子 + 审批三级链第一级 | f7629d4f |
| 第二批 | Guardian 拒绝熔断 + 嵌套调用 spanType | c4874915 |
| 第三批 | 世界状态 diff(reflectLog.reviewedStepIds 增量注入) | 50aacae1 |
| 第四批 | 滚动窗口推进(压缩后新窗口去重) | b27222c3 |

| 第五批 | B1 Steer / B2 Mailbox / B3 挂起检查点 / C6 审批缓存 / C8 暴露矩阵 / D3 SessionStart / E4 LRU / F2 评审隔离 | (第五批 commit) |

**✅ 全部差距已清零(2026-09-01)** — 六层 30 项能力全部落地或确认已有。

## 实施路线(按依赖排序)

### 第一批(P0 循环层,独立性强,直接提升质量/成本)
1. **A3+A4+A6 预算与时间提醒注入** — 新服务 `agent-reminder-service.ts`:Rollout剩余token/TokenBudget阈值(6_144)/CurrentTime 三提醒,作为对话消息注入下一轮 reflect/replan prompt(窗口去重)。Codex 模板文案直接移植。
2. **A1+A2 压缩不终止** — 改造 runAgentTask:上下文超限(估 token > 阈值)不再失败,触发 compressContext 压缩后 continue;压缩结果带窗口标记进下一轮。
3. **A9 滚动窗口** — 压缩后 window_id 递增,注入模型上下文告知已压缩。

### 第二批(P1 交互/安全层)
4. **B4 Elicitation 暂停协调** — 新服务 `agent-elicitation-service.ts`:计数注册+暂停,工具执行后等待追问完成(对齐 code_mode execute_handler)。
5. **D1 Stop 钩子** — agent-hooks 加 `turn_stop` 事件(Stop/SubagentStop),返回 should_stop/should_block(block 注入继续)。
6. **C1+C2 工具钩子** — PreToolUse(可改写输入)/PostToolUse(feedback)挂到 exec 主管线。
7. **C5+C6 审批三级链+缓存** — 审批门改为 PermissionHook→Guardian→User 三级,命令指纹缓存。

### 第三批(P2 深度增强)
8. **A7 世界状态 diff** — 每步只注入变化片段。
9. **C4 嵌套调用追踪** — exec_logs 加 parent_call_id。
10. **F3 Guardian 自动评审线程** — 独立线程评审+拒绝熔断。

## 移植边界(能用源码的部分)
- ✅ **提示词模板**: codex-rs/core/templates/(compact/prompt.md 等)+ token_budget_context.rs 的 reminder/fallback 模板文案 — 直接翻译复用
- ✅ **阈值**: 6_144 reminder / 64_000 retain / 20_000 user message / 90% 窗 / 32KB output / 8KB call — 直接采用
- ✅ **设计模式**: 窗口去重(claim)、三target钩子、计数暂停、倒序保留、原子截断 — 模式移植
- ❌ **Rust 源码**: 语言不通,不搬;按上述模式在 TS 侧自研
