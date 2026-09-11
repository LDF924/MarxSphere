-- 140_rate_limit_db.sql — 限流与租户并发槽位落库(多副本共享配额)
--
-- 由来(2026-09-11 上云审计): rate-limiter.ts 是纯进程内桶。多副本部署下 N 个副本
-- 各有各的桶 → 租户实际可用 QPS 是配置值的 N 倍, 事前拦不住、只能事后扣费。
-- 租户并发槽位(tenantConcurrency Map)同理: free 租户 2 并发 × N 副本。
--
-- 改法: 计数落库, 各副本共享。窗口按固定边界对齐(与内存版同一语义)。
-- DB 不可用时调用方降级回进程内计数并打日志 —— 限流是保护性功能, 不能因为它挂掉就拒绝所有请求。

create table if not exists rate_limit_counters (
  key          text        not null,   -- 形如 ip:1.2.3.4 / tok:<tokenId> / tenant:<uuid>
  window_start timestamptz not null,   -- 固定窗口起点
  count        bigint      not null default 0,
  primary key (key, window_start)
);

-- 过期窗口清理用(保留最近 2 个窗口即可; 由定时任务删)
create index if not exists idx_rate_limit_counters_window on rate_limit_counters(window_start);

-- 租户并发推理槽位(跨副本共享)
-- count 归零的行保留(下次领取直接递增), 由 updated_at 判过期。
create table if not exists tenant_slots (
  tenant_id  text        primary key,
  count      int         not null default 0,
  updated_at timestamptz not null default now()
);
