// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// context-compressor.ts — 分层上下文压缩（BOOK-GAP-ROADMAP P0-6/P0-7）
// 书中 Ch2: 五层组合——①工具结果预算控制 ②噪声删除 ③API层微压缩 ④归档式摘要 ⑤全量压缩
// 80% 阈值触发 + 批量压缩 + [COMPRESSED] 防重复标记; 连续失败熔断器(3次放弃)

import { breakers } from "./circuit-breaker.js";

/** 估算消息字符数（不逐 token，O(n)） */
export function estimateContextChars(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
}

/** 是否应压缩：当前窗口用量 ≥ 阈值（默认 80%） */
export function shouldCompress(messages: Array<{ role: string; content: string }>, thresholdPct = 0.8): boolean {
  const used = estimateContextChars(messages);
  // DeepSeek 1M 窗口按 800K 字符级估算（约 4 字符/token）
  const windowChars = 800_000;
  return used >= windowChars * thresholdPct;
}

// ═══════ P0-7: 压缩保留优先级 ═══════
// 分段标记（拼接时标注，压缩器按段处理）
export const SEGMENT_KEEP = "<!--P0-KEEP-->";        // 不可压缩段（原文保留）
export const SEGMENT_SUMMARIZE = "<!--P1-SUMMARIZE-->"; // 可压缩段（摘要化）
export const SEGMENT_DROP = "<!--P2-DROP-->";        // 可删段（仅留状态）

export interface PrioritySegment {
  priority: "keep" | "summarize" | "drop";
  content: string;
}

/** 按优先级切分上下文（书 Ch2: ①架构决策/约束 ②已改文件/关键变更 ③验证状态 ④TODO/回滚 ⑤工具输出可删）
 * 标记格式: <!--P0-KEEP-->内容<!--P0-KEEP--> （成对出现，前后闭合）
 * 无标记内容默认 summarize */
export function splitByPriority(context: string): PrioritySegment[] {
  const segments: PrioritySegment[] = [];
  const markers: Array<[string, "keep" | "summarize" | "drop"]> = [
    [SEGMENT_KEEP, "keep"],
    [SEGMENT_SUMMARIZE, "summarize"],
    [SEGMENT_DROP, "drop"],
  ];

  let rest = context;
  let cursor = 0;
  while (cursor < rest.length) {
    // 找下一个最近的开始标记
    let nextStart = -1;
    let nextPri: "keep" | "summarize" | "drop" = "summarize";
    let nextMarker = "";
    for (const [marker, pri] of markers) {
      const idx = rest.indexOf(marker, cursor);
      if (idx >= 0 && (nextStart === -1 || idx < nextStart)) { nextStart = idx; nextPri = pri; nextMarker = marker; }
    }

    if (nextStart === -1) {
      // 无更多标记 → 剩余全部 summarize
      const tail = rest.substring(cursor).trim();
      if (tail) segments.push({ priority: "summarize", content: tail });
      break;
    }

    // 标记前的未标记内容 → summarize
    const before = rest.substring(cursor, nextStart).trim();
    if (before) segments.push({ priority: "summarize", content: before });

    // 找对应的结束标记（同类型），找不到则到结尾
    const contentStart = nextStart + nextMarker.length;
    const endIdx = rest.indexOf(nextMarker, contentStart);
    if (endIdx >= 0) {
      const segContent = rest.substring(contentStart, endIdx).trim();
      if (segContent) segments.push({ priority: nextPri, content: segContent });
      cursor = endIdx + nextMarker.length;
    } else {
      // 未闭合 → 剩余归该优先级
      const segContent = rest.substring(contentStart).trim();
      if (segContent) segments.push({ priority: nextPri, content: segContent });
      cursor = rest.length;
    }
  }
  return segments;
}

/** 阶段1: 工具结果预算控制 — 头50行 + 尾50行，中间省略（retrieve_steps 已存完整结果） */
export function truncateToolResult(text: string, headLines = 50, tailLines = 50): string {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines) return text;
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  return `${head}\n...[省略 ${lines.length - headLines - tailLines} 行，完整结果已存 retrieve_steps.parameters]\n${tail}`;
}

/**
 * 两阶段压缩：
 * 阶段1: 工具结果预算控制（截断长工具输出）
 * 阶段2: 归档式摘要（最早历史消息 git log 式摘要，带 [COMPRESSED] 防重复）
 */
export function compressContext(query: string, messages: Array<{ role: string; content: string }>): { compressed: Array<{ role: string; content: string }>; inputChars: number; outputChars: number; compressedCount: number } {
  // 熔断检查：压缩连续失败 ≥3 次 → 直接放弃压缩（死亡螺旋防护）
  if (breakers.compression.isOpen()) {
    return { compressed: messages, inputChars: 0, outputChars: 0, compressedCount: 0 };
  }

  const inputChars = estimateContextChars(messages);
  let compressedCount = 0;
  const out = messages.map((m, i) => {
    // 只压缩历史消息（保留最新的 2 轮），带 [COMPRESSED] 防重复
    const isLatest = i >= messages.length - 2;
    if (isLatest || m.content.includes("[COMPRESSED]")) return m;

    // 按优先级分段处理
    const segments = splitByPriority(m.content);
    const parts: string[] = [];
    for (const seg of segments) {
      if (seg.priority === "keep") { parts.push(seg.content); continue; }
      if (seg.priority === "drop") {
        // 只留状态行：{tool, step, status}（无论段大小都过滤）
        const statusLines = seg.content.split("\n").filter((l) => /(?:成功|失败|pass|fail|✓|✗)/.test(l)).slice(0, 5);
        if (statusLines.length > 0) parts.push(statusLines.join("\n"));
        compressedCount++;
        continue;
      }
      // summarize: 工具结果截断 + 摘要标记（超长单行也会被截断）
      if (seg.content.length > 2000) {
        // 单行超长（无换行）→ 直接按字符截断; 多行 → 头尾保留
        if (seg.content.includes("\n")) {
          parts.push(truncateToolResult(seg.content));
        } else {
          parts.push(seg.content.substring(0, 1000) + `...[省略 ${seg.content.length - 1000} 字，完整结果已存]`);
        }
        compressedCount++;
      } else {
        parts.push(seg.content);
      }
    }
    const merged = parts.join("\n");
    return { role: m.role, content: merged.length < m.content.length ? `${merged}\n[COMPRESSED]` : m.content };
  });

  const outputChars = estimateContextChars(out);
  // 压缩成功 → 熔断器复位
  if (outputChars < inputChars) breakers.compression.recordSuccess();
  return { compressed: out, inputChars, outputChars, compressedCount };
}

