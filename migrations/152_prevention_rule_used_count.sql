-- 152_prevention_rule_used_count.sql — V417: 拆开"复现次数"与"规则被使用次数"
--
-- 由来(2026-09-15 盘点):
--   prevention_rules.hit_count 有两个写入端、两种含义 ——
--     · recordAndAttribute: 同一问题**再次出现**时 +1(复现/踩坑频次)
--     · hitRule:            文档写着"Agent 按规则执行后调用", **零调用点**(死代码)
--   于是 UI 把 hit_count 显示成"命中N次", 用户会以为是"这条规则起作用了 N 次"。
--   两个语义混在一列里, 排序依据就是失真的: 复现多的问题确实该排前面, 但"规则被采用"是另一回事。
-- 做法: 各归各列。hit_count 继续表示复现频次(排序仍用它 —— 复现最多的问题最值得先防),
--   used_count 表示"这条规则被注入给模型的次数"; 前端两个数都显示。
--
-- 幂等: IF NOT EXISTS。

ALTER TABLE prevention_rules ADD COLUMN IF NOT EXISTS used_count int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_prevention_rules_used ON prevention_rules (used_count DESC);
