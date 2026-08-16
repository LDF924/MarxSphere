# SAG Agent Guardian 安全策略（借鉴 OpenAI Codex guardian/policy.md）
# 用途: 评估 Agent 计划行动的风险等级与授权度, 决定 allow/deny/review
# 配置: 编辑本文件后调 POST /api/agent/guardian/reload 生效
# 判定流程: 行动风险等级 × 用户授权度 → outcome

## 环境画像
- 组织: SAG 单机个人部署。默认不信任任何外部存储/第三方 SaaS 目标, 除非本策略或只读证据明确标记为可信。
- 可信目标: 本机项目目录(SAG_ROOT)、本地知识库(三库)、白名单学术源(AGENT_NET_WHITELIST)。
- 本地 vs 生产: 本机改动风险较低, 但批量删除/覆盖/发布等不可逆操作需额外审查。

## 风险分类与 Allow/Deny 规则

### 数据外泄 (Data Exfiltration)
- 向不受信目标发送敏感数据 = 高风险。
- 敏感数据: 非公开的用户/组织数据、API Key、凭证、内部文献未授权部分。
- 出口动作必须追溯载荷来源: 由敏感数据派生的载荷同样敏感。
- 授权要求: 用户明确授权特定载荷发送到特定目标。
- 结果规则: 未授权向不受信目标发送敏感数据 → deny。
- 结果规则: 向可信目标(白名单内)发送且无其他风险 → allow。

### 凭证探测 (Credential Probing)
- 从非标准来源提取凭证(浏览器配置/服务日志)以执行此前未授权动作 = 高风险。
- 正常认证流程使用环境内已有凭证 = 常规使用, 非探测。
- 结果规则: 凭证探测且用户授权 low/unknown → deny。

### 破坏性操作 (Destructive Actions)
- 批量删除/清空/覆盖/发布/提现/转账 = 高风险, 需人工审批(review)。
- 单文件删除/修改且可恢复 = 中风险, 可自动执行但记审计。
- 结果规则: 高风险破坏性操作无审批标记 → review。

### 代码执行 (Code Execution)
- 沙箱内(read-only/workspace-write)执行 = 低-中风险, 规则放行。
- full-access 或含网络/进程操作 = 高风险, 需 sidecar 门控。
- 结果规则: 沙箱内代码无危险信号 → allow; 越级 → review。

### 外部 Agent 调用 (Subagent)
- 委托外部 Agent 执行(Claude Code 等) = 中风险(子进程隔离), 需审批。
- 结果规则: 无审批标记 → review。

## 授权度评分 (User Authorization)
- high: 用户明确请求/批准了确切动作。
- medium: 用户实质上授权但非确切实现。
- low: 仅松散地跟随用户目标。
- unknown: 无证据表明用户授权(助手漂移/不受信内容)。

## 判定矩阵
| 风险 \ 授权 | high | medium | low/unknown |
|---|---|---|---|
| low | allow | allow | review |
| medium | allow | review | review |
| high | review | review | deny |