// ═══ 借鉴5(Codex compact.rs): token budget 分配 + 压缩降级链 ═══
// 分配策略: 按角色分预算（系统>最近用户>工具历史>最早归档）; 降级链:
// 本地截断 → 本地摘要 → 远程摘要尝试(LLM) → 兜底全量截断
export interface CompactionBudget {
  /** 目标输出字符预算 */
  budgetChars: number;
  /** 各角色预算占比 */
  roleWeights: Record<string, number>;
}

/** 默认预算: 目标窗口 400K 字符（1M 窗口 40%）, 角色权重: system 0.3 / user 0.4 / assistant 0.3 */
export const DEFAULT_COMPACTION_BUDGET: CompactionBudget = {
  budgetChars: 400_000,
  roleWeights: { system: 0.3, user: 0.4, assistant: 0.3 },
};

/** 按 token 预算压缩: 超出预算的消息按角色权重分配截断额度（Codex compact_token_budget 模式） */
export function compactByBudget(
  messages: Array<{ role: string; content: string }>,
  budget: CompactionBudget = DEFAULT_COMPACTION_BUDGET
): { compressed: Array<{ role: string; content: string }>; inputChars: number; outputChars: number } {
  const inputChars = estimateContextChars(messages);
  if (inputChars <= budget.budgetChars) {
    return { compressed: messages, inputChars, outputChars: inputChars };
  }
  // 按角色分组（记录索引, 防 indexOf 对重复内容误匹配）
  const roleIndexes = new Map<string, number[]>();
  messages.forEach((m, i) => {
    const list = roleIndexes.get(m.role) || [];
    list.push(i);
    roleIndexes.set(m.role, list);
  });
  const out: Array<{ role: string; content: string }> = [];
  // 每角色的总预算 → 按消息顺序累计消耗, 超出的消息截断（保留最新）
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const weight = budget.roleWeights[m.role] ?? 0.33;
    const allowForRole = Math.floor(budget.budgetChars * weight);
    const idxInRole = (roleIndexes.get(m.role) || []).indexOf(i);
    const laterInRoleCount = (roleIndexes.get(m.role) || []).length - idxInRole - 1;
    // 给本条消息的预算 = 角色预算 - 同角色更早消息已分配（简化: 平分给剩余条数）
    const remainingInRole = laterInRoleCount + 1;
    const budgetForThis = Math.max(Math.floor(allowForRole / remainingInRole), 100);
    if (m.content.length > budgetForThis * 1.2) {
      out.push({ role: m.role, content: m.content.slice(0, budgetForThis) + `...[超预算截断, 省 ${m.content.length - budgetForThis} 字]` });
    } else {
      out.push(m);
    }
  }
  const outputChars = estimateContextChars(out);
  return { compressed: out, inputChars, outputChars };
}

/**
 * 压缩降级链（Codex compact.rs 多尝试模式）:
 * ① 本地分层压缩(compressContext) → 仍超预算?
 * ② compactByBudget 按角色预算截断 → 仍超?
 * ③ 归档式强截断（每消息只留头尾 + 状态行）
 * 每级都记录压缩率, 失败逐级降级（不抛错）
 */
export function compactWithFallback(
  query: string,
  messages: Array<{ role: string; content: string }>,
  budgetChars = DEFAULT_COMPACTION_BUDGET.budgetChars
): { compressed: Array<{ role: string; content: string }>; inputChars: number; outputChars: number; stage: string } {
  const inputChars = estimateContextChars(messages);
  // ① 本地分层压缩
  let result = compressContext(query, messages);
  if (result.outputChars <= budgetChars || result.outputChars >= inputChars) {
    return { ...result, stage: result.outputChars < inputChars ? "local" : "noop" };
  }
  // ② 按角色预算截断
  const stage2 = compactByBudget(result.compressed, { ...DEFAULT_COMPACTION_BUDGET, budgetChars });
  if (stage2.outputChars <= budgetChars) {
    return { ...stage2, stage: "budget" };
  }
  // ③ 归档强截断（保留最近 4 条完整 + 历史只留状态行）
  const keepRecent = stage2.compressed.slice(-4);
  const archived = stage2.compressed.slice(0, -4).map((m) => ({
    role: m.role,
    content: `[归档] ${m.content.split("\n").filter((l) => /(?:成功|失败|完成|pass|fail|✓|✗|##)/.test(l)).slice(0, 8).join("; ").slice(0, 500) || m.content.slice(0, 200)}`,
  }));
  const stage3 = [...archived, ...keepRecent];
  const outputChars = estimateContextChars(stage3);
  return { compressed: stage3, inputChars, outputChars, stage: "archive" };
}
