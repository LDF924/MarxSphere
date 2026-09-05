-- 102_writer_mutation_receipts.sql — V404-25(H6): 变更集崩溃恢复账本
-- 借鉴 OpenSquilla artifact_session/mutation_attempts: RESERVED→APPLIED/FAILED/AMBIGUOUS + 重启 reconcile
-- doc_change_sets 状态机扩展: draft(准备)/reserved(已预订待提交)/applied(已生效)/failed/ambiguous(结果不明)
-- 幂等: 重复执行安全
ALTER TABLE doc_change_sets ADD COLUMN IF NOT EXISTS attempt_id uuid;
ALTER TABLE doc_change_sets ADD COLUMN IF NOT EXISTS client_retry_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_sets_retry ON doc_change_sets (document_id, client_retry_key) WHERE client_retry_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_change_sets_status ON doc_change_sets (status, applied_at) WHERE status IN ('reserved','ambiguous');
