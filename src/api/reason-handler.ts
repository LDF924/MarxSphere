// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reason-handler.ts — 推理 API handler，三层检索链 (Cognee→Graphiti→SAG)
// P0 hardened: readiness probe, SIG cleanup, close-before-null, PID logging
// V92: MCP 多实例连接池 (Cognee ×4, Graphiti ×4) — 消除单进程串行排队
import { z } from "zod";
import path from "node:path";
import { pool } from "../db/pool.js";
import { RichMcpClient } from "../ai/rich-mcp-client.js";
import { McpPool } from "../ai/mcp-pool.js";
import { InferenceService } from "../services/inference-service.js";
import { cogneeMcpLimit, graphitiMcpLimit } from "../db/concurrency.js";
import { memoryService } from "../services/memory-service.js";

export const reasonSchema = z.object({
  sourceId: z.string().uuid(),
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  paperId: z.string().optional(),
  sources: z.array(z.enum(["pg", "graphiti", "cognee"])).optional(),
  ablation: z.array(z.string()).max(15).optional(),
  /** V267: 推理模式 — template(固定52步,默认) / adaptive(LLM动态选算子) */
  mode: z.enum(["template", "adaptive"]).optional(),
  /** 2026-08-07 记忆层：会话 ID（注入短期记忆 + 沉淀长期经验） */
  sessionId: z.string().uuid().optional(),
  /** V294: 评测联动 — 评测题号（反思闭环按题号查 eval_failures 归因） */
  questionId: z.string().optional(),
});

export const getReasonTaskSchema = z.object({
  taskId: z.string().uuid(),
});

// ─── 统一 Python 解释器为项目 venv（桌面端可用 COGNEE_PYTHON 环境变量覆盖）───
const SAG_ROOT = process.env.SAG_ROOT || process.cwd();
const PYTHON = process.env.COGNEE_PYTHON || "";
const GRAPHITI_RUNNER = path.join(SAG_ROOT, "scripts", "mcp_graphiti_runner.py");
const COGNEE_RUNNER = path.join(SAG_ROOT, "scripts", "mcp_cognee_runner.py");
const MCP_CONNECT_TIMEOUT_MS = 120_000; // 120s 建连超时

// V92: MCP 多实例连接池
let _graphitiPool: McpPool | null = null;
let _cogneePool: McpPool | null = null;
let _cogneeDataset = 'capital_demo';

// ─── 保留单实例向后兼容 (用于 callTool 签名)
let _graphiti: RichMcpClient | null = null;
let _graphitiReady = false;
let _cognee: RichMcpClient | null = null;
let _cogneeReady = false;

// ─── P0-2d: 进程退出清理 ───
const _activeClients: RichMcpClient[] = [];
let _exitHandlerRegistered = false;
function trackClient(c: RichMcpClient): RichMcpClient {
  _activeClients.push(c);
  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on('exit', () => { for (const cl of _activeClients) { try { cl.abort(); } catch {} } });
  }
  return c;
}
function onSignal() { for (const cl of _activeClients) { try { cl.abort(); } catch {} } process.exit(0); }
process.once('SIGTERM', onSignal);
process.once('SIGINT', onSignal);

async function discoverCogneeDataset(cognee: RichMcpClient): Promise<string> {
  try {
    const r = await cognee.callTool('cognee_datasets', {});
    const text = (r as any).result?.[0]?.text || '[]';
    const datasets = JSON.parse(text);
    if (Array.isArray(datasets) && datasets.length > 0) {
      const capitalDs = datasets.find((d: any) => d.name?.includes('capital_v28'));
      if (capitalDs) return capitalDs.name;
      const fallback = datasets.find((d: any) => d.name?.includes('capital'));
      return fallback?.name || datasets[0].name || 'capital_v28';
    }
  } catch {}
  return 'capital_v28';
}

