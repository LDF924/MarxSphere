# 多 Agent 系统（Multi-Agent）

MarxSphere 多代理编排（2026-08-27）：主管-工人模式 + 并行任务 + 协作协商 + 消息协议。

## 架构

```
主管(Orchestrator) ── 拆解任务 ──→ 工人(Worker) 并行执行
     │                                  │
     └── 协商(协作) ←──────── 结果汇总/冲突仲裁
```

## 核心组件

| 组件 | 文件 | 说明 |
|---|---|---|
| **主管编排** | `agent-orchestrator.ts` | 任务拆解 → 分配工人 → 汇总 → 评审 |
| **工作流** | `agent-workflows.ts` | 预定义多步工作流（研究/写作/分析） |
| **任务队列** | `agent-task-queue.ts` | 并行任务调度（并发上限） |
| **任务链** | `agent-task-service.ts` | 任务依赖 DAG、续作、checkpoint |
| **协作协商** | `agent-orchestrator.ts` 协商模块 | 多 Agent 观点冲突 → 确定性规则兜底 |
| **消息协议** | 结构化消息（fromAgent/toAgent/msgType/payload） | Agent 间通信 |
| **执行日志** | `agent-exec-log.ts` | 全链路追踪（span 树） |

## 能力

### 1. 主管-工人编排
- 目标 → 步骤拆解 → 每步分配给工人（工具/LLM）
- 工人执行 → 结果回传 → 主管评审/合并
- 失败重试/降级链

### 2. 并行任务
- 任务队列并发执行（上限可配）
- 独立会话隔离（变量/上下文不串）

### 3. 协作协商
- 多 Agent 对同一问题给观点
- 冲突时确定性规则（多数/置信度）兜底
- 协商结果记录

### 4. 任务链续作
- 任务依赖 DAG（A 完成后 B 才能跑）
- checkpoint 恢复（中断后续跑）

### 5. 消息协议
```
{ fromAgent, toAgent, msgType: "result"|"ask"|"approve"|"replan", payload }
```

### 6. 角色
- 研究者（Research）→ 生成者（Draft）→ 评审者（Review）→ 反思（Reflect）
- 轻量多 Agent 循环（V373）

## 前端

AgentConsole：
- 任务面板（任务列表/状态/依赖图）
- Worker 面板（工人状态/负载）
- 消息流（Agent 间消息实时查看）
- 协作记录

## 相关文件

- `src/services/agent-orchestrator.ts` — 主管编排/协商
- `src/services/agent-workflows.ts` — 工作流
- `src/services/agent-task-service.ts` — 任务/依赖/checkpoint
- `src/services/agent-task-queue.ts` — 并行队列
- `src/services/agent-exec-log.ts` — 执行日志
- `docs/AGENT-ARCHITECTURE-NEXT.md` — 架构演进规划
