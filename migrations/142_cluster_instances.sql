-- 142_cluster_instances.sql — 实例登记(实测集群规模)
--
-- 由来(2026-09-11): 上一轮用 REPLICA_COUNT 环境变量判断"多副本却还在用本机态",
-- 但**忘记声明就退回看不出问题**的状态 —— 一个可选的开关解决不了一个必现的风险。
--
-- 改法: 限流后端自己就是共享存储, 让每个实例定期登记心跳, 数一跳之内活跃的实例数即可
-- 实测集群规模。不需要识别 K8s 还是别的编排, 也不依赖部署时记得设变量。
--
-- 用途: ① 启动自检据此判断部署形态; ② 限流后端故障降级到进程内时按实例数**均分**配额
-- (否则 N 个副本各发满 limit, 整体仍是 N 倍)。

create table if not exists cluster_instances (
  instance_id text primary key,          -- 形如 <hostname>#<pid>
  seen_at     timestamptz not null default now()
);

create index if not exists idx_cluster_instances_seen on cluster_instances(seen_at);