/** 带 120s 超时的 connect — 超时则降级 */
async function connectWithTimeout(client: RichMcpClient, label: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MCP_CONNECT_TIMEOUT_MS);
  try {
    await client.connect(ac.signal);
    // P0-1c: readiness probe after connect
    const ready = await client.probe();
    if (!ready) {
      console.log(`[sag] ${label} MCP connect OK but probe failed — tools unavailable`);
      return false;
    }
    trackClient(client);
    return true;
  } catch (e: any) {
    console.log(`[sag] ${label} MCP 预连接超时/失败 (${(e.message || e).substring(0, 120)})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function initMcpClients(): Promise<void> {
  // V92: 创建多实例连接池
  _graphitiPool = new McpPool("graphiti", {
    name: "marx-graphiti",
    command: PYTHON,
    args: [GRAPHITI_RUNNER],
    env: { PYTHONIOENCODING: "utf-8" },
    concurrencyLimit: (fn) => graphitiMcpLimit(fn),
  });

  _cogneePool = new McpPool("cognee", {
    name: "marx-cognee",
    command: PYTHON,
    args: [COGNEE_RUNNER],
    env: { PYTHONIOENCODING: "utf-8", COGNEE_LOG_FILE: "false", CACHING: "false" },
    concurrencyLimit: (fn) => cogneeMcpLimit(fn),
  });

  const [gOk, cOk] = await Promise.all([
    _graphitiPool.init(),
    _cogneePool.init(),
  ]);

  _graphitiReady = gOk;
  _cogneeReady = cOk;
  // 向后兼容: 用池中第一个实例作为单例引用
  _graphiti = gOk ? (_graphitiPool as any).clients?.[0]?.client ?? null : null;
  _cognee = cOk ? (_cogneePool as any).clients?.[0]?.client ?? null : null;

  if (gOk) {
    console.log(`[sag] Graphiti MCP 池就绪 (${_graphitiPool.getClientCount()} 实例)`);
  } else {
    console.log("[sag] Graphiti MCP 降级 — 推理时将用 PG 向量兜底");
  }

  if (cOk) {
    _cogneeDataset = await discoverCogneeDataset(_cognee!);
    console.log(`[sag] Cognee MCP 池就绪 (${_cogneePool.getClientCount()} 实例, dataset=${_cogneeDataset})`);
  } else {
    console.log("[sag] Cognee MCP 降级 — 推理时将用 PG 向量兜底");
  }
}

// 检索源配置：供 search-service / inference-service 取 MCP 池（三库任意组合）
export function getGraphitiPool(): McpPool | null {
  return _graphitiPool;
}
export function getCogneePool(): McpPool | null {
  return _cogneePool;
}
export function getMcpReady(): { graphiti: boolean; cognee: boolean } {
  return { graphiti: _graphitiReady, cognee: _cogneeReady };
}

// 获取已连接的 MCP 工具列表（复用推理连接池，不重复 spawn）
export async function getConnectedMcpTools(): Promise<{
  servers: Array<{ serverId: string; serverName: string; tools: string[]; connected: boolean }>;
  total: number;
}> {
  const servers: Array<{ serverId: string; serverName: string; tools: string[]; connected: boolean }> = [];

  // Cognee
  const cogneeClient = (_cogneePool as any)?.clients?.[0]?.client ?? _cognee;
  if (cogneeClient?.isConnected?.()) {
    try {
      const res = await cogneeClient.client?.listTools(undefined);
      servers.push({
        serverId: "cognee",
        serverName: "Cognee 知识图谱",
        tools: (res?.tools ?? []).map((t: any) => t.name),
        connected: true
      });
    } catch {
      servers.push({ serverId: "cognee", serverName: "Cognee 知识图谱", tools: [], connected: false });
    }
  } else {
    servers.push({ serverId: "cognee", serverName: "Cognee 知识图谱", tools: [], connected: false });
  }

  // Graphiti
  const graphitiClient = (_graphitiPool as any)?.clients?.[0]?.client ?? _graphiti;
  if (graphitiClient?.isConnected?.()) {
    try {
      const res = await graphitiClient.client?.listTools(undefined);
      servers.push({
        serverId: "graphiti",
        serverName: "Graphiti 知识图谱",
        tools: (res?.tools ?? []).map((t: any) => t.name),
        connected: true
      });
    } catch {
      servers.push({ serverId: "graphiti", serverName: "Graphiti 知识图谱", tools: [], connected: false });
    }
  } else {
    servers.push({ serverId: "graphiti", serverName: "Graphiti 知识图谱", tools: [], connected: false });
  }

  const total = servers.reduce((sum, s) => sum + s.tools.length, 0);
  return { servers, total };
}

// 延迟初始化: 保留原有的 initCognee 兼容
export async function initCognee(): Promise<void> {
  if (_cogneeReady) return;
  try {
    if (!_cognee) {
      _cognee = new RichMcpClient({
        name: "marx-cognee",
        command: PYTHON,
        args: [COGNEE_RUNNER],
        env: { PYTHONIOENCODING: "utf-8", COGNEE_LOG_FILE: "false", CACHING: "false" },
        concurrencyLimit: (fn) => cogneeMcpLimit(fn),
      });
    }
    await _cognee.connect();
    _cogneeReady = true;
  } catch { /* will retry on next call */ }
}

async function getGraphiti(): Promise<RichMcpClient | null> {
  if (_graphitiReady && _graphiti) {
    if (_graphiti.isConnected()) return _graphiti;
    // P0-2c: close old transport before dropping reference
    const old = _graphiti;
    _graphitiReady = false;
    _graphiti = null;
    await old.close().catch(() => {});
  }
  try {
    if (!_graphiti) {
      _graphiti = new RichMcpClient({
        name: "marx-graphiti",
        command: PYTHON,
        args: [GRAPHITI_RUNNER],
        env: { PYTHONIOENCODING: "utf-8" },
        concurrencyLimit: (fn) => graphitiMcpLimit(fn),
      });
    }
    await _graphiti.connect();
    _graphitiReady = true;
    console.error("[sag] Graphiti MCP 懒重连成功 pid=" + (_graphiti.getPid() || '?'));
    return _graphiti;
  } catch (e: any) {
    console.error("[sag] Graphiti MCP 懒重连失败:", e.message || e);
    _graphitiReady = false;
    _graphiti = null;
    return null;
  }
}

async function getCognee(): Promise<RichMcpClient | null> {
  if (_cogneeReady && _cognee) {
    if (_cognee.isConnected()) return _cognee;
    // P0-2c: close old transport before dropping reference
    const old = _cognee;
    _cogneeReady = false;
    _cognee = null;
    await old.close().catch(() => {});
  }
  try {
    if (!_cognee) {
      _cognee = new RichMcpClient({
        name: "marx-cognee",
        command: PYTHON,
        args: [COGNEE_RUNNER],
        env: { PYTHONIOENCODING: "utf-8", COGNEE_LOG_FILE: "false", CACHING: "false" },
        concurrencyLimit: (fn) => cogneeMcpLimit(fn),
      });
    }
    await _cognee.connect();
    _cogneeReady = true;
    _cogneeDataset = await discoverCogneeDataset(_cognee);
    console.error("[sag] Cognee MCP 懒重连成功 (pid=" + (_cognee.getPid() || '?') + " dataset=" + _cogneeDataset + ")");
    return _cognee;
  } catch (e: any) {
    console.error("[sag] Cognee MCP 懒重连失败:", e.message || e);
    _cogneeReady = false;
    _cognee = null;
    return null;
  }
}

export async function startReasonFlow(input: {
  sourceId: string;
  query: string;
  topK?: number;
  paperId?: string;
  sources?: Array<"pg" | "graphiti" | "cognee">;
  ablation?: string[];
  /** V267: template(默认) / adaptive */
  mode?: "template" | "adaptive";
  /** 2026-08-07 记忆层：会话 ID */
  sessionId?: string;
  /** V294: 评测联动 — 评测题号（反思闭环查归因用） */
  questionId?: string;
  /** V389: BYOK — 用户 LLM 配置（用户自带 key 时覆盖平台 key） */
  userLlmConfig?: { provider: "byok"; apiKey: string };
  userId?: string;
}): Promise<{ taskId: string; trace: Record<string, unknown> }> {
  // V92: 使用连接池 — 每个请求从池中获取独立实例
  const [graphiti, cognee] = await Promise.all([getGraphiti(), getCognee()]);
  // V92: 如果池就绪, 同时传入池引用供 InferenceService 在 callTool 时使用
  const inference = new InferenceService(graphiti, cognee, _cogneeDataset);
  (inference as any).graphitiPool = _graphitiPool;
  (inference as any).cogneePool = _cogneePool;
  // V389: BYOK — 用户 key 传入推理服务（getLlmEndpoint 覆盖平台 key）
  if (input.userLlmConfig) (inference as any).userLlmConfig = input.userLlmConfig;
  // 源配置：请求携带的 sources 优先（前端开关 → 请求参数）
  if (input.sources) (inference as any).requestSources = input.sources;
  // 2026-08-07 记忆层：注入会话短期记忆（最近对话上下文）
  if (input.sessionId) {
    try {
      const contexts = await memoryService.listConversationContexts(input.sessionId, 6);
      (inference as any).conversationMemory = contexts;
    } catch { /* 记忆读取失败不阻塞推理 */ }
  }
  // V267: 自适应模式 → reasonAdaptive（失败降级 template）
  const t0 = Date.now();
  let result: { taskId: string; trace: Record<string, unknown> };
  if (input.mode === "adaptive") {
    try {
      result = await (inference as any).reasonAdaptive(input);
    } catch (e: any) {
      console.warn('[sag] adaptive FAIL, falling back to template:', e?.message?.substring(0, 80));
      result = await (inference as any).reasonWithFallback(input);
    }
  } else {
    // V80: 检索自愈闭环 — 回答质量不足时自动降级到更强检索策略
    result = await (inference as any).reasonWithFallback(input);
  }
  // 任务巡检：慢查询告警（>SLOW_QUERY_MS）
  const durationMs = Date.now() - t0;
  try {
    const { reportQueryTiming } = await import("../services/task-monitor-service.js");
    await reportQueryTiming(result.taskId, input.query, durationMs);
  } catch { /* 巡检失败不阻塞 */ }
  return result;
}

export async function getReasonTaskDetail(taskId: string): Promise<Record<string, unknown> | null> {
  const task = await pool.query("SELECT * FROM query_tasks WHERE id = $1", [taskId]);
  if (task.rows.length === 0) return null;

  const outlines = await pool.query("SELECT * FROM outlines WHERE task_id = $1 ORDER BY order_index", [taskId]);
  const steps = await pool.query("SELECT * FROM retrieve_steps WHERE task_id = $1 ORDER BY created_at", [taskId]);
  const hypotheses = await pool.query("SELECT * FROM infer_hypotheses WHERE task_id = $1 ORDER BY created_at", [taskId]);
  const evaluations = await pool.query("SELECT * FROM eval_records WHERE task_id = $1 ORDER BY created_at", [taskId]);

  // V249: 解包每步真实 token（LLM usage 采集，存于 parameters.tokens）
  // V381: 透传 cacheHit — KV Cache 命中 token（前端 52 步链路展示每步缓存命中率）
  const retrieveSteps = steps.rows.map((r: any) => {
    const params = (typeof r.parameters === 'object' && r.parameters !== null) ? r.parameters : {};
    const tokens = params.tokens;
    return {
      ...r,
      parameters: params,
      tokens: (tokens && typeof tokens.in === 'number')
        ? { in: tokens.in, out: tokens.out, ...(typeof tokens.cacheHit === 'number' ? { cacheHit: tokens.cacheHit } : {}) }
        : undefined,
    };
  });

  return {
    task: task.rows[0],
    outlines: outlines.rows,
    retrieveSteps,
    hypotheses: hypotheses.rows,
    evaluations: evaluations.rows,
  };
}
