-- 150_admin_audit_target.sql — V417: 管理操作审计补全
--
-- 由来(2026-09-14 安全审计):
--   ① admin 高危操作(改余额/禁用/重置密码/改 plan)全都没有写审计 —— auth-service.ts:277
--      的注释写着"记录审计在调用方", 但四个调用方一个都没记。只有 billing_records 里的
--      admin_adjust 流水(那是**用户的账单**, 不是管理审计)。
--   ② audit_logs 只有 status_code 没有"改了什么": POST 的目标 id 都在 body 里, 而审计只记 path。
--   加 target_id 与 detail 两列, 让"谁在什么时候对谁做了什么"可查。
--
-- 幂等: 全部 IF NOT EXISTS。

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS detail text;

CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs (target_id, created_at DESC);
