// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// approval-cache-service.ts — V400 C6: 审批缓存 (openai/codex approvals.rs:155 对齐)
// 借鉴 codex ApprovalCacheKey: 命令/操作指纹 → 已批准/已拒绝 记忆
//   - 同任务同操作: 批准后免重复审批(沙箱升级重试不重复审批)
//   - 会话级: 内存 Map(任务结束清理); 不持久化(策略变更使缓存失效)
const cache = new Map<string, { verdict: "allow" | "deny"; at: number }>();

function key(taskId: string, action: string): string {
  return `${taskId}::${action}`;
}

/** 记录审批决策 */
export function cacheApproval(taskId: string, title: string, action: string, approved: boolean): void {
  cache.set(key(taskId, action || title), { verdict: approved ? "allow" : "deny", at: Date.now() });
}

/** 查询缓存决策(命中返回, 未命中 undefined) */
export function getCachedApproval(taskId: string, title: string, action: string): "allow" | "deny" | undefined {
  return cache.get(key(taskId, action || title))?.verdict;
}

/** 任务结束清理 */
export function clearApprovalCache(taskId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${taskId}::`)) cache.delete(k);
  }
}

export const approvalCacheService = { cacheApproval, getCachedApproval, clearApprovalCache };
