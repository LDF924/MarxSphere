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

## 前端

- MemoryPanel：记忆浏览/搜索/整理
- OpenViking 状态：可用性/记忆数量/最近整理报告

## 相关文件

- `src/services/agent-chat-memory.ts` — 对话记忆
- `src/services/agent-episodic-memory.ts` — 情景记忆
- `src/services/strategic-memory-service.ts` — 战略记忆
- `src/services/openviking-memory.ts` — OpenViking 记忆层
- `src/services/memory-maintenance-service.ts` — 记忆整理
- `scripts/sag-memory-probe.sh` — 记忆健康探测
