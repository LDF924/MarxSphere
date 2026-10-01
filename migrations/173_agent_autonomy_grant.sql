-- 173_agent_autonomy_grant.sql — 任务级的动作审批授权(2026-10-01)
--
-- ═══ 为什么存在这个列 ═══
--
-- 2026-10-01 实测: 一个"用技能生成 .pptx"的任务要**批准 6-8 次**。原因是
-- `execute` 类型**无条件**走人工审批门(它必然产生文件系统副作用, 不做关键词启发式判断),
-- 而 agent 循环一旦一轮没达标就 **replan** —— 新计划里的步骤 `approved` 字段是全新的、
-- 一律 false, 于是**每一步都要重新批一次**。用户点同意时看到的明明是
-- "调用 nature-paper2ppt 技能生成可编辑 .pptx", 下一步换个措辞再来一遍。
--
-- ═══ 为什么是"任务级"而不是"这一步" ═══
--
-- 存在**任务行**上, 而不是计划里的步骤上 —— 因为计划会被 replan 整体替换, 而任务行不会。
-- 这正是要解决的问题: 把授权绑在会被重建的东西上, 它必然随重建一起丢。
--
-- ═══ 为什么不是简单的布尔 ═══
--
-- 加一个 `execute_approved boolean` 最省事, 但那样**一旦打开就再也问不了**:
-- "写工作区"和"开子进程/联网"是两种后果完全不同的授权, 用户点一次同意给的是前者。
-- 所以存**权限档位**(对齐 Codex PermissionProfile), 当前只有一档:
--   workspace-write —— 只在 agent_workspace 内读写; 网络/进程仍被沙箱黑名单拦。
-- 未来若要再加一档(如 full-access), 这里加个值即可, 不必改结构。
--
-- ═══ 边界 ═══
--
-- 只对**同一任务**有效, 任务结束即失去意义(它本来就随任务行生命周期);
-- 不做跨任务、跨会话的持久授权 —— 那需要另一套显式的"信任设置", 不该由一次点击产生。
--
-- 幂等: ADD COLUMN IF NOT EXISTS。

alter table agent_tasks
  add column if not exists autonomy_grant text;

comment on column agent_tasks.autonomy_grant is
  '用户对**本任务**内动作类步骤(execute)的授权档位; NULL=未授权, 每步仍逐次审批。取值: workspace-write';
