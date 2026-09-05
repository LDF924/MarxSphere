# SAG 商业化多租户架构方案（V388+）

## 决策基线（用户已拍板）
- 商业模式：**C 混合**（基础订阅 + 超额按量）
- LLM 成本：**B BYOK**（用户自带 key，平台网关）
- 租户：**A+B**（单用户租户 + 企业租户）
- 数据隔离：**B 混合**（共享公共知识库 + 用户私有数据）
- 计费：**混合**（订阅 + 按量）
- 安全：**A admin 角色**（替代仅本机）

---

## 阶段 1：用户认证 + 租户基础 + admin 角色

### 1.1 数据库（迁移 043）
```sql
-- users 用户表
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,           -- bcrypt
  role text NOT NULL DEFAULT 'user',     -- user | admin
  tenant_id uuid NOT NULL,
  plan text NOT NULL DEFAULT 'free',     -- free | pro | enterprise
  balance_cents bigint NOT NULL DEFAULT 0,  -- 余额(分)
  llm_provider text NOT NULL DEFAULT 'platform',  -- platform | byok
  byok_key_encrypted text,               -- BYOK key(加密存储)
  created_at timestamptz NOT NULL DEFAULT now()
);
-- tenants 租户表（单用户 + 企业）
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'single',   -- single | enterprise
  name text NOT NULL,
  owner_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- tenant_members 企业成员
CREATE TABLE tenant_members (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',   -- owner | admin | member
  PRIMARY KEY (tenant_id, user_id)
);
-- api_tokens 扩展: user_id, tenant_id
ALTER TABLE api_tokens ADD COLUMN user_id uuid;
ALTER TABLE api_tokens ADD COLUMN tenant_id uuid;
-- token_usage 扩展: user_id, tenant_id
ALTER TABLE token_usage ADD COLUMN user_id uuid;
ALTER TABLE token_usage ADD COLUMN tenant_id uuid;
-- 订阅表
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan text NOT NULL,
  status text NOT NULL DEFAULT 'active',  -- active | expired | cancelled
  quota_tokens bigint NOT NULL DEFAULT 0, -- 月额度 token 数
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
```

### 1.2 后端
- `auth-service.ts`：注册/登录（bcrypt + JWT session）、admin 校验
- Web 登录中间件（JWT cookie → request.user）
- admin 角色：eval/ai-execute/settings/tokens 从"仅本机"改"本机 OR admin token"
- 前端：登录页 + 路由守卫 + 用户菜单

### 1.3 前端
- 登录/注册页
- App 顶层: 未登录 → 登录页；已登录 → 现有界面
- 用户菜单（余额/计划/设置）

---

## 阶段 2：计费系统（订阅 + 按量）

> **V405 衔接(2026-09-05)**: 本文档为**用户侧计费**设计(订阅额度→超额扣 balance, 走 `billing_records`/`user_usage_log`)。
> 平台**成本侧审计**由 V405 成本账本承担(`llm_usage_ledger` 105 迁移, cost_source 三态 provider_billed/estimate/byok,
> 按模型单价 `llm_model_prices`)——两侧解耦: 计费=含利润售价, 账本=真实平台成本。运营面板两卡并列可视化。

### 2.1 数据库（迁移 044）
```sql
-- 账单
CREATE TABLE billing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,                    -- subscription | usage | recharge
  amount_cents bigint NOT NULL,          -- 正=收费 负=退款
  tokens_used bigint,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 充值
CREATE TABLE recharges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | success | failed
  provider text,                          -- 支付渠道
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 计费逻辑
- 每次 LLM 调用记账（token_usage 已有）→ 按用户聚合
- 平台 key 用户：订阅额度内免费 → 超额按单价扣 balance
- BYOK 用户：LLM 费用用户自付，平台只收订阅费
- 价格表（config）：每 1M token 单价（按模型）

### 2.3 API
- POST /api/billing/recharge（充值发起）
- GET /api/billing/balance（余额）
- GET /api/billing/records（账单）
- GET /api/billing/usage（用量明细）

### 2.4 前端
- 充值页 + 余额显示 + 账单查询

---

## 阶段 3：BYOK（用户自带 key）

### 3.1 数据库
- users.byok_key_encrypted（AES 加密存 key）
- llm_provider 切换

### 3.2 LLM 路由（核心改动）
```
请求 → 查用户 llm_provider
  ├─ byok: 用用户 key 调 LLM（平台不承担成本）
  └─ platform: 用服务端 key（订阅/余额）
```
- 改 `getLlmEndpoint()`：从 process.env 取 key → 从用户配置取
- 所有 LLM 调用点（inference/education/search 等）传 user_ctx

### 3.3 API
- POST /api/user/llm-config（设置 BYOK key）
- GET /api/user/llm-config（查配置）
- 前端：用户设置页 BYOK 配置

---

## 阶段 4：多租户数据隔离

### 4.1 PG 隔离
- 所有业务表加 tenant_id（documents/source_chunks/entities 等）
- 查询加 WHERE tenant_id = ctx.tenant_id
- 共享库：公共 tenant（tenant_id = DEFAULT）所有用户可读

### 4.2 Neo4j 隔离（大工程）
- Graphiti/Cognee 图库按 tenant 分库？或图属性加 tenant_id？
- 建议：MVP 用**共享图库**（所有用户共享检索），私有文档走 PG

### 4.3 检索隔离
- 检索源：共享库（public）+ 私有库（user tenant）混合
- search-service/inference-service 检索时加 tenant 过滤

---

## 阶段 5：运营

### 5.1 审计日志
- audit_logs 表（谁/何时/调了什么/花了多少）
- 管理端查看

### 5.2 差异化限流
- 按 plan 分级：free/pro/enterprise 不同限流和配额

### 5.3 管理端
- 用户管理（禁用/改角色/调余额）
- 系统用量总览

---

## 实施顺序与依赖

```
阶段1（认证+租户+admin）→ 阶段2（计费）→ 阶段3（BYOK）→ 阶段4（隔离）→ 阶段5（运营）
      ↑ 所有后续依赖               ↑ 依赖1             ↑ 依赖1+2         ↑ 依赖全部
```

## 风险与注意
1. BYOK key 安全：AES 加密存储 + 不返回明文
2. 计费准确性：token_usage 已有精确记账，需确保用户维度正确
3. 隔离漏洞：tenant_id 过滤遗漏 = 越权（需全表审计）
4. 迁移兼容：现有 500 篇文档库 → 归入默认公共租户（不影响现有使用）
