// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-tool-registry.ts — 借鉴 Codex tools/registry.rs + parallel.rs
// 工具注册表: 统一注册/查询/冲突检测 + 并行执行（无依赖工具并发跑, 结果合并）
// 与 agent-tool-router 的 buildAgentTools 互补: registry 提供查询/编排层,
// router 提供执行/降级层。Codex 的 ToolRegistry 是 IndexMap<ToolName, RegisteredTool>,
// 这里用 Map 存 AgentToolDef + 元信息。
import type { AgentToolDef } from "./agent-tool-router.js";

export interface RegisteredToolInfo {
  def: AgentToolDef;
  /** 注册来源: builtin(内置) / plugin(插件) / external(MCP) */
  source: "builtin" | "plugin" | "external";
  /** 并行安全: true 表示可与其他工具并发执行（无共享可变状态） */
  parallelSafe: boolean;
}

/** 工具注册表（单例; Codex ToolRegistry 模式: 冲突检测 + 命名空间） */
class ToolRegistry {
  private tools = new Map<string, RegisteredToolInfo>();

  /** 注册工具（同名冲突 → 抛错, 防覆盖） */
  register(def: AgentToolDef, info: Partial<Omit<RegisteredToolInfo, "def">> = {}): void {
    if (this.tools.has(def.name)) {
      throw new Error(`工具 ${def.name} 已注册（Codex registry 冲突检测）`);
    }
    this.tools.set(def.name, {
      def,
      source: info.source ?? "builtin",
      parallelSafe: info.parallelSafe ?? this.defaultParallelSafe(def.name),
    });
  }

  /** 默认并行安全判定: 只读类工具可并行; 写/执行类串行 */
  private defaultParallelSafe(name: string): boolean {
    const READ_ONLY = ["sag_reason", "sag_retrieve", "sag_search", "sag_get_event", "concept_trace",
      "policy_search", "summarize", "review_output", "file_read", "web_fetch"];
    if (READ_ONLY.includes(name)) return true;
    // 含"写/执行/入库"语义 → 串行
    if (/write|ingest|delete|exec|run|code/.test(name)) return false;
    return true;
  }

  /** 查询工具（未注册返回 undefined） */
  get(name: string): RegisteredToolInfo | undefined {
    return this.tools.get(name);
  }

  /** 全部工具列表（保持注册顺序） */
  all(): RegisteredToolInfo[] {
    return [...this.tools.values()];
  }

  /** 按来源过滤 */
  bySource(source: RegisteredToolInfo["source"]): AgentToolDef[] {
    return [...this.tools.values()].filter((t) => t.source === source).map((t) => t.def);
  }

  /** 并行安全工具（可并发执行集合） */
  parallelSafeTools(): AgentToolDef[] {
    return [...this.tools.values()].filter((t) => t.parallelSafe).map((t) => t.def);
  }

  /** 注册工具数（运维/测试） */
  size(): number {
    return this.tools.size;
  }

  /** 清空（测试用） */
  reset(): void {
    this.tools.clear();
  }
}

export const toolRegistry = new ToolRegistry();

// ═══ 并行执行（借鉴 Codex tools/parallel.rs）═══
// 并行执行多个工具调用: 无依赖且并行安全的工具并发跑; 有依赖/串行工具按序跑
// 结果按调用顺序返回（Promise.allSettled 保序）
export interface ParallelToolCall {
  tool: AgentToolDef;
  args: Record<string, unknown>;
}

export interface ParallelToolResult {
  toolName: string;
  ok: boolean;
  result: string;
  risk: string;
  durationMs: number;
}

/** 执行器签名（注入 executeAgentTool, 避免循环依赖） */
export type ToolExecutor = (
  tool: AgentToolDef,
  args: Record<string, unknown>,
  opts?: { role?: "reader" | "analyst" | "manager"; whitelist?: Set<string> | null }
) => Promise<{ ok: boolean; result: string; risk: string; denied?: boolean; requiresApproval?: boolean }>;

/**
 * 并行执行一组工具调用
 * - 全部并行安全的调用 → 并发执行（Codex parallel tools）
 * - 任一含串行工具 → 整体降级为顺序执行（保守: 防共享状态竞争）
 * - 单调用失败不阻塞其他（allSettled）
 */
export async function executeToolsParallel(
  calls: ParallelToolCall[],
  executor: ToolExecutor,
  opts?: { role?: "reader" | "analyst" | "manager"; whitelist?: Set<string> | null }
): Promise<ParallelToolResult[]> {
  if (calls.length === 0) return [];
  // 串行检测: 只要有一个不并行安全 → 全部顺序执行（保序且防竞争）
  const allParallelSafe = calls.every((c) => {
    const info = toolRegistry.get(c.tool.name);
    return info ? info.parallelSafe : true;
  });
  const runOne = async (c: ParallelToolCall): Promise<ParallelToolResult> => {
    const t0 = Date.now();
    const r = await executor(c.tool, c.args, opts);
    return { toolName: c.tool.name, ok: r.ok, result: r.result, risk: r.risk, durationMs: Date.now() - t0 };
  };
  if (allParallelSafe && calls.length > 1) {
    const results = await Promise.all(calls.map((c) => runOne(c)));
    console.log(`[agent] parallel tools: ${calls.map((c) => c.tool.name).join(" + ")} (${Math.max(...results.map((r) => r.durationMs))}ms)`);
    return results;
  }
  // 顺序执行
  const results: ParallelToolResult[] = [];
  for (const c of calls) {
    results.push(await runOne(c));
  }
  return results;
}
