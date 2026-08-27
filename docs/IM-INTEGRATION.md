# IM 接入（远程对话）

MarxSphere IM 接入（2026-08-27）：通过 飞书 / 钉钉 / Telegram 机器人远程对话——查状态、项目、评测、审批、告警。

## 支持的平台

| 平台 | 配置 | 说明 |
|---|---|---|
| **飞书** | `IM_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx` | 自定义机器人 webhook |
| **钉钉** | `IM_DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx` | 自定义机器人 webhook |
| **Telegram** | `IM_TELEGRAM_TOKEN` + `IM_TELEGRAM_CHAT_ID` | Bot API |

## 能力

### 远程命令（发消息到机器人）

| 命令 | 返回 |
|---|---|
| `状态` | 服务/文献库数量/Notebook Python/记忆 |
| `项目` | 项目列表（最近 10 个） |
| `评测` | 最近评测 run |
| `审批` | 待审批任务 |
| `告警` | 最近告警 |
| `帮助` | 命令清单 |

### 主动推送（告警/审批通知）

`POST /api/im/send {text}` → 广播到全部已配置平台。
告警中心/审批流可调用 `imService.imBroadcast(text)` 主动推送。

## 接入步骤

### 飞书
1. 飞书开放平台 → 创建自定义机器人 → 复制 webhook
2. 配置 `.env`: `IM_FEISHU_WEBHOOK=...`
3. 事件订阅（可选，接收消息）: 把回调 URL 指向 `http://你的地址/api/im/feishu`

### 钉钉
1. 钉钉群 → 群机器人 → 自定义 → 复制 webhook（含 access_token）
2. 配置 `.env`: `IM_DINGTALK_WEBHOOK=...`
3. 接收消息: 回调 URL 指向 `http://你的地址/api/im/dingtalk`

### Telegram
1. @BotFather 创建 bot → 获取 token
2. 配置 `.env`: `IM_TELEGRAM_TOKEN=...` + `IM_TELEGRAM_CHAT_ID=...`
3. 接收消息: webhook 指向 `http://你的地址/api/im/telegram`（或轮询）

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/im/feishu` | POST | 飞书回调（含 URL 验证 challenge） |
| `/api/im/dingtalk` | POST | 钉钉回调 |
| `/api/im/telegram` | POST | Telegram 回调 |
| `/api/im/send` | POST | 手动广播 `{text}` |
| `/api/im/status` | GET | 平台配置状态 |

## 实现

- `src/services/im-service.ts` — 发送/接收/命令解析
- 免依赖（Node 18+ 内置 fetch），参考 email-service 的降级风格（未配置 → 静默跳过）
- 命令解析 `handleImCommand`：按关键词路由（状态/项目/评测/审批/告警/帮助）
