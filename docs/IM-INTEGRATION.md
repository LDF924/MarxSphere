# IM 接入（远程对话）

MarxSphere 的 **IM 接入** = 在聊天软件里放一个 MarxSphere 机器人，让你**不用打开网页**，直接在 飞书 / 钉钉 / Telegram / 企业微信 里发消息就能查状态、批任务、收告警。配置入口在 Web 端 **系统管理 → IM 接入** 面板（保存即时生效）。

## 一句话理解

```
你在聊天软件里发消息 ──► MarxSphere 机器人 ──► 系统查库/执行 ──► 结果回复到聊天
系统主动推送(告警/审批/任务完成) ──► 你的聊天窗口
```

## 消息流转示意

```mermaid
flowchart LR
    subgraph 你的聊天软件
        A[钉钉 / 飞书 / Telegram / 企业微信 机器人会话]
    end
    subgraph MarxSphere
        B[回调入口<br/>/api/im/feishu|dingtalk|telegram|wecom]
        C[命令解析<br/>handleImCommand]
        D[(PostgreSQL<br/>文献库/任务/评测/告警)]
        E[回复推送<br/>sendFeishu/sendDingtalk/...]
    end
    A -- "发『状态/项目/评测/审批/告警』" --> B
    B -- 解析关键词 --> C
    C -- SQL 查询 --> D
    C -- 组织回复文本 --> E
    E -- 推送到原会话 --> A
    F[系统内部<br/>告警/审批完成] -- imBroadcast 主动推送 --> E
```

> 飞书/钉钉 为「webhook 单向回调」：平台把消息 POST 到你配置的回调 URL。
> 企业微信为「自建应用双向」：GET 做 URL 验证，POST 收加密消息（AES-256-CBC），回复走 `message/send` API。

## 支持的平台

| 平台 | 模式 | 配置（面板或 env） | 说明 |
|---|---|---|---|
| **钉钉** | 群机器人 webhook | `dingtalkWebhook` / `IM_DINGTALK_WEBHOOK` | 群自定义机器人，单向推送 + 回调接收 |
| **飞书** | 自定义机器人 webhook | `feishuWebhook` / `IM_FEISHU_WEBHOOK` | 同上 |
| **Telegram** | Bot API | `telegramToken` + `telegramChatId` / `IM_TELEGRAM_*` | 需 @BotFather 建 bot |
| **企业微信** | 群机器人 webhook（推送）+ **自建应用双向**（收发） | `wecomCorpId/Secret/AgentId/CallbackToken/EncodingAesKey/Touser` + `wecomWebhook` | 自建应用含 AES 加解密回调，群机器人只需 webhook |

> 配置存数据库 `im_config` 表（迁移 112/113），**前端面板修改即时生效、无需重启**；`.env` 变量仅在 DB 未配置时兜底。

## 远程命令

向机器人发送消息即触发命令解析：

| 命令关键词 | 返回 |
|---|---|
| `状态` / `status` | 服务状态 · 文献库篇数 · Notebook Python 就绪 · 记忆 |
| `项目` / `project` | 项目列表（最近 10 个） |
| `评测` / `eval` | 最近评测 run |
| `审批` / `approve` | 待审批任务 |
| `告警` / `alert` | 最近告警 |
| `帮助` / `help` / `?` | 命令清单 |

## 主动推送（系统 → 聊天）

`POST /api/im/send { "text": "..." }` → 广播到**全部已配置**平台（含企业微信：有群机器人 webhook 走 webhook，否则走自建应用发给 touser）。
告警中心 / 审批流 / 任务完成事件可调用 `imService.imBroadcast(text)` 主动推送到聊天。

## 接入步骤（Web 面板，推荐）

1. 打开 **系统管理 → IM 接入** 面板
2. 按平台创建机器人并取得凭据（见下）
3. 在面板填写并「保存配置」（即时生效）
4. 点「发送测试」验证连通
5. 把对应**回调地址**填进平台机器人配置（面板已展示）

### 各平台创建机器人要点

- **钉钉**：群 → 群机器人 → 自定义 → 复制 webhook（含 access_token）
- **飞书**：飞书开放平台 → 自定义机器人 → 复制 webhook；事件订阅指向回调地址
- **Telegram**：@BotFather 建 bot 得 token；回调地址填 `/api/im/telegram`
- **企业微信**：
  - 群机器人：群 → 添加群机器人 → 复制 webhook（发消息需在机器人安全设置加关键词或 IP 白名单）
  - 自建应用：管理后台 → 应用管理 → 自建 → 取 CorpID / Secret / AgentId；接收消息服务器配 Token + EncodingAESKey(43 字符)，URL 填 `/api/im/wecom`

## API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/im/feishu` | POST | 飞书回调（含 challenge URL 验证） |
| `/api/im/dingtalk` | POST | 钉钉回调 |
| `/api/im/telegram` | POST | Telegram 回调 |
| `/api/im/wecom` | GET | 企业微信 URL 验证（echostr 解密回显） |
| `/api/im/wecom` | POST | 企业微信加密消息回调（验签 + AES 解密 → 命令 → 回复） |
| `/api/im/wecom/send` | POST | 企业微信测试发送（`{mode:"app"\|"webhook", content}`） |
| `/api/im/send` | POST | 手动广播到全部平台 `{text}` |
| `/api/im/status` | GET | 各平台配置状态 |
| `/api/im/config` | GET/POST | 读（敏感字段打码）/ 保存 IM 配置 |

## 实现

- `src/services/im-service.ts` — 飞书/钉钉/Telegram 收发 + 命令解析 `handleImCommand` + 配置读写 `getImConfig`/`saveImConfig`
- `src/services/wecom-service.ts` — 企业微信：AES-256-CBC 加解密（腾讯 32 字节块 PKCS7）、sha1 签名恒时校验、access_token 缓存（7000s、42001 自动刷新）、自建应用发消息、群机器人推送
- `web/src/components/ImPanel.tsx` — 配置面板（4 渠道状态卡 / 表单 / 测试按钮 / 回调地址）
- 迁移 `112_im_config.sql`（表）+ `113_wecom_config.sql`（企业微信列）
- 测试：`test/wecom-service.test.ts`（加解密往返 / receiver 防串号 / 签名 / 回调解析）
