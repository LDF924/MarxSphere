# 记忆系统（Memory System）

MarxSphere 跨会话持久化记忆（2026-08-27）：分层记忆 + OpenViking 对话记忆层 + 自主整理。

## 分层架构

| 层 | 载体 | 内容 | 持久化 |
|---|---|---|---|
| **对话记忆** | `agent-chat-memory.ts` | 当前会话上下文 | 会话内 |
| **情景记忆** | `agent-episodic-memory.ts` | 任务执行经验（目标/步骤/结果/教训） | PG 表 |
| **战略记忆** | `strategic-memory-service.ts` | 项目目标/约束/决策/里程碑 | PG 表 |
| **OpenViking 记忆层** | `openviking-memory.ts` | 用户偏好/经验/历史交互（对话记忆） | OpenViking 服务（1933 端口） |

## OpenViking 对话记忆（V368+）

- **Recall@5 = 95% 无损**（DeepSeek V4 Flash 抽取）
- **3 个钩子**：recall（推理前注入相关记忆）/ commit（重要交互沉淀）/ remember（主动记忆）
- **分类体系**：偏好/经验/历史交互（V369）
- **持续运行**：bootstrap + watchdog + VBS 静默自启
- **记忆评测**：95%（V373）

## 记忆生命周期

```
交互 → commit/remember 钩子 → 抽取分类 → OpenViking 存储
                                            ↓
推理前 → recall 钩子 → 注入相关记忆 → 生成
                                            ↓
用户反馈(👍/👎) → 记忆更新
```

## 自主整理（memory-maintenance-service）

- 定期合并/归档/剪枝（避免记忆膨胀）
- 冲突检测与解决
- 遗忘策略（低价值记忆降权）

## 战略记忆（项目级）

- kind: goal（目标）/ decision（决策）/ constraint（约束）/ milestone（里程碑）
- source: user（用户）/ agent（Agent）/ system（系统）/ user_down（踩反馈）/ eval_failure（评测失败）
- 注入 Agent 规划（任务创建时约束注入）

## 记忆 Dream 巩固（V404-7 + V405 扩展）

**每日空闲凝练三通道**（`dream-consolidation-service.ts`，每日定时器零额外调度；`SAG_DREAM_SKILL_PROPOSE=0` 关技能/DAG 通道）：

| 通道 | 来源 | 去向 | 证据 |
|---|---|---|---|
| 记忆候选 | task_experience 反复成功任务(≥2次/跨天, 负评硬拦) | 隔离区 → accept 写 strategic_memory(回执) / reject / rollback | 候选带 `evidence[]`(支撑记录 id/query/质量分/策略, V405) |
| 技能蒸馏候选 | 高频任务 → auto-propose → EDV 验证 | 技能库 pending(AgentConsole 技能 tab) | — |
| MetaSkill DAG 提案 | 高频目标 → LLM 编排声明式工作流 | data/dag-proposals 隔离区 → MetaSkillPanel 审阅区 accept 注册可跑 | triggerGoal 去重, 每天 ≤2 条 |

- 人工审红线：**任何通道不自动 accept**（隔离区/待审区人工决定）
- 审计：accept 回执与 reject 隔离区记录均携带支撑证据（V405 evidence）——"这条记忆由哪几次任务/质量/策略支撑"可追溯
- 候选评分：频率(×0.35)+跨天(×0.35)+正评信号(×0.3)，负评=0 硬拦

## 前端

- MemoryPanel：记忆浏览/搜索/整理
- OpenViking 状态：可用性/记忆数量/最近整理报告

## 相关文件

- `src/services/agent-chat-memory.ts` — 对话记忆
- `src/services/agent-episodic-memory.ts` — 情景记忆
- `src/services/strategic-memory-service.ts` — 战略记忆
- `src/services/openviking-memory.ts` — OpenViking 记忆层
- `src/services/memory-maintenance-service.ts` — 记忆整理
- `src/services/dream-consolidation-service.ts` — Dream 每日空闲凝练(记忆/技能/DAG 三通道 + evidence)
- `scripts/sag-memory-probe.sh` — 记忆健康探测
