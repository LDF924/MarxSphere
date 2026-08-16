# Agent 子系统环境变量参考（G21）

> 所有 `AGENT_*` 变量均为可选，未设置时使用默认值。写入 `.env` 或进程环境。

## 任务执行

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MAX_LOOPS` | `3` | Agentic Loop 最大轮数（初始 + N 次修订） |
| `AGENT_PASS_THRESHOLD` | `0.65` | reflect 判定达标阈值（LLM 评分 ≥ 此值视为完成） |
| `AGENT_TASK_TIMEOUT_MS` | `600000` | 任务总时长上限（超时置 failed 并沉淀经验） |
| `AGENT_BUDGET_CENTS` | `300` | 任务预算上限（分）；超预算自动降级（减步骤/换便宜模型） |
| `AGENT_STEP_RETRIES` | `3` | 步骤级最大重试次数（初始 + 指数退避） |
| `AGENT_RETRY_BASE_MS` | `1000` | 步骤重试退避基数（第 n 次等待 base×2^(n-1)，上限 30s） |

## 队列 / 并发

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_QUEUE_CONCURRENCY` | `2` | 任务队列最大并发执行数 |
| `AGENT_LLM_CONCURRENCY` | `8` | 全局 LLM 调用并发信号量（超出排队等待） |

## 编排

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MAX_WORKERS` | `3` | 主管拆包最大并行工人数 |

## 审批

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_APPROVAL_TIMEOUT_MINUTES` | `60` | 等待审批超时分钟数（超时按拒绝处理，绝不自动放行） |
| `AGENT_APPROVAL_CHECK_MS` | `1800000` | 审批超时巡检间隔（默认 30 分钟） |

## 对话记忆

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_CHAT_SESSION_TTL_MS` | `86400000` | 会话内存 TTL（24h 未访问自动清除，持久化摘要仍可恢复） |

## 安全

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_TOOL_WHITELIST` | 空（不限制） | 工具白名单（逗号分隔）；deny 工具白名单开启后需审批 |
| `AGENT_NET_WHITELIST` | 内置列表 | 网络出口白名单（逗号分隔域名）；未配置=全部拒绝（防 SSRF） |

## 通用 LLM（Agent 相关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_MAX_RETRIES` | `2` | callLlm 最大重试次数（429 退避加倍、5xx/超时重试、4xx 不重试） |
| `LLM_TIMEOUT_MS` | `60000` | LLM 请求超时 |

## 相关通用变量（Agent 使用）

- `DEEPSEEK_API_KEY` / `DS_BASE_URL`：DeepSeek 原生端点（优先于 LLM_API_KEY）
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`：备选 LLM 提供方
- `DATABASE_URL`：PostgreSQL 连接串（Agent 全部持久化）
- `SAG_AUTH_ENABLED`：`true` 时启用令牌鉴权（localhost 豁免）
