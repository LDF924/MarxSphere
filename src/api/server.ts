// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import { pool } from "../db/pool.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { webuiService } from "../services/webui-service.js";

/**
 * S1: 任务所有权校验 — 非管理员操作他人任务 → 403
 * 返回 true=放行; false=已回复 403（调用方需 return）
 * 无 JWT（localhost/本机）→ 放行（与现有鉴权豁免一致）
 */
async function assertTaskOwnership(request: any, reply: any, taskId: string): Promise<boolean> {
  const authHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
  const jwt = authHdr ? authService.verifyToken(authHdr) : null;
  if (!jwt || jwt.role === "admin") return true;  // 无令牌或管理员 → 放行
  try {
    const owner = await pool.query("select user_id from agent_tasks where id = $1::uuid", [taskId]);
    if (owner.rows.length === 0) return true;  // 任务不存在 → 交给后续 404
    if (owner.rows[0].user_id && owner.rows[0].user_id !== jwt.uid) {
      reply.code(403).send({ error: "无权操作他人任务", code: "AGENT_FORBIDDEN" });
      return false;
    }
  } catch { /* 查询失败放行（后续 404 兜底） */ }
  return true;
}
import { directionService } from "../services/direction-service.js";
import { mcpAgentService } from "../services/mcp-agent-service.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import { listModelCallLogs } from "../observability/model-call-log.js";
import { reasonSchema, getReasonTaskSchema, startReasonFlow, getReasonTaskDetail, initMcpClients } from "./reason-handler.js";
import { getAllMcpTools, getMcpConnectionStatus } from "../services/mcp-tools-service.js";
import { sciverseService } from "../services/sciverse-service.js";
import { skillsService } from "../services/skills-service.js";
import { skillsUpdateService } from "../services/skills-update-service.js";
import { githubDiscoverService } from "../services/github-discover-service.js";
import { stepDocs } from "../services/step-docs.js";
import { jobsService } from "../services/jobs-service.js";
import { eventBus } from "../services/event-bus.js";
import { memoryService } from "../services/memory-service.js";
import { agentTaskService } from "../services/agent-task-service.js";
import { LLM_MODEL_REGISTRY, getRoleModel, getRoleModelMap, resolveModelAlias, setRoleModel, type LlmRole } from "../services/llm-model-registry.js";
import { traceService } from "../services/trace-service.js";
import { quotaService } from "../services/quota-service.js";
import { globalRateLimiter, tokenRateLimiter, tenantRateLimiter, tryAcquireTenantSlot, releaseTenantSlot, tenantConcurrencyLimit } from "../services/rate-limiter.js";
import { breakers } from "../services/circuit-breaker.js";import "../services/jobs-handlers.js";
import { vaultService } from "../services/vault-service.js";
import { truthService } from "../services/truth-service.js";
import { literatureService } from "../services/literature-service.js";
import { llmClient } from "../ai/llm-client.js";
import { skillifyTracker } from "../services/skillify-tracker.js";
import { policyService } from "../services/policy-service.js";
import { apiTokenService } from "../services/api-token-service.js";
import * as authService from "../services/auth-service.js";
import * as billingService from "../services/billing-service.js";
import * as opsService from "../services/ops-service.js";
import { classicalTextService } from "../services/classical-text-service.js";
import { academicResearchService } from "../services/academic-research-service.js";
import { writingResearchService } from "../services/writing-research-service.js";
import { writingOutputService } from "../services/writing-output-service.js";
import { paperQualityService } from "../services/paper-quality-service.js";
import { theoryReflectionService } from "../services/theory-reflection-service.js";
import { alertService } from "../services/alert-service.js";
import { selfHealService } from "../services/self-heal-service.js";
import { startTaskPatrol, taskMonitorService } from "../services/task-monitor-service.js";
import { externalSourcesService } from "../services/external-sources-service.js";
import { policyLibraryService } from "../services/policy-library-service.js";
import { citationService } from "../services/citation-service.js";
import { cnkiCitationProxy } from "../services/cnki-citation-proxy.js";
import { aiExecuteService } from "../services/ai-execute-service.js";
import { runEvalWithEvents, killActiveEvalRun, type EvalScript } from "../services/eval-runner.js";
import { strategicMemoryService } from "../services/strategic-memory-service.js";
import { memoryMaintenanceService } from "../services/memory-maintenance-service.js";
import { preventionRulesService } from "../services/prevention-rules-service.js";
import { agentOrchestrator } from "../services/agent-orchestrator.js";
import { agentExecLogService } from "../services/agent-exec-log.js";

// 桌面端封装（V397）: SAG_ROOT 环境变量覆盖资源根目录（安装目录 vs 运行时目录分离）
const rootDir = process.env.SAG_ROOT || process.cwd();
const webDistDir = path.join(rootDir, "web", "dist");
const webIndexFile = path.join(webDistDir, "index.html");

// 上传大小限制 — 与 webui-service.ts MAX_UPLOAD_BYTES 一致, 这里在 schema 层拦截(防 POST /ingest 绕过)
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3); // utf8 中文最坏 3 字节/字
const uploadContentSchema = z.string().min(1).max(MAX_UPLOAD_CHARS).refine(
  (s) => Buffer.byteLength(s, "utf8") <= MAX_UPLOAD_BYTES,
  { message: "上传文档超过 5MB 限制" }
);

const ingestSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1),
  content: uploadContentSchema,
  metadata: z.record(z.unknown()).optional(),
  extract: z.boolean().optional(),
  waitForCompletion: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

const searchSchema = z.object({
  query: z.string().min(1),
  sourceIds: z.array(z.string().uuid()).min(1),
  strategy: z.enum(["vector", "multi"]).optional(),
  searchMode: z.enum(["standard", "fast"]).optional(),
  subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
  topK: z.number().int().positive().max(50).optional(),
  returnTrace: z.boolean().optional(),
  multi: z.object({
    entityTopK: z.number().int().positive().optional(),
    multiTopK: z.number().int().positive().optional(),
    keySimilarityThreshold: z.number().min(0).max(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    maxHops: z.number().int().min(0).max(10).optional(),
    maxEvents: z.number().int().positive().optional(),
    maxEventsA: z.number().int().positive().optional(),
    maxEventsB: z.number().int().min(0).optional(),
    maxHopRetries: z.number().int().positive().max(10).optional(),
    rerankTopK: z.number().int().positive().max(20).optional(),
    maxSections: z.number().int().positive().max(50).optional()
  }).optional()
});

const uploadSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1),
  content: uploadContentSchema,
  extract: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable()
});

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable()
});

const documentUpdateSchema = z.object({
  title: z.string().min(1).optional()
});

const createMcpSessionSchema = z.object({
  title: z.string().min(1).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  kind: z.enum(["project", "chat"]).optional()
});

const mcpMessageSchema = z.object({
  content: z.string().min(1)
});

// 可信 LLM/Embedding provider 域名白名单 — 防止改 baseUrl 重定向窃取调用
// 必须包含默认值 api.302ai.cn（.env 默认 EMBEDDING_BASE_URL/LLM_BASE_URL），否则设置页首次保存必 400
const ALLOWED_PROVIDER_HOSTS = [
  "api.302ai.cn",
  "api.deepseek.com",
  "dashscope.aliyuncs.com",
  "maas.aliyuncs.com",
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.moonshot.cn",
  "api.z.ai",
  "api.minimax.chat",
  "api.xiaoai.mi.com",
];
const isTrustedProviderUrl = (url: string) => {
  try {
    const u = new URL(url);
    // 本机/回环地址（Ollama http://127.0.0.1:11434、本地代理等）放行 — 单机桌面应用，不构成外部窃取
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1") return true;
    return ALLOWED_PROVIDER_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
};

const aiSettingsSchema = z.object({
  embeddingBaseUrl: z.string().url().refine(isTrustedProviderUrl, { message: "baseUrl 仅允许可信 provider 域名" }),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.literal(SUPPORTED_EMBEDDING_DIMENSIONS),
  embeddingApiKey: z.string().optional(),
  clearEmbeddingApiKey: z.boolean().optional(),
  llmBaseUrl: z.string().url().refine(isTrustedProviderUrl, { message: "baseUrl 仅允许可信 provider 域名" }),
  llmModel: z.string().min(1),
  llmApiKey: z.string().optional(),
  clearLlmApiKey: z.boolean().optional(),
  llmTimeoutMs: z.number().int().positive(),
  llmMaxRetries: z.number().int().min(0).max(10),
  defaultSearchMode: z.enum(["standard", "fast"]).default("fast"),
  defaultSearchTopK: z.number().int().min(1).max(50).default(10),
  defaultChunkingMode: z.enum(["heading_strict", "token"]).default("heading_strict"),
  chunkTokenLimit: z.number().int().min(64).max(8192).default(512),
  chunkOverlapTokens: z.number().int().min(0).max(4096).default(100)
});

export function buildHttpServer() {
  // V437: 迁移完成前服务降级 — 迁移未完成时业务接口返回 503（避免后端在缺表时崩溃/闪退循环）
  // 迁移由 index.ts 的 runMigrationsWithRetry 完成（等 DB 就绪 + 重试），完成后 markMigrationsReady() 置 true
  // 读取走 isMigrationsReady()（跨模块 globalThis 标记），闭包不缓存
  // 启动限流器桶清理 (防 Map 无限增长)
  globalRateLimiter.startCleanup();
  tokenRateLimiter.startCleanup();
  const app = Fastify({
    // V412: 全局请求体上限 30MB（问卷文件解析/附件上传需要；默认 1MB 会挡掉 base64 大文件）
    bodyLimit: 30 * 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: "marxsphere"
      }
    }
  });

  // V437: 迁移完成前降级 — 业务请求 503（避免缺表崩溃），/health 与 /api/auth/status 放行
  app.addHook("onRequest", async (request, reply) => {
    if (isMigrationsReady()) return;
    const url = request.url.split("?")[0];
    if (url === "/health" || url === "/api/auth/status" || url.startsWith("/api/auth/")) return;
    reply.code(503).send({ error: { code: "MIGRATING", message: "数据库初始化中，请稍候重试" } });
  });

  // ─── 对外 API 鉴权（部署到服务器 + 多用户场景）───
  // 规则: 本机 socket 连接豁免（本机开发便利）; 外部连接强制 Bearer Token
  // 白名单路由: /health /api/mode /api/docs /前端静态资源
  // ⚠ 安全: 不信任 X-Forwarded-For (可伪造绕过 localhost 豁免), 只认 socket 真实连接地址
  // ⚠ /api/tokens 管理端点不在白名单 — 外部连接一律 401 (即使带 token 也拒绝, 避免令牌被盗后直接管理)
  const AUTH_WHITELIST = new Set([
    "/health", "/api/mode", "/api/docs",
  ]);
  // 高危管理路由: 仅限本机 socket — 外部即使持有效 token 也拒绝
  //   /api/tokens 令牌管理 | /api/ai-execute Claude Code 执行桥(RCE 面)
  //   /api/settings AI 配置(可改 key/baseUrl) | /api/llm/models 模型映射
  //   /api/eval 评测执行与报告(内部运营数据)
  //   V388: /api/ai/execute 也仅本机（LLM 执行面, 可消耗 API 余额, 原只映射reason权限可被外部调）
  const LOCAL_ONLY_PREFIXES = [
    "/api/tokens",
    "/api/ai-execute",
    "/api/ai/execute",
    "/api/settings",
    "/api/llm/models",
    "/api/eval",
    "/api/memory/context",  // V381: 会话上下文清理, 仅本机
  ];
  // V381: 26 个工作台 tab 功能 → 所需令牌权限映射
  // 规则: 精确前缀匹配(先长后短), 命中即要求对应权限; 未命中的功能默认放行(任意有效令牌)
  // 兼容: reason/search/ingest 旧权限仍作用于旧前缀
  // V388: 场景研究 API(classical/academic/writing/quality/theory等)归入 scenarios 权限 — 商业化多用户下防止只读token烧LLM余额
  const PERMISSION_PREFIX_MAP: Array<[string, string]> = [
    // 核心(兼容旧权限)
    ["/api/reason", "reason"],
    ["/api/search", "reason"],       // Ask/检索
    ["/api/classical", "scenarios"],
    ["/api/academic", "scenarios"],
    ["/api/writing", "scenarios"],
    ["/api/quality", "scenarios"],
    ["/api/theory", "scenarios"],
    ["/api/feedback", "scenarios"],
    ["/api/documents/upload", "ingest"],
    ["/ingest", "ingest"],
    // 26 tab 功能
    ["/api/chat", "chat"],
    ["/api/ask", "ask"],
    ["/api/literature", "literature"],
    ["/api/sciverse", "sciverse"],
    ["/api/scenarios", "scenarios"],
    ["/api/education", "education"],
    ["/api/empirical", "empirical"],
    ["/api/truth", "truth"],
    ["/api/memory", "memory"],
    ["/api/documents", "documents"],
    ["/api/graphiti", "graphiti"],
    ["/api/cognee", "cognee"],
    ["/api/graph", "graph"],
    ["/api/sources", "sources"],
    ["/api/policy", "policy"],
    ["/api/vault", "vault"],
    ["/api/skills", "skills"],
    ["/api/mcp", "mcp"],
    ["/api/docs", "docs"],
    ["/api/jobs", "jobs"],
    ["/api/tasks", "tasks"],
    ["/api/trace", "trace"],
    ["/api/eval", "eval"],
    ["/api/alerts", "alerts"],
    ["/api/inbox", "inbox"],
    // V395-11: 导航对齐 — PDF2Obsidian / Agent控制台+任务（本机豁免, 外部令牌需对应权限）
    ["/api/p2o", "p2o"],
    ["/api/agent", "agent"],
  ];

  /** 请求是否来自本机 (只认 socket 真实地址, 绝不信任可伪造的 XFF 头; V381: 精确匹配防 localhost.evil.com 伪造) */
  const isLocalRequest = (request: { socket?: { remoteAddress?: string }; ip?: string }) => {
    const addr = request.socket?.remoteAddress || request.ip || "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === "localhost";
  };

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0];
    // 静态资源 / 前端页面豁免
    if (url.startsWith("/assets/") || url === "/" || url.endsWith(".html") || url.endsWith(".css") || url.endsWith(".js") || url.endsWith(".svg") || url.endsWith(".ico") || url.endsWith(".png") || url.endsWith(".map")) return;
    if (AUTH_WHITELIST.has(url)) return;

    // 高危管理路由: 本机 OR admin token 远程管理（V388+: 商业化 admin 角色替代仅本机）
    if (LOCAL_ONLY_PREFIXES.some((p) => url.startsWith(p))) {
      if (isLocalRequest(request)) return;
      // 远程: 需 Bearer token 且用户角色为 admin
      const auth = request.headers.authorization as string | undefined;
      if (auth && auth.startsWith("Bearer ")) {
        const token = auth.slice(7).trim();
        // 支持两种 token: JWT 会话(Web登录) 或 API token
        const jwtPayload = authService.verifyToken(token);
        if (jwtPayload) {
          if (jwtPayload.role === "admin") return;
          return reply.code(403).send({ error: { code: "FORBIDDEN", message: "需要管理员权限" } });
        }
        const verified = await apiTokenService.validateApiToken(auth);
        if (verified && verified.permissions.includes("admin")) return;
      }
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "该接口需本机或管理员权限" } });
    }

    // 本机 socket 连接豁免
    if (isLocalRequest(request)) return;

    // 外部请求: 强制 Bearer Token
    const auth = request.headers.authorization as string | undefined;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "缺少 API Token（外部调用需 Authorization: Bearer sag_xxx）" } });
    }
    const verified = await apiTokenService.validateApiToken(auth);
    if (!verified) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "API Token 无效或已撤销" } });
    }
    // 权限检查: 用 tab→权限映射(先长后短匹配)
    let required: string | null = null;
    for (const [prefix, perm] of PERMISSION_PREFIX_MAP) {
      if (url.startsWith(prefix)) { required = perm; break; }
    }
    if (required && !apiTokenService.hasPermission(verified.permissions as any, required as any)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: `Token 缺少 ${required} 权限` } });
    }
    // 把令牌上下文挂到 request, 供配额/限流/用量记录使用
    (request as any).tokenCtx = { tokenId: verified.tokenId, permissions: verified.permissions };
  });

  // ─── 外部令牌配额 + 限流 hook (仅对持 token 的外部请求生效; 本机/白名单已在上一个 hook 提前 return) ───
  app.addHook("onRequest", async (request, reply) => {
    const ctx = (request as any).tokenCtx as { tokenId: string; permissions: string[] } | undefined;
    if (!ctx) return;

    const url = request.url.split("?")[0];
    let kind: "search" | "ingest" | "reason" | "other" | "p2o" = "other";
    if (url.startsWith("/api/search") || url === "/search") kind = "search";
    else if (url.startsWith("/api/documents/upload") || url.startsWith("/ingest")) kind = "ingest";
    else if (url.startsWith("/api/reason") || url.startsWith("/api/ai/execute")) kind = "reason";
    // V395-11: P2O 走独立次数配额（PDF 解析烧 MinerU/LLM, 不与 other 混桶）
    else if (url.startsWith("/api/p2o/tasks") && request.method === "POST") kind = "p2o";

    // 全局熔断: DeepSeek 429 连续超阈值 → reason/search 外部请求 503
    if ((kind === "reason" || kind === "search") && breakers.deepseek429.isOpen()) {
      return reply.code(503).send({ error: { code: "DEEPSEEK_CIRCUIT_OPEN", message: "LLM 服务限流熔断中, 请稍后再试" } });
    }

    // 双 key 限流: per IP + per token
    const ip = request.socket?.remoteAddress || request.ip || "unknown";
    const global = globalRateLimiter.check("ip:" + ip);
    if (!global.allowed) {
      reply.header("Retry-After", String(global.retryAfterSec));
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "请求过于频繁, 请稍后再试", retryAfterSec: global.retryAfterSec } });
    }
    const quota = await quotaService.getQuota(ctx.tokenId);
    const tokenLimit = quota.rateLimitPerMin > 0 ? quota.rateLimitPerMin : 60;
    const tokenCheck = tokenRateLimiter.check("tok:" + ctx.tokenId, tokenLimit);
    if (!tokenCheck.allowed) {
      reply.header("Retry-After", String(tokenCheck.retryAfterSec));
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "令牌调用过于频繁, 请稍后再试", retryAfterSec: tokenCheck.retryAfterSec } });
    }

    // 配额预检 (次数/成本; 入库字节在 handler 内查 — body 此时未解析)
    // V381: other 类端点(实证/agent/知识库等)也做成本配额预检(成本门控全覆盖)
    // V395-11: p2o 也做独立次数配额预检
    if (kind === "search" || kind === "reason" || kind === "other" || kind === "p2o") {
      const r = await quotaService.ensureWithinQuota(ctx.tokenId, kind);
      if (r.blocked) {
        reply.header("Retry-After", String(r.retryAfterSec ?? 0));
        return reply.code(429).send({
          error: {
            code: "QUOTA_EXCEEDED", message: "配额已用完, 请稍后再试",
            retryAfterSec: r.retryAfterSec ?? 0, quotaStatus: r.quotaStatus,
          },
        });
      }
    }
  });

  // V381: other 类端点通用记账(成本可追溯; 请求完成时记一条 0-token 记录, LLM 端点已有精确记账)
  app.addHook("onResponse", async (request, reply) => {
    const ctx = (request as any).tokenCtx as { tokenId: string; permissions: string[] } | undefined;
    if (!ctx) return;
    const url = request.url.split("?")[0];
    if (url.startsWith("/api/search") || url.startsWith("/api/reason") || url.startsWith("/api/documents/upload") || url.startsWith("/ingest")) return;
    // V395-11: P2O 创建已按 p2o kind 记账, 不重复记 other
    if (url.startsWith("/api/p2o/tasks") && request.method === "POST") return;
    if (reply.statusCode >= 400) return;  // 失败请求不记成本
    quotaService.recordUsage(ctx.tokenId, "other", {});
  });

  // V389修复: 场景 API 租户校验 — JWT 用户请求体含 sourceId 时校验归属（公共库放行/他人私有 403）
  // 覆盖 classical/academic/writing/quality/theory 等所有场景 API（原仅 reason 校验）
  // V390修复: onRequest 阶段 body 尚未解析(校验从未生效) — 改为 preHandler 再校验, 并解决 body 二次解析限制:
  // 校验只读不动 body, handler 里 re-read (request.body as any) 拿到的是同一份已解析对象
  const scenarioSourceCheck = async (request: any, reply: any) => {
    try {
      const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
      const jwtPayload = token && authService.verifyToken(token);
      if (!jwtPayload) return;
      const body = (request.body as any) || {};
      const sourceId = body.sourceId || body.projectId || body.documentIds?.[0];
      if (!sourceId || typeof sourceId !== "string") return;
      // 场景 API 前缀才校验（避免误伤 reason/其他已校验路径）
      const url = request.url.split("?")[0];
      if (!/^\/api\/(classical|academic|writing|quality|theory|scenarios)/.test(url)) return;
      const access = await authService.verifySourceAccess(jwtPayload.uid, sourceId);
      if (!access.allowed) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }
    } catch { /* 校验失败不阻断（宽松策略） */ }
  };
  app.addHook("preHandler", scenarioSourceCheck);

  // V389: 审计日志 — 记录 JWT 用户请求（谁/何时/调了什么/结果）
  // V390: duration_ms 修复 — (reply as any).elapsedTime 非 Fastify 标准字段不可靠, 改为 onRequest 记开始时间 + onResponse 用 Date.now() 差
  app.addHook("onRequest", async (request) => {
    (request as any).auditStartMs = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    try {
      const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
      const payload = token && authService.verifyToken(token);
      if (!payload) return;  // 非 JWT 用户不记审计（本机/API token 已有 token_usage）
      const started = (request as any).auditStartMs as number | undefined;
      const durationMs = started ? Date.now() - started : 0;
      void opsService.recordAudit({
        userId: payload.uid, username: payload.username, method: request.method, path: request.url.split("?")[0],
        statusCode: reply.statusCode, durationMs,
        ip: request.socket?.remoteAddress || "",
      });
    } catch { /* 审计失败不阻塞 */ }
  });

  // 外部令牌: 按 traceId 聚合真实 LLM token 用量记账 (search 链 trace_spans 已落库; 失败静默)
  async function recordSearchUsage(tokenId: string, traceId: string): Promise<void> {
    try {
      if (!traceId) {
        quotaService.recordUsage(tokenId, "search", {});
        return;
      }
      const spans = await traceService.list({ traceId });
      const sum = (key: "tokensInput" | "tokensOutput" | "tokensCacheRead") =>
        spans.reduce((acc: number, s: any) => acc + (s[key] ?? 0), 0);
      quotaService.recordUsage(tokenId, "search", {
        tokensInput: sum("tokensInput"),
        tokensOutput: sum("tokensOutput"),
        tokensCacheRead: sum("tokensCacheRead"),
      });
    } catch (e) {
      console.error("[quota] recordSearchUsage failed:", e);
    }
  }

  // 外部令牌: reason 链按 taskId 聚合 retrieve_steps 真实 tokens 记账 (计月成本; 失败静默)
  async function recordReasonUsage(tokenId: string, taskId: string | undefined): Promise<void> {
    try {
      if (!taskId) {
        quotaService.recordUsage(tokenId, "reason", {});
        return;
      }
      const { getTaskTokenUsage } = await import("../services/cost-service.js");
      const t = await getTaskTokenUsage(taskId);
      quotaService.recordUsage(tokenId, "reason", { tokensInput: t.tokensIn, tokensOutput: t.tokensOut });
    } catch (e) {
      console.error("[quota] recordReasonUsage failed:", e);
    }
  }

  // ─── API 令牌管理（生成/列出/撤销/删除）───
  // V381: 权限目录(设置页勾选列表)
  app.get("/api/tokens/permissions", async () => {
    const { PERMISSION_LABELS, ALL_PERMISSIONS } = await import("../services/api-token-service.js");
    return { permissions: ALL_PERMISSIONS.map((p) => ({ id: p, label: PERMISSION_LABELS[p] ?? p })) };
  });

  app.get("/api/tokens", async () => {
    const tokens = await apiTokenService.listApiTokens();
    // 并行附配额状态 (令牌数少, 一次聚合即可)
    const statuses = await Promise.all(tokens.map((t) => quotaService.getQuotaStatus(t.id).catch(() => null)));
    return { tokens: tokens.map((t, i) => ({ ...t, quotaStatus: statuses[i] })) };
  });

  app.post("/api/tokens", async (request) => {
    const body = (request.body ?? {}) as {
      name?: string; permissions?: string[];
      quota?: Partial<{ dailySearchLimit: number; dailyIngestBytesLimit: number; monthlyCostLimitUsd: number; rateLimitPerMin: number }>;
    };
    const name = (body.name || "default").substring(0, 64);
    // V381: 26+ 权限全量放行(过滤非法值)
    const ALLOWED_PERMS = ["reason","search","ingest","chat","ask","literature","sciverse","scenarios",
      "education","empirical","truth","memory","documents","graphiti","cognee",
      "graph","sources","policy","vault","skills","mcp","docs","jobs","tasks",
      "trace","eval","alerts","inbox",
      "p2o","agent"];  // V395-11: 导航对齐 — PDF2Obsidian / Agent控制台+任务
    const perms = (body.permissions ?? ["reason"]).filter((p) => ALLOWED_PERMS.includes(p)) as any[] as Parameters<typeof apiTokenService.createApiToken>[1];
    const { token, record } = await apiTokenService.createApiToken(name, perms);
    // 可选: 创建时写入配额 (前端创建表单留空 = 服务端默认)
    if (body.quota && typeof body.quota === "object") {
      try {
        await quotaService.updateQuota(record.id, {
          dailySearchLimit: body.quota.dailySearchLimit,
          dailyIngestBytesLimit: body.quota.dailyIngestBytesLimit,
          monthlyCostLimitUsd: body.quota.monthlyCostLimitUsd,
          rateLimitPerMin: body.quota.rateLimitPerMin,
        });
      } catch (e) { console.error("[quota] create-with-quota failed:", e); }
    }
    return { token, record, note: "明文 token 仅返回一次, 请妥善保存" };
  });

  app.delete("/api/tokens/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await apiTokenService.deleteApiToken(id);
    if (!ok) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "令牌不存在" } });
    return { ok: true };
  });

  app.post("/api/tokens/:id/revoke", async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await apiTokenService.revokeApiToken(id);
    if (!ok) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "令牌不存在或已撤销" } });
    return { ok: true };
  });

  // ─── 令牌配额管理 (LOCAL_ONLY 仅本机; 外部连接 403) ───
  const quotaUpdateSchema = z.object({
    dailySearchLimit: z.number().int().min(0).max(1_000_000_000).optional(),
    dailyIngestBytesLimit: z.number().int().min(0).max(1_000_000_000_000).optional(),
    monthlyCostLimitUsd: z.number().min(0).max(100_000).optional(),
    rateLimitPerMin: z.number().int().min(0).max(10_000).optional(),
    dailyP2oLimit: z.number().int().min(0).max(1_000_000).optional(),  // V395-11
  });

  app.put("/api/tokens/:id/quota", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const patch = quotaUpdateSchema.parse(request.body);
    try {
      const quota = await quotaService.updateQuota(id, patch);
      return { quota };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "令牌不存在" } });
    }
  });

  app.get("/api/tokens/:id/quota", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    try {
      const status = await quotaService.getQuotaStatus(id);
      return { status };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "令牌不存在" } });
    }
  });

  app.get("/api/tokens/:id/usage", async (request) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const q = request.query as { days?: string };
    const days = Math.min(30, Math.max(1, parseInt(q.days ?? "7", 10) || 7));
    const daily = await quotaService.getUsageDaily(id, days);
    return { days: daily };
  });

  // ─── 经典文本研究 API（马理论 5 大能力）───
  // V390: 默认源按用户配置 — JWT 用户未传 sourceId 时用"用户自己的 source"(私有库/首个source), 未认证(本机/API令牌)回退公共库
  const DEFAULT_SOURCE = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";
  // 修复1: Agent 步骤执行器 self-fetch base — AGENT_API_BASE 覆盖（局域网部署用局域网 IP）
  const SELF_BASE = process.env.AGENT_API_BASE || "http://localhost:4173";
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";

  /** 解析请求的默认 sourceId：请求带 sourceId 直接返回；否则按 JWT 用户租户取私有库，最后回退公共库 */
  async function resolveDefaultSource(request: any, explicitSourceId?: string): Promise<string> {
    if (explicitSourceId) return explicitSourceId;
    try {
      const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
      const payload = token && authService.verifyToken(token);
      if (payload) {
        const u = await pool.query("select tenant_id from users where id = $1", [payload.uid]);
        if (u.rows.length > 0 && u.rows[0].tenant_id !== PUBLIC_TENANT) {
          // 用户私有库优先（webui 上传私有文档用的命名: @{username}-private）
          const s = await pool.query(
            "select id from sources where tenant_id = $1 order by (metadata->>'private' = 'true') desc, created_at asc limit 1",
            [u.rows[0].tenant_id]
          );
          if (s.rows.length > 0) return s.rows[0].id;
        }
      }
    } catch { /* 解析失败回退公共库 */ }
    return DEFAULT_SOURCE;
  }

  // 概念溯源与语义演变: POST { concept, topK? }
  app.post("/api/classical/concept-trace", async (request, reply) => {
    const body = (request.body ?? {}) as { concept?: string; topK?: number; sourceId?: string; model?: string };
    if (!body.concept) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 concept" } });
    return classicalTextService.conceptTrace(body.concept, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });

  // 论证结构拆解: POST { documentId, maxChunks? }
  app.post("/api/classical/argument-structure", async (request, reply) => {
    const body = (request.body ?? {}) as { documentId?: string; maxChunks?: number; model?: string };
    if (!body.documentId) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 documentId" } });
    return classicalTextService.argumentStructure(body.documentId, { maxChunks: body.maxChunks, model: body.model });
  });

  // 多文本互文对照: POST { topic, documentIds[], perDoc? }
  app.post("/api/classical/intertextual", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; documentIds?: string[]; perDoc?: number; sourceId?: string; model?: string };
    if (!body.topic || !Array.isArray(body.documentIds) || body.documentIds.length < 2) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 topic 和至少 2 个 documentIds" } });
    }
    return classicalTextService.intertextualCompare(body.topic, body.documentIds, await resolveDefaultSource(request, body.sourceId), { perDoc: body.perDoc, model: body.model });
  });

  // 晦涩文本阐释: POST { text, topK? }
  app.post("/api/classical/exegesis", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; topK?: number; sourceId?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return classicalTextService.exegesis(body.text, await resolveDefaultSource(request, body.sourceId), { topK: body.topK });
  });

  // 版本校勘: POST { documentGroup, perVersion? }
  app.post("/api/classical/collation", async (request, reply) => {
    const body = (request.body ?? {}) as { documentGroup?: string; perVersion?: number; sourceId?: string; model?: string };
    if (!body.documentGroup) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 documentGroup" } });
    return classicalTextService.collation(body.documentGroup, await resolveDefaultSource(request, body.sourceId), { perVersion: body.perVersion, model: body.model });
  });

  // 论证树查询: GET /api/classical/argument-tree?documentId=&treeId=
  app.get("/api/classical/argument-tree", async (request, reply) => {
    const q = request.query as { documentId?: string; treeId?: string };
    if (!q.documentId || !q.treeId) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 documentId 和 treeId" } });
    return classicalTextService.getArgumentTree(q.documentId, q.treeId);
  });

  // G19: /health 增强 — DB 连通/队列深度/卡死任务数（守护进程/监控探针用）
  app.get("/health", async (): Promise<{
    ok: boolean; service: string; db?: "up" | "down"; queueDepth?: number;
    runningTasks?: number; stuckTasks?: number; agentQueue?: { queued: number; running: number; maxConcurrent: number };
  }> => {
    // V437: 迁移未完成 → db:down（前端/electron 等健康检查，不会误以为就绪）
    if (!isMigrationsReady()) return { ok: false, service: "marxsphere", db: "down" };
    let db: "up" | "down" = "down";
    let queueDepth = 0;
    let runningTasks = 0;
    let stuckTasks = 0;
    let agentQueue: { queued: number; running: number; maxConcurrent: number } | undefined;
    try {
      const r = await pool.query("select 1");
      db = r.rows.length > 0 ? "up" : "down";
      // 队列深度: 等待执行的任务数
      const q = await pool.query("select count(*)::int as n from agent_task_queue");
      queueDepth = q.rows[0]?.n || 0;
      // 运行中任务数
      const t = await pool.query("select count(*)::int as n from agent_tasks where status in ('running','planning')");
      runningTasks = t.rows[0]?.n || 0;
      // 卡死任务: 超过 1 小时仍 running/planning（异常滞留）
      const s = await pool.query(
        `select count(*)::int as n from agent_tasks
         where status in ('running','planning') and updated_at < now() - interval '1 hour'`
      );
      stuckTasks = s.rows[0]?.n || 0;
      // 内存队列状态（agentTaskQueue）
      try {
        const { queueStatus } = await import("../services/agent-task-queue.js");
        const qs = queueStatus();
        agentQueue = { queued: qs.queued, running: qs.running, maxConcurrent: qs.maxConcurrent };
      } catch { /* 队列状态不可用忽略 */ }
    } catch { /* DB 不可达时 db=down 其余保持 0 */ }
    return { ok: db === "up", service: "marxsphere", db, queueDepth, runningTasks, stuckTasks, agentQueue };
  });

  // 运行模式（GBrain 模式徽标）：preview=预览（省内存）/ full=完整（推理+MCP池）
  // V399: 真实健康探测 — mode 显示实际服务状态（Neo4j 双端口 + Python 进程），不再只看 env 标记
  app.get("/api/mode", async () => {
    const mode: "preview" | "full" = process.env.MARXSPHERE_PREVIEW === "1" ? "preview" : "full";
    const mcpPoolSize = process.env.MCP_POOL_SIZE ? Number(process.env.MCP_POOL_SIZE) : 10;

    // Neo4j 端口探测（Graphiti 11001 / Cognee 11003）— TCP 连接即算 up
    const net = await import("node:net");
    const probePort = (port: number): Promise<boolean> => new Promise((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1", timeout: 1500 });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });
    const [graphitiUp, cogneeUp] = await Promise.all([probePort(11001), probePort(11003)]);

    // Python 进程探测（openviking/cognee 相关子进程）
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const pythonProcessCount = await new Promise<number>((resolve) => {
      if (process.platform === "win32") {
        promisify(execFile)("tasklist", ["/FI", "IMAGENAME eq python.exe", "/FO", "CSV", "/NH"])
          .then(({ stdout }) => resolve(stdout.split("\n").filter((l) => l.includes("python")).length))
          .catch(() => resolve(0));
      } else {
        promisify(execFile)("pgrep", ["-c", "-f", "python|openviking|cognee"])
          .then(({ stdout }) => resolve(Number(stdout.trim()) || 0))
          .catch(() => resolve(0));
      }
    });

    // 真实状态: 完整模式需 Neo4j 至少一个 up（推理需要图库）
    const neo4jUp = graphitiUp || cogneeUp;
    const effectiveMode = mode === "full" && neo4jUp ? "full" : mode === "full" ? "degraded" : "preview";
    return {
      mode: effectiveMode,
      mcpPoolSize,
      health: {
        neo4j: { graphiti: graphitiUp, cognee: cogneeUp },
        pythonProcesses: pythonProcessCount,
        label: effectiveMode === "full" ? "完整模式（全部服务在线）"
          : effectiveMode === "degraded" ? "降级（Neo4j 未连接，推理不可用）"
          : "预览模式"
      }
    };
  });

  // ─── 学术研究 API（S41-S45）───
  // 学派脉络全景: POST { schoolName, topK?, model? }
  app.post("/api/academic/school", async (request, reply) => {
    const body = (request.body ?? {}) as { schoolName?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.schoolName) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 schoolName" } });
    return academicResearchService.schoolOverview(body.schoolName, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });

  // 核心观点对比: POST { topic, scholars[], perScholar?, model? }
  app.post("/api/academic/view-comparison", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; scholars?: string[]; perScholar?: number; model?: string; sourceId?: string };
    if (!body.topic || !Array.isArray(body.scholars) || body.scholars.length < 2) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 topic 和至少 2 位学者" } });
    }
    return academicResearchService.viewComparison(body.topic, body.scholars, await resolveDefaultSource(request, body.sourceId), { perScholar: body.perScholar, model: body.model });
  });

  // 学术争鸣还原: POST { debateTopic, topK?, model? }
  app.post("/api/academic/debate", async (request, reply) => {
    const body = (request.body ?? {}) as { debateTopic?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.debateTopic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 debateTopic" } });
    return academicResearchService.debateReconstruction(body.debateTopic, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });

  // 学者思想谱系: POST { scholarName, topK?, model? }
  app.post("/api/academic/scholar", async (request, reply) => {
    const body = (request.body ?? {}) as { scholarName?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.scholarName) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 scholarName" } });
    return academicResearchService.scholarGenealogy(body.scholarName, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });


  // ─── 论文写作与研究设计 API（S46-S50）───
  // 研究问题凝练与空白识别: POST { topic, topK?, model? }
  app.post("/api/writing/gap", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return writingResearchService.researchGapIdentification(body.topic, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });
  // 研究框架与论证结构设计: POST { topic, researchType, model? }
  app.post("/api/writing/framework", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; researchType?: string; model?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return writingResearchService.frameworkDesign(body.topic, body.researchType ?? "理论研究", { model: body.model });
  });
  // 论证链条补全与逻辑校验: POST { claim, conclusion, model? }
  app.post("/api/writing/argument-chain", async (request, reply) => {
    const body = (request.body ?? {}) as { claim?: string; conclusion?: string; model?: string };
    if (!body.claim || !body.conclusion) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 claim 和 conclusion" } });
    return writingResearchService.argumentChainCompletion(body.claim, body.conclusion, { model: body.model });
  });
  // 研究方法适配建议: POST { topic, researchType, model? }
  app.post("/api/writing/method", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; researchType?: string; model?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return writingResearchService.methodRecommendation(body.topic, body.researchType ?? "理论研究", { model: body.model });
  });

  // ─── 论文写作输出 API（S51-S55）───
  // 高质量文献综述生成: POST { topic, topK?, model? }
  app.post("/api/writing-out/review", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return writingOutputService.literatureReviewGeneration(body.topic, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });
  // 学术段落扩写与润色: POST { coreIdea, topic, style?, model? }
  app.post("/api/writing-out/paragraph", async (request, reply) => {
    const body = (request.body ?? {}) as { coreIdea?: string; topic?: string; style?: string; model?: string };
    if (!body.coreIdea) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 coreIdea" } });
    return writingOutputService.paragraphExpansion(body.coreIdea, body.topic ?? "", { style: body.style, model: body.model });
  });
  // 规范化学术要件生成: POST { title, topic, method, findings, type, model? }
  app.post("/api/writing-out/components", async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; topic?: string; method?: string; findings?: string; type?: string; model?: string };
    if (!body.title) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 title" } });
    return writingOutputService.academicComponentsGeneration({ title: body.title, topic: body.topic ?? "", method: body.method ?? "", findings: body.findings ?? "", type: body.type === "学位论文" ? "学位论文" : "期刊论文", model: body.model });
  });
  // 引文与参考文献格式化: POST { rawText, format, model? }
  app.post("/api/writing-out/citation", async (request, reply) => {
    const body = (request.body ?? {}) as { rawText?: string; format?: string; model?: string };
    if (!body.rawText) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 rawText" } });
    const fmt = body.format === "APA" ? "APA" : body.format === "MLA" ? "MLA" : "GB/T 7714";
    return writingOutputService.citationFormatting({ rawText: body.rawText, format: fmt, model: body.model });
  });


  // ─── 告警中心 API（任务巡检/降级/熔断/失败事件）───
  app.get("/api/alerts", async (request) => {
    const q = request.query as { limit?: string; unread?: string };
    const alerts = await alertService.listAlerts(Number(q.limit) || 50, q.unread === "true");
    const unread = await alertService.unreadAlertCount();
    return { alerts, unread };
  });
  app.post("/api/alerts/read", async (request) => {
    const body = (request.body ?? {}) as { id?: string };
    const n = await alertService.markAlertsRead(body.id);
    return { ok: true, marked: n };
  });

  // 告警 demo（前端一键触发各类型演示）

  // ─── 用户反馈闭环（V375）: 点赞/踩 → OpenViking 记忆 ───
  app.post("/api/feedback", async (request) => {
    const body = (request.body ?? {}) as { feedback?: string; query?: string; answer?: string; note?: string };
    if (!body.feedback || !body.query) {
      return { ok: false, error: "需要 feedback 和 query" };
    }
    const { recordUserFeedback } = await import("../services/openviking-memory.js");
    const ok = await recordUserFeedback(
      body.feedback === "up" ? "up" : "down",
      body.query,
      body.answer ?? "",
      body.note
    );
    // V391(P1-6): 踩反馈 → 自动归因 → 生成预防规则（防同类错误复发）
    let ruleCreated = false;
    if (body.feedback === "down") {
      try {
        const { preventionRulesService } = await import("../services/prevention-rules-service.js");
        const rule = await preventionRulesService.recordAndAttribute({
          query: body.query, answer: body.answer ?? "", note: body.note, source: "user_down",
        });
        ruleCreated = !!rule;
      } catch { /* 归因失败不阻断 */ }
    }
    return { ok, feedback: body.feedback, note: ok ? "已写入长期记忆" : "记忆写入失败（OpenViking 不可用）", ruleCreated };
  });
  app.post("/api/alerts/demo", async (request) => {
    const body = (request.body ?? {}) as { level?: string; category?: string; message?: string; taskType?: string; detail?: Record<string, unknown> };
    await alertService.recordAlert({
      level: (body.level ?? "warning") as any,
      category: body.category ?? "demo",
      message: body.message ?? "demo 告警",
      taskType: body.taskType,
      detail: body.detail,
    });
    const unread = await alertService.unreadAlertCount();
    return { ok: true, unread };
  });
  app.post("/api/alerts/clear", async () => {
    const n = await alertService.clearReadAlerts();
    return { ok: true, cleared: n };
  });
  // ─── 论文质量检查 API（S56-S60）───
  // 概念一致性校验: POST { text, model? }
  app.post("/api/quality/concept", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return paperQualityService.conceptConsistencyCheck(body.text, { model: body.model });
  });
  // 引文准确性核查: POST { text, referenceList, model? }
  app.post("/api/quality/citation", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; referenceList?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return paperQualityService.citationAccuracyCheck(body.text, body.referenceList ?? "", { model: body.model });
  });
  // 逻辑自洽性检查: POST { text, model? }
  app.post("/api/quality/logic", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return paperQualityService.logicConsistencyCheck(body.text, { model: body.model });
  });
  // 学术不端风险提示: POST { text, sourceText, model? }
  app.post("/api/quality/plagiarism", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; sourceText?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return paperQualityService.plagiarismRiskCheck(body.text, body.sourceText ?? "", { model: body.model });
  });

  // ─── 理论思辨拓展 API（S61-S65）───
  // 理论前提反思: POST { claim, text, model? }
  app.post("/api/theory/premise", async (request, reply) => {
    const body = (request.body ?? {}) as { claim?: string; text?: string; model?: string };
    if (!body.claim) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 claim" } });
    return theoryReflectionService.premiseReflection(body.claim, body.text ?? "", { model: body.model });
  });
  // 跨学科视角拓展: POST { topic, discipline, model? }
  app.post("/api/theory/interdisciplinary", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; discipline?: string; model?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return theoryReflectionService.interdisciplinaryExpansion(body.topic, body.discipline ?? "政治经济学", { model: body.model });
  });
  // 理论与现实联结: POST { theory, claim, realCases, model? }
  app.post("/api/theory/bridge", async (request, reply) => {
    const body = (request.body ?? {}) as { theory?: string; claim?: string; realCases?: string; model?: string };
    if (!body.theory) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 theory" } });
    return theoryReflectionService.theoryRealityBridge(body.theory, body.claim ?? "", body.realCases ?? "", { model: body.model });
  });
  // 理论创新点识别: POST { topic, text, model? }
  app.post("/api/theory/innovation", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; text?: string; model?: string };
    if (!body.topic) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 topic" } });
    return theoryReflectionService.innovationPointIdentification(body.topic, body.text ?? "", { model: body.model });
  });
  // 理论体系建构: POST { propositions[], topic, model? }
  app.post("/api/theory/system", async (request, reply) => {
    const body = (request.body ?? {}) as { propositions?: string[]; topic?: string; model?: string };
    if (!Array.isArray(body.propositions) || body.propositions.length < 2) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要至少 2 个命题" } });
    }
    return theoryReflectionService.theoreticalSystemConstruction(body.propositions, body.topic ?? "", { model: body.model });
  });
  // 格式规范适配: POST { text, target, model? }
  app.post("/api/quality/format", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; target?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return paperQualityService.formatAdaptation(body.text, body.target ?? "期刊论文", { model: body.model });
  });
  // 多场景语体适配: POST { text, scene, model? }
  app.post("/api/writing-out/style", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; scene?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 text" } });
    return writingOutputService.styleAdaptation(body.text, body.scene ?? "期刊论文", { model: body.model });
  });
  // 反方视角与反驳意见生成: POST { claim, argumentText, model? }
  app.post("/api/writing/counter", async (request, reply) => {
    const body = (request.body ?? {}) as { claim?: string; argumentText?: string; model?: string };
    if (!body.claim) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 claim" } });
    return writingResearchService.counterargumentGeneration(body.claim, body.argumentText ?? "", { model: body.model });
  });
  // 学科前沿动态: POST { discipline, topK?, model? }
  app.post("/api/academic/frontier", async (request, reply) => {
    const body = (request.body ?? {}) as { discipline?: string; topK?: number; model?: string; sourceId?: string };
    if (!body.discipline) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 discipline" } });
    return academicResearchService.frontierReport(body.discipline, await resolveDefaultSource(request, body.sourceId), { topK: body.topK, model: body.model });
  });

  // ─── 文档 API（前端 DocsPanel 渲染 docs/*.md，对标 Sciverse /docs）───
  const DOCS_ROOT = path.join(rootDir, "docs");
  const DOC_INDEX: Array<{ id: string; path: string; title: string; group: string }> = [
    // 指南
    { id: "overview", path: "overview.md", title: "平台总览", group: "指南" },
    { id: "project-overview", path: "PROJECT-OVERVIEW.md", title: "项目概述（用户/痛点/创新）", group: "指南" },
    { id: "quickstart", path: "quickstart.md", title: "快速开始", group: "指南" },
    { id: "cookbook", path: "cookbook.md", title: "Cookbook 示例", group: "指南" },
    { id: "faq", path: "FAQ.md", title: "常见问题", group: "指南" },
    { id: "deployment", path: "DEPLOYMENT.md", title: "部署指南", group: "指南" },
    { id: "desktop", path: "DESKTOP.md", title: "桌面端", group: "指南" },
    { id: "project-brief", path: "project-brief.md", title: "项目简报", group: "指南" },
    // 参考
    { id: "api-reference", path: "api-reference.md", title: "API 参考", group: "参考" },
    { id: "agent-api", path: "agent-api.md", title: "Agent API", group: "参考" },
    { id: "agent-env", path: "agent-env.md", title: "Agent 环境变量", group: "参考" },
    { id: "api-integration", path: "API-INTEGRATION.md", title: "API 集成", group: "参考" },
    // 架构
    { id: "architecture", path: "ARCHITECTURE.md", title: "系统架构", group: "架构" },
    { id: "pipeline-callgraph", path: "SAG_PIPELINE_CALLGRAPH.md", title: "推理链路调用图", group: "架构" },
    // Agent
    { id: "agent-capabilities", path: "AGENT-CAPABILITIES.md", title: "Agent 能力总览", group: "Agent" },
    { id: "agent-architecture-next", path: "AGENT-ARCHITECTURE-NEXT.md", title: "Agent 架构演进", group: "Agent" },
    // 评测
    { id: "scoring-standard", path: "SCORING_STANDARD.md", title: "评测标准", group: "评测" },
    { id: "edu-evaluation", path: "EDU-EVALUATION.md", title: "教育评测与实测", group: "评测" },
    // 集成
    { id: "claude-code", path: "integrations/claude-code.md", title: "Claude Code 集成", group: "集成" },
    { id: "codex-cli", path: "integrations/codex-cli.md", title: "Codex CLI 集成", group: "集成" },
    { id: "deepseek-harness", path: "integrations/deepseek-harness.md", title: "DeepSeek Harness 集成", group: "集成" },
    { id: "data-sources-guide", path: "DATA-SOURCES-GUIDE.md", title: "外部数据源目录", group: "集成" },
    { id: "skills-guide", path: "SKILLS-GUIDE.md", title: "Skill 目录与导入", group: "集成" },
    // 合规
    { id: "open-source-disclosure", path: "OPEN-SOURCE-DISCLOSURE.md", title: "开源披露", group: "合规" },
    { id: "features-detail", path: "FEATURES-DETAILED.md", title: "功能明细", group: "合规" },
  ];

  app.get("/api/docs", async (request) => {
    const query = request.query as { id?: string };
    const id = query.id || "overview";
    const entry = DOC_INDEX.find((d) => d.id === id) ?? DOC_INDEX[0];
    const filePath = path.join(DOCS_ROOT, entry.path);
    let content = "";
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { content = "# 文档未找到\n\n该文档不存在或已被移动。"; }
    return {
      index: DOC_INDEX.map((d) => ({ id: d.id, title: d.title, group: d.group })),
      current: { id: entry.id, title: entry.title, content },
    };
  });

  // ─── 教育复用资产 API（V389：模板/案例/示例课程 浏览入口）───
  const EDU_ASSETS_ROOT = path.join(rootDir, "education-templates");
  app.get("/api/education/assets", async (request) => {
    const query = request.query as { kind?: string; name?: string };
    const kind = query.kind || "templates";

    if (kind === "templates") {
      // 场景模板列表 + 单模板内容
      const files = fs.readdirSync(EDU_ASSETS_ROOT).filter((f) => f.endsWith(".json"));
      const templates = files.map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(EDU_ASSETS_ROOT, f), "utf-8"));
          return { file: f, name: j.name, description: j.description, route: j.route };
        } catch { return { file: f, name: f.replace(".json", ""), description: "", route: null }; }
      });
      if (query.name) {
        const safe = String(query.name).replace(/[^a-z0-9-.]/gi, "");
        const target = path.join(EDU_ASSETS_ROOT, safe);
        // 防路径穿越：确保 target 在 EDU_ASSETS_ROOT 内
        if (!target.startsWith(EDU_ASSETS_ROOT + path.sep)) return { ok: false, error: "非法路径" };
        try { return { ok: true, template: JSON.parse(fs.readFileSync(target, "utf-8")) }; }
        catch { return { ok: false, error: "模板不存在" }; }
      }
      return { ok: true, templates };
    }

    if (kind === "cases") {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(rootDir, "data", "education-cases.json"), "utf-8"));
        return { ok: true, cases: j.cases || [] };
      } catch { return { ok: false, error: "案例库读取失败" }; }
    }

    if (kind === "courses") {
      // 示例课程状态（seed 脚本是否已入库 source_chunks）
      const r = await pool.query(`select count(*)::int as n from source_chunks where metadata->>'kind' = '示例课程'`);
      const seeded = (r.rows[0]?.n || 0) > 0;
      // 已入库的示例课程切片（含标题与内容）
      const chunks = await pool.query(
        `select heading, content, metadata->>'subject' as subject from source_chunks where metadata->>'kind' = '示例课程' order by heading`
      );
      return {
        ok: true,
        seeded,
        count: r.rows[0]?.n || 0,
        seedCommand: "npx tsx scripts/seed-edu-courses.ts",
        courses: (chunks.rows || []).map((c: any) => ({ title: c.heading, subject: c.subject, content: (c.content || "").slice(0, 300) })),
      };
    }

    return { ok: false, error: "未知资产类型" };
  });

  // ─── 教育资产导入 API（V389：示例课程一键入库 / 模板 / 案例写入）───
  app.post("/api/education/assets/import", async (request) => {
    const body = (request.body ?? {}) as { action?: string; kind?: string; name?: string; data?: unknown };

    // ① 示例课程一键入库（复用 seed-edu-courses 逻辑）
    if (body.action === "seed-courses") {
      // 示例课程数据（与 scripts/seed-edu-courses.ts 的 COURSES 一致）
      const COURSES = [
        { subject: "政治经济学", chapters: [
          { title: "商品与价值", content: "商品是用来交换的劳动产品，具有使用价值和价值二因素。使用价值是商品能满足人们某种需要的属性，是价值的物质承担者；价值是凝结在商品中的无差别的人类劳动。商品二因素由生产商品的劳动二重性决定：具体劳动创造使用价值，抽象劳动形成价值。价值量由生产商品的社会必要劳动时间决定，与劳动生产率成反比。" },
          { title: "价值规律", content: "价值规律是商品经济的基本规律：商品的价值量由生产商品的社会必要劳动时间决定，商品交换以价值量为基础实行等价交换。价格受供求关系影响围绕价值上下波动，这是价值规律的表现形式。价值规律的作用：自发调节生产资料和劳动力在社会各生产部门之间的分配；刺激商品生产者改进技术、提高劳动生产率；促使商品生产者优胜劣汰。" },
          { title: "剩余价值", content: "剩余价值是雇佣工人在生产过程中创造的、被资本家无偿占有的超过劳动力价值的价值。剩余价值生产是资本主义生产的绝对规律：绝对剩余价值生产靠延长劳动日，相对剩余价值生产靠缩短必要劳动时间。剩余价值率 = 剩余价值 / 可变资本。剩余价值理论是马克思主义政治经济学的核心。" },
        ]},
        { subject: "数学", chapters: [
          { title: "一元二次方程与配方法", content: "配方法是解一元二次方程的基本方法之一。对于 ax² + bx + c = 0（a ≠ 0），配方步骤：① 化二次项系数为 1；② 移项，常数项移到等号右边；③ 配方，两边同时加一次项系数一半的平方；④ 左边写成完全平方；⑤ 开平方求解，注意正负号。" },
          { title: "因式分解", content: "因式分解是把一个多项式分解为几个整式乘积的形式，是配方法等后续学习的基础。常用方法：提公因式法、公式法（平方差 a² - b² = (a+b)(a-b)、完全平方 a² ± 2ab + b² = (a±b)²）、十字相乘法。因式分解是解一元二次方程与化简分式的核心技能。" },
        ]},
      ];
      const SOURCE_ID = process.env.EDU_SOURCE_ID || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";
      let total = 0;
      for (const course of COURSES) {
        for (const ch of course.chapters) {
          const exists = await pool.query(`select id from source_chunks where heading = $1 limit 1`, [ch.title]);
          if (exists.rows.length > 0) continue;
          await pool.query(
            `insert into source_chunks (id, source_id, source_type, heading, content, raw_content, rank, metadata)
             values (gen_random_uuid(), $1, 'document', $2, $3, $3, 0, $4)`,
            [SOURCE_ID, ch.title, ch.content, JSON.stringify({ subject: course.subject, kind: "示例课程" })]
          );
          total += 1;
        }
      }
      return { ok: true, imported: total, note: total > 0 ? `新增 ${total} 条课程切片` : "全部已存在，无新增" };
    }

    // ② 模板/案例写入（追加到对应 JSON 文件）
    if (body.kind && body.name && body.data) {
      const safeName = String(body.name).replace(/[^a-z0-9-.]/gi, "");
      if (!safeName.endsWith(".json")) return { ok: false, error: "文件名需以 .json 结尾" };
      let dir: string;
      if (body.kind === "templates") dir = path.join(rootDir, "education-templates");
      else if (body.kind === "cases") dir = path.join(rootDir, "data");
      else return { ok: false, error: "kind 仅支持 templates/cases" };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safeName), JSON.stringify(body.data, null, 2), "utf-8");
      // 案例库特殊：追加到 education-cases.json 的 cases 数组
      if (body.kind === "cases") {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, "education-cases.json"), "utf-8"));
          if (!j.cases.some((c: any) => c.id === (body.data as any).id)) {
            j.cases.push(body.data);
            fs.writeFileSync(path.join(dir, "education-cases.json"), JSON.stringify(j, null, 2), "utf-8");
          }
        } catch { /* 忽略 */ }
      }
      return { ok: true, saved: safeName };
    }

    return { ok: false, error: "参数不完整（需 action 或 kind+name+data）" };
  });

  // ─── 教育外部资源源 API（V389：学校资源库/公开平台接入）───
  app.get("/api/education/sources", async (request) => {
    const { educationResourceSourcesService } = await import("../services/education-resource-sources.js");
    const sources = await educationResourceSourcesService.listSources();
    return { ok: true, sources };
  });
  app.post("/api/education/sources/upsert", async (request) => {
    const { educationResourceSourcesService } = await import("../services/education-resource-sources.js");
    return educationResourceSourcesService.upsertSource(request.body as any);
  });
  app.post("/api/education/sources/fetch", async (request) => {
    const { educationResourceSourcesService } = await import("../services/education-resource-sources.js");
    const body = (request.body ?? {}) as { sourceId?: string };
    const sources = await educationResourceSourcesService.listSources();
    const source = sources.find((s: any) => s.id === body.sourceId);
    if (!source) return { ok: false, error: "来源不存在" };
    const fetched = await educationResourceSourcesService.fetchFromSource(source);
    return { ok: fetched.ok, items: fetched.items, error: fetched.error };
  });
  app.post("/api/education/sources/import", async (request) => {
    const { educationResourceSourcesService } = await import("../services/education-resource-sources.js");
    return educationResourceSourcesService.importFromSource(request.body as any);
  });

  // ─── 教育复用资产（个人/公共隔离：学生 personal + public，教师 public）───
  app.get("/api/education/asset-store", async (request) => {
    const { educationAssetStoreService } = await import("../services/education-asset-store.js");
    const query = request.query as { role?: string; kind?: string };
    return educationAssetStoreService.listAssets({
      role: query.role === "student" ? "student" : "teacher",
      kind: query.kind,
    });
  });
  app.post("/api/education/asset-store/add", async (request) => {
    const { educationAssetStoreService } = await import("../services/education-asset-store.js");
    return educationAssetStoreService.addAsset(request.body as any);
  });
  app.post("/api/education/asset-store/delete", async (request) => {
    const { educationAssetStoreService } = await import("../services/education-asset-store.js");
    return educationAssetStoreService.deleteAsset(request.body as any);
  });

  // 模式切换（写入 mode.json，重启后生效）：POST { mode: "preview" | "full" }
  // V441: 写 cwd（userData/sag-root，可写）而非 rootDir（安装目录只读）— 与 index.ts 读取路径一致
  app.post("/api/mode", async (request) => {
    const body = (request.body ?? {}) as { mode?: string };
    const mode = body.mode === "full" ? "full" : "preview";
    fs.writeFileSync(path.join(process.cwd(), "mode.json"), JSON.stringify({ mode, updatedAt: new Date().toISOString() }), "utf-8");
    return { ok: true, mode, note: "重启服务后生效（当前模式不变）" };
  });

  app.get("/api/model-call-logs", async (request) => {
    const query = request.query as { after?: string };
    const after = query.after ? Number(query.after) : 0;
    return listModelCallLogs(Number.isFinite(after) ? after : 0);
  });

  app.get("/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await graphService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await webuiService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  // ───── 商业化认证 API（V388+: 注册/登录/me） ─────
  app.post("/api/auth/register", async (request, reply) => {
    const body = request.body as { username?: string; password?: string; email?: string };
    const r = await authService.register(body.username || "", body.password || "", body.email);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // V390修复: 注册即登录 — 直接签发 JWT（原只返回 user, 前端无 token 导致计费/运营接口全部 401）
    const loginRes = await authService.login(body.username || "", body.password || "");
    if (loginRes.ok && loginRes.token) {
      return { token: loginRes.token, user: loginRes.user };
    }
    return { user: r.user };
  });
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const r = await authService.login(body.username || "", body.password || "");
    if (!r.ok) return reply.code(401).send({ error: r.error });
    return { token: r.token, user: r.user };
  });
  app.get("/api/auth/me", async (request, reply) => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = authService.verifyToken(token);
    if (!payload) return reply.code(401).send({ error: "未登录" });
    const user = await authService.getUserById(payload.uid);
    if (!user) return reply.code(401).send({ error: "用户不存在" });
    return { user };
  });
  // V389: 认证启用状态（前端 AuthGate 判断是否需要登录; 环境变量 SAG_AUTH_ENABLED=true 启用）
  app.get("/api/auth/status", async () => ({ enabled: (process.env.SAG_AUTH_ENABLED || "false") === "true" }));

  // ───── V390: 邮箱找回密码 ─────
  // 绑定/更新邮箱（JWT 用户, 需登录）
  app.post("/api/auth/email", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { email?: string };
    const r = await authService.setEmail(user.id, body.email || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  // 忘记密码 → 发重置邮件（无需登录; 防枚举统一返回 ok）
  app.post("/api/auth/forgot-password", async (request, reply) => {
    const body = request.body as { email?: string };
    const r = await authService.requestPasswordReset(body.email || "", String(request.headers.origin || request.protocol + "://" + request.hostname + (request.port ? ":" + request.port : "")));
    if (r.smtpError) return { ok: true, smtpError: r.smtpError };  // SMTP 未配置: 前端提示需配置（不暴露邮箱存在性）
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  // 重置密码（token 一次性, 无需登录）
  app.post("/api/auth/reset-password", async (request, reply) => {
    const body = request.body as { token?: string; newPassword?: string };
    const r = await authService.resetPassword(body.token || "", body.newPassword || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });

  // ───── 商业化计费 API（V389+: 余额/充值/订阅/账单/用量, JWT认证） ─────
  // JWT 认证辅助: 从 Authorization 提取用户（V3xx: 校验 status='active', disabled 一律 403）
  const requireUser = async (request: any, reply: any) => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = authService.verifyToken(token);
    if (!payload) { reply.code(401).send({ error: "未登录" }); return null; }
    const user = await authService.getUserById(payload.uid);
    if (!user) { reply.code(401).send({ error: "用户不存在" }); return null; }
    // 已禁用账号: 拒绝一切需登录的 API（与登录校验对齐; 已签发 token 不再有效）
    if (user.status === "disabled") { reply.code(403).send({ error: "账号已被禁用" }); return null; }
    return user;
  };

  // V3xx: 会话租户隔离 — 从 JWT 提取当前用户 tenantId（未登录/无 JWT → 默认公共租户）
  const requestTenantId = async (request: any): Promise<string> => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    if (token) {
      const payload = authService.verifyToken(token);
      if (payload?.tenantId) return payload.tenantId;
    }
    return config.DEFAULT_TENANT_ID;
  };

  app.get("/api/billing/balance", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const quota = await billingService.getSubscriptionQuota(user.id);
    return { balanceCents: user.balanceCents, ...quota };
  });
  app.post("/api/billing/recharge", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { amountCents?: number };
    const amount = Math.min(Math.max(Number(body.amountCents) || 0, 100), 10_000_000);
    const r = await billingService.recharge(user.id, amount);
    return r;
  });
  app.post("/api/billing/subscribe", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { plan?: string };
    const r = await billingService.subscribe(user.id, body.plan || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  app.get("/api/billing/records", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    return { records: await billingService.getBillingRecords(user.id, parseInt(q.limit || "50", 10)) };
  });
  // V390: 删除账单记录（仅本人; 用量扣费记录保留追溯, 只允许删充值/调整类）
  app.delete("/api/billing/records/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const params = request.params as { id: string };
    const r = await billingService.deleteBillingRecord(user.id, params.id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  app.get("/api/billing/usage", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { days?: string };
    return { usage: await billingService.getUsage(user.id, parseInt(q.days || "7", 10)) };
  });

  // ───── BYOK API（V389+: 用户自带 LLM key） ─────
  app.post("/api/user/llm-config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { provider?: "platform" | "byok"; apiKey?: string };
    const provider = body.provider === "byok" ? "byok" : "platform";
    const r = await authService.setByokKey(user.id, body.apiKey || "", provider);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, provider };
  });

  // ───── 企业租户 API（V389+: 企业注册/邀请/接受/成员） ─────
  app.post("/api/enterprise/register", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { companyName?: string };
    const r = await authService.registerEnterprise(user.id, body.companyName || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, tenantId: r.tenantId };
  });
  app.post("/api/enterprise/invite", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { username?: string; role?: string };
    const r = await authService.inviteMember(user.id, body.username || "", body.role || "member");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  app.get("/api/enterprise/invites", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { invites: await authService.listPendingInvites(user.username) };
  });
  app.post("/api/enterprise/invite/:id/accept", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const params = request.params as { id: string };
    const r = await authService.acceptInvite(user.id, user.username, params.id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  app.get("/api/enterprise/members", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const m = await pool.query("select tenant_id from users where id = $1", [user.id]);
    if (m.rows.length === 0) return { members: [] };
    return { members: await authService.listTenantMembers(m.rows[0].tenant_id) };
  });
  app.get("/api/user/llm-config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const cfg = await authService.getUserLlmConfig(user.id);
    return { provider: cfg.provider, hasKey: !!cfg.apiKey };
  });

  // ───── 运营管理 API（V389+: 审计/用量/用户管理, 仅 admin） ─────
  const requireAdmin = async (request: any, reply: any) => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = authService.verifyToken(token);
    if (!payload || payload.role !== "admin") { reply.code(403).send({ error: "需要管理员权限" }); return null; }
    // 已禁用管理员同样拒绝（disabled 状态全局生效）
    const admin = await authService.getUserById(payload.uid);
    if (!admin || admin.status === "disabled") { reply.code(403).send({ error: "账号已被禁用" }); return null; }
    return payload;
  };
  app.get("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return { users: await opsService.adminUserStats() };
  });
  app.get("/api/admin/usage", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { days?: string };
    return { usage: await opsService.adminUsageSummary(parseInt(q.days || "7", 10)) };
  });
  app.get("/api/admin/audit", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { limit?: string };
    return { logs: await opsService.adminAuditLogs(parseInt(q.limit || "100", 10)) };
  });
  app.post("/api/admin/user/:id/plan", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const params = request.params as { id: string };
    const body = request.body as { plan?: string };
    if (!body.plan || !billingService.PLANS[body.plan]) return reply.code(400).send({ error: "未知计划" });
    await pool.query("update users set plan = $2 where id = $1", [params.id, body.plan]);
    return { ok: true };
  });

  // V390: 运营管理增强 — 禁用/启用/调余额/重置密码（admin 操作全记录审计）
  app.post("/api/admin/user/:id/status", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { status?: string };
    if (body.status !== "active" && body.status !== "disabled") return reply.code(400).send({ error: "status 需为 active/disabled" });
    const r = await authService.setUserStatus(admin.uid, params.id, body.status);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  app.post("/api/admin/user/:id/balance", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { deltaCents?: number };
    const r = await authService.adminAdjustBalance(admin.uid, params.id, Number(body.deltaCents) || 0);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, balanceCents: r.balanceCents };
  });
  app.post("/api/admin/user/:id/reset-password", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { newPassword?: string };
    const r = await authService.adminResetPassword(admin.uid, params.id, body.newPassword || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });

  app.get("/api/projects", async (request) => {
    const query = request.query as { limit?: string; cursor?: string; includeArchived?: string };
    // V392修复: JWT 用户按租户查项目（公共库 + 用户自己租户合并）— 原缺省 tenantId 查不到任何项目
    const authHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtPayload = authHdr && authService.verifyToken(authHdr);
    let tenantIds: string[] = [];
    if (jwtPayload) {
      const u = await pool.query("select tenant_id from users where id = $1", [jwtPayload.uid]);
      // V454: 带 token 也包含 DEFAULT_TENANT_ID（default 租户）— 项目创建时归 default 租户，
      // 若只查 PUBLIC_TENANT + 用户租户，default 项目全部不可见（刷新后列表为空）
      if (u.rows.length > 0) tenantIds = [PUBLIC_TENANT, config.DEFAULT_TENANT_ID, u.rows[0].tenant_id];
    } else {
      // V398: 未登录（本机/无 JWT）也应可见公共库（PUBLIC_TENANT）项目 — 公开文献资产
      tenantIds = [PUBLIC_TENANT, config.DEFAULT_TENANT_ID];
    }
    const projects = tenantIds.length > 0
      ? await webuiService.listProjectsByTenants(tenantIds, {
          limit: query.limit ? Number(query.limit) : undefined,
          cursor: query.cursor,
          includeArchived: query.includeArchived === "true",
        })
      : await webuiService.listProjects({
          limit: query.limit ? Number(query.limit) : undefined,
          cursor: query.cursor,
          includeArchived: query.includeArchived === "true",
        });
    return { projects };
  });

  app.post("/api/projects", async (request, reply) => {
    // V381 M3: 外部令牌禁止写内容管理(读/分析不受限)
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const input = projectSchema.parse(request.body);
    const project = await webuiService.createProject(input);
    return reply.code(201).send({ project });
  });

  app.patch("/api/projects/:projectId", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const input = projectUpdateSchema.parse(request.body);
    return {
      project: await webuiService.updateProject(params.projectId, input)
    };
  });

  app.post("/api/projects/:projectId/archive", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.archiveProject(params.projectId)
    };
  });

  app.post("/api/projects/:projectId/restore", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.restoreProject(params.projectId)
    };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });  // V388: 删除保护
    const params = request.params as { projectId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.projectId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除项目必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteProject(params.projectId);
  });

  app.get("/api/sources/:sourceId/documents", async (request) => {
    const params = request.params as { sourceId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.sourceId);
    return {
      documents: await webuiService.listDocuments(params.sourceId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/documents", async (request) => {
    const params = request.params as { projectId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.projectId);
    return {
      documents: await webuiService.listDocuments(params.projectId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/stats", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      stats: await webuiService.getProjectStats(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/graph", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      graph: await webuiService.getProjectGraph(params.projectId)
    };
  });

  // 事件方向推断（关系查询 in/out 语义支撑；首次调用 LLM 批量推断缺失方向）
  app.post("/api/projects/:projectId/graph/infer-directions", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const result = await directionService.inferEventDirections(params.projectId);
    return result;
  });

  app.post("/api/documents/upload", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    // V389: 私有文档 — JWT 用户上传 → source 归用户租户（仅自己/企业成员可见）
    const authHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtPayload = authHdr && authService.verifyToken(authHdr);
    if (jwtPayload) {
      const user = await authService.getUserById(jwtPayload.uid);
      if (user) (request as any).jwtUser = { id: user.id, tenantId: user.tenantId, username: user.username };
    }
    if (ctx) {
      // 外部 token: 字节配额检查 (body 已解析, 此时才可查字节)
      const r = await quotaService.ensureWithinQuota(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
      if (r.blocked) {
        reply.header("Retry-After", String(r.retryAfterSec ?? 0));
        return reply.code(429).send({
          error: { code: "QUOTA_EXCEEDED", message: "入库配额已用完, 请稍后再试", retryAfterSec: r.retryAfterSec ?? 0, quotaStatus: r.quotaStatus },
        });
      }
    }
    const result = await webuiService.uploadDocument(input, undefined, (request as any).jwtUser);
    if (ctx) quotaService.recordUsage(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
    return reply.code(201).send(result);
  });

  app.post("/api/documents/upload/jobs", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    if (ctx) {
      const r = await quotaService.ensureWithinQuota(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
      if (r.blocked) {
        reply.header("Retry-After", String(r.retryAfterSec ?? 0));
        return reply.code(429).send({
          error: { code: "QUOTA_EXCEEDED", message: "入库配额已用完, 请稍后再试", retryAfterSec: r.retryAfterSec ?? 0, quotaStatus: r.quotaStatus },
        });
      }
    }
    const job = await webuiService.createUploadJob(input);
    if (ctx) quotaService.recordUsage(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
    return reply.code(202).send({ job });
  });

  app.get("/api/documents/upload/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const job = webuiService.getUploadJob(params.jobId);
    if (!job) {
      return reply.code(404).send(notFound("UPLOAD_JOB_NOT_FOUND", "上传任务不存在"));
    }
    return { job };
  });

  // 2026-08-12：ingest_jobs 批量任务 API（batch-ingest-jobs.ts 写统计用）
  app.post("/api/ingest-jobs", async (request) => {
    const body = (request.body ?? {}) as { sourceId?: string; engine?: string; jobType?: string };
    const r = await pool.query(
      `insert into ingest_jobs (source_id, engine, job_type, status, paper_count, started_at)
       values ($1, $2, $3, 'running', 0, now()) returning *`,
      [body.sourceId ?? config.DEFAULT_TENANT_ID, body.engine ?? "sag", body.jobType ?? "batch-ingest"]
    );
    return { job: r.rows[0] };
  });

  app.patch("/api/ingest-jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const body = (request.body ?? {}) as { processed?: number; failed?: number; total?: number };
    const r = await pool.query(
      `update ingest_jobs set
         processed_count = $2, failed_count = $3,
         paper_count = greatest(paper_count, $4),
         updated_at = now()
       where id = $1 returning *`,
      [params.jobId, body.processed ?? 0, body.failed ?? 0, body.total ?? 0]
    );
    if (r.rows.length === 0) return reply.code(404).send(notFound("INGEST_JOB_NOT_FOUND", "批量任务不存在"));
    return { job: r.rows[0] };
  });

  app.patch("/api/ingest-jobs/:jobId/complete", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const body = (request.body ?? {}) as { ok?: number; fail?: number };
    const r = await pool.query(
      `update ingest_jobs set
         status = 'completed', processed_count = $2, failed_count = $3,
         completed_at = now(), updated_at = now()
       where id = $1 returning *`,
      [params.jobId, body.ok ?? 0, body.fail ?? 0]
    );
    if (r.rows.length === 0) return reply.code(404).send(notFound("INGEST_JOB_NOT_FOUND", "批量任务不存在"));
    return { job: r.rows[0] };
  });

  // 活跃上传任务列表（未完成）——前端启动时拉取，让后台脚本/刷新后的任务可见
  app.get("/api/documents/upload/jobs", async () => {
    return { jobs: webuiService.listActiveUploadJobs() };
  });

  app.get("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const document = await webuiService.getDocument(params.documentId);
    if (!document) {
      return reply.code(404).send(notFound("DOCUMENT_NOT_FOUND", "文档不存在"));
    }
    return { document };
  });

  app.patch("/api/documents/:documentId", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const input = documentUpdateSchema.parse(request.body);
    return {
      document: await webuiService.updateDocument(params.documentId, input)
    };
  });

  app.post("/api/documents/:documentId/archive", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.archiveDocument(params.documentId)
    };
  });

  app.post("/api/documents/:documentId/restore", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.restoreDocument(params.documentId)
    };
  });

  app.delete("/api/documents/:documentId", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });
    const params = request.params as { documentId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.documentId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除文档必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteDocument(params.documentId);
  });

  app.get("/api/documents/:documentId/chunks", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      chunks: await webuiService.listChunks(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/events", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      events: await webuiService.listEvents(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/entities", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      entities: await webuiService.listEntities(params.documentId)
    };
  });

  app.post("/ingest", async (request, reply) => {
    const input = ingestSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    if (ctx) {
      const r = await quotaService.ensureWithinQuota(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
      if (r.blocked) {
        reply.header("Retry-After", String(r.retryAfterSec ?? 0));
        return reply.code(429).send({
          error: { code: "QUOTA_EXCEEDED", message: "入库配额已用完, 请稍后再试", retryAfterSec: r.retryAfterSec ?? 0, quotaStatus: r.quotaStatus },
        });
      }
    }
    const result = await ingestionService.ingestDocument(input);
    if (ctx) quotaService.recordUsage(ctx.tokenId, "ingest", { estimatedBytes: Buffer.byteLength(input.content, "utf8") });
    return reply.code(201).send(result);
  });

  // V399: Graphiti/Cognee 引擎入库（后台执行 orchestrate_ingest.py）
  const engineIngestProcs = new Map<string, { startedAt: string; running: boolean }>();
  app.post("/api/ingest/engine", async (request, reply) => {
    const body = (request.body ?? {}) as { engine?: string };
    const engine = body.engine === "cognee" ? "cognee" : "graphiti";
    const existing = engineIngestProcs.get(engine);
    if (existing?.running) {
      return reply.code(409).send({ error: { code: "INGEST_RUNNING", message: `${engine} 入库已在运行中` } });
    }
    engineIngestProcs.set(engine, { startedAt: new Date().toISOString(), running: true });
    // 后台执行
    const { spawn } = await import("node:child_process");
    const py = process.env.COGNEE_PYTHON || "";
    const child = spawn(py, ["scripts/orchestrate_ingest.py", `--${engine}`], {
      cwd: rootDir,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("close", (code) => {
      const rec = engineIngestProcs.get(engine);
      if (rec) rec.running = false;
      console.warn(`[ingest-engine] ${engine} 完成 exit=${code}`);
    });
    return { ok: true, engine, startedAt: engineIngestProcs.get(engine)!.startedAt };
  });

  app.get("/api/ingest/engine/status", async (request) => {
    const query = request.query as { engine?: string };
    const engine = query.engine === "cognee" ? "cognee" : "graphiti";
    const rec = engineIngestProcs.get(engine);
    return { engine, running: rec?.running ?? false, startedAt: rec?.startedAt ?? null };
  });

  // V406: 图库入库监控 — 概览（左侧文档队列 + 右侧各步骤计数）/ 文档详情 / 检索
  app.get("/api/ingest/monitor/overview", async (request) => {
    const { ingestMonitorService } = await import("../services/ingest-monitor-service.js");
    const q = request.query as { engine?: string };
    return ingestMonitorService.overview(q.engine === "cognee" ? "cognee" : "graphiti");
  });
  app.get("/api/ingest/monitor/doc", async (request) => {
    const { ingestMonitorService } = await import("../services/ingest-monitor-service.js");
    const q = request.query as { engine?: string; name?: string };
    return ingestMonitorService.docDetail(q.engine === "cognee" ? "cognee" : "graphiti", q.name || "");
  });
  app.get("/api/ingest/monitor/search", async (request) => {
    const { ingestMonitorService } = await import("../services/ingest-monitor-service.js");
    const q = request.query as { engine?: string; q?: string; doc?: string };
    return ingestMonitorService.search(q.engine === "cognee" ? "cognee" : "graphiti", q.q || "", q.doc || undefined);
  });

  // V400: Neo4j 库直连浏览（安全只读：类型统计/按标签列表/实体搜索/关系图）
  app.get("/api/neo4j/stats", async (request) => {
    const { neo4jBrowserService } = await import("../services/neo4j-browser-service.js");
    const q = request.query as { engine?: string };
    return neo4jBrowserService.typeStats(q.engine === "cognee" ? "cognee" : "graphiti");
  });
  app.get("/api/neo4j/label", async (request) => {
    const { neo4jBrowserService } = await import("../services/neo4j-browser-service.js");
    const q = request.query as { engine?: string; label?: string; limit?: string; skip?: string };
    return neo4jBrowserService.listByLabel(
      q.engine === "cognee" ? "cognee" : "graphiti",
      q.label || "Entity", Number(q.limit) || 30, Number(q.skip) || 0
    );
  });
  app.get("/api/neo4j/search", async (request) => {
    const { neo4jBrowserService } = await import("../services/neo4j-browser-service.js");
    const q = request.query as { engine?: string; q?: string };
    return neo4jBrowserService.searchEntity(q.engine === "cognee" ? "cognee" : "graphiti", q.q || "");
  });
  app.get("/api/neo4j/graph", async (request) => {
    const { neo4jBrowserService } = await import("../services/neo4j-browser-service.js");
    const q = request.query as { engine?: string; name?: string };
    return neo4jBrowserService.entityGraph(q.engine === "cognee" ? "cognee" : "graphiti", q.name || "");
  });

  app.post("/search", async (request) => {
    const input = searchSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    const result = await searchService.search(input);
    if (ctx) void recordSearchUsage(ctx.tokenId, result.traceId);
    return result;
  });

  app.post("/api/search", async (request) => {
    const input = searchSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    const result = await searchService.search(input);
    if (ctx) {
      // 外部 token: 按 traceId 聚合真实 LLM token 用量 (trace_spans 已落库) → 记账
      void recordSearchUsage(ctx.tokenId, result.traceId);
    }
    return result;
  });

  app.post("/api/search/stream", async (request, reply) => {
    const input = searchSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") {
        flush.call(reply.raw);
      }
    };

    try {
      const result = await searchService.search(input, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
      const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
      if (ctx) void recordSearchUsage(ctx.tokenId, result.traceId);
      send("done", {
        type: "done",
        result
      });
    } catch (error) {
      send("error", {
        type: "error",
        message: getErrorMessage(error)
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  // V337(用户控制): 记忆注入设置 — 是否注入 + 模式 + 数量（环境变量, 持久化到 memory-settings.json）
  // 注: 环境变量在服务启动时读取, 修改后需重启服务生效（设置面板会提示）
  const MEMORY_SETTINGS_FILE = "memory-settings.json";
  function readMemorySettings(): { enabled: string; mode: string; count: string } {
    try {
      if (fs.existsSync(path.join(rootDir, MEMORY_SETTINGS_FILE))) {
        return JSON.parse(fs.readFileSync(path.join(rootDir, MEMORY_SETTINGS_FILE), "utf-8"));
      }
    } catch { /* 损坏忽略 */ }
    return { enabled: "on", mode: "all", count: "2" };
  }
  app.get("/api/settings/memory-inject", async () => {
    const s = readMemorySettings();
    return {
      settings: {
        enabled: s.enabled,           // on / off
        mode: s.mode,                 // all / success / top
        count: s.count,               // 0-5
      },
      note: "修改后需重启服务生效",
    };
  });
  app.put("/api/settings/memory-inject", async (request) => {
    const body = (request.body ?? {}) as { enabled?: string; mode?: string; count?: number };
    const cur = readMemorySettings();
    const next = {
      enabled: body.enabled === "off" ? "off" : "on",
      mode: ["all", "success", "top"].includes(body.mode || "") ? body.mode! : cur.mode,
      count: String(Math.min(Math.max(body.count ?? 2, 0), 5)),
    };
    try {
      fs.writeFileSync(path.join(rootDir, MEMORY_SETTINGS_FILE), JSON.stringify(next, null, 2), "utf-8");
      return { ok: true, settings: next, note: "重启服务后生效" };
    } catch (e: any) {
      return { ok: false, error: String(e).substring(0, 100) };
    }
  });

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });

  app.get("/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    const event = await graphService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "事件不存在"
        }
      });
    }
    return event;
  });

  app.get("/api/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    const event = await webuiService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send(notFound("EVENT_NOT_FOUND", "事件不存在"));
    }
    return event;
  });

  app.get("/api/entities/:entityId", async (request, reply) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    const entity = await webuiService.getEntity(params.entityId);
    if (!entity) {
      return reply.code(404).send(notFound("ENTITY_NOT_FOUND", "实体不存在"));
    }
    return entity;
  });

  app.post("/api/mcp/sessions", async (request, reply) => {
    const input = createMcpSessionSchema.parse(request.body);
    const session = await mcpAgentService.createSession(input, await requestTenantId(request));
    return reply.code(201).send({ session });
  });

  // V398: 会话重命名（AI 对话页/项目会话通用）
  app.post("/api/mcp/sessions/:sessionId/rename", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(request.body);
    const session = await mcpAgentService.updateTitle(params.sessionId, title, await requestTenantId(request));
    if (!session) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return { session };
  });

  // V398: 撤回单条消息（AI 对话页回复前撤回）
  app.delete("/api/mcp/sessions/:sessionId/messages/:messageId", async (request, reply) => {
    const params = request.params as { sessionId: string; messageId: string };
    z.string().uuid().parse(params.sessionId);
    z.string().uuid().parse(params.messageId);
    const result = await mcpAgentService.deleteMessage(params.sessionId, params.messageId, await requestTenantId(request));
    if (!result) {
      return reply.code(404).send(notFound("MCP_MESSAGE_NOT_FOUND", "消息不存在"));
    }
    return result;
  });

  // V398: 通用 AI 对话会话列表（kind=chat）
  app.get("/api/chat/sessions", async (request) => ({
    sessions: await mcpAgentService.listSessions({ kind: "chat" }, await requestTenantId(request))
  }));

  app.get("/api/mcp/sessions", async (request) => ({
    sessions: await mcpAgentService.listSessions({}, await requestTenantId(request))
  }));

  app.get("/api/projects/:projectId/mcp/sessions", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      sessions: await mcpAgentService.listSessions({ sourceId: params.projectId }, await requestTenantId(request))
    };
  });

  app.get("/api/mcp/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.getSession(params.sessionId, await requestTenantId(request));
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.post("/api/mcp/sessions/:sessionId/clear", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.clearSession(params.sessionId, await requestTenantId(request));
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.delete("/api/mcp/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    return mcpAgentService.deleteSession(params.sessionId, await requestTenantId(request));
  });

  app.post("/api/mcp/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const tenantId = await requestTenantId(request);
    const authHdrU = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtU = authHdrU ? authService.verifyToken(authHdrU) : null;
    const result = await mcpAgentService.runUserMessage({
      sessionId: params.sessionId,
      content: input.content,
      userId: jwtU?.uid
    }, tenantId);
    return reply.code(201).send(result);
  });

  app.post("/api/mcp/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const abortController = new AbortController();
    let completed = false;
    const abortRun = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    request.raw.on("aborted", abortRun);
    reply.raw.on("close", abortRun);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      if (abortController.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await mcpAgentService.runUserMessage({
        sessionId: params.sessionId,
        content: input.content,
        signal: abortController.signal
      }, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        send("error", {
          type: "error",
          message: getErrorMessage(error)
        });
      }
    } finally {
      completed = true;
      request.raw.off("aborted", abortRun);
      reply.raw.off("close", abortRun);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  // ───── V398: 通用 AI 对话（ChatPanel）─────

  /** 图片上传：base64 → data/agent_workspace/chat_uploads/ 相对路径（≤2MB，扩展名白名单） */
  async function persistChatImage(dataUrl: string, allowDocs = false): Promise<{ path: string; name: string; sizeKB: number } | { error: string }> {
    // V399: 支持文档（PDF/Office/文本）+ 图片；扩展名白名单
    const mimeMatch = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
    if (!mimeMatch) return { error: "格式不支持" };
    const mime = mimeMatch[1].toLowerCase();
    const raw = Buffer.from(mimeMatch[2], "base64");
    if (raw.length === 0) return { error: "文件内容为空" };
    if (raw.length > 20 * 1024 * 1024) return { error: "文件超过 20MB 上限" };
    const extMap: Record<string, string> = {
      "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "application/vnd.ms-powerpoint": "ppt",
      "text/plain": "txt", "text/markdown": "md", "text/csv": "csv"
    };
    const ext = extMap[mime];
    if (!ext) return { error: "仅支持 png/jpg/jpeg/gif/webp 图片 + PDF/Word/Excel/PPT/文本" };
    const isImage = ["png", "jpg", "gif", "webp", "bmp"].includes(ext);
    if (!isImage && !allowDocs) return { error: "仅支持图片（文档请经对话附件上传）" };
    if (isImage && raw.length > 2 * 1024 * 1024) return { error: "图片超过 2MB 上限，请压缩后重试" };
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const uploadsDir = nodePath.join(process.env.SAG_ROOT || nodePath.resolve(process.cwd()), "data", "agent_workspace", "chat_uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const fileName = `${randomUUID()}.${ext}`;
    fs.writeFileSync(nodePath.join(uploadsDir, fileName), raw);
    return { path: `chat_uploads/${fileName}`, name: fileName, sizeKB: Math.round(raw.length / 1024) };
  }

  app.post("/api/chat/uploads", async (request, reply) => {
    const { dataUrl } = z.object({ dataUrl: z.string().min(20).max(3_500_000) }).parse(request.body);
    const saved = await persistChatImage(dataUrl);
    if ("error" in saved) {
      return reply.code(400).send({ error: saved.error });
    }
    return reply.code(201).send(saved);
  });

  // V399: 对话工具审批（前端弹窗 → 批准/拒绝 review 工具）
  // V3xx: 审批 ID 绑定 sessionId+userId — 仅本人会话的审批可批准（防跨会话/跨用户审批）
  app.post("/api/chat/approvals/:approvalId", async (request, reply) => {
    const params = request.params as { approvalId: string };
    const { approved } = z.object({ approved: z.boolean() }).parse(request.body);
    const user = await requireUser(request, reply); if (!user) return;
    const ok = await mcpAgentService.approveToolCall(params.approvalId, approved, user.id);
    if (!ok) {
      return reply.code(404).send(notFound("APPROVAL_NOT_FOUND", "审批请求不存在或已超时"));
    }
    return { ok: true, approved };
  });

  app.post("/api/chat/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = z.object({
      content: z.string().trim().min(1).max(20000),
      images: z.array(z.object({ dataUrl: z.string().min(20), name: z.string().max(200) })).max(6).optional(),
      webSearch: z.boolean().optional(),
      deepMode: z.boolean().optional(),
      reasoningEffort: z.enum(["low", "high", "max"]).optional(),
      docs: z.array(z.object({ dataUrl: z.string().min(20), name: z.string().max(200) })).max(3).optional()
    }).parse(request.body);

    const tenantId = await requestTenantId(request);
    const authHdrU = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtU = authHdrU ? authService.verifyToken(authHdrU) : null;
    const detail = await mcpAgentService.getSession(params.sessionId, tenantId);
    if (!detail || detail.session.kind !== "chat") {
      return reply.code(404).send(notFound("CHAT_SESSION_NOT_FOUND", "AI 对话会话不存在"));
    }

    // 图片持久化（base64 → 相对路径，不入库）
    let images: Array<{ path: string; name: string }> | undefined;
    if (input.images?.length) {
      images = [];
      for (const img of input.images) {
        const saved = await persistChatImage(img.dataUrl);
        if ("error" in saved) {
          return reply.code(400).send({ error: saved.error });
        }
        images.push({ path: saved.path, name: img.name });
      }
    }
    // V399: 文档附件持久化（PDF/Office/文本 → agent_workspace/chat_uploads/）
    let docs: Array<{ path: string; name: string }> | undefined;
    if (input.docs?.length) {
      docs = [];
      for (const doc of input.docs) {
        const saved = await persistChatImage(doc.dataUrl, true);
        if ("error" in saved) {
          return reply.code(400).send({ error: saved.error });
        }
        docs.push({ path: saved.path, name: doc.name });
      }
    }

    const abortController = new AbortController();
    let completed = false;
    const abortRun = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    request.raw.on("aborted", abortRun);
    reply.raw.on("close", abortRun);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      if (abortController.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // V399: 审批事件注入（review 工具 → 前端弹窗）
    mcpAgentService.emitApproval = (event) => {
      if (event.sessionId === params.sessionId) {
        send("tool_approval", event);
      }
    };

    try {
      await mcpAgentService.runUserMessage({
        sessionId: params.sessionId,
        content: input.content,
        images,
        webSearch: input.webSearch,
        deepMode: input.deepMode,
        reasoningEffort: input.reasoningEffort,
        docs,
        userId: jwtU?.uid,
        signal: abortController.signal
      }, tenantId, (event) => {
        send(event.type, event);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        send("error", {
          type: "error",
          message: getErrorMessage(error)
        });
      }
    } finally {
      completed = true;
      mcpAgentService.emitApproval = undefined;
      request.raw.off("aborted", abortRun);
      reply.raw.off("close", abortRun);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  // ───── 推理 API (11005) ─────
  app.post("/api/reason/query", async (request, reply) => {
    const input = reasonSchema.parse(request.body);
    const reasonQuery: any = { sourceId: input.sourceId, query: input.query };
    if (input.topK) reasonQuery.topK = input.topK;
    if (input.paperId && input.paperId.length > 0) reasonQuery.paperId = input.paperId;
    if (input.ablation && input.ablation.length > 0) reasonQuery.ablation = input.ablation;
    if (input.mode) reasonQuery.mode = input.mode; // V267: 推理模式 template/adaptive
    if (input.sources && input.sources.length > 0) reasonQuery.sources = input.sources; // V387: 三库检索源配置透传
    if (input.questionId) reasonQuery.questionId = input.questionId; // V294: 评测联动（反思归因）
    // V389: BYOK — JWT 用户传入推理链（getLlmEndpoint 用用户 key 覆盖平台 key）
    const authHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtPayload = authHdr && authService.verifyToken(authHdr);
    if (jwtPayload) {
      const llmCfg = await authService.getUserLlmConfig(jwtPayload.uid);
      if (llmCfg.provider === "byok" && llmCfg.apiKey) reasonQuery.userLlmConfig = { provider: "byok", apiKey: llmCfg.apiKey };
      reasonQuery.userId = jwtPayload.uid;
      // V389: 租户隔离 — 校验 sourceId 归属（公共租户或用户自己租户）
      const access = await authService.verifySourceAccess(jwtPayload.uid, reasonQuery.sourceId);
      if (!access.allowed) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }
      // V391(P1-3): 租户计算配额 — 按租户隔离并发推理数（free 2 / pro 5 / enterprise 20）
      const u = await pool.query("select tenant_id, plan from users where id = $1", [jwtPayload.uid]);
      if (u.rows.length > 0) {
        const tenantId = u.rows[0].tenant_id;
        const plan = u.rows[0].plan || "free";
        // 租户频率限制（60s 窗口）
        const rateCheck = tenantRateLimiter.check(`tenant:${tenantId}`, 30);
        if (!rateCheck.allowed) {
          return reply.code(429).send({ error: { code: "TENANT_RATE_LIMITED", message: "租户请求过于频繁, 请稍后再试", retryAfterSec: rateCheck.retryAfterSec } });
        }
        // 并发槽位
        if (!tryAcquireTenantSlot(tenantId, plan)) {
          return reply.code(429).send({ error: { code: "TENANT_BUSY", message: `租户并发推理已达上限(${tenantConcurrencyLimit(plan)}), 请稍后再试` } });
        }
        reasonQuery.tenantId = tenantId;
        reasonQuery.releaseTenantSlot = () => releaseTenantSlot(tenantId);
      }
    }
    try {
      const result = await startReasonFlow(reasonQuery);
      const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
      if (ctx) {
        // reason 计月成本: 从 taskId 聚合 retrieve_steps 真实 tokens
        const taskId = result?.taskId ?? (result as any)?.id;
        void recordReasonUsage(ctx.tokenId, taskId);
      }
      // V389: JWT 用户计费 — 聚合 retrieve_steps tokens → chargeUser（订阅额度→超额扣余额）
      if (jwtPayload && reasonQuery.userId) {
        const taskId = result?.taskId ?? (result as any)?.id;
        void (async () => {
          try {
            const agg = await pool.query(
              `select coalesce(sum((parameters->'tokens'->>'in')::int), 0) as tin,
                      coalesce(sum((parameters->'tokens'->>'out')::int), 0) as tout
               from retrieve_steps where task_id = $1`, [taskId]);
            const tin = Number(agg.rows[0]?.tin || 0);
            const tout = Number(agg.rows[0]?.tout || 0);
            if (tin + tout > 0) {
              const llmCfg = await authService.getUserLlmConfig(reasonQuery.userId);
              const model = llmCfg.provider === "byok" ? "deepseek-v4-flash" : "deepseek-v4-flash";
              await billingService.chargeUser(reasonQuery.userId, model, tin, tout, "/api/reason/query");
            }
          } catch { /* 计费失败不阻塞响应 */ }
        })();
      }
      return reply.code(201).send(result);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('_TIMEOUT') || msg.includes('MCP_TIMEOUT')) {
        return reply.code(503).send({ error: { code: "RETRIEVAL_TIMEOUT", message: "检索超时，请稍后重试" } });
      }
      if (e instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "请求参数无效" } });
      }
      logger.error({ error: msg }, "reason flow failed");
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "推理服务暂时不可用" } });
    } finally {
      // V391(P1-3): 释放租户并发槽位 — try/finally 保证异常路径也一定释放（防槽位泄漏）
      reasonQuery.releaseTenantSlot?.();
    }
  });

  // 2026-08-07 流式输出：推理完成后答案分块 SSE 推送（长答案逐步渲染）
  app.post("/api/reason/query/stream", async (request, reply) => {
    const input = reasonSchema.parse(request.body);
    const reasonQuery: any = { sourceId: input.sourceId, query: input.query };
    if (input.topK) reasonQuery.topK = input.topK;
    if (input.paperId && input.paperId.length > 0) reasonQuery.paperId = input.paperId;
    if (input.ablation && input.ablation.length > 0) reasonQuery.ablation = input.ablation;
    if (input.mode) reasonQuery.mode = input.mode;
    if (input.sessionId) reasonQuery.sessionId = input.sessionId;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") flush.call(reply.raw);
    };
    try {
      const result = await startReasonFlow(reasonQuery);
      const content = (result.trace?.hypothesis as any)?.content || "";
      // 分块推送答案（每 120 字一块，80ms 间隔——模拟打字效果）
      const CHUNK = 120;
      for (let i = 0; i < content.length; i += CHUNK) {
        send("token", { type: "token", text: content.slice(i, i + CHUNK), index: i / CHUNK });
        await new Promise((r) => setTimeout(r, 80));
      }
      send("done", { type: "done", result });
    } catch (e: any) {
      send("error", { type: "error", message: getErrorMessage(e) });
    } finally {
      reply.raw.end();
    }
  });

  // ───── 证据 → LLM 综合回答 API（Ask 面板闭环）─────
  const composeAnswerSchema = z.object({
    query: z.string().min(1),
    evidence: z.array(z.object({
      title: z.string(),
      content: z.string(),
      heading: z.string().optional()
    })).min(1)
  });

  app.post("/api/compose-answer", async (request, reply) => {
    const input = composeAnswerSchema.parse(request.body);
    try {
      // 2026-08-07 模型注册表：Ask 综合回答用 reason 角色（用户可选）
      const result = await llmClient.composeAnswer({ ...input, modelOverride: getRoleModel("reason") } as any);
      return reply.code(201).send(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "composeAnswer failed");
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "综合回答生成失败" } });
    }
  });

  // ───── LLM 直接执行 API（2026-08-07：替代 Claude CLI，直调 LLM API）─────
  // POST /api/ai/execute — {prompt, model?} 用注册表模型直调（默认 reason 角色）
  const aiExecuteLlmSchema = z.object({
    prompt: z.string().min(1).max(8000),
    model: z.string().max(50).optional(),
  });

  app.post("/api/ai/execute", async (request, reply) => {
    const input = aiExecuteLlmSchema.parse(request.body);
    try {
      const dsKey = process.env.DEEPSEEK_API_KEY || "";
      const key = dsKey || (process.env.LLM_API_KEY || "");
      const url = dsKey
        ? (process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions")
        : (process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1") + "/chat/completions";
      // 模型：优先显式指定，否则用注册表 reason 角色（用户选择）
      const model = input.model ?? getRoleModel("reason");
      const startedAt = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: input.prompt }],
          temperature: 0.2,
          max_tokens: 3000,
        }),
      });
      const data: any = await res.json();
      const output = data?.choices?.[0]?.message?.content || data?.error?.message || JSON.stringify(data).slice(0, 500);
      // V348: 外部 token 调用直调 LLM → 按输出估算 tokens 记账 (计 reason 成本)
      const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
      if (ctx) {
        const tokensIn = Math.ceil((input.prompt.length + 16) / 4);
        const tokensOut = Math.ceil((output?.length ?? 0) / 4);
        quotaService.recordUsage(ctx.tokenId, "reason", { tokensInput: tokensIn, tokensOutput: tokensOut });
      }
      return {
        ok: Boolean(data?.choices?.[0]?.message?.content),
        output,
        model,
        tookMs: Date.now() - startedAt,
        exitCode: null,
      };
    } catch (e: any) {
      // V348: 外部请求脱敏, 不暴露内部错误细节
      const isExternal = !!((request as any).tokenCtx);
      return { ok: false, output: isExternal ? "调用失败" : `调用失败: ${String(e?.message || e).slice(0, 300)}`, model: input.model ?? "?", tookMs: 0, exitCode: null };
    }
  });

  // ───── LLM 关系抽取：快速建联的深度识别模式 ─────
  const llmExtractSchema = z.object({
    text: z.string().min(1).max(5000),
    relationTypes: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1)
    })).min(1).max(50)
  });
  app.post("/api/quick-links/llm-extract", async (request, reply) => {
    const input = llmExtractSchema.parse(request.body);
    try {
      const triples = await llmClient.extractRelations(input);
      return reply.code(200).send({ triples });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "llm-extract failed");
      return reply.code(500).send({ error: { code: "LLM_EXTRACT_FAILED", message: msg } });
    }
  });

  app.get("/api/reason/tasks/:taskId", async (request) => {
    const params = request.params as { taskId: string };
    const input = getReasonTaskSchema.parse(params);
    const detail = await getReasonTaskDetail(input.taskId);
    if (!detail) {
      return { error: { code: "TASK_NOT_FOUND", message: "推理任务不存在" } };
    }
    return detail;
  });

  // MCP 工具大全（静态清单 + 中文说明，预览模式可用）
  app.get("/api/mcp/tools", async () => getAllMcpTools());

  // MCP 动态连接状态（真实工作中/断开）
  app.get("/api/mcp/status", async () => ({
    status: await getMcpConnectionStatus()
  }));

  // ───── Sciverse 外部检索 API ─────
  const sciverseParamsSchema = z.object({
    query: z.string().optional(),
    tool: z.enum(["catalog", "semantic_search", "search_papers", "read_content", "relations", "get_resource"]),
    top_k: z.number().int().min(1).max(30).optional(),
    doc_id: z.string().optional(),
    unique_id: z.string().optional(),
    relation: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(16384).optional(),
    page: z.number().int().min(1).optional(),
    page_size: z.number().int().min(1).max(50).optional(),
    collection: z.string().optional(),
    title_contains: z.string().optional(),
    authors: z.array(z.string()).optional(),
    year_from: z.number().int().optional(),
    year_to: z.number().int().optional(),
    language: z.string().optional(),
    filters_advanced: z.array(z.record(z.unknown())).optional(),
    file_name: z.string().optional(),
    mode: z.enum(["auto", "mock", "online"]).optional()
  });

  app.post("/api/sciverse/search", async (request) => {
    const input = sciverseParamsSchema.parse(request.body);
    const result = await sciverseService.dispatch(input.tool, input);
    if (result.error) {
      return { ...result, ok: false };
    }
    return { ...result, ok: true };
  });

  app.get("/api/sciverse/catalog", async (request) => {
    const query = request.query as { collection?: string };
    const result = await sciverseService.dispatch("catalog", { collection: query.collection ?? "papers" });
    return { ...result, ok: !result.error };
  });

  app.get("/api/sciverse/status", async () => ({
    configured: sciverseService.isConfigured(),
    baseUrl: sciverseService.getBaseUrl()
  }));

  // 知网引文网络（CDP 代理，从 Edge 知网页面提取）
  const cnkiCitationTypeSchema = z.enum([
    "references", "citations", "coreferences", "cocitations", "secondreferences", "secondcitations"
  ]);
  app.get("/api/cnki/citations/:type", async (request, reply) => {
    const params = request.params as { type: string };
    const parsed = cnkiCitationTypeSchema.safeParse(params.type);
    if (!parsed.success) {
      return reply.code(400).send(notFound("BAD_CITATION_TYPE", "引文类型无效"));
    }
    const result = await cnkiCitationProxy.fetch(parsed.data);
    if (!result.ok && result.error) {
      return reply.code(502).send(notFound("CNKI_CITATION_FAILED", result.error));
    }
    return result;
  });

  // 知网搜索并打开论文详情页（联动引文网络）
  const cnkiSearchSchema = z.object({
    query: z.string().min(1).max(100)
  });
  app.post("/api/cnki/search-open", async (request, reply) => {
    const input = cnkiSearchSchema.parse(request.body);
    const result = await cnkiCitationProxy.searchAndOpen(input.query);
    if (!result.ok) {
      return reply.code(502).send(notFound("CNKI_SEARCH_FAILED", result.error ?? "知网搜索失败"));
    }
    return result;
  });

  // ───── AI 执行桥：面板 → Claude Code ─────
  const aiExecuteSchema = z.object({
    prompt: z.string().min(1).max(4000),
    cwd: z.string().max(500).optional(),
    timeoutMs: z.number().int().min(10000).max(300000).optional(),
    noTools: z.boolean().optional(),
    /** 2026-08-07 模型选择：claude 模型 ID */
    model: z.string().max(50).optional()
  });
  app.get("/api/ai-execute/status", async () => ({
    available: aiExecuteService.available()
  }));
  app.post("/api/ai-execute", async (request, reply) => {
    const input = aiExecuteSchema.parse(request.body);
    if (!aiExecuteService.available()) {
      return reply.code(503).send(notFound("CLAUDE_CLI_UNAVAILABLE", "claude CLI 不可用，请确认已安装 Claude Code"));
    }
    const result = await aiExecuteService.execute(input);
    return result;
  });

  // ───── Jobs 任务队列 API（GBrain Jobs 适配）─────
  const jobsEnqueueSchema = z.object({
    jobType: z.enum(["lint", "backlinks", "sync", "synthesize", "embed", "orphans", "purge", "extract", "patterns", "recompute_emotional_weight", "dream_cycle", "batch_ingest", "hyperedge"]),
    payload: z.record(z.string(), z.unknown()).optional(),
    priority: z.number().int().optional(),
    schedule: z.string().optional(),
    delayMs: z.number().int().optional(),
    idempotencyKey: z.string().optional()
  });
  app.post("/api/jobs", async (request, reply) => {
    const input = jobsEnqueueSchema.parse(request.body);
    const job = await jobsService.enqueue(input);
    return reply.code(201).send({ job });
  });
  app.get("/api/jobs", async (request) => {
    const params = request.query as { status?: string; limit?: string };
    const [jobs, stats] = await Promise.all([
      jobsService.list({ status: params.status, limit: Number(params.limit ?? 50) }),
      jobsService.stats()
    ]);
    return { jobs, stats };
  });
  app.get("/api/jobs/worker", async () => ({
    running: jobsService.hasHandler("lint") // worker 已注册处理器即视为可用
  }));
  app.delete("/api/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    const deleted = await jobsService.delete(params.jobId);
    return { deleted };
  });

  // ───── Trace Waterfall API（统一 span：Ask 步骤 + Jobs 流水）─────
  app.get("/api/traces", async (request) => {
    const params = request.query as { limit?: string };
    const traces = await traceService.listTraces({ limit: Number(params.limit ?? 20) });
    return { traces };
  });
  // ───── 评测结果可视化（V273）─────
  // GET /api/eval/results — 列出根目录 eval_*.json 文件（排除旧格式 eval_results_*.json）
  // GET /api/eval/results?file=xxx.json — 返回该文件完整内容
  // V445: 评测/巡检用户确认 — 启动不再自动跑（防静默消费 LLM），前端需用户确认后手动触发
  app.post("/api/eval/confirm", async (request) => {
    const body = (request.body ?? {}) as { action?: string };
    const action = body.action === "proactive" ? "proactive" : "eval";
    if (action === "eval") {
      // 触发评测（EVAL_LIMIT=4，异步执行，结果见评测工作台运行区）
      const { runEvalWithEvents } = await import("../services/eval-runner.js");
      void runEvalWithEvents({ script: "eval-32-metrics", env: { EVAL_LIMIT: "4" } }, () => true);
      return { ok: true, action, result: { started: true } };
    }
    const { runProactiveResearch } = await import("../services/agent-proactive-research.js");
    const result = await runProactiveResearch();
    return { ok: true, action, result: { created: result.created.length, skipped: result.skipped } };
  });
  // V445: 当前 LLM 配置与模型（前端提示"用什么模型"）
  app.get("/api/eval/model-info", async () => {
    const { getLlmEndpoint } = await import("../ai/llm-common.js");
    try {
      const ep = await getLlmEndpoint();
      return { ok: true, model: ep.model, baseUrl: ep.url, provider: ep.url.includes("deepseek") ? "DeepSeek" : ep.url.includes("dashscope") || ep.url.includes("aliyun") ? "阿里云百炼" : "其他" };
    } catch {
      return { ok: false, model: "未知" };
    }
  });
  app.get("/api/eval/results", async (request) => {
    const params = request.query as { file?: string };
    const fs = await import("node:fs");
    const path = await import("node:path");
    const rootDir = process.env.SAG_ROOT || process.cwd();
    // V399: 评测文件已移入 evaluation/ 目录 — 优先查 evaluation/，根目录兜底
    const evalDir = path.join(rootDir, "evaluation");
    const resolveEvalFile = (name: string) => {
      const inEval = path.join(evalDir, name);
      if (fs.existsSync(inEval)) return inEval;
      return path.join(rootDir, name);
    };
    if (params.file) {
      // 防目录穿越：只允许 eval_*.json
      const safeName = path.basename(params.file);
      if (!safeName.startsWith("eval_") || !safeName.endsWith(".json") || safeName.startsWith("eval_results_")) {
        return { error: "文件不合法" };
      }
      const filePath = resolveEvalFile(safeName);
      if (!fs.existsSync(filePath)) return { error: "文件不存在" };
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        // W8: 主评测结果附带 Agent 维度摘要（两套评测体系桥接）
        let agentSummary: Record<string, unknown> | undefined;
        try {
          const { agentEvalService } = await import("../services/agent-eval-service.js");
          const rep = await agentEvalService.generateAgentEvalReport(7);
          agentSummary = {
            completionRate: rep.completionRate,
            stepSuccessRate: rep.stepSuccessRate,
            toolAccuracy: rep.toolAccuracy,
            planAdherence: rep.planAdherence,
            reasoningQuality: rep.reasoningQuality,
            multiLoopRate: rep.multiLoopRate,
            totalTasks: rep.totalTasks,
            judgedTasks: rep.judgedTasks,
          };
        } catch { /* agent 摘要失败不影响主结果 */ }
        return { file: safeName, data: content, agentSummary };
      } catch (e: any) {
        return { error: "JSON 解析失败: " + (e?.message || String(e)).substring(0, 100) };
      }
    }
    // 列表：扫描 evaluation/ + 根目录 eval_*.json（V399: 文件已移入 evaluation/）
    try {
      const scanDirs = [evalDir, rootDir];
      const files: Array<{ name: string; updatedAt: Date; size: number; questionCount: number; overallAvg: number }> = [];
      for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith("eval_") || !f.endsWith(".json") || f.startsWith("eval_results_")) continue;
          if (files.some((x) => x.name === f)) continue;  // evaluation/ 优先，根目录同名校跳
          const stat = fs.statSync(path.join(dir, f));
          let questionCount = 0;
          let overallAvg = 0;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
            if (Array.isArray(data) && data.length > 0) {
              questionCount = data.length;
              const valid = data.filter((r: any) => typeof r?.overall === "number" && !r?.error);
              overallAvg = valid.length > 0 ? valid.reduce((s: number, r: any) => s + r.overall, 0) / valid.length : 0;
            }
          } catch { /* 解析失败跳过统计 */ }
          files.push({ name: f, updatedAt: stat.mtime, size: stat.size, questionCount, overallAvg });
        }
      }
      files.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { files };
    } catch (e: any) {
      return { error: (e?.message || String(e)).substring(0, 100) };
    }
  });

  // ───── 评测实时运行（2026-08-06）─────
  // POST /api/eval/run — 启动评测脚本，SSE 推送流程事件（phase/question_start/question_done/metric_done/log/done/error）
  // body: { script: "eval-32-metrics"|"run-eval-dual"|"ablation-eval", questions?, output?, dims?, mergePolicy?, limit?, operators? }
  const evalRunSchema = z.object({
    script: z.enum(["eval-32-metrics", "run-eval-dual", "ablation-eval"]),
    questions: z.string().optional(),
    output: z.string().regex(/^eval_[a-zA-Z0-9_-]+\.json$/).optional(),
    dims: z.string().optional(),
    mergePolicy: z.enum(["max", "min", "avg", "rule_only", "llm_only"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    operators: z.string().optional(),
    // V381: 评测配置（模型/模式/机制）——白名单校验后透传为 EVAL_* 环境变量
    env: z.record(z.string()).optional(),
  });

  app.post("/api/eval/run", async (request, reply) => {
    const input = evalRunSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") flush.call(reply.raw);
    };

    // 客户端断开 → 杀评测进程
    // 注意: 必须监听 reply.raw 的 close（request.raw 的 close 在请求体读完时就触发，会误杀）
    // V382 fix: 按 runId 精准杀, 不误伤并发评测
    const evalRunId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let closed = false;
    const onClose = () => {
      if (!(reply.raw as typeof reply.raw & { writableEnded?: boolean }).writableEnded) {
        closed = true;
        killActiveEvalRun(evalRunId); // 立即杀评测子进程（即使它阻塞在无输出的 SAG 请求）
      }
    };
    reply.raw.on("close", onClose);
    const emit = (evt: { type: string }): boolean | void => {
      if (closed) return false;
      try {
        send(evt.type === "log" ? "log" : "progress", evt);
      } catch {
        closed = true;
        return false;
      }
      return !closed;
    };

    const env: Record<string, string> = {};
    if (input.questions) env.EVAL_QUESTIONS = input.questions;
    if (input.output) env.EVAL_OUTPUT = input.output;
    if (input.dims) env.EVAL_DIMS = input.dims;
    if (input.mergePolicy) env.EVAL_MERGE_POLICY = input.mergePolicy;
    if (input.limit) env.EVAL_LIMIT = String(input.limit);
    if (input.operators) env.EVAL_OPERATORS = input.operators;
    // V381: 评测配置白名单透传（模型/模式/机制）——V382 fix: 精确键集合, 防任意 EVAL_* 前缀注入
    const EVAL_ENV_ALLOWLIST = new Set([
      "EVAL_QUESTIONS", "EVAL_OUTPUT", "EVAL_DIMS", "EVAL_MERGE_POLICY", "EVAL_LIMIT", "EVAL_OPERATORS",
      "EVAL_MODEL", "EVAL_MODE", "EVAL_MECHANISM", "EVAL_JUDGE_MODEL", "EVAL_REASON_MODEL",
    ]);
    if (input.env) {
      for (const [k, v] of Object.entries(input.env)) {
        if (EVAL_ENV_ALLOWLIST.has(k) && v !== undefined && v !== "") env[k] = v;
      }
    }

    try {
      const { code, output } = await runEvalWithEvents(
        { script: input.script as EvalScript, env, runId: evalRunId },
        (evt) => emit(evt)
      );
      if (!closed) {
        send("done", { type: "done", code, output: output || undefined });
      }
    } catch (e) {
      send("error", { type: "error", message: getErrorMessage(e) });
    } finally {
      reply.raw.removeListener("close", onClose);
      reply.raw.end();
    }
  });

  // ───── 评测学习引擎 API（2026-08-08 V290：P0-2 归因数据 + P0-1/3/4 报告文件）─────
  // GET /api/eval/failures — 查 eval_failures 表（类别统计 + 逐题归因列表）
  app.get("/api/eval/failures", async () => {
    try {
      const { pool } = await import("../db/pool.js");
      const [cats, items, layerCounts] = await Promise.all([
        pool.query("select failure_category, count(*)::int as n from eval_failures group by failure_category order by n desc"),
        pool.query("select eval_run_id, question_id, failure_category, first_error_step, tool_name, evidence, root_cause, is_recoverable, confidence, layer from eval_failures order by id"),
        pool.query("select layer, count(*)::int as n from eval_failures where layer is not null group by layer order by n desc"),
      ]);
      const runRow = items.rows.length > 0 ? await pool.query("select eval_run_id from eval_failures order by id limit 1") : null;
      return {
        categoryCounts: cats.rows.map((r: any) => ({ category: r.failure_category, count: r.n })),
        // V329(P1-6): 三层验证 layer 分布（result/process/quality）
        layerCounts: layerCounts.rows.map((r: any) => ({ layer: r.layer, count: r.n })),
        // PG numeric 列返回字符串 → 转 number，前端直接可用
        items: items.rows.map((r: any) => ({ ...r, confidence: r.confidence !== null ? Number(r.confidence) : null })),
        runId: runRow?.rows?.[0]?.eval_run_id ?? null,
        total: items.rows.length,
      };
    } catch {
      // DB 不可用 → 空数据（前端靠 total===0 回退 demo）
      return { categoryCounts: [], items: [], layerCounts: [], runId: null, total: 0 };
    }
  });

  // GET /api/eval/reports — 列评测报告（V399: 报告已移入 reports/ 目录）
  // 允许的报告名（防目录穿越）
  const EVAL_REPORT_NAMES = ["significance_report.md", "failure_report.md", "tp_report.md", "kappa_report.md"];
  app.get("/api/eval/reports", async (request) => {
    const params = request.query as { name?: string };
    const rootDir = process.env.SAG_ROOT || process.cwd();
    const reportsDir = path.join(rootDir, "reports");
    const resolveReport = (name: string) => {
      const inReports = path.join(reportsDir, name);
      if (fs.existsSync(inReports)) return inReports;
      return path.join(rootDir, name);
    };
    if (params.name) {
      const safeName = path.basename(params.name);
      if (!EVAL_REPORT_NAMES.includes(safeName)) return { error: "报告名不合法" };
      const filePath = resolveReport(safeName);
      if (!fs.existsSync(filePath)) return { name: safeName, exists: false, content: "", updatedAt: null };
      const stat = fs.statSync(filePath);
      return { name: safeName, exists: true, content: fs.readFileSync(filePath, "utf-8"), updatedAt: stat.mtime };
    }
    // 列表：扫描 reports/ + 根目录 *_report.md
    try {
      const files: Array<{ name: string; updatedAt: Date; size: number }> = [];
      for (const dir of [reportsDir, rootDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!EVAL_REPORT_NAMES.includes(f)) continue;
          if (files.some((x) => x.name === f)) continue;
          const stat = fs.statSync(path.join(dir, f));
          files.push({ name: f, updatedAt: stat.mtime, size: stat.size });
        }
      }
      files.sort((a: any, b: any) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { files };
    } catch (e: any) {
      return { error: (e?.message || String(e)).substring(0, 100) };
    }
  });

  // V331(P1-9): 预算感知记录（adaptive 执行中裁剪事件, 前端展示省钱效果）
  app.get("/api/eval/budget-prunes", async (request) => {
    const params = request.query as { limit?: string };
    try {
      const { pool: bp } = await import("../db/pool.js");
      const r = await bp.query(
        `select task_id, query, parameters, created_at from retrieve_steps
         where search_type = 'budget_pruned' order by created_at desc limit $1`,
        [Math.min(parseInt(params.limit ?? "10", 10) || 10, 50)]
      );
      return {
        items: r.rows.map((row: any) => {
          let params2: any = {};
          try { params2 = typeof row.parameters === "string" ? JSON.parse(row.parameters) : (row.parameters || {}); } catch {}
          return { taskId: row.task_id, query: String(row.query || "").substring(0, 60), op: params2.op, executedCost: params2.executed_cost, budget: params2.budget, createdAt: row.created_at };
        }),
      };
    } catch {
      return { items: [] };
    }
  });

  // 按类型分组（Ask/入库/Jobs 各组独立，互不挤占）
  app.get("/api/traces/grouped", async (request) => {
    const params = request.query as { perGroup?: string };
    return traceService.listTracesGrouped({ perGroup: Number(params.perGroup ?? 50) });
  });
  // ───── V298: 闭环流转聚合 API — 四个学习闭环的状态一次返回（实时同步用）─────
  // GET /api/eval/loop — { loops: { reflection, trajectoryReflux, minDiffPatch, badCasePromote } }
  // 每个闭环: { enabled(是否已实现), status(数据就绪度), counts, lastRun, items(最近产物) }
  app.get("/api/eval/loop", async () => {
    const rootDir = process.env.SAG_ROOT || process.cwd();
    const readJson = (file: string): any | null => {
      try {
        const p = path.join(rootDir, file);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch { return null; }
    };
    // 归因表（闭环① 输入 + ② 输入 + ④ 输入）
    let failures: { total: number; categories: any[]; lastRun: string | null } = { total: 0, categories: [], lastRun: null };
    try {
      const { pool } = await import("../db/pool.js");
      const [cnt, cat, last] = await Promise.all([
        pool.query("select count(*)::int as n from eval_failures"),
        pool.query("select failure_category, count(*)::int as n from eval_failures group by failure_category order by n desc"),
        pool.query("select eval_run_id from eval_failures order by id desc limit 1"),
      ]);
      failures = { total: cnt.rows[0].n, categories: cat.rows, lastRun: last.rows[0]?.eval_run_id ?? null };
    } catch { /* DB 不可用 → 空 */ }

    // 候选 TP 题（闭环② 产物）
    const tpCands = readJson("data/trajectory_prefix_candidates.json");
    // 新 gold 候选（闭环④ 产物）
    const goldCands = readJson("data/gold_candidates.json");
    // 补丁表（闭环③ 产物）
    let patches: { total: number; byStatus: any[]; lastRun: string | null } = { total: 0, byStatus: [], lastRun: null };
    try {
      const { pool } = await import("../db/pool.js");
      const [cnt, st, last] = await Promise.all([
        pool.query("select count(*)::int as n from prompt_patches"),
        pool.query("select status, count(*)::int as n from prompt_patches group by status"),
        pool.query("select created_at from prompt_patches order by id desc limit 1"),
      ]);
      patches = { total: cnt.rows[0].n, byStatus: st.rows, lastRun: last.rows[0] ? new Date(last.rows[0].created_at).toISOString() : null };
    } catch { /* DB 不可用 → 空 */ }

    return {
      loops: {
        // 闭环① 反思接归因（推理时实时查询归因表）
        reflection: {
          id: "reflection", label: "反思接归因",
          enabled: true, trigger: "每次推理反思时（实时）",
          status: failures.total > 0 ? "ready" : "empty",
          counts: { failures: failures.total },
          lastRun: failures.lastRun,
          items: [],
        },
        // 闭环② 归因→轨迹回流（归因脚本末尾生成候选）
        trajectoryReflux: {
          id: "trajectoryReflux", label: "归因→轨迹回流",
          enabled: true, trigger: "跑 failure-attribution.ts 后",
          status: tpCands?.candidates?.length > 0 ? "ready" : "empty",
          counts: { candidates: tpCands?.candidates?.length ?? 0, confirmed: (tpCands?.candidates || []).filter((c: any) => c.status === "confirmed").length },
          lastRun: tpCands?.generated_at ?? null,
          items: (tpCands?.candidates || []).slice(-3).map((c: any) => ({ id: c.id, source: c.source_question, status: c.status })),
        },
        // 闭环③ 最小 diff 补丁（手动跑 min-diff-patch.ts）
        minDiffPatch: {
          id: "minDiffPatch", label: "最小 diff 补丁",
          enabled: true, trigger: "跑 min-diff-patch.ts 后",
          status: patches.total > 0 ? "ready" : "empty",
          counts: { patches: patches.total },
          lastRun: patches.lastRun,
          items: [],
        },
        // 闭环④ bad case 回流（手动跑 promote-to-gold.ts）
        badCasePromote: {
          id: "badCasePromote", label: "Bad Case 回流",
          enabled: true, trigger: "跑 promote-to-gold.ts 后",
          status: goldCands?.candidates?.length > 0 ? "ready" : "empty",
          counts: { candidates: goldCands?.candidates?.length ?? 0, confirmed: (goldCands?.candidates || []).filter((c: any) => c.status === "confirmed").length },
          lastRun: goldCands?.generated_at ?? null,
          items: (goldCands?.candidates || []).slice(-3).map((c: any) => ({ id: c.id, source: c.source_question, status: c.status })),
        },
      },
    };
  });
  app.get("/api/traces/:traceId", async (request) => {
    const params = request.params as { traceId: string };
    const spans = await traceService.list({ traceId: params.traceId });
    return { spans };
  });
  // 批量删除（body: { traceIds: string[] }）— 必须注册在 /:traceId 之前
  const tracesBatchDeleteSchema = z.object({
    traceIds: z.array(z.string().uuid()).min(1).max(500)
  });
  app.delete("/api/traces/batch", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });  // V388: 删除保护
    const input = tracesBatchDeleteSchema.parse(request.body);
    return traceService.deleteTracesBatch(input.traceIds);
  });
  app.delete("/api/traces/:traceId", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });  // V388: 删除保护
    const params = request.params as { traceId: string };
    return traceService.deleteTrace(params.traceId);
  });
  app.delete("/api/traces", async (request, reply) => {
    if ((request as any).tokenCtx) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "外部令牌只读, 内容管理仅限本机" } });  // V388: 删除保护
    return traceService.clearTraces();
  });

  // ───── Skills 注册表 API ─────
  // ───── 记忆层 API（2026-08-07：短期会话记忆 + 长期经验）─────
  // GET /api/memory/context?sessionId=xxx — 取会话记忆（推理注入用）
  // POST /api/memory/context — 保存一次对话记忆
  // DELETE /api/memory/context?sessionId=xxx — 清空会话记忆
  app.get("/api/memory/context", async (request) => {
    const params = request.query as { sessionId?: string; limit?: string };
    if (!params.sessionId) return { contexts: [] };
    const contexts = await memoryService.listConversationContexts(
      params.sessionId,
      Number(params.limit ?? 6)
    );
    return { contexts };
  });

  app.post("/api/memory/context", async (request) => {
    const input = request.body as {
      sessionId: string;
      projectId?: string;
      query: string;
      answerSummary?: string;
      citations?: string[];
    };
    if (!input.sessionId || !input.query) return { error: "sessionId 和 query 必填" };
    await memoryService.saveConversationContext(input);
    return { ok: true };
  });

  // ───── V326: 记忆管理 API（P1-4 记忆向量化 + P1-8 睡眠学习 的前端展示）─────
  // GET /api/memory/stats — 长期经验统计（总数/归档/冲突/向量覆盖）
  app.get("/api/memory/stats", async () => {
    try {
      const { pool: mp } = await import("../db/pool.js");
      const [total, archived, conflict, withEmbedding] = await Promise.all([
        mp.query("select count(*)::int as n from task_experience"),
        mp.query("select count(*)::int as n from task_experience where archived = true"),
        mp.query("select count(*)::int as n from task_experience where conflict_unsolved = true"),
        mp.query("select count(*)::int as n from task_experience where embedding is not null"),
      ]);
      return {
        total: total.rows[0].n,
        archived: archived.rows[0].n,
        conflicts: conflict.rows[0].n,
        vectorized: withEmbedding.rows[0].n,
      };
    } catch {
      return { total: 0, archived: 0, conflicts: 0, vectorized: 0 };
    }
  });
  // GET /api/memory/recent?limit=10 — 最近记忆（供前端展示）
  app.get("/api/memory/recent", async (request) => {
    const params = request.query as { limit?: string };
    try {
      const { pool: mp } = await import("../db/pool.js");
      const r = await mp.query(
        `select query, qtype, success, quality_score, archived, conflict_unsolved, created_at
         from task_experience order by created_at desc limit $1`,
        [Math.min(parseInt(params.limit ?? "10", 10) || 10, 50)]
      );
      return { items: r.rows };
    } catch {
      return { items: [] };
    }
  });

  // V335(P1-8): 睡眠学习报告 — 实时执行 sleep_learn（幂等, 无副作用）+ 当前归档/冲突统计
  app.get("/api/memory/sleep-report", async () => {
    try {
      // 实时跑 sleep_learn（去重/冲突标记/修剪, 幂等: 已归档的不会再动）
      const { jobsService } = await import("../services/jobs-service.js");
      const report = await jobsService.runHandlerDirect("sleep_learn" as never) as { status: string; report?: { duplicates: number; archived_duplicates: number; conflicts: number; pruned: number } };
      const { pool: mp } = await import("../db/pool.js");
      const [archived, conflicts] = await Promise.all([
        mp.query("select count(*)::int as n from task_experience where archived = true"),
        mp.query("select count(*)::int as n from task_experience where conflict_unsolved = true"),
      ]);
      return {
        lastReport: { ...(report?.report || { duplicates: 0, archived_duplicates: 0, conflicts: 0, pruned: 0 }), at: new Date().toISOString() },
        current: { archived: archived.rows[0].n, conflicts: conflicts.rows[0].n },
      };
    } catch (e: any) {
      return { lastReport: null, current: { archived: 0, conflicts: 0 }, error: String(e).substring(0, 100) };
    }
  });

  // V381(P2-2): 事件驱动触发 — sleep_learn 事件化（取消式：新触发覆盖旧）
  // 注册处理器（并行式独立执行，不阻塞请求）
  eventBus.onEvent("memory", "sleep_learn", async (ev) => {
    const { jobsService: js } = await import("../services/jobs-service.js");
    await js.runHandlerDirect("sleep_learn" as never);
    console.warn(`[event-bus] sleep_learn 完成（source=${ev.source}）`);
  });
  app.post("/api/events/memory/sleep-learn", async (request) => {
    const body = (request.body ?? {}) as { strategy?: string };
    const ok = await eventBus.emit({
      source: body.strategy === "scheduler" ? "scheduler" : "system",
      channel: "memory",
      content: { name: "sleep_learn" },
      context: { via: "api" },
      strategy: "parallel",      // 独立执行不阻塞请求
    });
    return { ok, pending: eventBus.pendingEvents() };
  });

  // V381(P2-2): 事件中心状态（监控/调试）— 含 KV Cache 命中率聚合（PG 不可用降级）
  app.get("/api/events/status", async () => {
    let cacheRate: number | null = null;
    try {
      const { pool: cp } = await import("../db/pool.js");
      const c = await Promise.race([
        cp.query(
          `select
             sum((parameters->'tokens'->>'cacheHit')::numeric) as hit,
             sum((parameters->'tokens'->>'in')::numeric) as total
           from retrieve_steps
           where parameters ? 'tokens' and parameters->'tokens'->>'cacheHit' is not null
             and created_at > now() - interval '7 days'`
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pg timeout")), 3000)),
      ]);
      const hit = Number(c.rows[0]?.hit ?? 0);
      const total = Number(c.rows[0]?.total ?? 0);
      if (total > 0) cacheRate = Math.round((hit / total) * 1000) / 10;
    } catch { /* 缓存率聚合失败不阻塞（PG 未就绪时降级） */ }
    return {
      ok: true,
      pending: eventBus.pendingEvents(),
      handlers: [
        { channel: "memory", name: "sleep_learn", active: eventBus.hasEventHandler("memory", "sleep_learn") },
      ],
      cacheRate,
    };
  });

  // V381(P2-2): 事件中心报告 — 最近事件触发记录（从 retrieve_steps 聚合事件化步骤，前端展示用）
  app.get("/api/events/report", async () => {
    try {
      const { pool: ep } = await import("../db/pool.js");
      const r = await ep.query(
        `select engine, search_type, result_count, duration_ms, status, created_at
         from retrieve_steps
         where search_type like 'adaptive_%'
         order by created_at desc limit 20`
      );
      return { ok: true, events: r.rows };
    } catch { return { ok: true, events: [] }; }
  });

  // V381: 记忆量化评测报告（memory-recall-report.json — Recall@k 数据，供前端展示）
  app.get("/api/memory/recall-report", async () => {
    try {
      const f = await import("fs/promises");
      const p = path.join(process.env.SAG_ROOT || process.cwd(), "data", "memory-recall-report.json");
      const raw = await f.readFile(p, "utf8");
      return { ok: true, report: JSON.parse(raw) };
    } catch {
      return { ok: true, report: null };
    }
  });

  // V382: AI+教育 六大能力（学习规划/课程辅导/学情诊断/预习复习/教师备课/学习陪伴）
  app.post("/api/education/learning-plan", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.learningPlan(request.body as any);
  });
  app.post("/api/education/tutoring", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.courseTutoring(request.body as any);
  });
  app.post("/api/education/diagnosis", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.learningDiagnosis(request.body as any);
  });
  app.post("/api/education/preview-review", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.previewReview(request.body as any);
  });
  app.post("/api/education/lesson-plan", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.lessonPlanning(request.body as any);
  });
  app.post("/api/education/companion", async (request) => {
    const { educationService } = await import("../services/education-service.js");
    return educationService.studyCompanion(request.body as any);
  });

  // V384: 自适应学习系统（学情建模/自适应推送/节奏适配/分层教学）
  app.post("/api/education/adaptive/record-answer", async (request) => {
    const { adaptiveLearningService } = await import("../services/adaptive-learning-service.js");
    return adaptiveLearningService.recordAnswer(request.body as any);
  });
  app.post("/api/education/adaptive/profile", async (request) => {
    const { adaptiveLearningService } = await import("../services/adaptive-learning-service.js");
    return adaptiveLearningService.getStudentProfile(request.body as any);
  });
  app.post("/api/education/adaptive/push", async (request) => {
    const { adaptiveLearningService } = await import("../services/adaptive-learning-service.js");
    return adaptiveLearningService.adaptivePush(request.body as any);
  });
  app.post("/api/education/adaptive/pace", async (request) => {
    const { adaptiveLearningService } = await import("../services/adaptive-learning-service.js");
    return adaptiveLearningService.paceAdapt(request.body as any);
  });
  app.post("/api/education/adaptive/layered", async (request) => {
    const { adaptiveLearningService } = await import("../services/adaptive-learning-service.js");
    return adaptiveLearningService.layeredTeaching(request.body as any);
  });

  // V385: 作业辅导（题目解析/错题处理/多模态/作业答疑）
  app.post("/api/education/homework/solve", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.solveQuestion(request.body as any);
  });
  app.post("/api/education/homework/wrong", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.recordWrongQuestion(request.body as any);
  });
  app.post("/api/education/homework/variant", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.generateVariant(request.body as any);
  });
  app.post("/api/education/homework/wrong-list", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.listWrongQuestions(request.body as any);
  });
  app.post("/api/education/homework/wrong-mastered", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.markWrongMastered(request.body as any);
  });
  app.post("/api/education/homework/qna", async (request) => {
    const { homeworkHelpService } = await import("../services/homework-help-service.js");
    return homeworkHelpService.homeworkQnA(request.body as any);
  });

  // V386: 学情诊断升级（漏洞定位/行为分析/双报告/预测预警）
  app.post("/api/education/diagnostic/gaps", async (request) => {
    const { diagnosticService } = await import("../services/diagnostic-service.js");
    return diagnosticService.locateGaps(request.body as any);
  });
  app.post("/api/education/diagnostic/behavior", async (request) => {
    const { diagnosticService } = await import("../services/diagnostic-service.js");
    return diagnosticService.behaviorAnalysis(request.body as any);
  });
  app.post("/api/education/diagnostic/report", async (request) => {
    const { diagnosticService } = await import("../services/diagnostic-service.js");
    return diagnosticService.diagnosticReport(request.body as any);
  });
  app.post("/api/education/diagnostic/risk", async (request) => {
    const { diagnosticService } = await import("../services/diagnostic-service.js");
    return diagnosticService.predictRisk(request.body as any);
  });

  // V387: 教师备课辅助（教案课件/命题组卷/作业批改/班级汇总）
  app.post("/api/education/teach/lesson", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateLesson(request.body as any);
  });
  app.post("/api/education/teach/exam", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateExam(request.body as any);
  });
  app.post("/api/education/teach/grade", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.gradeSubmission(request.body as any);
  });
  app.post("/api/education/teach/class-summary", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.classSummary(request.body as any);
  });

  // ─── 教师端教学辅助扩展（V389，复赛：备课/作业考试/课堂互动）───
  app.post("/api/education/teach/syllabus", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateSyllabus(request.body as any);
  });
  app.post("/api/education/teach/courseware", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateCourseware(request.body as any);
  });
  app.post("/api/education/teach/layered", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.layeredDesign(request.body as any);
  });
  app.post("/api/education/teach/questions", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateQuestions(request.body as any);
  });
  app.post("/api/education/teach/wrong-report", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.wrongAnalysisReport(request.body as any);
  });
  app.post("/api/education/teach/discussion", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.generateDiscussion(request.body as any);
  });
  app.post("/api/education/teach/quiz", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.quickQuiz(request.body as any);
  });
  app.post("/api/education/teach/lecture-summary", async (request) => {
    const { teachingAssistantService } = await import("../services/teaching-assistant-service.js");
    return teachingAssistantService.lectureSummary(request.body as any);
  });

  // ─── 学生端学习服务扩展（V389，复赛：认知维度/千人千策/复习提醒）───
  app.post("/api/education/student/cognitive-dims", async (request) => {
    const { studentLearningService } = await import("../services/student-learning-service.js");
    return studentLearningService.cognitiveDimensions(request.body as any);
  });
  app.post("/api/education/student/recommend", async (request) => {
    const { studentLearningService } = await import("../services/student-learning-service.js");
    return studentLearningService.personalizedRecommend(request.body as any);
  });
  app.post("/api/education/student/review-reminder", async (request) => {
    const { studentLearningService } = await import("../services/student-learning-service.js");
    return studentLearningService.reviewReminder(request.body as any);
  });

  // ─── 阅读与语言学习 Agent（V389，复赛）───
  app.post("/api/education/lang/reading", async (request) => {
    const { languageLearningService } = await import("../services/language-learning-service.js");
    return languageLearningService.readingTutor(request.body as any);
  });
  app.post("/api/education/lang/vocab-grammar", async (request) => {
    const { languageLearningService } = await import("../services/language-learning-service.js");
    return languageLearningService.vocabGrammar(request.body as any);
  });
  app.post("/api/education/lang/writing", async (request) => {
    const { languageLearningService } = await import("../services/language-learning-service.js");
    return languageLearningService.writingPolish(request.body as any);
  });
  app.post("/api/education/lang/record", async (request) => {
    const { languageLearningService } = await import("../services/language-learning-service.js");
    return languageLearningService.recordStudy(request.body as any);
  });

  // ─── 职业教育/编程教育 Agent（V389，复赛）───
  app.post("/api/education/coding/decompose", async (request) => {
    const { codingEducationService } = await import("../services/coding-education-service.js");
    return codingEducationService.taskDecomposition(request.body as any);
  });
  app.post("/api/education/coding/tutor", async (request) => {
    const { codingEducationService } = await import("../services/coding-education-service.js");
    return codingEducationService.codeTutoring(request.body as any);
  });
  app.post("/api/education/coding/interview", async (request) => {
    const { codingEducationService } = await import("../services/coding-education-service.js");
    return codingEducationService.interviewPrep(request.body as any);
  });
  app.post("/api/education/coding/path", async (request) => {
    const { codingEducationService } = await import("../services/coding-education-service.js");
    return codingEducationService.careerPath(request.body as any);
  });

  // V388: 学习陪伴 Agent（计划/答疑/激励/复盘）
  app.post("/api/education/companion/plan", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.createPlan(request.body as any);
  });
  app.post("/api/education/companion/progress", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.updateProgress(request.body as any);
  });
  app.post("/api/education/companion/plans", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.currentPlans(request.body as any);
  });
  app.post("/api/education/companion/qna", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.companionQnA(request.body as any);
  });
  app.post("/api/education/companion/motivate", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.motivate(request.body as any);
  });
  app.post("/api/education/companion/review", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.dailyReview(request.body as any);
  });
  app.post("/api/education/companion/reviews", async (request) => {
    const { studyCompanionService } = await import("../services/study-companion-service.js");
    return studyCompanionService.reviewHistory(request.body as any);
  });

  // ─── 教育专属 Agent 编排层（V389+，复赛冲刺期）───
  app.post("/api/education/agent/socratic", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.socraticStart(request.body as any);
  });
  app.post("/api/education/agent/socratic-continue", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.socraticContinue(request.body as any);
  });
  app.post("/api/education/agent/scaffold", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.scaffoldedTutoring(request.body as any);
  });
  app.post("/api/education/agent/wrong-to-mastery", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.wrongToMastery(request.body as any);
  });
  app.post("/api/education/agent/progress", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.learningProgress(request.body as any);
  });
  app.post("/api/education/agent/route", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.routeByRole(request.body as any);
  });
  app.post("/api/education/agent/policy-check", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.checkEducationPolicy(String((request.body as any)?.content ?? ""));
  });
  app.post("/api/education/agent/polish", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.polishStep(request.body as any);
  });
  app.post("/api/education/agent/decompose", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.decomposeQuestions(request.body as any);
  });
  app.post("/api/education/agent/follow-up", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.followUpPolish(request.body as any);
  });

  // ─── 想法卡管理（Hazel 式多想法并行）───
  app.post("/api/education/agent/idea-cards/list", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.listIdeaCards(request.body as any);
  });
  app.post("/api/education/agent/idea-cards/create", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.createIdeaCard(request.body as any);
  });
  app.post("/api/education/agent/idea-cards/update", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.updateIdeaCard(request.body as any);
  });
  app.post("/api/education/agent/idea-cards/delete", async (request) => {
    const { agentEducationService } = await import("../services/agent-education.js");
    return agentEducationService.deleteIdeaCard(request.body as any);
  });

  // ─── 端到端自动闭环（复赛冲刺期）───
  app.post("/api/education/loop/hook-answer", async (request) => {
    const { autoLearningLoopService } = await import("../services/auto-learning-loop.js");
    return autoLearningLoopService.hookRecordAnswer(request.body as any);
  });
  app.post("/api/education/loop/hook-plan-progress", async (request) => {
    const { autoLearningLoopService } = await import("../services/auto-learning-loop.js");
    return autoLearningLoopService.hookPlanProgress(request.body as any);
  });
  app.post("/api/education/loop/diagnose", async (request) => {
    const { autoLearningLoopService } = await import("../services/auto-learning-loop.js");
    return autoLearningLoopService.autoDiagnose(request.body as any);
  });
  app.post("/api/education/loop/iterate", async (request) => {
    const { autoLearningLoopService } = await import("../services/auto-learning-loop.js");
    return autoLearningLoopService.autoIterate(request.body as any);
  });
  app.post("/api/education/loop/report", async (request) => {
    const { autoLearningLoopService } = await import("../services/auto-learning-loop.js");
    return autoLearningLoopService.autoLoopReport(request.body as any);
  });

  // ─── BKT 认知诊断（复赛冲刺期）───
  app.post("/api/education/cognitive/bkt-track", async (request) => {
    const { cognitiveDiagnosisService } = await import("../services/cognitive-diagnosis.js");
    return cognitiveDiagnosisService.bktTrack(request.body as any);
  });
  app.post("/api/education/cognitive/bkt-diagnose", async (request) => {
    const { cognitiveDiagnosisService } = await import("../services/cognitive-diagnosis.js");
    return cognitiveDiagnosisService.bktDiagnose(request.body as any);
  });

  // ─── 知识点先修图 + 拓扑路径规划（复赛冲刺期）───
  app.post("/api/education/kg/check-prereq", async (request) => {
    const { knowledgeGraphEduService } = await import("../services/knowledge-graph-edu.js");
    return knowledgeGraphEduService.checkPrerequisites(request.body as any);
  });
  app.post("/api/education/kg/plan-path", async (request) => {
    const { knowledgeGraphEduService } = await import("../services/knowledge-graph-edu.js");
    return knowledgeGraphEduService.planPath(request.body as any);
  });
  app.post("/api/education/kg/validate-path", async (request) => {
    const { knowledgeGraphEduService } = await import("../services/knowledge-graph-edu.js");
    return knowledgeGraphEduService.validatePath(request.body as any);
  });

  // ─── 思政内容四维核验（复赛冲刺期）───
  app.post("/api/education/audit/content", async (request) => {
    const { contentAuditService } = await import("../services/content-audit-service.js");
    return contentAuditService.auditContent(request.body as any);
  });
  app.post("/api/education/audit/calibrate", async (request) => {
    const { contentAuditService } = await import("../services/content-audit-service.js");
    return contentAuditService.calibrateConcept(request.body as any);
  });

  // ─── 教育多模态打通（复赛冲刺期）───
  app.post("/api/education/multimodal/photo-solve", async (request) => {
    const { educationMultimodalService } = await import("../services/education-multimodal.js");
    return educationMultimodalService.homeworkPhotoSolve(request.body as any);
  });
  app.post("/api/education/multimodal/speech-assessment", async (request) => {
    const { educationMultimodalService } = await import("../services/education-multimodal.js");
    return educationMultimodalService.speechAssessment(request.body as any);
  });
  app.post("/api/education/multimodal/blackboard", async (request) => {
    const { educationMultimodalService } = await import("../services/education-multimodal.js");
    return educationMultimodalService.blackboardRecognize(request.body as any);
  });

  // ─── 教育数据合规（复赛冲刺期）───
  app.post("/api/education/compliance/classification", async (request) => {
    const { educationComplianceService } = await import("../services/education-compliance.js");
    return educationComplianceService.dataClassification();
  });
  app.post("/api/education/compliance/cleanup-student", async (request) => {
    const { educationComplianceService } = await import("../services/education-compliance.js");
    return educationComplianceService.cleanupStudentData(request.body as any);
  });
  app.post("/api/education/compliance/cleanup-expired", async (request) => {
    const { educationComplianceService } = await import("../services/education-compliance.js");
    return educationComplianceService.cleanupExpiredData();
  });
  app.post("/api/education/compliance/status", async (request) => {
    const { educationComplianceService } = await import("../services/education-compliance.js");
    return educationComplianceService.complianceStatus(request.body as any);
  });

  // ─── 教育反馈闭环（V397: 学生/教师使用反馈 → 教学效果统计 → 改进驱动）───
  app.post("/api/education/feedback", async (request) => {
    const { educationFeedbackService } = await import("../services/education-feedback-service.js");
    return educationFeedbackService.submitEduFeedback(request.body as any);
  });
  app.get("/api/education/feedback/stats", async () => {
    const { educationFeedbackService } = await import("../services/education-feedback-service.js");
    return educationFeedbackService.eduFeedbackStats();
  });
  app.get("/api/education/eval", async () => {
    const { educationEvalService } = await import("../services/education-eval-service.js");
    return educationEvalService.runEducationEval();
  });

  // ─── 实证研究执行工作台（V348+）───
  const MAX_EMPIRICAL_CELLS = 200_000;
  const empiricalRunSchema = z.object({
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    method: z.enum(["descriptive", "ols", "did", "did_twfe", "event_study", "iv", "rdd", "panel_fe", "psm", "scm", "logit", "ologit", "mnl", "crosstab", "genvars", "filter"]),
    params: z.record(z.unknown()).default({}),
    // V381 fix: preprocess 被 zod 剥离导致前端勾选静默失效
    preprocess: z.object({
      winsorize: z.array(z.string()).optional(),
      log: z.array(z.string()).optional(),
      standardize: z.array(z.string()).optional(),
      lag: z.array(z.string()).optional(),
    }).optional(),
  });

  app.post("/api/empirical/run", async (request, reply) => {
    const input = empiricalRunSchema.parse(request.body);
    // 大小守卫: 超 5MB / 20 万单元格 → 400
    const cells = input.data.rows.length * input.data.columnOrder.length;
    const bytes = Buffer.byteLength(JSON.stringify(input.data), "utf8");
    if (bytes > 5 * 1024 * 1024 || cells > MAX_EMPIRICAL_CELLS) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "数据过大 (≤5MB 或 ≤20万单元格)" } });
    }
    const { empiricalService } = await import("../services/empirical-service.js");
    return empiricalService.runEmpirical(input);
  });

  app.get("/api/empirical/result/:taskId", async (request) => {
    const { taskId } = request.params as { taskId: string };
    z.string().uuid().parse(taskId);
    const { empiricalService } = await import("../services/empirical-service.js");
    return empiricalService.getEmpiricalResult(taskId);
  });

  app.get("/api/empirical/methods", async () => {
    // 静态方法目录（9 方法; iv/rdd/psm/scm/panel_fe 首版走技能流程）
    return {
      methods: [
        { id: "descriptive", label: "描述性统计", en: "Descriptive", desc: "均值/标准差/N/Min/Max, Table 1 基础", category: "基础", engine: "statsmodels", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "ols", label: "OLS 回归", en: "OLS", desc: "多元线性回归 + 系数图 + 95%CI", category: "基础", engine: "statsmodels", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "did", label: "双重差分 DiD", en: "DiD", desc: "statspai 自动估计 ATT (含事件研究)", category: "因果识别", engine: "statspai", skills: ["10-Jill0099-causal-inference-mixtape"] },
        { id: "did_twfe", label: "DID 双向固定效应", en: "TWFE DiD", desc: "交互项 OLS + 双向固定效应", category: "因果识别", engine: "statspai", skills: ["10-Jill0099-causal-inference-mixtape"] },
        { id: "event_study", label: "事件研究", en: "Event Study", desc: "TWFE 动态效应 + 平行趋势检验 + 系数图", category: "因果识别", engine: "statsmodels", skills: ["10-Jill0099-causal-inference-mixtape"] },
        { id: "logit", label: "Logit/Probit 回归", en: "Logit", desc: "二值因变量(是否转出/是否撂荒) 系数+边际效应", category: "分类模型", engine: "statsmodels", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "ologit", label: "有序 Logit", en: "Ordered Logit", desc: "有序因变量(调地意愿1-5) 系数+阈值", category: "分类模型", engine: "statsmodels", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "mnl", label: "多项 Logit", en: "MNL", desc: "多分类因变量(身份6类) 类别×协变量系数", category: "分类模型", engine: "statsmodels", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "crosstab", label: "交叉表+卡方", en: "Crosstab", desc: "分类变量关联(身份×意愿) 卡方+Cramér's V", category: "分类模型", engine: "scipy", skills: ["00.1-Full-empirical-analysis-skill_Python"] },
        { id: "genvars", label: "变量构造", en: "Gen Vars", desc: "自定义公式(流转率=转出/承包) 生成新列", category: "数据处理", engine: "pandas", skills: [] },
        { id: "filter", label: "子样本筛选", en: "Filter", desc: "条件筛选(身份=2 且 面积>10) 子样本统计", category: "数据处理", engine: "pandas", skills: [] },
        { id: "iv", label: "工具变量 IV", en: "IV", desc: "2SLS / 弱工具变量检验", category: "因果识别", engine: "技能流程", skills: ["10-Jill0099-causal-inference-mixtape", "r-econometrics"] },
        { id: "rdd", label: "断点回归 RDD", en: "RDD", desc: "sharp/fuzzy RDD + 带宽选择", category: "因果识别", engine: "技能流程", skills: ["10-Jill0099-causal-inference-mixtape", "00.3-Full-empirical-analysis-skill_R"] },
        { id: "panel_fe", label: "面板固定效应", en: "Panel FE", desc: "个体/时间双向固定效应, 聚类 SE", category: "面板数据", engine: "技能流程", skills: ["python-panel-data", "00.1-Full-empirical-analysis-skill_Python"] },
        { id: "psm", label: "倾向得分匹配 PSM", en: "PSM", desc: "匹配 + 平衡检验", category: "匹配", engine: "技能流程", skills: ["10-Jill0099-causal-inference-mixtape"] },
        { id: "scm", label: "合成控制 SCM", en: "SCM", desc: "合成控制法 + 安慰剂检验", category: "匹配", engine: "技能流程", skills: ["10-Jill0099-causal-inference-mixtape"] },
      ],
    };
  });

  app.get("/api/empirical/skills", async () => {
    // 代理 skillsService 过滤实证关键词
    const { skillsService } = await import("../services/skills-service.js");
    const all = await skillsService.listSkills();
    const kw = /DID|RDD|IV|panel|causal|回归|面板|stata|econometrics|实证|计量|Mixtape|empirical/i;
    return { skills: all.filter((s: any) => kw.test(String(s.description ?? "") + " " + String(s.name ?? ""))).slice(0, 20) };
  });

  app.get("/api/empirical/meta", async () => {
    const { empiricalService } = await import("../services/empirical-service.js");
    return empiricalService.getEmpiricalMeta();
  });

  // 实证历史记录（持久化到 PG）
  app.get("/api/empirical/history", async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20", 10) || 20));
    const { empiricalService } = await import("../services/empirical-service.js");
    return { history: await empiricalService.listEmpiricalHistory(limit) };
  });

  app.get("/api/empirical/history/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { empiricalService } = await import("../services/empirical-service.js");
    const rec = await empiricalService.getEmpiricalHistory(id);
    if (!rec) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "记录不存在" } });
    return { record: rec };
  });

  app.delete("/api/empirical/history/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { empiricalService } = await import("../services/empirical-service.js");
    const ok = await empiricalService.deleteEmpiricalHistory(id);
    if (!ok) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "记录不存在" } });
    return { ok: true };
  });

  // 导出（LaTeX / CSV）
  app.post("/api/empirical/export", async (request, reply) => {
    const body = (request.body ?? {}) as { format?: string; table?: any; recordId?: string };
    const { empiricalService } = await import("../services/empirical-service.js");
    if (body.recordId) {
      const rec = await empiricalService.getEmpiricalHistory(body.recordId);
      if (!rec) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "记录不存在" } });
      const tables = ((rec.result ?? {}) as any).tables ?? [];
      if (body.format === "latex") {
        return reply.type("text/plain").send(tables.map((t: any) => empiricalService.latexTable(t)).join("\n\n"));
      }
      if (body.format === "csv") {
        return reply.type("text/csv").send(tables.map((t: any) => empiricalService.csvTable(t)).join("\n\n"));
      }
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "format 需为 latex 或 csv" } });
    }
    if (!body.table) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 table 或 recordId" } });
    if (body.format === "latex") {
      return reply.type("text/plain").send(empiricalService.latexTable(body.table));
    }
    if (body.format === "csv") {
      return reply.type("text/csv").send(empiricalService.csvTable(body.table));
    }
    return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "format 需为 latex 或 csv" } });
  });

  // 存为知识页（联动 SAG 知识库）
  app.post("/api/empirical/:id/knowledge", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { empiricalService } = await import("../services/empirical-service.js");
    const r = await empiricalService.saveAsKnowledgePage(id);
    if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "保存失败" } });
    return { ok: true, pageId: r.pageId };
  });

  // 数据源: PG 表列表(可导入实证分析)
  app.get("/api/empirical/datasets", async () => {
    const { empiricalService } = await import("../services/empirical-service.js");
    return { datasets: await empiricalService.listEmpiricalDatasets() };
  });

  // 数据源: 拉取表数据(转 CSV 行)
  app.post("/api/empirical/datasets/fetch", async (request, reply) => {
    const body = (request.body ?? {}) as { table?: string; limit?: number };
    if (!body.table) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "缺少 table" } });
    const { empiricalService } = await import("../services/empirical-service.js");
    const data = await empiricalService.fetchEmpiricalDataset(body.table, Math.min(Number(body.limit) || 2000, 5000));
    if (!data) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "表不存在或为空" } });
    return { data };
  });

  // ═══════════ V380: 实证研究工作台增强 — 课题/问卷/数据版本 ═══════════
  const empProjectSchema = z.object({ title: z.string().min(1).max(200), topic: z.string().max(2000).default("") });
  app.post("/api/empirical/projects", async (request, reply) => {
    const body = empProjectSchema.parse(request.body);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    try {
      return { project: await questionnaireService.createProject(body) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 200) } });
    }
  });
  app.get("/api/empirical/projects", async () => {
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    return { projects: await questionnaireService.listProjects() };
  });

  const generateSchema = z.object({
    projectId: z.string().uuid().optional(),
    title: z.string().max(200).default("未命名问卷"),
    topic: z.string().min(1).max(2000),
    extra: z.string().max(3000).optional(),
    nQuestions: z.number().int().min(5).max(120).optional(),
  });
  app.post("/api/empirical/questionnaires/generate", async (request, reply) => {
    const body = generateSchema.parse(request.body);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    try {
      const { questions, meta } = await questionnaireService.generateQuestionnaire(body);
      const saved = await questionnaireService.saveQuestionnaire({
        projectId: body.projectId ?? null, title: body.title, source: "generated",
        questions, meta: { ...(meta as object), topic: body.topic },
      });
      return { ok: true, questionnaire: { ...saved, questions, meta } };
    } catch (e: any) {
      const code = e?.code ?? "BAD_REQUEST";
      return reply.code(400).send({ error: { code, message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  const recognizeSchema = z.object({
    projectId: z.string().uuid().optional(),
    title: z.string().max(200).default("上传问卷"),
    rawText: z.string().min(1).max(50_000),
  });
  // V412: 问卷文件解析 — PDF/Word/Excel/PPT 上传后转文本（复用 Python 解析，供问卷识别）
  app.post("/api/empirical/questionnaires/parse-file", async (request, reply) => {
    const parseSchema = z.object({
      fileName: z.string().max(300),
      base64: z.string().min(10).max(30_000_000), // 最大 ~30MB
    });
    const body = parseSchema.parse(request.body);
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const ext = pathMod.extname(body.fileName).toLowerCase();
      const SUPPORTED = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".csv"];
      if (!SUPPORTED.includes(ext)) {
        return reply.code(400).send({ error: { code: "UNSUPPORTED_TYPE", message: `不支持的文件类型 ${ext}，支持 ${SUPPORTED.join(" / ")}` } });
      }
      // 纯文本类直接解析 base64 为 UTF-8
      if ([".txt", ".md", ".csv"].includes(ext)) {
        const text = Buffer.from(body.base64, "base64").toString("utf-8");
        return { ok: true, text: text.slice(0, 50_000) };
      }
      // Office/PDF → Python 子进程解析
      const tmpDir = pathMod.join(process.env.SAG_ROOT || process.cwd(), "data", "questionnaire_tmp");
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = pathMod.join(tmpDir, `q_${Date.now()}${ext}`);
      writeFileSync(tmpFile, Buffer.from(body.base64, "base64"));
      const py = process.env.COGNEE_PYTHON || process.env.EMPIRICAL_PYTHON || "python";
      const pyScript = `
import sys
from pathlib import Path
p = Path(r"${tmpFile.replace(/\\/g, "\\\\")}")
ext = p.suffix.lower()
out = []
try:
    if (ext == ".pdf"):
        import pymupdf  # PyMuPDF 1.28+: fitz 已弃用，用 pymupdf 避免 deprecation 警告污染输出
        doc = pymupdf.open(str(p))
        for i, page in enumerate(doc):
            if len("\\n".join(out)) > 49000: break
            out.append(page.get_text())
    elif ext in (".docx", ".doc"):
        from docx import Document
        d = Document(str(p))
        for para in d.paragraphs:
            if para.text.strip(): out.append(para.text)
        for t in d.tables:
            for row in t.rows:
                out.append(" | ".join(c.text.strip() for c in row.cells))
    elif ext in (".xlsx", ".xls"):
        import openpyxl
        wb = openpyxl.load_workbook(str(p), read_only=True, data_only=True)
        for ws in wb.worksheets:
            out.append(f"[Sheet: {ws.title}]")
            for row in ws.iter_rows(values_only=True):
                out.append(" | ".join(str(c) if c is not None else "" for c in row))
    elif ext in (".pptx", ".ppt"):
        from pptx import Presentation
        prs = Presentation(str(p))
        for i, slide in enumerate(prs.slides):
            out.append(f"[Slide {i+1}]")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        if para.text.strip(): out.append(para.text)
    text = "\\n".join(out)
    print(text[:49000])
except Exception as e:
    print(f"（解析失败: {e}）")
`;
      const { stdout } = await promisify(execFile)(py, ["-c", pyScript], { timeout: 90_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      try { const rm = await import("node:fs"); rm.rmSync(tmpFile, { force: true }); } catch { /* 清理失败忽略 */ }
      const text = String(stdout || "").trim();
      if (!text || text.startsWith("（解析失败")) {
        return reply.code(400).send({ error: { code: "PARSE_FAILED", message: text.slice(0, 200) || "解析无输出" } });
      }
      return { ok: true, text: text.slice(0, 50_000) };
    } catch (e: any) {
      return reply.code(500).send({ error: { code: "PARSE_ERROR", message: String(e?.message || e).slice(0, 200) } });
    }
  });

  app.post("/api/empirical/questionnaires/recognize", async (request, reply) => {
    const body = recognizeSchema.parse(request.body);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    try {
      const { questions, meta } = await questionnaireService.recognizeQuestionnaire(body);
      const saved = await questionnaireService.saveQuestionnaire({
        projectId: body.projectId ?? null, title: body.title, source: "uploaded",
        rawText: body.rawText, questions, meta,
      });
      return { ok: true, questionnaire: { ...saved, questions, meta } };
    } catch (e: any) {
      const code = e?.code ?? "BAD_REQUEST";
      return reply.code(400).send({ error: { code, message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  app.get("/api/empirical/questionnaires", async (request) => {
    const query = request.query as { projectId?: string };
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    return { questionnaires: await questionnaireService.listQuestionnaires(query.projectId) };
  });

  const dataVersionSchema = z.object({
    projectId: z.string().uuid().optional(),
    name: z.string().min(1).max(200),
    columns: z.array(z.string().min(1)).min(1),
    nRows: z.number().int().min(0).default(0),
    meta: z.record(z.unknown()).default({}),
  });
  app.post("/api/empirical/data-versions", async (request, reply) => {
    const body = dataVersionSchema.parse(request.body);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    try {
      return { version: await questionnaireService.saveDataVersion(body) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 200) } });
    }
  });
  app.get("/api/empirical/data-versions", async (request) => {
    const query = request.query as { projectId?: string };
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    return { versions: await questionnaireService.listDataVersions(query.projectId) };
  });

  // 演示数据: 基于《农村经营形态调查问卷(最终打印版).pdf》模板生成的 50 份全量模拟作答
  app.get("/api/empirical/demo", async (request) => {
    const query = request.query as { missing?: string };
    const fs = await import("node:fs");
    const path = await import("node:path");
    // missing=1 → 挖缺版(含 15% 空值/-88/乱答, 供 LLM 插补演示)
    const isMissing = query.missing === "1";
    const demoPath = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", isMissing ? "问卷演示数据_挖缺全量.csv" : "问卷演示数据_全量.csv");
    try {
      if (!fs.existsSync(demoPath)) return { ok: false, error: "演示数据文件缺失" };
      const text = fs.readFileSync(demoPath, "utf-8").replace(/^﻿/, "");
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return { ok: false, error: "演示数据为空" };
      // 用严格 CSV 解析(处理引号内逗号, 如文本题 "自家食用为主, 剩余出售")
      const parseLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
            else inQ = !inQ;
          } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
          else cur += ch;
        }
        out.push(cur);
        return out;
      };
      const columnOrder = parseLine(lines[0]).map((c) => c.trim());
      const rows = lines.slice(1).map((l) => {
        const cells = parseLine(l);
        return columnOrder.map((_, i) => {
          const raw = (cells[i] ?? "").trim().replace(/^"|"$/g, "");
          if (raw === "" || raw === "-99" || raw === "-88") return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : raw;
        });
      });
      return { ok: true, data: { columnOrder, rows }, meta: { nRows: rows.length, source: isMissing ? "农村经营形态问卷(挖缺版, 供插补演示)" : "农村经营形态调查问卷(最终打印版).pdf", nCols: columnOrder.length, missing: isMissing } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    }
  });

  // 演示: 农村经营形态问卷 PDF 提取的原始文本(供「问卷识别」演示)
  app.get("/api/empirical/demo/questionnaire-text", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const textPath = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "_问卷原始文本.txt");
    try {
      if (!fs.existsSync(textPath)) return { ok: false, error: "问卷文本文件缺失" };
      const text = fs.readFileSync(textPath, "utf-8");
      return { ok: true, text, meta: { source: "农村经营形态调查问卷(最终打印版).pdf", chars: text.length } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    }
  });

  // ═══════════ V380: 实证工作台增强 — 信效度 / 闸门状态机 / 数据诊断 ═══════════
  const reliabilitySchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    dataVersionId: z.string().uuid().optional().nullable(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    scaleGroups: z.array(z.object({
      name: z.string().min(1),
      columns: z.array(z.string().min(1)).min(2),
    })).min(1),
  });
  app.post("/api/empirical/reliability", async (request, reply) => {
    const body = reliabilitySchema.parse(request.body);
    const { reliabilityService } = await import("../services/empirical-reliability-service.js");
    try {
      const r = await reliabilityService.runReliability(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "执行失败" } });
      return { ok: true, taskId: r.taskId };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  const gateUpsertSchema = z.object({
    projectId: z.string().uuid(),
    node: z.enum(["topic", "variable_definition", "identification", "result_interpretation"]),
    content: z.record(z.unknown()),
  });
  app.post("/api/empirical/gates/upsert", async (request, reply) => {
    const body = gateUpsertSchema.parse(request.body);
    const { gateService } = await import("../services/empirical-gate-service.js");
    try {
      return { gate: await gateService.upsertDraft(body.projectId, body.node, body.content) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/gates/:id/lock", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { gateService } = await import("../services/empirical-gate-service.js");
    const { pool: poolDb } = await import("../db/pool.js");
    try {
      const r = await poolDb.query(`select project_id, node from empirical_gates where id = $1`, [id]);
      if (r.rows.length === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "闸门不存在" } });
      return { gate: await gateService.lockGate(String(r.rows[0].project_id), String(r.rows[0].node)) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/gates/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { gateService } = await import("../services/empirical-gate-service.js");
    const { pool: poolDb } = await import("../db/pool.js");
    try {
      const r = await poolDb.query(`select project_id, node from empirical_gates where id = $1`, [id]);
      if (r.rows.length === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "闸门不存在" } });
      return { gate: await gateService.confirmGate(String(r.rows[0].project_id), String(r.rows[0].node)) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/gates/:id/reopen", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const body = (request.body ?? {}) as { note?: string };
    const { gateService } = await import("../services/empirical-gate-service.js");
    const { pool: poolDb } = await import("../db/pool.js");
    try {
      const r = await poolDb.query(`select project_id, node from empirical_gates where id = $1`, [id]);
      if (r.rows.length === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "闸门不存在" } });
      return { gate: await gateService.reopenGate(String(r.rows[0].project_id), String(r.rows[0].node), body.note ?? "") };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.get("/api/empirical/gates", async (request) => {
    const query = request.query as { projectId: string };
    z.string().uuid().parse(query.projectId);
    const { gateService } = await import("../services/empirical-gate-service.js");
    return { gates: await gateService.listGates(query.projectId) };
  });

  const diagnosisSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    fieldNotes: z.string().min(1).max(5000),
  });
  app.post("/api/empirical/diagnosis", async (request, reply) => {
    const body = diagnosisSchema.parse(request.body);
    const { diagnosisService } = await import("../services/empirical-diagnosis-service.js");
    try {
      const r = await diagnosisService.runDiagnosis({
        projectId: body.projectId ?? null, data: body.data, fieldNotes: body.fieldNotes,
      });
      return { ok: true, report: r.report };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  // ═══════════ V380: 实证工作台增强 — LLM 民调插补 / 变量敲定 ═══════════
  const imputationSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    targetCol: z.string().min(1),
    contextCols: z.array(z.string()).default([]),
    fieldInfo: z.string().max(3000).optional(),
    codingOptions: z.array(z.number()).optional(),
    strategy: z.enum(["llm_only", "llm_compare"]).default("llm_compare"),
  });
  app.post("/api/empirical/imputation/start", async (request, reply) => {
    const body = imputationSchema.parse(request.body);
    const { imputationService } = await import("../services/empirical-imputation-service.js");
    try {
      const r = await imputationService.startImputation(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "插补失败" } });
      return { ok: true, runId: r.runId, nImputed: r.nImputed, junkCells: r.junkCells };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.get("/api/empirical/imputation/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    z.string().uuid().parse(runId);
    const { imputationService } = await import("../services/empirical-imputation-service.js");
    const run = await imputationService.getRun(runId);
    if (!run) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "插补任务不存在" } });
    return { run };
  });
  app.post("/api/empirical/imputation/batch", async (request, reply) => {
    const body = (request.body ?? {}) as { runId: string; cells: { id: string; confirmed?: boolean; editedValue?: string }[] };
    z.string().uuid().parse(body.runId);
    if (!Array.isArray(body.cells) || body.cells.length === 0) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "cells 为空" } });
    }
    const { imputationService } = await import("../services/empirical-imputation-service.js");
    const r = await imputationService.confirmBatch(body);
    return { ok: true, runId: r.runId, confirmed: r.confirmed };
  });
  const imputationCompareSchema = z.object({
    runId: z.string().uuid(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    targetCol: z.string().min(1),
    contextCols: z.array(z.string()).default([]),
    codingOptions: z.array(z.number()).optional(),
    fieldInfo: z.string().max(3000).optional(),
  });
  app.post("/api/empirical/imputation/compare", async (request, reply) => {
    const body = imputationCompareSchema.parse(request.body ?? {});
    const { imputationService } = await import("../services/empirical-imputation-service.js");
    try {
      const r = await imputationService.runCompare(body as any);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "对比失败" } });
      return { ok: true, stats: r.stats, baselineCompare: r.baselineCompare };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  const variablesSuggestSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    topic: z.string().max(2000).optional(),
    columns: z.array(z.string().min(1)).min(1),
    nRows: z.number().int().min(0),
    missingRates: z.record(z.number()).optional(),
    questionMeta: z.record(z.unknown()).optional(),
  });
  app.post("/api/empirical/variables/suggest", async (request, reply) => {
    const body = variablesSuggestSchema.parse(request.body);
    const { variablesService } = await import("../services/empirical-variables-service.js");
    try {
      const r = await variablesService.suggestVariables(body);
      return { ok: true, suggestion: r.suggestion };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/variables/save", async (request, reply) => {
    const body = gateUpsertSchema.extend({ node: z.literal("variable_definition") }).parse(request.body);
    const { gateService } = await import("../services/empirical-gate-service.js");
    try {
      return { gate: await gateService.upsertDraft(body.projectId, body.node, body.content) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  // ═══════════ V380: 实证工作台增强 — 数据管道 / 回归生成 / Agent Debug ═══════════
  const pipelineSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    steps: z.record(z.unknown()),
  });
  app.post("/api/empirical/pipeline", async (request, reply) => {
    const body = pipelineSchema.parse(request.body);
    const { pipelineService } = await import("../services/empirical-pipeline-service.js");
    try {
      const r = await pipelineService.runPipeline(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "执行失败" } });
      return { ok: true, taskId: r.taskId };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/pipeline/stata", async (request, reply) => {
    const body = pipelineSchema.parse(request.body);
    const { pipelineService } = await import("../services/empirical-pipeline-service.js");
    const r = await pipelineService.generateStata(body.steps, body.data.columnOrder);
    if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "Stata 生成失败" } });
    return { ok: true, stataCode: r.stataCode, scriptName: "pipeline.do" };
  });
  app.post("/api/empirical/pipeline/verify", async (request, reply) => {
    const body = (request.body ?? {}) as { projectId?: string; nBefore?: number; nAfter?: number; generatedVars?: string[]; dataColumns?: string[] };
    const { pipelineService } = await import("../services/empirical-pipeline-service.js");
    const r = await pipelineService.verifyPipeline(body);
    return { ok: true, report: r.report };
  });

  const regressionSpecSchema = z.object({
    dep: z.string().min(1),
    core: z.array(z.string().min(1)).min(1),
    controls: z.array(z.string()).optional(),
    fe: z.array(z.string()).optional(),
    cluster: z.string().optional(),
    interactions: z.array(z.string()).optional(),
    model: z.enum(["ols", "logit", "ologit"]).default("ols"),
  });
  const regressionGenerateSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    data: z.object({
      columnOrder: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
    }),
    spec: regressionSpecSchema,
  });
  app.post("/api/empirical/regression/generate", async (request, reply) => {
    const body = regressionGenerateSchema.parse(request.body);
    const { regressionService } = await import("../services/empirical-regression-service.js");
    try {
      const r = await regressionService.generateRegression(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "生成失败" } });
      return { ok: true, code: r.code, meta: r.meta };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/regression/run", async (request, reply) => {
    const body = regressionGenerateSchema.extend({ code: z.string().min(1) }).parse(request.body);
    const { regressionService } = await import("../services/empirical-regression-service.js");
    try {
      const r = await regressionService.runRegressionCode(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "执行失败" } });
      return { ok: true, taskId: r.taskId };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/regression/debug", async (request, reply) => {
    const body = (request.body ?? {}) as { projectId?: string; code: string; errorLog: string; columns: string[] };
    if (!body.code || !body.errorLog) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 code 和 errorLog" } });
    }
    const { regressionService } = await import("../services/empirical-regression-service.js");
    try {
      const r = await regressionService.debugRegression(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "调试失败" } });
      return { ok: true, fixedCode: r.fixedCode, explanation: r.explanation, changedLines: r.changedLines };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.get("/api/empirical/regression/templates", async (request) => {
    const query = request.query as { dep?: string; core?: string };
    const { regressionService } = await import("../services/empirical-regression-service.js");
    const spec = { dep: query.dep ?? "y", core: [query.core ?? "x"] };
    return { templates: regressionService.getTemplates(spec) };
  });

  // ═══════════ V380: 实证工作台增强 — 证据账本 / 结果解释闸门 ═══════════
  const ledgerAddSchema = z.object({
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    tableIndex: z.number().int().min(0),
    rowIndex: z.number().int().min(0),
    colIndex: z.number().int().min(0),
    dataVersionId: z.string().uuid().optional().nullable(),
    citeKeys: z.array(z.string()).optional(),
  });
  app.post("/api/empirical/ledger/add-from-result", async (request, reply) => {
    const body = ledgerAddSchema.parse(request.body);
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    try {
      const r = await ledgerService.addFromResult(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "入账失败" } });
      return { ok: true, entry: r.entry };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.get("/api/empirical/ledger", async (request) => {
    const query = request.query as { projectId: string };
    z.string().uuid().parse(query.projectId);
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    return { entries: await ledgerService.listEntries(query.projectId) };
  });
  app.post("/api/empirical/ledger/:id/update-refs", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const body = (request.body ?? {}) as { codeSnippet?: string; dataVersionId?: string | null; citeKeys?: string[] };
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    const r = await ledgerService.updateRefs(id, body);
    if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "更新失败" } });
    return { ok: true, entry: r.entry };
  });
  app.delete("/api/empirical/ledger/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    z.string().uuid().parse(id);
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    const ok = await ledgerService.deleteEntry(id);
    if (!ok) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
    return { ok: true };
  });
  const citationSchema = z.object({
    projectId: z.string().uuid(),
    citeKey: z.string().min(1).max(100),
    title: z.string().min(1).max(500),
    authors: z.string().max(300).optional(),
    source: z.string().max(300).optional(),
    url: z.string().max(500).optional(),
  });
  app.post("/api/empirical/ledger/citations", async (request, reply) => {
    const body = citationSchema.parse(request.body);
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    const r = await ledgerService.addCitation(body);
    if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "添加失败" } });
    return { ok: true, citation: r.citation };
  });
  app.get("/api/empirical/ledger/citations", async (request) => {
    const query = request.query as { projectId: string };
    z.string().uuid().parse(query.projectId);
    const { ledgerService } = await import("../services/empirical-ledger-service.js");
    return { citations: await ledgerService.listCitations(query.projectId) };
  });
  const interpretationSchema = z.object({
    projectId: z.string().uuid().optional().nullable(),
    runId: z.string().uuid(),
    tablesText: z.string().min(1),
  });
  app.post("/api/empirical/interpretation/draft", async (request, reply) => {
    const body = interpretationSchema.parse(request.body);
    const { interpretationService } = await import("../services/empirical-interpretation-service.js");
    try {
      const r = await interpretationService.generateInterpretationDraft(body);
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "生成失败" } });
      return { ok: true, draft: r.draft };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  app.post("/api/empirical/interpretation/save", async (request, reply) => {
    const body = gateUpsertSchema.extend({ node: z.literal("result_interpretation") }).parse(request.body);
    const { gateService } = await import("../services/empirical-gate-service.js");
    try {
      return { gate: await gateService.upsertDraft(body.projectId, body.node, body.content) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  app.delete("/api/memory/context", async (request) => {
    const params = request.query as { sessionId?: string };
    if (params.sessionId) await memoryService.clearConversationContext(params.sessionId);
    return { ok: true };
  });

  // GET /api/memory/profile — 用户画像（高频主题/偏好源/提问数）
  app.get("/api/memory/profile", async () => {
    const profile = await memoryService.getUserProfile();
    return { profile };
  });

  // ───── V338(P2-3): 成本监控 API — 聚合 token → 成本估算 ─────
  app.get("/api/cost/summary", async (request) => {
    const params = request.query as { days?: string };
    try {
      const { getCostSummary } = await import("../services/cost-service.js");
      const s = await getCostSummary(parseInt(params.days ?? "7", 10) || 7);
      return s;
    } catch (e: any) {
      return { error: String(e).substring(0, 100) , code: "AGENT_INTERNAL_ERROR"};
    }
  });
  app.get("/api/cost/today", async () => {
    try {
      const { getTodayCost } = await import("../services/cost-service.js");
      return await getTodayCost();
    } catch (e: any) {
      return { error: String(e).substring(0, 100) , code: "AGENT_INTERNAL_ERROR"};
    }
  });

  // GET /api/memory/experience?query=xxx&projectId=xxx — 相似问题历史经验
  app.get("/api/memory/experience", async (request) => {
    const params = request.query as { query?: string; projectId?: string };
    if (!params.query) return { experiences: [] };
    const experiences = await memoryService.findSimilarExperiences(
      params.query,
      params.projectId
    );
    return { experiences };
  });

  // POST /api/memory/experience/:id/feedback — 用户反馈闭环（点赞/点踩）
  app.post("/api/memory/experience/:id/feedback", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { positive: boolean };
    await memoryService.feedbackExperience(Number(params.id), body.positive === true);
    return { ok: true };
  });

  // ───── LLM 模型注册表 API（2026-08-07：模型选择 + 角色映射）─────
  // GET /api/llm/models — 可用模型列表 + 角色映射
  // PUT /api/llm/models — 设置角色模型 {role, modelId}
  app.get("/api/llm/models", async () => ({
    models: LLM_MODEL_REGISTRY,
    roleMap: getRoleModelMap(),
  }));

  app.put("/api/llm/models", async (request) => {
    const body = request.body as { role?: LlmRole; modelId?: string };
    if (!body.role || !body.modelId) return { error: "role 和 modelId 必填" };
    setRoleModel(body.role, body.modelId);
    return { ok: true, roleMap: getRoleModelMap() };
  });

  // V449: 服务商选择联动 — 同步 LLM_MODEL（.env 兜底模型名）到服务商默认模型
  // 防止"服务商选 DeepSeek 但 LLM_MODEL 还是 qwen3.6-flash"导致 400
  app.post("/api/llm/provider-sync", async (request) => {
    const body = (request.body ?? {}) as { provider?: string };
    const provider = body.provider === "deepseek" ? "deepseek" : body.provider === "302ai" ? "302ai" : null;
    if (!provider) return { ok: false, error: "provider 必填 (deepseek/302ai)" };
    const defaultModel = provider === "deepseek" ? "deepseek-v4-flash" : "qwen3.6-flash";
    // 写 .env（追加/替换 LLM_MODEL）
    try {
      const fs = await import("node:fs");
      const envFile = path.join(process.cwd(), ".env");
      let env = "";
      if (fs.existsSync(envFile)) env = fs.readFileSync(envFile, "utf8");
      const lines = env.split("\n").filter((l) => !l.startsWith("LLM_MODEL="));
      lines.push(`LLM_MODEL=${defaultModel}`);
      fs.writeFileSync(envFile, lines.join("\n") + "\n", "utf8");
      process.env.LLM_MODEL = defaultModel;  // 当前进程即时生效
      return { ok: true, model: defaultModel };
    } catch (e: any) {
      return { ok: false, error: "写 .env 失败: " + String(e?.message || e).slice(0, 80) };
    }
  });

  // ───── 自主任务 API（2026-08-07 P2：目标→拆解→执行→干预）─────
  // POST /api/agent/tasks — 创建任务（body: {goal, projectId?}），返回任务 + 计划
  // POST /api/agent/tasks/:id/run — 逐项执行（检索/推理/写作调度）
  // POST /api/agent/tasks/:id/control — 干预 {action: pause|resume|cancel}
  // GET /api/agent/tasks?projectId= — 任务列表
  app.post("/api/agent/tasks", async (request) => {
    const body = request.body as { goal: string; projectId?: string; budgetCents?: number; parentTaskId?: string; target?: string };
    if (!body.goal?.trim()) return { error: "goal 必填", code: "AGENT_BAD_REQUEST" };
    // V391(P1-2): 预算声明 — 前端可传 budgetCents, 超预算自动降级
    const budgetCents = Math.min(Math.max(Number(body.budgetCents) || 300, 50), 10000);
    // wisp借鉴: 计算上下文透传（local/wsl/ssh/gpu → 存入任务 progress 标记, 步骤执行器读取）
    const target = ["wsl", "ssh", "gpu"].includes(String(body.target || "")) ? String(body.target) : "local";
    // V394-5: 任务链 — 支持续作（parentTaskId 关联上次任务）
    // W6: 用户隔离 — 从 JWT 取 userId 记录任务归属（billing 扣费依据）
    const authHdrW6 = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtW6 = authHdrW6 ? authService.verifyToken(authHdrW6) : null;
    const task = await agentTaskService.createAgentTask({ goal: body.goal.trim(), projectId: body.projectId, budgetCents, parentTaskId: body.parentTaskId, userId: jwtW6?.uid || undefined });
    // wisp借鉴: 任务级计算上下文标记（exec_logs/步骤执行器可读）
    if (target !== "local") {
      await pool.query(`update agent_tasks set progress = $2 where id = $1`, [task.id, `计算上下文: ${target}`]);
    }
    // V395-6: 返回预估成本（创建时 planBudget 计算; 前端显示"预估 ¥X"）
    return { task, estimatedCostCents: task.estimatedCostCents, estimatedCostYuan: (task.estimatedCostCents / 100).toFixed(3) };
  });

  app.post("/api/agent/tasks/:id/run", async (request, reply) => {
    const params = request.params as { id: string };
    const task = await agentTaskService.getAgentTask(params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    // V391(P0-4): awaiting_approval 任务 — 批准后从挂起步骤继续
    if (task.status === "awaiting_approval") {
      return reply.code(400).send({ error: "任务等待审批中，请先 /approve", code: "AGENT_AWAITING_APPROVAL" });
    }
    // S3: 防并发双跑 — running/planning/completed 任务不可重复入队
    if (task.status === "running" || task.status === "planning" || task.status === "completed") {
      return reply.code(400).send({ error: `任务状态为 ${task.status}，不可重复执行`, code: "AGENT_ALREADY_RUNNING" });
    }
    // V394-4: 任务调度队列 — 并发上限+优先级（JWT 用户按 plan 定优先级）
    const { agentTaskQueue } = await import("../services/agent-task-queue.js");
    const authHdrQ = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtPQ = authHdrQ ? authService.verifyToken(authHdrQ) : null;
    let priority = 1;
    if (jwtPQ) {
      const uQ = await pool.query("select plan from users where id = $1", [jwtPQ.uid]);
      if (uQ.rows.length > 0) priority = agentTaskQueue.priorityForPlan(uQ.rows[0].plan || "free");
    }
    agentTaskQueue.enqueueTask({
      taskId: params.id,
      priority,
      run: () => runAgentTaskInner(params.id, task, request),
    });
    return { ok: true, taskId: params.id, queued: true, priority };
  });

  // V394-4: 队列内部执行器（原 run 路由的后台执行逻辑抽出）
  async function runAgentTaskInner(id: string, task: any, request: any): Promise<void> {
    await agentTaskService.runAgentTask(id, async (step) => {
      // 步骤执行器：V393-1 先 LLM 动态选工具（真·工具调用），失败回退类型调度
      try {
        // ── V393-1: LLM 动态工具选择（V393-4/5: 带角色+白名单策略; V393-8: 失败降级链）──
        // V1: sourceId 动态化 — 用任务关联的项目(而非写死的 c609acbf), 检索与用户研究项目对齐
        const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
        const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
        const chosen = await chooseToolByLlm(task.goal, step.title, tools);
        // 差距S②(Codex tool_dispatch_trace): 分派追踪 — 每次工具选择记录入 exec_logs
        if (chosen) {
          const { logAgentExec } = await import("../services/agent-exec-log.js");
          await logAgentExec({
            taskId: task.id, stepId: step.id, action: "dispatch", tool: chosen.tool.name,
            inputSummary: `步骤: ${step.title}`, outputSummary: `选择工具: ${chosen.tool.name}（LLM动态路由）`,
            status: "ok", spanType: "TOOL",
          });
        }
        if (chosen) {
          // V393-4: 角色 = 用户角色(admin→manager, user→analyst, 无token→manager兼容)
          const authHdr2 = String((request.headers.authorization || "").replace("Bearer ", "").trim());
          const jwtP = authHdr2 ? authService.verifyToken(authHdr2) : null;
          const agentRole = jwtP?.role === "admin" ? "manager" as const : "analyst" as const;
          // V393-8: 带降级链执行（主工具失败自动切换替代工具）
          const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: agentRole });
          if (exec.ok) {
            return {
              result: exec.result.substring(0, 120),
              detail: `【工具调用】${chosen.tool.label}(${chosen.tool.name}) [角色:${agentRole}]${exec.usedFallback ? `\n【降级】主工具失败 → ${exec.usedFallback}` : ""}\n【参数】${JSON.stringify(chosen.args).slice(0, 200)}\n【结果】\n${exec.result}`,
              source: `工具: ${chosen.tool.label}${exec.usedFallback ? `(降级→${exec.usedFallback})` : ""}`,
            };
          }
          // 工具执行失败/策略拒绝 → 回退类型调度（不阻断任务）
          console.log(`[agent] tool ${chosen.tool.name} blocked/failed: ${exec.result.slice(0, 80)}, fallback to type dispatch`);
        }
        if (step.type === "retrieve" || step.type === "reason") {
          const res = await fetch(SELF_BASE + "/api/reason/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // G24: sourceId 动态化 — 用任务关联项目(未关联时省略走服务端默认), 不再硬编码
            body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive", sessionId: "00000000-0000-0000-0000-000000000000" }),
          });
          const data: any = await res.json();
          const trace = data?.trace || {};
          const content = trace?.hypothesis?.content || data?.error || "（无结果）";
          // 真实详情：检索链路 + 实体 + 评估分
          const detail = [
            `【检索链路】${(trace?.retrieveSources || []).join(" → ") || "adaptive"}`,
            `【实体】${(trace?.entityNames || []).slice(0, 10).join("、") || "无"}`,
            `【评估】${trace?.evaluation ? `${(trace.evaluation.overallScore ?? 0).toFixed(2)}/1.0 (${trace.evaluation.passed ? "通过" : "未通过"})` : "未评估"}`,
            trace?.planRationale ? `【规划依据】${trace.planRationale}` : "",
            `【完整回答】\n${content}`,
          ].filter(Boolean).join("\n");
          return {
            result: content.substring(0, 120),
            detail,
            source: `SAG 推理（${trace?.model?.model || "adaptive"}）`,
          };
        }
        if (step.type === "write") {
          // 写作步骤：基于检索结果生成（真实 LLM 调用）
          const dsKey = process.env.DEEPSEEK_API_KEY || "";
          const llmRes = await fetch(
            dsKey ? (process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
              body: JSON.stringify({
                model: resolveModelAlias(getRoleModel("reason")),
                messages: [{ role: "user", content: `撰写研究段落。主题: ${step.title}\n目标: ${step.query}\n用中文，400-600字，结构化。` }],
                temperature: 0.3, max_tokens: 1200,
              }),
            }
          );
          const data: any = await llmRes.json();
          const text = data?.choices?.[0]?.message?.content || "（写作失败）";
          return { result: text.substring(0, 120), detail: `【写作结果】\n${text}`, source: "LLM 写作（deepseek-chat）" };
        }
        if (step.type === "review") {
          // 评审步骤：对前序产出做质量检查（真实 LLM 评审）
          const dsKey = process.env.DEEPSEEK_API_KEY || "";
          const llmRes = await fetch(
            dsKey ? (process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
              body: JSON.stringify({
                model: resolveModelAlias(getRoleModel("reason")),
                messages: [{ role: "user", content: `评审研究产出质量。任务: ${step.title}\n目标: ${step.query}\n输出：1) 主要问题 2) 修正建议 3) 总体评分(0-1)。简洁中文。` }],
                temperature: 0.1, max_tokens: 800,
              }),
            }
          );
          const data: any = await llmRes.json();
          const text = data?.choices?.[0]?.message?.content || "（评审失败）";
          return { result: `评审完成: ${text.substring(0, 100)}`, detail: `【评审意见】\n${text}`, source: "评审 Agent（deepseek-chat）" };
        }
        return { result: `（未知步骤类型: ${step.type}）` };
      } catch (e: any) {
        return { result: `执行失败: ${String(e?.message || e).slice(0, 300)}`, detail: String(e?.message || e).slice(0, 500) };
      }
    }).catch((e: any) => console.error("[agent] run FAIL:", e?.message?.slice(0, 100)));
  }

  app.post("/api/agent/tasks/:id/control", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { action: "pause" | "resume" | "cancel" };
    // S1: 越权校验 — 非管理员操作他人任务 → 拒绝（与 messages 路由一致）
    if (!(await assertTaskOwnership(request, reply, params.id))) return;
    const task = await agentTaskService.controlAgentTask(params.id, body.action);
    return { task };
  });

  // V391(P0-4): 人工审批门 — 高危步骤挂起后由用户批准/拒绝
  app.post("/api/agent/tasks/:id/approve", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { approve: boolean; note?: string; action?: "approve" | "edit" | "reject" | "respond"; editArgs?: Record<string, unknown> };
    // S1: 越权校验 — 非管理员审批他人任务 → 拒绝
    if (!(await assertTaskOwnership(request, reply, params.id))) return;
    try {
      // V396-11: 四态确认 — approve/edit/reject/respond
      const task = await agentTaskService.approveAgentStep(params.id, !!body.approve, body.note, body.action, body.editArgs);
      // V395-2: SSE — 审批后推送最新任务状态（前端立即刷新, 无需轮询）
      const { publishAgentProgress } = await import("../services/agent-progress.js");
      publishAgentProgress({ type: "task", taskId: params.id, data: { status: task.status, plan: task.plan, currentStep: task.currentStep, progress: task.progress, approvalRequest: task.approvalRequest } });
      return { task };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 100) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  // V396-11: 审批超时处理 — 超时=拒绝(绝不自动放行)
  app.post("/api/agent/tasks/timeout-approvals", async (request) => {
    const body = request.body as { maxWaitMinutes?: number };
    const { agentTaskService } = await import("../services/agent-task-service.js");
    return { result: await agentTaskService.timeoutPendingApprovals(body.maxWaitMinutes || 60) };
  });

  // P2: 主动研究 — 手动触发一次自主巡检（每日自动由 startProactiveResearchScheduler 执行）
  app.post("/api/agent/proactive-research", async () => {
    const { runProactiveResearch } = await import("../services/agent-proactive-research.js");
    const r = await runProactiveResearch();
    return { ok: true, result: r };
  });

  // 借鉴5(Codex Guardian): 策略文件审查 API
  app.get("/api/agent/guardian/policy", async () => {
    const { guardianService } = await import("../services/agent-guardian-service.js");
    return { policy: guardianService.readGuardianPolicy() };
  });
  app.post("/api/agent/guardian/review", async (request, reply) => {
    const body = request.body as { tool: string; args?: Record<string, unknown>; authorization?: string };
    if (!body.tool) return reply.code(400).send({ error: "tool 必填", code: "AGENT_BAD_REQUEST" });
    const { guardianService } = await import("../services/agent-guardian-service.js");
    const auth = (body.authorization === "high" || body.authorization === "medium" || body.authorization === "low" || body.authorization === "unknown")
      ? body.authorization : "high";
    return { decision: guardianService.guardianReview(body.tool, body.args, auth) };
  });
  app.post("/api/agent/guardian/reload", async () => {
    const { guardianService } = await import("../services/agent-guardian-service.js");
    return { result: guardianService.reloadGuardianPolicy() };
  });

  // 差距D(DSH hooks + preset): 钩子注册/列表 + 预设切换
  app.get("/api/agent/hooks", async () => {
    const { agentHooks, registerBuiltinHooks } = await import("../services/agent-hooks.js");
    registerBuiltinHooks();
    return { hooks: agentHooks.list(), stats: agentHooks.stats() };
  });
  app.post("/api/agent/hooks", async (request, reply) => {
    const body = request.body as { event?: string; name?: string };
    const events = ["task_start", "task_end", "tool_before", "tool_after", "step_fail", "reflect", "approval"];
    if (!body.event || !events.includes(body.event)) return reply.code(400).send({ error: "event 需为: " + events.join("/"), code: "AGENT_BAD_REQUEST" });
    const { agentHooks } = await import("../services/agent-hooks.js");
    const id = agentHooks.register(body.event as any, body.name || "自定义钩子", async (payload) => {
      console.log(`[hook:${body.event}] ${body.name}: ${JSON.stringify(payload).slice(0, 120)}`);
      return `[hook:${body.event}] 已触发`;
    });
    return { ok: true, id };
  });
  app.delete("/api/agent/hooks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentHooks } = await import("../services/agent-hooks.js");
    return { ok: agentHooks.unregister(params.id) };
  });
  app.get("/api/agent/presets", async () => {
    const { AGENT_PRESETS, getActivePreset } = await import("../services/agent-presets.js");
    return { presets: Object.values(AGENT_PRESETS), active: getActivePreset().id };
  });
  app.post("/api/agent/presets", async (request, reply) => {
    const body = request.body as { id?: string };
    const { setActivePreset } = await import("../services/agent-presets.js");
    if (!body.id || !setActivePreset(body.id as any)) {
      return reply.code(400).send({ error: "预设不存在（academic/data/writing/coding）", code: "AGENT_BAD_REQUEST" });
    }
    // 差距P③: 设置持久化
    const { agentSettingsService } = await import("../services/agent-settings.js");
    void agentSettingsService.setAgentSetting("preset", body.id);
    return { ok: true, active: body.id };
  });

  // 差距F⑤(DSH credentials): Agent 凭证管理（API 只返回脱敏视图）
  app.get("/api/agent/credentials", async () => {
    const { agentCredentialsService } = await import("../services/agent-credentials.js");
    return { credentials: await agentCredentialsService.listAgentCredentials() };
  });
  app.post("/api/agent/credentials", async (request, reply) => {
    const body = request.body as { name?: string; kind?: string; value?: string; hint?: string };
    if (!body.name?.trim() || !body.value?.trim()) {
      return reply.code(400).send({ error: "name 和 value 必填", code: "AGENT_BAD_REQUEST" });
    }
    const { agentCredentialsService } = await import("../services/agent-credentials.js");
    const cred = await agentCredentialsService.upsertAgentCredential({ name: body.name, kind: body.kind, value: body.value, hint: body.hint });
    return { ok: true, credential: cred };
  });
  app.delete("/api/agent/credentials/:name", async (request, reply) => {
    const params = request.params as { name: string };
    const { agentCredentialsService } = await import("../services/agent-credentials.js");
    return { ok: await agentCredentialsService.deleteAgentCredential(params.name) };
  });

  // 差距H⑤(DSH workflow): 工作流模板 — 固定多步骤流程一键执行
  app.get("/api/agent/workflows", async () => {
    const { workflowTemplates } = await import("../services/agent-workflows.js");
    return { workflows: workflowTemplates };
  });
  app.post("/api/agent/workflows/:id/run", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { goal?: string };
    const { runWorkflow } = await import("../services/agent-workflows.js");
    const result = await runWorkflow(params.id, body.goal || "");
    if (!result) return reply.code(404).send({ error: "工作流不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true, result };
  });

  // 差距H⑥(Codex memory_usage): Agent 内存使用监控
  app.get("/api/agent/memory-usage", async () => {
    const mem = process.memoryUsage();
    return {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),
    };
  });

  // 差距O①(DSH feedback): Agent 任务反馈闭环
  app.post("/api/agent/feedback", async (request, reply) => {
    const body = request.body as { taskId?: string; feedback?: number; note?: string };
    if (!body.taskId || ![1, -1, 0].includes(Number(body.feedback))) {
      return reply.code(400).send({ error: "taskId 和 feedback(1/-1/0) 必填", code: "AGENT_BAD_REQUEST" });
    }
    const { agentFeedbackService } = await import("../services/agent-feedback.js");
    return { result: await agentFeedbackService.submitAgentFeedback({ taskId: body.taskId, feedback: Number(body.feedback) as 1 | -1 | 0, note: body.note }) };
  });
  app.get("/api/agent/feedback/stats", async () => {
    const { agentFeedbackService } = await import("../services/agent-feedback.js");
    return { stats: await agentFeedbackService.agentFeedbackStats() };
  });

  // 差距O②(Codex plan): 计划确认 — 任务执行前展示计划, 确认后才执行
  app.post("/api/agent/tasks/:id/confirm-plan", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentTaskService } = await import("../services/agent-task-service.js");
    const task = await agentTaskService.getAgentTask(params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    if (task.status !== "planning") return reply.code(400).send({ error: "仅 planning 状态可确认计划", code: "AGENT_BAD_REQUEST" });
    const body = request.body as { approved?: boolean };
    if (body.approved === false) {
      // 拒绝计划 → 置 cancelled
      await agentTaskService.controlAgentTask(params.id, "cancel");
      return { ok: true, approved: false, note: "计划已拒绝" };
    }
    // 确认 → 置 running（可入队执行）
    await agentTaskService.controlAgentTask(params.id, "resume");
    return { ok: true, approved: true, plan: task.plan, note: `计划已确认（${task.plan.length} 步）` };
  });

  // 差距Q①(DSH session-query): 会话全文检索
  app.get("/api/agent/sessions/search", async (request) => {
    const q = request.query as { q?: string };
    const { agentChatMemory } = await import("../services/agent-chat-memory.js");
    return { sessions: await agentChatMemory.searchAgentSessions(q?.q || "") };
  });

  // 架构F1: 会话图（会话→任务→工具 可视化）
  app.get("/api/agent/session-graph", async (request, reply) => {
    const q = request.query as { sessionId?: string };
    if (!q.sessionId) return reply.code(400).send({ error: "sessionId 必填", code: "AGENT_BAD_REQUEST" });
    const { agentSessionGraphService } = await import("../services/agent-session-graph.js");
    return await agentSessionGraphService.buildSessionGraph(q.sessionId);
  });
  // 架构F2: 从 checkpoint 分叉新任务（计划复制, 独立演进）
  app.post("/api/agent/tasks/:id/fork", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { goal?: string };
    const { agentSessionGraphService } = await import("../services/agent-session-graph.js");
    const result = await agentSessionGraphService.forkTaskFromCheckpoint(params.id, body?.goal);
    if (!result) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true, taskId: result.taskId, note: "已分叉: 计划复制为新任务, 可独立演进" };
  });

  // 前端缺口④: 文件插件列表（plugins/ 目录, 含签名状态）
  app.get("/api/agent/plugins/files", async () => {
    const { pluginsDir, verifyPluginSignature } = await import("../services/agent-file-plugins.js");
    const fs = await import("node:fs");
    const dir = pluginsDir();
    let files: Array<{ name: string; signed: boolean }> = [];
    try {
      files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".ts") && !f.startsWith(".")).map((f: string) => ({
        name: f,
        signed: process.env.AGENT_PLUGIN_SIGNATURES ? true : false,  // 配置签名后由 verify 决定; 简化为配置状态
      }));
    } catch { files = []; }
    return { files };
  });

  // 审计修复: 实时工具清单（含动态 pdf_parse/插件工具 — 工具策略页与实际工具集对齐）
  app.get("/api/agent/tools", async () => {
    const { buildAgentTools } = await import("../services/agent-tool-router.js");
    const tools = await buildAgentTools({});
    return {
      tools: tools.map((t) => ({
        name: t.name, label: t.label, risk: t.risk,
        description: (t.description || "").slice(0, 60),
      })),
    };
  });

  // wisp借鉴: 计算上下文状态（持久运行时会话 + 远程 WSL/SSH/GPU 配置）
  app.get("/api/agent/compute-status", async () => {
    const { agentPersistentRuntime } = await import("../services/agent-persistent-runtime.js");
    const { remoteExecStatus } = await import("../services/agent-remote-exec.js");
    return { runtimes: agentPersistentRuntime.persistentRuntimeStatus(), remote: remoteExecStatus() };
  });
  // wisp借鉴: 关闭持久运行时会话（重置）
  app.post("/api/agent/persistent-runtime/:id/close", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentPersistentRuntime } = await import("../services/agent-persistent-runtime.js");
    agentPersistentRuntime.closeSession(params.id);
    return { ok: true };
  });

  // 架构A2: Provider 抽象状态（LLM/沙箱实现列表）
  app.get("/api/agent/providers", async () => {
    const { agentProviderService } = await import("../services/agent-provider-abstraction.js");
    return { providers: agentProviderService.providerStatus() };
  });

  // 架构A2 + #7: 插件模板库（预置插件生成: 数据可视化/文献管理/翻译）
  app.get("/api/agent/plugins/templates", async () => {
    const { PLUGIN_TEMPLATES } = await import("../services/agent-plugin-templates.js");
    return { templates: PLUGIN_TEMPLATES };
  });
  app.post("/api/agent/plugins/templates/:id/install", async (request, reply) => {
    const params = request.params as { id: string };
    const { installPluginTemplate } = await import("../services/agent-plugin-templates.js");
    const result = await installPluginTemplate(params.id);
    if (!result) return reply.code(404).send({ error: "模板不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true, file: result.file, tools: result.tools };
  });

  app.get("/api/agent/oauth/:provider/start", async (request, reply) => {
    const params = request.params as { provider: string };
    const { agentOAuthService } = await import("../services/agent-oauth.js");
    const redirectBase = `${request.protocol}://${request.headers.host}`;
    const flow = await agentOAuthService.startOAuthFlow(params.provider, redirectBase);
    if (!flow) return reply.code(400).send({ error: `provider ${params.provider} 未注册（GitHub 需配置 AGENT_GITHUB_CLIENT_ID）`, code: "AGENT_BAD_REQUEST" });
    return { url: flow.url };
  });
  app.get("/api/agent/oauth/:provider/callback", async (request, reply) => {
    const params = request.params as { provider: string };
    const q = request.query as { code?: string; state?: string };
    const { agentOAuthService } = await import("../services/agent-oauth.js");
    const result = await agentOAuthService.handleOAuthCallback(params.provider, q.code || "", q.state || "");
    if (!result.ok) return reply.code(400).send({ error: result.error || "授权失败", code: "AGENT_OAUTH_FAILED" });
    return reply.type("text/html").send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ 授权成功</h2><p>账号: ${result.account}</p><p>可关闭此页面，返回 SAG 继续使用。</p></body></html>`);
  });
  app.get("/api/agent/oauth/accounts", async () => {
    const { agentOAuthService } = await import("../services/agent-oauth.js");
    return { accounts: await agentOAuthService.listOAuthAccounts() };
  });
  app.delete("/api/agent/oauth/:provider/:account", async (request, reply) => {
    const params = request.params as { provider: string; account: string };
    const { agentOAuthService } = await import("../services/agent-oauth.js");
    return { ok: await agentOAuthService.revokeOAuthAccount(params.provider, params.account) };
  });

  // 架构E2: LLM 流式推理端点 — SSE 逐块推送（前端实时显示生成过程）
  app.post("/api/agent/llm/stream", async (request, reply) => {
    const body = request.body as { prompt?: string; model?: string; maxTokens?: number };
    if (!body.prompt?.trim()) return reply.code(400).send({ error: "prompt 必填", code: "AGENT_BAD_REQUEST" });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
    });
    const { callLlm } = await import("../ai/llm-common.js");
    const r = await callLlm({
      model: body.model || undefined,
      maxTokens: body.maxTokens,
      messages: [{ role: "user", content: body.prompt }],
      agentContext: { action: "agent_llm_stream" },
      onStream: (delta) => {
        reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
      },
    });
    reply.raw.write(`data: ${JSON.stringify({ done: true, text: r?.text || "", error: r?.error })}\n\n`);
    reply.raw.end();
  });

  // 差距R④(Codex image_preparation): 附件图片预处理（压缩 → 减少多模态 token）
  app.post("/api/agent/image/prepare", async (request, reply) => {    const body = request.body as { path?: string; maxDim?: number };
    const { agentToolRouter } = await import("../services/agent-tool-router.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    const rel = String(body.path || "").replace(/^[/\\]+/, "");
    const target = path.resolve(workspace, rel);
    if (!(target === workspace || target.startsWith(workspace + path.sep))) {
      return reply.code(400).send({ error: "路径越界", code: "AGENT_BAD_REQUEST" });
    }
    if (!fs.existsSync(target)) return reply.code(404).send({ error: "文件不存在", code: "AGENT_NOT_FOUND" });
    const sizeKB = Math.round(fs.statSync(target).size / 1024);
    const ext = path.extname(target).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
    // 图片超 1MB → 提示压缩（多模态 token 与分辨率成正比）
    const suggestion = isImage && sizeKB > 1024
      ? `图片 ${sizeKB}KB 较大 — 建议压缩后上传（多模态 token 成本与分辨率成正比）`
      : isImage ? `图片 ${sizeKB}KB — 可直接用于附件读取` : `文件 ${sizeKB}KB — 非图片附件`;
    return { ok: true, sizeKB, isImage, suggestion };
  });

  // V398: 对话图片静态服务（ChatPanel 消息内联预览；限 agent_workspace/chat_uploads 内，防路径穿越）
  app.get("/api/chat/images/*", async (request, reply) => {
    const raw = String((request.params as { "*"?: string })["*"] ?? "");
    // 兼容两种相对路径：`chat_uploads/xxx.png`（上传接口返回值）或 `xxx.png`（直接文件名）
    const rel = raw.replace(/^[/\\]+/, "").replace(/^chat_uploads[/\\]/, "");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    const uploadsDir = path.join(workspace, "chat_uploads");
    const target = path.resolve(uploadsDir, rel);
    if (!(target === uploadsDir || target.startsWith(uploadsDir + path.sep))) {
      return reply.code(400).send({ error: "路径越界", code: "AGENT_BAD_REQUEST" });
    }
    if (!fs.existsSync(target)) return reply.code(404).send({ error: "文件不存在", code: "AGENT_NOT_FOUND" });
    const ext = path.extname(target).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : ext === ".bmp" ? "image/bmp" : "image/jpeg";
    reply.header("Content-Type", mime);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(fs.readFileSync(target));
  });

  // 差距P③(DSH settings): 设置读写 + 差距P⑤ 子进程状态
  app.get("/api/agent/settings", async () => {
    const { agentSettingsService } = await import("../services/agent-settings.js");
    const [preset, autonomy, sandbox] = await Promise.all([
      agentSettingsService.getAgentSetting("preset"),
      agentSettingsService.getAgentSetting("autonomy"),
      agentSettingsService.getAgentSetting("sandbox_profile"),
    ]);
    return { settings: { preset, autonomy, sandbox_profile: sandbox } };
  });
  app.get("/api/agent/subprocesses", async () => {
    const { subprocessStatus } = await import("../services/agent-runtime-utils.js");
    return { processes: subprocessStatus() };
  });

  // 差距I②(Codex approval modes): 自主级别
  app.get("/api/agent/autonomy", async () => {
    const { getAutonomyLevel, AUTONOMY_LABELS } = await import("../services/agent-autonomy.js");
    return { level: getAutonomyLevel(), labels: AUTONOMY_LABELS };
  });
  app.post("/api/agent/autonomy", async (request, reply) => {
    const body = request.body as { level?: string };
    const { setAutonomyLevel, AUTONOMY_LABELS } = await import("../services/agent-autonomy.js");
    if (!body.level || !setAutonomyLevel(body.level as any)) {
      return reply.code(400).send({ error: "级别不存在（suggest/auto-edit/full-auto）", code: "AGENT_BAD_REQUEST" });
    }
    // 差距P③: 设置持久化
    const { agentSettingsService } = await import("../services/agent-settings.js");
    void agentSettingsService.setAgentSetting("autonomy", body.level);
    return { ok: true, level: body.level, label: AUTONOMY_LABELS[body.level as keyof typeof AUTONOMY_LABELS] };
  });

  // 差距F④(DSH runtime-diagnostics): 运行时诊断 — 一次拉取全部 Agent 运行时状态
  app.get("/api/agent/diagnostics", async () => {
    const diag: Record<string, unknown> = { timestamp: new Date().toISOString() };
    try {
      const { llmConcurrencyStats } = await import("../ai/llm-common.js");
      diag.llm = llmConcurrencyStats();
    } catch { diag.llm = null; }
    try {
      const { agentTaskQueue } = await import("../services/agent-task-queue.js");
      diag.queue = agentTaskQueue.queueStatus();
    } catch { diag.queue = null; }
    try {
      const { agentProgressService } = await import("../services/agent-progress.js");
      diag.sseSubscribers = agentProgressService.agentProgressSubscriberCount();
    } catch { diag.sseSubscribers = null; }
    try {
      const { agentChatMemory } = await import("../services/agent-chat-memory.js");
      diag.chatSessions = agentChatMemory.agentChatSessionCount();
    } catch { diag.chatSessions = null; }
    try {
      const { agentHooks, registerBuiltinHooks } = await import("../services/agent-hooks.js");
      registerBuiltinHooks();
      diag.hooks = agentHooks.stats();
    } catch { diag.hooks = null; }
    try {
      const { toolRegistry } = await import("../services/agent-tool-registry.js");
      diag.toolRegistry = { size: toolRegistry.size() };
    } catch { diag.toolRegistry = null; }
    try {
      const { getActivePreset } = await import("../services/agent-presets.js");
      diag.preset = getActivePreset().id;
    } catch { diag.preset = null; }
    try {
      const r = await pool.query(`select
        (select count(*) from agent_tasks where status='running') as running,
        (select count(*) from agent_tasks where status='awaiting_approval') as awaiting,
        (select count(*) from agent_tasks where status='failed' and created_at > now()-interval '24 hours') as failed24h,
        (select count(*) from agent_exec_logs where created_at > now()-interval '1 hour') as logs1h`);
      diag.db = r.rows[0];
    } catch { diag.db = null; }
    return diag;
  });

  // ═══ 学术写作语料库 API（2026-08-16: 四大子库 + LLM 提取 + 检索召回）═══
  const corpusService = () => import("../services/writing-corpus-service.js").then((m) => m.writingCorpusService);
  // 四大子库列表（统一入口: kind=texts|concepts|logics|expressions, 过滤参数透传）
  app.get("/api/writing-corpus/:kind", async (request) => {
    const params = request.params as { kind: string };
    const q = request.query as { module?: string; language?: string; tag?: string; group?: string; q?: string; limit?: string };
    const svc = await corpusService();
    const limit = Number(q.limit) || 100;
    switch (params.kind) {
      case "texts": return { items: await svc.listCorpusTexts({ module: q.module, language: q.language, tag: q.tag, q: q.q, limit }) };
      case "concepts": return { items: await svc.listCorpusConcepts({ q: q.q, limit }) };
      case "logics": return { items: await svc.listCorpusLogics({ q: q.q, limit }) };
      case "expressions": return { items: await svc.listCorpusExpressions({ group: q.group, q: q.q, limit }) };
      default: return { items: [] };
    }
  });
  // 新增语料（kind=texts|concepts|logics|expressions, body 透传）
  app.post("/api/writing-corpus/:kind", async (request, reply) => {
    const params = request.params as { kind: string };
    const body = request.body as any;
    const svc = await corpusService();
    try {
      switch (params.kind) {
        case "texts": return { item: await svc.addCorpusText(body) };
        case "concepts": return { item: await svc.addCorpusConcept(body) };
        case "logics": return { item: await svc.addCorpusLogic(body) };
        case "expressions": return { item: await svc.addCorpusExpression(body) };
        default: return reply.code(400).send({ error: "未知语料类型", code: "CORPUS_BAD_KIND" });
      }
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 100), code: "CORPUS_INVALID" });
    }
  });
  // LLM 辅助提取（粘贴原文 → 结构化语料）
  app.post("/api/writing-corpus/extract", async (request, reply) => {
    const body = request.body as { text: string; kind: "text" | "concept" | "logic" | "expression" };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text 必填", code: "CORPUS_BAD_REQUEST" });
    const svc = await corpusService();
    const extracted = await svc.extractCorpusWithLlm({ text: body.text, kind: body.kind || "text" });
    return { extracted };
  });
  // 检索召回（Agent llm_write 注入 + 前端"写作前调取"）
  app.post("/api/writing-corpus/recall", async (request) => {
    const body = request.body as { writingModule?: string; semanticGroups?: string[]; q?: string; limit?: number };
    const svc = await corpusService();
    return await svc.recallCorpusForWriting(body);
  });

  // V395-2: 任务流式进度 — SSE 推送（步骤执行/reflect/日志/完成）
  // GET /api/agent/tasks/:id/stream → text/event-stream
  app.get("/api/agent/tasks/:id/stream", async (request, reply) => {
    const params = request.params as { id: string };
    const { subscribeAgentProgress, publishAgentProgress, bufferedEventsSince } = await import("../services/agent-progress.js");
    const task = await agentTaskService.getAgentTask(params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown, seq?: number) => {
      // W3: SSE id 字段（Last-Event-ID 断线续传依据）
      if (seq) reply.raw.write(`id: ${seq}\n`);
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") flush.call(reply.raw);
    };
    // 心跳（每 15s, 防代理超时断连）
    const heartbeat = setInterval(() => {
      try { send("heartbeat", { ts: Date.now() }); } catch { /* 连接已断 */ }
    }, 15000);
    heartbeat.unref?.();
    // W3: Last-Event-ID 续传 — 断线重连时补发漏掉的中间事件
    const lastEventId = Number((request.headers as any)["last-event-id"] || 0);
    const missed = bufferedEventsSince(params.id, lastEventId || undefined);
    for (const ev of missed) send(ev.type, ev.data, ev.seq);
    // 初始快照（连上即有完整状态, 不漏事件）
    send("snapshot", { task });
    const unsubscribe = subscribeAgentProgress(params.id, (ev) => {
      try { send(ev.type, ev.data, ev.seq); } catch { /* 客户端断开 */ }
    });
    // 连接关闭清理（前端 EventSource 断开 → 移除订阅 + 停心跳）
    request.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    // 立即发布一次 task 事件（后端已有新状态立即推送, 与快照互补）
    publishAgentProgress({ type: "task", taskId: params.id, data: { status: task.status, plan: task.plan, currentStep: task.currentStep, progress: task.progress } });
  });

  // ───── V391(P1-4): 战略记忆（项目目标/决策/约束） ─────
  app.get("/api/strategic-memory", async (request) => {
    const q = request.query as { projectId?: string };
    return { memory: await strategicMemoryService.listStrategicMemory(q.projectId) };
  });
  app.get("/api/strategic-memory/context", async (request) => {
    const q = request.query as { projectId?: string };
    return { context: await strategicMemoryService.loadStrategicContext(q.projectId) };
  });
  app.post("/api/strategic-memory", async (request, reply) => {
    const body = request.body as { projectId?: string; kind: string; content: string; source?: string };
    if (!["goal", "decision", "constraint", "milestone"].includes(body.kind)) return reply.code(400).send({ error: "kind 需为 goal/decision/constraint/milestone", code: "AGENT_BAD_REQUEST" });
    if (!body.content?.trim()) return reply.code(400).send({ error: "content 必填", code: "AGENT_BAD_REQUEST" });
    const record = await strategicMemoryService.recordStrategicMemory({
      projectId: body.projectId, kind: body.kind as any, content: body.content, source: (body.source || "user") as any,
    });
    return { record };
  });
  app.delete("/api/strategic-memory/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const ok = await strategicMemoryService.deleteStrategicMemory(Number(params.id));
    if (!ok) return reply.code(404).send({ error: "记录不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true };
  });

  // ───── V391(P1-5): 记忆维护（自动遗忘/合并） ─────
  app.get("/api/memory-maintenance/stats", async () => ({ stats: await memoryMaintenanceService.memoryMaintenanceStats() }));
  app.post("/api/memory-maintenance/run", async (request, reply) => {
    const body = request.body as { recallDays?: number } | undefined;
    const result = await memoryMaintenanceService.runMemoryMaintenance({ recallDays: body?.recallDays });
    return { result };
  });
  app.post("/api/memory-maintenance/register", async (request, reply) => {
    const body = request.body as { category: string; subtype?: string; content: string };
    if (!body.content?.trim()) return reply.code(400).send({ error: "content 必填", code: "AGENT_BAD_REQUEST" });
    const result = await memoryMaintenanceService.registerMemory({ category: body.category, subtype: body.subtype, content: body.content });
    return { result };
  });

  // ───── V391(P1-6): 预防规则（错误模式→防错） ─────
  app.get("/api/prevention-rules", async () => ({ rules: await preventionRulesService.listRules() }));
  app.post("/api/prevention-rules", async (request, reply) => {
    const body = request.body as { query: string; answer?: string; note?: string; source?: string };
    if (!body.query?.trim()) return reply.code(400).send({ error: "query 必填", code: "AGENT_BAD_REQUEST" });
    const rule = await preventionRulesService.recordAndAttribute({
      query: body.query, answer: body.answer, note: body.note, source: (body.source === "eval_failure" ? "eval_failure" : "user_down") as any,
    });
    return { rule };
  });
  app.post("/api/prevention-rules/:id/toggle", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { enabled: boolean };
    await preventionRulesService.toggleRule(Number(params.id), !!body.enabled);
    return { ok: true };
  });

  // ───── V391(P2-1/2): 主管-工人编排 + 消息协议 ─────
  // 复杂任务: POST /api/agent/orchestrate {goal, projectId?} → 主管拆包→并行工人→主管汇总（后台执行）
  // G8: 走 agentTaskQueue.enqueueTask(带优先级) — 与普通任务共享并发控制, 不再直接 dispatchWorkers
  app.post("/api/agent/orchestrate", async (request, reply) => {
    const body = request.body as { goal: string; projectId?: string };
    if (!body.goal?.trim()) return reply.code(400).send({ error: "goal 必填", code: "AGENT_BAD_REQUEST" });
    // 创建父任务记录（状态=orchestrating 用 running）
    const parent = await agentTaskService.createAgentTask({ goal: body.goal.trim(), projectId: body.projectId });
    // G8: JWT 用户按 plan 定优先级（enterprise=3, pro=2, free=1）
    const { agentTaskQueue } = await import("../services/agent-task-queue.js");
    const authHdrO = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtO = authHdrO ? authService.verifyToken(authHdrO) : null;
    let priority = 1;
    if (jwtO) {
      const uO = await pool.query("select plan from users where id = $1", [jwtO.uid]);
      if (uO.rows.length > 0) priority = agentTaskQueue.priorityForPlan(uO.rows[0].plan || "free");
    }
    // 后台编排执行（并行工人 → 主管汇总）— 入队, 与任务共享并发槽位
    agentTaskQueue.enqueueTask({
      taskId: parent.id,
      priority,
      run: () => agentOrchestrator.dispatchWorkers({
      parentTaskId: parent.id,
      goal: body.goal.trim(),
      workerRunner: async (worker) => {
        // 工人执行: 按角色调度到现有能力（retriever→推理检索, writer→写作, 通用→推理）
        // V394-6: 注入其他工人已产出（共享上下文, 避免重复检索）
        const query = worker.goal;
        const sharedHint = worker.sharedContext ? `\n\n【其他工人已产出(可复用, 勿重复检索)】\n${worker.sharedContext}` : "";
        if (worker.assignee === "writer") {
          const dsKey = process.env.DEEPSEEK_API_KEY || "";
          const llmRes = await fetch(
            dsKey ? (process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
              body: JSON.stringify({
                model: resolveModelAlias(getRoleModel("reason")),
                messages: [{ role: "user", content: `撰写研究段落。主题: ${query}\n用中文，300-500字，结构化。${sharedHint}` }],
                temperature: 0.3, max_tokens: 1000,
              }),
            }
          );
          const data: any = await llmRes.json();
          return data?.choices?.[0]?.message?.content || "（写作失败）";
        }
        // 默认: 推理/检索（走 SAG reason adaptive）— G24: sourceId 用父任务项目(未关联省略)
        const res = await fetch(SELF_BASE + "/api/reason/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: parent.projectId || undefined, query, mode: "adaptive" }),
        });
        const data: any = await res.json();
        return data?.trace?.hypothesis?.content || data?.error || "（无结果）";
      },
    }).then(async () => {
      // 编排完成 → 更新父任务为 completed + 汇总结果
      const summary = await pool.query(
        "select payload from agent_messages where task_id = $1 and msg_type = 'result' and from_agent = 'orchestrator' order by id desc limit 1",
        [parent.id]
      );
      const summaryText = summary.rows[0]?.payload?.summary || "（编排完成）";
      await pool.query("update agent_tasks set status='completed', result=$2, progress='主管汇总完成', updated_at=now() where id=$1",
        [parent.id, summaryText]);
    }).catch((e: any) => {
      void pool.query("update agent_tasks set status='failed', progress=$2, updated_at=now() where id=$1",
        [parent.id, `编排失败: ${String(e?.message || e).slice(0, 100)}`]);
    }),
    });
    return { ok: true, taskId: parent.id, queued: true, priority };
  });
  // 消息流 + 工人任务（前端可视化）— V3: 权限隔离(非admin只能看自己任务的)
  app.get("/api/agent/messages", async (request, reply) => {
    const q = request.query as { taskId?: string };
    // V3: 校验任务归属 — 非管理员访问他人任务 → 拒绝
    const authHdrV3 = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtV3 = authHdrV3 ? authService.verifyToken(authHdrV3) : null;
    if (q.taskId && jwtV3 && jwtV3.role !== "admin") {
      const owner = await pool.query("select user_id from agent_tasks where id = $1::uuid", [q.taskId]);
      if (owner.rows.length > 0 && owner.rows[0].user_id && owner.rows[0].user_id !== jwtV3.uid) {
        return reply.code(403).send({ error: "无权查看他人任务消息", code: "AGENT_FORBIDDEN" });
      }
    }
    return { messages: await agentOrchestrator.listAgentMessages(q.taskId) };
  });
  app.get("/api/agent/workers", async (request, reply) => {
    const q = request.query as { parentTaskId?: string };
    // V3: 校验父任务归属
    const authHdrV3w = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtV3w = authHdrV3w ? authService.verifyToken(authHdrV3w) : null;
    if (q.parentTaskId && jwtV3w && jwtV3w.role !== "admin") {
      const owner = await pool.query("select user_id from agent_tasks where id = $1::uuid", [q.parentTaskId]);
      if (owner.rows.length > 0 && owner.rows[0].user_id && owner.rows[0].user_id !== jwtV3w.uid) {
        return reply.code(403).send({ error: "无权查看他人任务工人", code: "AGENT_FORBIDDEN" });
      }
    }
    return { workers: await agentOrchestrator.listWorkerTasks(q.parentTaskId) };
  });
  // V396-10: 多 Agent 评审质量门（2 视角评审 + 对抗辩论）
  app.post("/api/agent/review", async (request, reply) => {
    const body = request.body as { goal?: string; workers?: Array<{ workerName: string; goal: string; result?: string }>; summary?: string };
    if (!body.goal?.trim()) return reply.code(400).send({ error: "goal 必填", code: "AGENT_BAD_REQUEST" });
    const { agentOrchestrator } = await import("../services/agent-orchestrator.js");
    const result = await agentOrchestrator.reviewWorkerOutputs(body.goal.trim(), body.workers || [], body.summary || "（无汇总）");
    return { result };
  });

  // ───── V391(P2-4): 统一 Agent 执行日志 + (P2-5) 成本看板 ─────
  app.get("/api/agent/logs", async (request) => {
    const q = request.query as { taskId?: string; limit?: string };
    return { logs: await agentExecLogService.listAgentExecLogs(q.taskId, parseInt(q.limit || "100", 10)) };
  });
  // V396-3: 执行 span 树（DAG 可视化数据: 节点+父子+类型）
  app.get("/api/agent/logs/span-tree", async (request) => {
    const q = request.query as { taskId?: string };
    if (!q.taskId) return { spans: [] };
    return { spans: await agentExecLogService.buildExecSpanTree(q.taskId) };
  });
  app.get("/api/agent/logs/cost-summary", async (request) => {
    const q = request.query as { taskId?: string };
    return { summary: await agentExecLogService.agentCostSummary(q.taskId) };
  });
  // V393-6: Agent 审计溯源报表（用户×任务×成本×工具聚合）
  app.get("/api/agent/logs/audit-report", async (request) => {
    const q = request.query as { days?: string };
    return { report: await agentExecLogService.agentAuditReport(parseInt(q.days || "7", 10)) };
  });
  // V393-7: Agent 任务级评测报告（完成率/步骤成功率/多轮收敛率）
  app.get("/api/agent/eval-report", async (request) => {
    const q = request.query as { days?: string };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    return { report: await agentEvalService.generateAgentEvalReport(parseInt(q.days || "7", 10)) };
  });
  // V394-9: Agent 学习曲线（按天环比趋势）
  app.get("/api/agent/learning-curve", async (request) => {
    const q = request.query as { days?: string };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    return { curve: await agentEvalService.generateLearningCurve(parseInt(q.days || "14", 10)) };
  });

  // ═══ V396-2: Agent 回归评测集（gold 任务 + 故障注入 + 门禁历史）═══
  app.get("/api/agent/eval-suite", async (request) => {
    const q = request.query as { category?: string };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    return { suite: await agentEvalService.listEvalSuite(q.category) };
  });
  app.post("/api/agent/eval-suite", async (request) => {
    const body = request.body as any;
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    try {
      return { item: await agentEvalService.upsertEvalSuite(body) };
    } catch (e: any) {
      return { error: String(e?.message || e).slice(0, 150) , code: "AGENT_INTERNAL_ERROR"};
    }
  });
  app.delete("/api/agent/eval-suite/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    await agentEvalService.deleteEvalSuite(Number(params.id));
    return { ok: true };
  });
  app.post("/api/agent/eval-suite/run", async (request, reply) => {
    const body = request.body as { category?: string; fault?: string; limit?: number };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    // 故障注入参数校验
    const fault = ["none", "rate_limit", "timeout", "degraded"].includes(body.fault || "none") ? body.fault : "none";
    try {
      const result = await agentEvalService.runEvalSuite({ category: body.category, fault: fault as any, limit: body.limit });
      return { result };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.get("/api/agent/eval-suite/history", async (request) => {
    const q = request.query as { limit?: string };
    const { agentEvalService } = await import("../services/agent-eval-service.js");
    return { history: await agentEvalService.evalSuiteHistory(parseInt(q.limit || "20", 10)) };
  });

  // V388: 删除自主任务（完成后清理）
  app.delete("/api/agent/tasks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    // S1: 越权校验 — 非管理员删除他人任务 → 拒绝
    if (!(await assertTaskOwnership(request, reply, params.id))) return;
    const ok = await agentTaskService.deleteAgentTask(params.id);
    if (!ok) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true };
  });

  app.get("/api/agent/tasks", async (request) => {
    const query = request.query as { projectId?: string; parentTaskId?: string; offset?: string; limit?: string };
    // V394-5: 支持按父任务查任务链
    // W6: 用户隔离 — 有 JWT 时只看自己的任务（管理员看全部）
    // G12: 分页 — offset/limit 参数（默认 offset=0 limit=20, 上限 100）
    const authHdrW6L = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtW6L = authHdrW6L ? authService.verifyToken(authHdrW6L) : null;
    const userId = jwtW6L?.role === "admin" ? undefined : jwtW6L?.uid;
    const offset = Math.max(0, parseInt(query.offset || "0", 10) || 0);
    const limit = Math.min(Math.max(parseInt(query.limit || "20", 10) || 20, 1), 100);
    const tasks = await agentTaskService.listAgentTasks(query.projectId, query.parentTaskId, userId, offset, limit);
    return { tasks, page: { offset, limit, hasMore: tasks.length >= limit } };
  });

  // V395-8: 任务结果导出 Markdown — 目标/状态/计划/步骤详情/执行日志/成本对比
  // GET /api/agent/tasks/:id/export → text/markdown 下载
  app.get("/api/agent/tasks/:id/export", async (request, reply) => {
    const params = request.params as { id: string };
    const task = await agentTaskService.getAgentTask(params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    // 执行日志（导出最近 50 条）
    const { agentExecLogService } = await import("../services/agent-exec-log.js");
    const { renderTaskMarkdown } = await import("../services/agent-task-export.js");
    const logs = await agentExecLogService.listAgentExecLogs(params.id, 50);
    const md = renderTaskMarkdown(task, logs);
    const safeName = (task.goal || "task").replace(/[^\w一-龥-]/g, "_").slice(0, 40);
    // RFC 5987: filename* 用于非 ASCII 文件名（Fastify 拒绝原始中文头值）
    reply.raw.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="agent-task-${params.id.slice(0, 8)}.md"; filename*=UTF-8''${encodeURIComponent(`agent-task-${params.id.slice(0, 8)}-${safeName}.md`)}`,
    });
    reply.raw.end(md);
  });

  // V394-4: 任务调度队列状态（前端展示）
  app.get("/api/agent/queue", async () => {
    const { agentTaskQueue } = await import("../services/agent-task-queue.js");
    return { queue: agentTaskQueue.queueStatus() };
  });

  // ───── V395-10: PDF2Obsidian 任务 API（持久化 + 异步管线 + 产物读取） ─────
  // 任务列表
  app.get("/api/p2o/tasks", async () => {
    const { p2oService } = await import("../services/p2o-service.js");
    return { tasks: await p2oService.listP2oTasks() };
  });
  // 单任务详情（前端轮询进度）
  app.get("/api/p2o/tasks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oService } = await import("../services/p2o-service.js");
    const task = await p2oService.getP2oTask(params.id);
    if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    return { task };
  });
  // 创建任务（上传 base64 / URL / pdfPath 三路; 创建后后台异步跑管线）
  app.post("/api/p2o/tasks", async (request, reply) => {
    const { p2oService } = await import("../services/p2o-service.js");
    const body = request.body as { url?: string; fileName?: string; fileBase64?: string; pdfPath?: string };
    // V395-11: 外部令牌创建 P2O 任务 → 记账（配额预检已在 hook 完成）
    const p2oCtx = (request as any).tokenCtx as { tokenId: string } | undefined;
    try {
      // 服务端已有文件路径（Agent 工具/CLI 调用）
      if (body.pdfPath) {
        const task = await p2oService.createP2oTask({
          fileName: path.basename(body.pdfPath), pdfPath: body.pdfPath, source: "path",
        });
        if (p2oCtx) quotaService.recordUsage(p2oCtx.tokenId, "p2o", {});
        return reply.code(201).send({ task });
      }
      // URL 下载导入（arXiv/DOI/PDF 直链 → 下载 → 管线）
      if (body.url) {
        const { pdfPath, fileName } = await p2oService.downloadPdfFromUrl(body.url);
        const task = await p2oService.createP2oTask({ fileName, pdfPath, source: "url" });
        if (p2oCtx) quotaService.recordUsage(p2oCtx.tokenId, "p2o", {});
        return reply.code(201).send({ task });
      }
      // base64 文件上传
      if (body.fileBase64) {
        const fileName = body.fileName || "upload.pdf";
        if (!fileName.toLowerCase().endsWith(".pdf")) return reply.code(400).send({ error: "仅支持 PDF 文件", code: "AGENT_BAD_REQUEST" });
        const buffer = Buffer.from(body.fileBase64, "base64");
        if (buffer.length > 5 * 1024 * 1024) return reply.code(400).send({ error: "文件超过 5MB 限制", code: "AGENT_FILE_TOO_LARGE" });
        const pdfPath = await p2oService.saveUploadedPdf(buffer, fileName);
        const task = await p2oService.createP2oTask({ fileName, pdfPath, source: "upload" });
        if (p2oCtx) quotaService.recordUsage(p2oCtx.tokenId, "p2o", {});
        return reply.code(201).send({ task });
      }
      return reply.code(400).send({ error: "请提供 pdfPath / url / fileBase64", code: "AGENT_BAD_REQUEST" });
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  // 删除任务（仅删记录 + 本地 PDF, 不动 vault 产物）
  app.delete("/api/p2o/tasks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oService } = await import("../services/p2o-service.js");
    const ok = await p2oService.deleteP2oTask(params.id);
    if (!ok) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
    return { ok: true };
  });
  // 重试失败任务
  app.post("/api/p2o/tasks/:id/retry", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oService } = await import("../services/p2o-service.js");
    try {
      const task = await p2oService.retryP2oTask(params.id);
      if (!task) return reply.code(404).send({ error: "任务不存在", code: "AGENT_NOT_FOUND" });
      return { task };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 100) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  // PDF 原文件流（左侧预览 iframe）
  app.get("/api/p2o/tasks/:id/pdf", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oService } = await import("../services/p2o-service.js");
    const pdf = await p2oService.readPdfBytes(params.id);
    if (!pdf) return reply.code(404).send({ error: "PDF 文件不存在（可能已删除）", code: "AGENT_NOT_FOUND" });
    reply.raw.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
      "Cache-Control": "no-cache",
    });
    reply.raw.end(pdf.data);
  });
  // 产物读取（原文/译文/论文信息/Bases/摘要/术语表/问答 — 从 vault 读回）
  app.get("/api/p2o/tasks/:id/artifact", async (request, reply) => {
    const params = request.params as { id: string };
    const q = request.query as { kind?: string };
    const kind = q.kind || "original";
    const { p2oService } = await import("../services/p2o-service.js");
    const result = await p2oService.readP2oArtifact(params.id, kind);
    if ("error" in result) return reply.code(404).send({ error: result.error });
    return { kind, content: result.content, path: result.path };
  });
  // 配置读取
  app.get("/api/p2o/config", async () => {
    const { p2oService } = await import("../services/p2o-service.js");
    return await p2oService.getP2oConfig();
  });
  // 历史导入记录（兼容旧前端, 保留内存实现）
  const p2oHistory: Array<{ slug: string; paths: Record<string, string>; importedAt: string }> = [];
  app.post("/api/p2o/history", async (request) => {
    const body = request.body as { slug: string; paths: Record<string, string> };
    p2oHistory.unshift({ slug: body.slug, paths: body.paths || {}, importedAt: new Date().toISOString() });
    if (p2oHistory.length > 20) p2oHistory.pop();
    return { ok: true };
  });
  app.get("/api/p2o/history", async () => ({ history: p2oHistory }));

  // ───── V395-13: P2O 批量导入（移植自研 skill pipeline.py 完整能力） ─────
  // 创建批量: POST /api/p2o/batch {inputDir, maxDailyPages?, concurrency?}
  // 状态: GET /api/p2o/batch/:id | 列表: GET /api/p2o/batch | 取消: DELETE /api/p2o/batch/:id
  // 目录扫描(预览): GET /api/p2o/batch/scan?dir= — 返回目录下 PDF 清单
  app.post("/api/p2o/batch", async (request, reply) => {
    const body = request.body as { inputDir?: string; outputDir?: string; maxDailyPages?: number; concurrency?: number; maxFiles?: number; retryFailed?: boolean };
    try {
      const { p2oBatchService } = await import("../services/p2o-batch-service.js");
      const job = await p2oBatchService.createBatchJob({
        inputDir: body.inputDir || "", outputDir: body.outputDir,
        maxDailyPages: body.maxDailyPages, concurrency: body.concurrency,
        maxFiles: body.maxFiles, retryFailed: body.retryFailed,  // V395-14: 参数透传
      });
      return { job: serializeBatchJob(job) };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.get("/api/p2o/batch", async () => {
    const { p2oBatchService } = await import("../services/p2o-batch-service.js");
    return { jobs: p2oBatchService.listBatchJobs().map(serializeBatchJob) };
  });
  app.get("/api/p2o/batch/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oBatchService } = await import("../services/p2o-batch-service.js");
    const job = p2oBatchService.getBatchJob(params.id);
    if (!job) return reply.code(404).send({ error: "批量任务不存在", code: "AGENT_NOT_FOUND" });
    return { job: serializeBatchJob(job) };
  });
  app.delete("/api/p2o/batch/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { p2oBatchService } = await import("../services/p2o-batch-service.js");
    const ok = p2oBatchService.cancelBatchJob(params.id);
    if (!ok) return reply.code(404).send({ error: "批量任务不存在或已结束", code: "AGENT_NOT_FOUND" });
    return { ok: true };
  });
  app.get("/api/p2o/batch/scan", async (request, reply) => {
    const q = request.query as { dir?: string };
    if (!q.dir) return reply.code(400).send({ error: "dir 必填" });
    try {
      const { p2oBatchService } = await import("../services/p2o-batch-service.js");
      const papers = await p2oBatchService.scanPdfDir(q.dir);
      return { papers: papers.map((p) => ({ fileName: p.fileName, sizeBytes: p.sizeBytes })), count: papers.length };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });

  // V394-8: 任务模板列表 + 模板创建
  app.get("/api/agent/templates", async () => ({ templates: agentTaskService.TASK_TEMPLATES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, stepCount: t.steps.length })) }));
  app.post("/api/agent/tasks/from-template", async (request, reply) => {
    const body = request.body as { templateId: string; goal: string; projectId?: string };
    if (!body.templateId || !body.goal?.trim()) return reply.code(400).send({ error: "templateId 和 goal 必填", code: "AGENT_BAD_REQUEST" });
    const task = await agentTaskService.createAgentTaskFromTemplate({ templateId: body.templateId, goal: body.goal.trim(), projectId: body.projectId });
    if (!task) return reply.code(400).send({ error: "模板不存在" });
    return { task };
  });

  // V394-7: Agent 对话式指挥 — 自然语言创建/控制任务
  // V395-3: sessionId 会话上下文 — "帮我研究X"→"重点看Y" 连续（历史注入规划 prompt）
  // POST /api/agent/chat {message, sessionId?} → 解析意图 → 创建/运行/查询任务
  app.post("/api/agent/chat", async (request, reply) => {
    const body = request.body as { message: string; sessionId?: string };
    if (!body.message?.trim()) return reply.code(400).send({ error: "message 必填" });
    const msg = body.message.trim();
    // V395-3: 会话记忆（无 sessionId → 生成一次性会话, 单轮不持久）
    const { agentChatMemory } = await import("../services/agent-chat-memory.js");
    const sessionId = body.sessionId || `anon-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      // V395-3: 续作基准目标 = 本条消息之前的最后一条用户消息（append 前取, 避免把自己当上下文）
      const prevLastGoal = await agentChatMemory.getAgentChatLastGoal(sessionId);
      // 差距I③(Codex mention_syntax): @前缀快捷指令 — @语料库/@评测/@工具 快速调取
      if (/^@(语料库|corpus)/.test(msg)) {
        const q = msg.replace(/^@(语料库|corpus)\s*/, "").trim();
        const { writingCorpusService } = await import("../services/writing-corpus-service.js");
        const rec = await writingCorpusService.recallCorpusForWriting({ q: q || undefined, semanticGroups: ["因果", "研究缺口", "对比", "总结发现"] });
        const lines: string[] = [`【语料库】${q || "全部"} — 句式${rec.expressions.length} 逻辑${rec.logics.length} 概念${rec.concepts.length} 范例${rec.texts.length}`];
        rec.expressions.slice(0, 3).forEach((e) => lines.push(`- [句式·${e.semanticGroup}] ${e.expression}`));
        rec.logics.slice(0, 2).forEach((l) => lines.push(`- [逻辑·${l.patternType}] ${l.name}: ${(l.structure || []).map((s) => s.desc).join(" → ")}`));
        agentChatMemory.appendAgentChat(sessionId, "assistant", lines.join("\n"));
        return { ok: true, intent: "mention:corpus", sessionId, note: lines.join("\n") };
      }
      if (/^@(评测|eval)/.test(msg)) {
        const { agentEvalService } = await import("../services/agent-eval-service.js");
        const report = await agentEvalService.generateAgentEvalReport(7);
        const line = `【评测】完成率 ${Math.round((report.completionRate ?? 0) * 100)}% · 步骤成功率 ${Math.round((report.stepSuccessRate ?? 0) * 100)}% · ${report.totalTasks ?? 0} 任务`;
        agentChatMemory.appendAgentChat(sessionId, "assistant", line);
        return { ok: true, intent: "mention:eval", sessionId, note: line };
      }
      // V395-3: 意图解析前记录用户消息（连续对话语义依据）
      agentChatMemory.appendAgentChat(sessionId, "user", msg);
      // 意图解析: 模板关键词 → 模板创建; 否则 LLM 规划创建
      const tplMatch = msg.match(/(?:综述|review)/i) ? "lit_review"
        : msg.match(/(?:实证|回归|分析数据)/i) ? "empirical"
        : msg.match(/(?:政策|法规|条例)/i) ? "policy"
        : msg.match(/(?:概念|溯源|定义)/i) ? "concept"
        : null;
      // V395-3: 会话上下文 — 最近 8 轮历史注入规划 prompt（多轮连续）
      const history = await agentChatMemory.getAgentChatHistory(sessionId, 8);
      const contextHint = history
        .filter((h) => h.content.trim())
        .map((h) => `${h.role === "user" ? "用户" : "Agent"}: ${h.content.slice(0, 150)}${h.taskId ? ` (任务 ${h.taskId.slice(0, 8)})` : ""}`)
        .join("\n");
      const createMatch = msg.match(/(?:帮我|请|研究|写|分析|总结|调查|梳理)(.*)/);
      // V395-3: 连续指令 — "继续/重点看Y" 类短语沿用上一轮目标（无需完整复述主题）
      // 优先于 create 判断: "继续/接着/重点看" 开头的续作指令即使含 分析/研究 等动词也走续作
      const lastGoal = prevLastGoal;
      if (lastGoal && /^(?:继续|接着|然后|重点看|补充|展开|再)/.test(msg.trim())) {
        const task = await agentTaskService.createAgentTask({ goal: `${lastGoal}（续: ${msg}）`, contextHint });
        if (!task) return reply.code(400).send({ error: "任务创建失败" });
        void agentTaskService.runAgentTask(task.id, async (step) => {
          const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
          // V1: 用任务项目 sourceId（对话续作任务无项目时回退默认）
          const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
          const chosen = await chooseToolByLlm(task.goal, step.title, tools);
          if (chosen) {
            const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools);
            if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
          }
          const res = await fetch(SELF_BASE + "/api/reason/query", {
            method: "POST", headers: { "Content-Type": "application/json" },
            // G24: sourceId 动态化 — 用任务项目(未关联时省略走服务端默认)
            body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive" }),
          });
          const data: any = await res.json();
          const content = data?.trace?.hypothesis?.content || data?.error || "（无结果）";
          return { result: content.substring(0, 120), detail: content, source: "SAG 推理" };
        }).catch((e: any) => console.error("[agent-chat] run FAIL:", e?.message?.slice(0, 100)));
        agentChatMemory.appendAgentChat(sessionId, "assistant", `已创建续作任务: ${lastGoal}（续: ${msg}）`, task.id);
        return { ok: true, taskId: task.id, intent: "continue", goal: task.goal, sessionId, note: "已沿用上次目标创建续作任务并开始执行" };
      }
      if (createMatch && msg.length > 4) {
        const goal = createMatch[1].trim();
        if (goal.length >= 4) {
          // 模板命中 → 模板创建（免 LLM 规划）
          const task = tplMatch
            ? await agentTaskService.createAgentTaskFromTemplate({ templateId: tplMatch, goal })
            : await agentTaskService.createAgentTask({ goal, contextHint });
          if (!task) return reply.code(400).send({ error: "任务创建失败" });
          void agentTaskService.runAgentTask(task.id, async (step) => {
            const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
            // V1: 用任务项目 sourceId
            const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
            const chosen = await chooseToolByLlm(task.goal, step.title, tools);
            if (chosen) {
              const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools);
              if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
            }
            const res = await fetch(SELF_BASE + "/api/reason/query", {
              method: "POST", headers: { "Content-Type": "application/json" },
              // G24: sourceId 动态化 — 用任务项目(未关联时省略走服务端默认)
              body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive" }),
            });
            const data: any = await res.json();
            const content = data?.trace?.hypothesis?.content || data?.error || "（无结果）";
            return { result: content.substring(0, 120), detail: content, source: "SAG 推理" };
          }).catch((e: any) => console.error("[agent-chat] run FAIL:", e?.message?.slice(0, 100)));
          agentChatMemory.appendAgentChat(sessionId, "assistant", `已创建任务「${goal}」并开始执行`, task.id);
          return { ok: true, taskId: task.id, intent: tplMatch ? "template:" + tplMatch : "create", goal, sessionId, note: "已创建任务并开始执行（查看: 任务面板）" };
        }
      }
      // V395-3: 会话记忆回看/清空命令
      if (/^(?:会话|记忆|历史)/.test(msg) && /(?:查看|历史|记录)/.test(msg)) {
        const history2 = await agentChatMemory.getAgentChatHistory(sessionId, 8);
        return { ok: true, intent: "history", sessionId, history: history2.map((h) => ({ role: h.role, content: h.content.slice(0, 200) })), note: `会话共 ${history2.length} 轮` };
      }
      if (/^(?:清空|清除)\s*(?:会话|记忆|上下文)/.test(msg)) {
        await agentChatMemory.clearAgentChat(sessionId);
        return { ok: true, intent: "clear", sessionId, note: "会话记忆已清空" };
      }
      return { ok: false, error: "无法理解指令。试试: 帮我研究资本下乡对农村集体经济的影响" };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 100) , code: "AGENT_INTERNAL_ERROR"});
    }
  });

  // ───── V395-20: 政经 C 刊科研（选题方法论整合: 四步法/理论接口/矩阵/悖论/编辑校验） ─────
  app.get("/api/cjournal/interfaces", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { interfaces: cjournalService.THEORY_INTERFACE_MAP };
  });
  app.get("/api/cjournal/seeds", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { seeds: cjournalService.SEED_TOPICS };
  });
  app.get("/api/cjournal/journals", async (request) => {
    // V395-38: 期刊画像改为动态库加载（80 本真实目录: 南核/北核/C扩）+ 内置示例兼容
    const { cjournalService } = await import("../services/cjournal-service.js");
    const q = request.query as { level?: string };
    try {
      const { pool } = await import("../db/pool.js");
      const levelFilter = q.level ? "where level = $1" : "";
      const params = q.level ? [q.level] : [];
      const r = await pool.query(
        `select id, name, level, org, topic_tags, style, official_site, updated_at, last_sync_status
         from cjournal_journals ${levelFilter} order by level desc, name asc`,
        params
      );
      return {
        journals: r.rows.map((j: any) => ({ id: j.id, name: j.name, level: j.level, org: j.org, topicTags: j.topic_tags, style: j.style, officialSite: j.official_site, updatedAt: j.updated_at, lastSyncStatus: j.last_sync_status })),
        total: r.rows.length,
        legacy: cjournalService.JOURNAL_PROFILES,  // 兼容旧引用
      };
    } catch {
      // 库不可用降级到内置
      return { journals: cjournalService.JOURNAL_PROFILES.map((j) => ({ name: j.name, style: j.style })), total: 0, legacy: cjournalService.JOURNAL_PROFILES };
    }
  });
  // V395-38: 期刊更新列表（最新热点/选题方向/目录, 自动同步管道写入）
  app.get("/api/cjournal/journal-updates", async (request) => {
    const q = request.query as { journalId?: string; limit?: string };
    const { journalSyncService } = await import("../services/journal-sync-service.js");
    return { updates: await journalSyncService.listJournalUpdates(q.journalId, Number(q.limit) || 50) };
  });
  // V395-38: 手动触发期刊同步
  app.post("/api/cjournal/journal-sync", async () => {
    const { journalSyncService } = await import("../services/journal-sync-service.js");
    return { result: await journalSyncService.forceSyncAllJournals() };
  });
  app.post("/api/cjournal/four-step", async (request, reply) => {
    const body = request.body as { hotTopic?: string; theory?: string; method?: string; practice?: string };
    if (!body.hotTopic?.trim()) return reply.code(400).send({ error: "hotTopic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateTopicFourStep({
      hotTopic: body.hotTopic.trim(), theory: body.theory,
      method: (body.method as any) || "default", practice: body.practice,
    }) };
  });
  // V395-21: 概念命名（现象→理论概念）
  app.post("/api/cjournal/naming", async (request, reply) => {
    const body = request.body as { phenomenon?: string };
    if (!body.phenomenon?.trim()) return reply.code(400).send({ error: "phenomenon 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateConceptNaming({ phenomenon: body.phenomenon.trim() }) };
  });
  // V395-21: 跨学科嫁接
  app.post("/api/cjournal/cross-disciplinary", async (request, reply) => {
    const body = request.body as { coreConcept?: string };
    if (!body.coreConcept?.trim()) return reply.code(400).send({ error: "coreConcept 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateCrossDisciplinary({ coreConcept: body.coreConcept.trim() }) };
  });
  // V395-21: 模板反例检测（纯规则, 无 LLM）
  app.post("/api/cjournal/template-check", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: cjournalService.checkTopicTemplate(body.topic.trim()) };
  });
  // V395-21: 对象特殊性检验
  app.post("/api/cjournal/specificity", async (request, reply) => {
    const body = request.body as { topic?: string; outline?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.checkObjectSpecificity({ topic: body.topic.trim(), outline: body.outline }) };
  });
  // V395-21: 外审意见翻译
  app.post("/api/cjournal/review-translate", async (request, reply) => {
    const body = request.body as { comment?: string };
    if (!body.comment?.trim()) return reply.code(400).send({ error: "comment 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.translateReviewComment({ comment: body.comment.trim() }) };
  });
  app.post("/api/cjournal/paradox", async (request, reply) => {
    const body = request.body as { phenomenon?: string };
    if (!body.phenomenon?.trim()) return reply.code(400).send({ error: "phenomenon 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateParadoxTopic({ phenomenon: body.phenomenon.trim() }) };
  });
  app.post("/api/cjournal/matrix", async (request, reply) => {
    const body = request.body as { coreConcept?: string };
    if (!body.coreConcept?.trim()) return reply.code(400).send({ error: "coreConcept 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateTopicMatrix({ coreConcept: body.coreConcept.trim() }) };
  });
  app.post("/api/cjournal/validate", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.validateByEditorStandards({ topic: body.topic.trim() }) };
  });

  // ═══ V395-31/32: 刘衍峰式选题方法系统（动态管理: 可添加/替换/删除）═══
  app.get("/api/cjournal/liuyanfeng-system", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.LIUYANFENG_SYSTEM, systems: await cjournalService.listMethodSystems() };
  });
  app.get("/api/cjournal/method-systems", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { systems: await cjournalService.listMethodSystems() };
  });
  app.post("/api/cjournal/method-systems", async (request, reply) => {
    const body = request.body as {
      id?: string; name?: string;
      features?: any[]; ideas?: any[]; productionChain?: any[]; warnings?: any[];
    };
    if (!body.id?.trim() || !body.name?.trim()) return reply.code(400).send({ error: "id/name 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    try {
      const s = await cjournalService.upsertMethodSystem({
        id: body.id.trim(), name: body.name.trim(),
        features: Array.isArray(body.features) ? body.features : [],
        ideas: Array.isArray(body.ideas) ? body.ideas : [],
        productionChain: Array.isArray(body.productionChain) ? body.productionChain : [],
        warnings: Array.isArray(body.warnings) ? body.warnings : [],
      });
      return { system: s };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.delete("/api/cjournal/method-systems/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { cjournalService } = await import("../services/cjournal-service.js");
    const r = await cjournalService.deleteMethodSystem(params.id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });
  // 特征① 关系型选题: 热点A × 热点B → 关系即论文
  app.post("/api/cjournal/relational", async (request, reply) => {
    const body = request.body as { hotA?: string; hotB?: string };
    if (!body.hotA?.trim()) return reply.code(400).send({ error: "hotA 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateRelationalTopic({ hotA: body.hotA.trim(), hotB: body.hotB?.trim() }) };
  });
  // 特征③ 研究主线设计: 母题 + 子问题链条
  app.post("/api/cjournal/research-line", async (request, reply) => {
    const body = request.body as { corePhenomenon?: string };
    if (!body.corePhenomenon?.trim()) return reply.code(400).send({ error: "corePhenomenon 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.designResearchLine({ corePhenomenon: body.corePhenomenon.trim() }) };
  });
  // 告诫③ 研究标签: 3-5 核心关键词反复组合
  app.post("/api/cjournal/research-labels", async (request, reply) => {
    const body = request.body as { researchFocus?: string };
    if (!body.researchFocus?.trim()) return reply.code(400).send({ error: "researchFocus 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateResearchLabels({ researchFocus: body.researchFocus.trim() }) };
  });
  // 告诫④ 题目尺度检验: 做窄做深
  app.post("/api/cjournal/scope-check", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: cjournalService.checkTopicScope(body.topic.trim()) };
  });
  // 告诫⑤ 系列延伸: 一篇成功不换题
  app.post("/api/cjournal/series-extend", async (request, reply) => {
    const body = request.body as { paperTitle?: string; published?: string };
    if (!body.paperTitle?.trim()) return reply.code(400).send({ error: "paperTitle 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.extendResearchSeries({ paperTitle: body.paperTitle.trim(), published: body.published?.trim() }) };
  });

  // ═══ V395-33: 马原理 C 刊选题六大趋势（六趋势+三规律+2026布局）═══
  app.get("/api/cjournal/marx-trends", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.MARX_TREND_SYSTEM };
  });
  app.post("/api/cjournal/trend-topic", async (request, reply) => {
    const body = request.body as { trendId?: string; hotTopic?: string };
    if (!body.trendId?.trim() || !body.hotTopic?.trim()) return reply.code(400).send({ error: "trendId/hotTopic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateTrendTopic({ trendId: body.trendId.trim(), hotTopic: body.hotTopic.trim() }) };
  });

  // ═══ V395-34: 经典马研究六大方向（转向诊断 + 方向深化）═══
  app.get("/api/cjournal/classic-marx", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.CLASSIC_MARX_SYSTEM };
  });
  app.post("/api/cjournal/classic-diagnose", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.diagnoseClassicTopic({ topic: body.topic.trim() }) };
  });
  app.post("/api/cjournal/classic-direction", async (request, reply) => {
    const body = request.body as { directionId?: string; phenomenon?: string };
    if (!body.directionId?.trim() || !body.phenomenon?.trim()) return reply.code(400).send({ error: "directionId/phenomenon 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateClassicDirection({ directionId: body.directionId.trim(), phenomenon: body.phenomenon.trim() }) };
  });

  // ═══ V395-35: C 刊编辑视角选题六法（六法总览 + ①②④生成）═══
  app.get("/api/cjournal/editor-system", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.EDITOR_SYSTEM };
  });
  app.post("/api/cjournal/editor-topic", async (request, reply) => {
    const body = request.body as { methodId?: string; topic?: string };
    if (!body.methodId?.trim() || !body.topic?.trim()) return reply.code(400).send({ error: "methodId/topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateEditorTopic({ methodId: body.methodId.trim(), topic: body.topic.trim() }) };
  });

  // ═══ V395-36: C 刊投稿五条军规（总览 + ①主线体检②国家战略④新视角）═══
  app.get("/api/cjournal/rules-system", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.RULES_SYSTEM };
  });
  app.post("/api/cjournal/mainline-check", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.checkMainline({ topic: body.topic.trim() }) };
  });
  app.post("/api/cjournal/national-strategy", async (request, reply) => {
    const body = request.body as { strategy?: string; phenomenon?: string };
    if (!body.strategy?.trim()) return reply.code(400).send({ error: "strategy 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateNationalStrategy({ strategy: body.strategy.trim(), phenomenon: body.phenomenon?.trim() }) };
  });
  app.post("/api/cjournal/new-angle", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateNewAngle({ topic: body.topic.trim() }) };
  });

  // ═══ V395-37: 小新学姐 12 条经验（总览 + 写前选刊 + 代表作诊断）═══
  app.get("/api/cjournal/xiaoxin-system", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { system: cjournalService.XIAOXIN_SYSTEM };
  });
  app.post("/api/cjournal/journal-selection", async (request, reply) => {
    const body = request.body as { topic?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.generateJournalSelection({ topic: body.topic.trim() }) };
  });
  app.post("/api/cjournal/representative", async (request, reply) => {
    const body = request.body as { papers?: string[] };
    if (!Array.isArray(body.papers)) return reply.code(400).send({ error: "papers 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.diagnoseRepresentative({ papers: body.papers.filter((p) => p?.trim()) }) };
  });
  // V395-37: 补已有函数的前端路由（对象特殊性检验/稿件梯队——V395-21 实现但未暴露 API）
  app.post("/api/cjournal/object-specificity", async (request, reply) => {
    const body = request.body as { topic?: string; outline?: string };
    if (!body.topic?.trim()) return reply.code(400).send({ error: "topic 必填" });
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: await cjournalService.checkObjectSpecificity({ topic: body.topic.trim(), outline: body.outline?.trim() }) };
  });
  app.post("/api/cjournal/manuscript-ladder", async (request, reply) => {
    const body = request.body as { items?: string };
    let items: Array<{ title: string; stage: string; tier: string }> = [];
    try { items = JSON.parse(body.items || "[]"); } catch { items = []; }
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { result: cjournalService.manuscriptLadder(items as any) };
  });

  // V395-24: 学者库管理（动态添加/编辑/删除学者方法）
  app.get("/api/cjournal/scholars", async () => {
    const { cjournalService } = await import("../services/cjournal-service.js");
    return { scholars: await cjournalService.listScholars() };
  });
  app.post("/api/cjournal/scholars", async (request, reply) => {
    const body = request.body as { id?: string; scholar?: string; concept?: string; method?: string; detail?: string };
    try {
      if (!body.id?.trim() || !body.scholar?.trim() || !body.concept?.trim() || !body.method?.trim()) {
        return reply.code(400).send({ error: "id/scholar/concept/method 必填" });
      }
      const { cjournalService } = await import("../services/cjournal-service.js");
      const scholar = await cjournalService.upsertScholar({
        id: body.id, scholar: body.scholar, concept: body.concept, method: body.method, detail: body.detail,
      });
      return { scholar };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.delete("/api/cjournal/scholars/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { cjournalService } = await import("../services/cjournal-service.js");
    const r = await cjournalService.deleteScholar(params.id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });

  // V395-25: 学者文献范式提取（知网→md→入库→范式提取→回填学者库）
  // 扫描目录预览: GET /api/cjournal/paradigm/scan?dir=&scholarId=
  // 提取并保存: POST /api/cjournal/paradigm {scholarId, docsDir}
  // 读取范式: GET /api/cjournal/paradigm/:scholarId
  app.get("/api/cjournal/paradigm/scan", async (request, reply) => {
    const q = request.query as { dir?: string };
    if (!q.dir) return reply.code(400).send({ error: "dir 必填" });
    try {
      const { scholarParadigmService } = await import("../services/scholar-paradigm-service.js");
      const docs = await scholarParadigmService.scanScholarDocs(q.dir);
      return { docs: docs.map((d) => ({ file: d.file, title: d.title })), count: docs.length };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.post("/api/cjournal/paradigm", async (request, reply) => {
    const body = request.body as { scholarId?: string; docsDir?: string; model?: string; source?: string; graph?: boolean };
    if (!body.scholarId?.trim()) return reply.code(400).send({ error: "scholarId 必填" });
    try {
      const { scholarParadigmService } = await import("../services/scholar-paradigm-service.js");
      const r = await scholarParadigmService.extractAndSaveParadigm({
        scholarId: body.scholarId.trim(), docsDir: body.docsDir, model: body.model,
        source: body.source === "pg" ? "pg" : body.source === "dir" ? "dir" : undefined,
        graph: body.graph !== false,  // V395-30: 图谱数据默认开启（服务不可用自动降级）
      });
      if (!r.ok) return reply.code(400).send({ error: r.error });
      return { ok: true, paradigm: r.paradigm, docCount: r.docCount, sourceInfo: r.sourceInfo, graphInfo: r.graphInfo };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  // V395-29: PG 结构化数据预览（实体/事件/章节 — 反映三库丰富数据类型）
  // V395-30: 附带图谱数据（Graphiti 超边/社区 + Cognee 实体关系）
  app.get("/api/cjournal/paradigm/pg-preview", async (request, reply) => {
    const q = request.query as { scholarName?: string };
    if (!q.scholarName?.trim()) return reply.code(400).send({ error: "scholarName 必填" });
    try {
      const { scholarParadigmService } = await import("../services/scholar-paradigm-service.js");
      const data = await scholarParadigmService.collectScholarStructuredData({ scholarName: q.scholarName.trim() });
      if (data.docIds.length === 0) return reply.code(404).send({ error: `PG 中未找到学者「${q.scholarName}」的文献` });
      return { docCount: data.docIds.length, structuredText: data.structuredText, graphText: data.graphText };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  app.get("/api/cjournal/paradigm/:scholarId", async (request, reply) => {
    const params = request.params as { scholarId: string };
    const { scholarParadigmService } = await import("../services/scholar-paradigm-service.js");
    const paradigm = await scholarParadigmService.getScholarParadigm(params.scholarId);
    if (!paradigm) return reply.code(404).send({ error: "该学者暂无范式数据（先在学者库添加后提取）" });
    return { paradigm };
  });

  // V395-3: 会话记忆查询/清空 API（前端调试/管理用）
  app.get("/api/agent/chat/history", async (request) => {
    const q = request.query as { sessionId?: string };
    if (!q.sessionId) return { history: [] };
    const { agentChatMemory } = await import("../services/agent-chat-memory.js");
    const history = await agentChatMemory.getAgentChatHistory(q.sessionId, 20);
    return { history: history.map((h) => ({ role: h.role, content: h.content, taskId: h.taskId, ts: h.ts })) };
  });
  app.delete("/api/agent/chat/history", async (request) => {
    const q = request.query as { sessionId?: string };
    if (!q.sessionId) return { ok: false };
    const { agentChatMemory } = await import("../services/agent-chat-memory.js");
    await agentChatMemory.clearAgentChat(q.sessionId);
    return { ok: true };
  });

  // ───── V395-4: 插件体系 API（agent_plugins 表: 注册/启用/禁用/删除/列表） ─────
  app.get("/api/agent/plugins", async () => {
    const { agentPluginService } = await import("../services/agent-plugin-service.js");
    return { plugins: await agentPluginService.listAgentPlugins() };
  });
  app.post("/api/agent/plugins", async (request, reply) => {
    const body = request.body as { id: string; name: string; description?: string; entry: string; tools?: Array<{ name: string; label: string; description: string; params?: Record<string, unknown>; risk?: string }> };
    try {
      const { agentPluginService } = await import("../services/agent-plugin-service.js");
      // 未显式传 tools → 扫描 entry 模块自动采集工具声明
      let tools = body.tools;
      if (!tools || tools.length === 0) {
        tools = await agentPluginService.scanPluginTools(body.entry);
      }
      const plugin = await agentPluginService.registerAgentPlugin({ id: body.id, name: body.name, description: body.description, entry: body.entry, tools });
      return { plugin };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) , code: "AGENT_INTERNAL_ERROR"});
    }
  });
  // 启用/禁用: PUT /api/agent/plugins/:id {enabled: true|false}
  app.put("/api/agent/plugins/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { enabled: boolean };
    const { agentPluginService } = await import("../services/agent-plugin-service.js");
    const plugin = await agentPluginService.setAgentPluginEnabled(params.id, !!body.enabled);
    if (!plugin) return reply.code(404).send({ error: "插件不存在" });
    return { plugin };
  });
  app.delete("/api/agent/plugins/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentPluginService } = await import("../services/agent-plugin-service.js");
    const ok = await agentPluginService.deleteAgentPlugin(params.id);
    if (!ok) return reply.code(404).send({ error: "插件不存在" });
    return { ok: true };
  });
  // V396-13: 插件审批过期检查（工具治理: 90 天重新验证）
  app.get("/api/agent/plugins/:id/approval", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentPluginService } = await import("../services/agent-plugin-service.js");
    return { result: await agentPluginService.checkPluginApprovalExpiry(params.id) };
  });

  // ───── V395-9: Agent 定时任务 API（agent_scheduled_tasks 表, cron 分钟级） ─────
  // ═══ V396-8: 情景记忆（研究轨迹 + 遗忘机制）═══
  app.get("/api/agent/episodic-memory", async (request) => {
    const q = request.query as { limit?: string; q?: string };
    const { agentEpisodicMemoryService } = await import("../services/agent-episodic-memory.js");
    if (q.q) return { memories: await agentEpisodicMemoryService.recallEpisodicMemory(q.q, Number(q.limit) || 5) };
    return { memories: await agentEpisodicMemoryService.listEpisodicMemories(Number(q.limit) || 50) };
  });
  app.post("/api/agent/episodic-memory/forget", async () => {
    const { agentEpisodicMemoryService } = await import("../services/agent-episodic-memory.js");
    return { result: await agentEpisodicMemoryService.forgetMemories() };
  });
  app.post("/api/agent/episodic-memory/consolidate", async (request) => {
    const body = request.body as { goal?: string };
    const { agentEpisodicMemoryService } = await import("../services/agent-episodic-memory.js");
    return { merged: await agentEpisodicMemoryService.consolidateMemories(body.goal || "") };
  });

  // ═══ V396-9: 技能蒸馏（EDV 防自我确认）═══
  app.get("/api/agent/skills", async (request) => {
    const q = request.query as { status?: string };
    const { agentSkillDistillService } = await import("../services/agent-skill-distill.js");
    return { skills: await agentSkillDistillService.listSkills(q.status) };
  });
  app.post("/api/agent/skills/distill", async (request) => {
    const body = request.body as { taskId?: string; goal?: string; result?: string; toolsUsed?: string[] };
    const { agentSkillDistillService } = await import("../services/agent-skill-distill.js");
    return { result: await agentSkillDistillService.distillSkillFromTask(body.taskId || "manual", body.goal || "", body.result || "", body.toolsUsed || []) };
  });
  app.post("/api/agent/skills/:id/validate", async (request) => {
    const params = request.params as { id: string };
    const { agentSkillDistillService } = await import("../services/agent-skill-distill.js");
    return { result: await agentSkillDistillService.validateSkill(Number(params.id)) };
  });
  app.get("/api/agent/skills/recall", async (request) => {
    const q = request.query as { q?: string };
    const { agentSkillDistillService } = await import("../services/agent-skill-distill.js");
    return { skills: await agentSkillDistillService.recallSkills(q.q || "") };
  });
  // V396-16: 删除技能（可选 removeSkillify=true 连带删除已固化的 SKILL.md）
  app.delete("/api/agent/skills/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const q = request.query as { removeSkillify?: string };
    const { agentSkillDistillService } = await import("../services/agent-skill-distill.js");
    const r = await agentSkillDistillService.deleteSkill(Number(params.id), q.removeSkillify === "true");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, removedSkillify: r.removedSkillify };
  });
  // W4: 消息表 TTL 清理（agent_messages/worker_tasks 防无限增长）
  app.post("/api/agent/cleanup-tables", async (request) => {
    const body = request.body as { days?: number };
    const { agentOrchestrator } = await import("../services/agent-orchestrator.js");
    return { result: await agentOrchestrator.cleanupAgentTables(body.days || 30) };
  });

  // 创建: POST /api/agent/scheduled {goal, cron}; 列表: GET /api/agent/scheduled
  // 启停: PUT /api/agent/scheduled/:id {enabled}; 删除: DELETE /api/agent/scheduled/:id
  app.post("/api/agent/scheduled", async (request, reply) => {
    const body = request.body as { goal?: string; cron?: string };
    try {
      const { agentScheduler } = await import("../services/agent-scheduler.js");
      const sched = await agentScheduler.createScheduledAgentTask({ goal: body.goal || "", cron: body.cron || "" });
      return { scheduled: sched };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e).slice(0, 200) });
    }
  });
  app.get("/api/agent/scheduled", async () => {
    const { agentScheduler } = await import("../services/agent-scheduler.js");
    return { scheduled: await agentScheduler.listScheduledAgentTasks() };
  });
  app.put("/api/agent/scheduled/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { enabled: boolean };
    const { agentScheduler } = await import("../services/agent-scheduler.js");
    const sched = await agentScheduler.setScheduledAgentTaskEnabled(params.id, !!body.enabled);
    if (!sched) return reply.code(404).send({ error: "定时任务不存在" });
    return { scheduled: sched };
  });
  app.delete("/api/agent/scheduled/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const { agentScheduler } = await import("../services/agent-scheduler.js");
    const ok = await agentScheduler.deleteScheduledAgentTask(params.id);
    if (!ok) return reply.code(404).send({ error: "定时任务不存在" });
    return { ok: true };
  });

  app.get("/api/skills", async () => ({
    skills: skillsService.listSkills()
  }));

  // V327: 技能审计摘要（P1-2 前端展示）— 读 skill-audit-report.md 解析统计
  // V332: 技能审计（P1-2 实时同步）— 实时扫描技能目录（60秒缓存）, 不读快照文件
  app.get("/api/skills/audit", async () => {
    try {
      const r = await skillsService.auditSkillsLive();
      return { exists: true, total: r.total, complete: r.complete, gaps: r.gaps };
    } catch (e: any) {
      return { exists: false, error: String(e).substring(0, 100) };
    }
  });

  // V331(P1-3): 技能语义搜索（找技能）— query → searchSkill 返回候选
  app.get("/api/skills/search", async (request) => {
    const params = request.query as { q?: string; top?: string };
    const q = (params.q || "").trim();
    if (!q) return { found: false, candidates: [] };
    try {
      const result = await skillsService.searchSkill(q, Math.min(parseInt(params.top ?? "5", 10) || 5, 10));
      return result;
    } catch (e: any) {
      return { found: false, candidates: [], error: String(e).substring(0, 100) };
    }
  });

  // 技能详情：SKILL.md 全文 + 中文说明 + 触发词
  app.get("/api/skills/:name/detail", async (request, reply) => {
    const params = request.params as { name: string };
    const detail = skillsService.getSkillDetail(params.name);
    if (!detail) {
      return reply.code(404).send(notFound("SKILL_NOT_FOUND", "技能不存在"));
    }
    return detail;
  });

  app.post("/api/skills/:name/healthcheck", async (request) => {
    const params = request.params as { name: string };
    return skillsService.runSkillHealthcheck(params.name);
  });

  // Skillify: 把工作流固化为 skill（GBrain 机制B）
  const skillifySchema = z.object({
    name: z.string().min(1).max(64),
    title: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
    triggers: z.array(z.string()).optional(),
    notTriggers: z.array(z.string()).optional(),
    steps: z.array(z.string().min(1)).min(1),
    checklist: z.array(z.string()).optional(),
    recipes: z.array(z.string()).optional()
  });

  app.post("/api/skills/skillify", async (request, reply) => {
    const input = skillifySchema.parse(request.body);
    const result = await skillsService.skillify(input);
    if (!result.ok) {
      return reply.code(400).send(notFound("SKILLIFY_FAILED", result.error ?? "Skillify 失败"));
    }
    return reply.code(201).send(result);
  });

  // Skillify 自动检测固化（GBrain 机制6）
  const skillifyRecordSchema = z.object({
    query: z.string().min(1),
    success: z.boolean(),
    evidenceTitles: z.array(z.string()).optional()
  });

  app.post("/api/skills/skillify/record", async (request) => {
    const input = skillifyRecordSchema.parse(request.body);
    skillifyTracker.recordPattern(input.query, input.success, input.evidenceTitles ?? []);
    return { ok: true };
  });

  app.get("/api/skills/skillify/candidates", async (request) => {
    const query = request.query as { threshold?: string };
    const threshold = query.threshold ? Number(query.threshold) : 3;
    return { candidates: skillifyTracker.detectSkillifyCandidates(threshold) };
  });

  app.post("/api/skills/skillify/candidates/:topic/generate", async (request, reply) => {
    const params = request.params as { topic: string };
    const candidates = skillifyTracker.detectSkillifyCandidates(1);
    const candidate = candidates.find((c) => c.topic === params.topic);
    if (!candidate) {
      return reply.code(404).send(notFound("CANDIDATE_NOT_FOUND", "未找到该候选"));
    }
    const name = `skillify-${candidate.topic.replace(/·/g, "-").slice(0, 30).toLowerCase()}`;
    const result = await skillsService.skillify({
      name,
      title: `${candidate.topic} 工作流`,
      description: `Skillify 自动检测：${candidate.topic} 已成功执行 ${candidate.count} 次，固化为可复用技能`,
      triggers: [candidate.topic.slice(0, 10)],
      steps: [`执行 ${candidate.topic} 检索`, "收集证据并核验", "生成带引用的结论"],
      checklist: ["每个论断有出处", "引用真实"]
    });
    if (!result.ok) {
      return reply.code(400).send(notFound("SKILLIFY_FAILED", result.error ?? "生成失败"));
    }
    return reply.code(201).send({ ...result, candidate });
  });

  // ───── 技能自动更新检测 ─────
  const skillUpdateSchema = z.object({ name: z.string().min(1) });

  app.get("/api/skills/update-scan", async () => skillsUpdateService.scanLocalChanges());

  app.post("/api/skills/update-scan/upstream", async (request) => {
    const body = (request.body ?? {}) as { skillName?: string };
    return skillsUpdateService.checkUpstream(body.skillName);
  });

  app.post("/api/skills/update/confirm", async (request, reply) => {
    const input = skillUpdateSchema.parse(request.body);
    const result = skillsUpdateService.confirmNewSkill(input.name);
    if (!result.ok) {
      return reply.code(400).send(notFound("SKILL_NOT_FOUND", result.error ?? "技能不存在"));
    }
    return reply.code(201).send(result);
  });

  app.post("/api/skills/update/dismiss", async (request) => {
    const input = skillUpdateSchema.parse(request.body);
    return skillsUpdateService.dismissModification(input.name);
  });

  // ───── Vault 政策资料库 API ─────
  app.get("/api/vault/tree", async () => vaultService.getTree());

  // V383: Obsidian 学习联动 — 按关键词搜索资料
  app.get("/api/vault/search", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    if (!query.q) return { results: [] };
    return { results: vaultService.searchVault(query.q, Number(query.limit) || 8) };
  });

  // V383: Obsidian 学习联动 — 保存学习记录（写 课题研究/学习记录/）
  app.post("/api/vault/study-note", async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; content?: string; subject?: string };
    if (!body.title || !body.content) {
      return reply.code(400).send(notFound("BAD_REQUEST", "缺少 title/content"));
    }
    const saved = vaultService.saveStudyNote({ title: body.title, content: body.content, subject: body.subject });
    if (!saved) {
      return reply.code(500).send(notFound("VAULT_WRITE_FAILED", "写入 Obsidian 失败"));
    }
    return { ok: true, saved };
  });

  // V383: Obsidian 学习联动 — 删除文件（仅学习记录目录，安全边界）
  app.post("/api/vault/delete", async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) {
      return reply.code(400).send(notFound("BAD_REQUEST", "缺少 path"));
    }
    const ok = vaultService.deleteVaultFile(body.path);
    if (!ok) {
      return reply.code(403).send(notFound("VAULT_DELETE_DENIED", "仅允许删除学习记录目录下的文件"));
    }
    return { ok: true };
  });

  app.get("/api/vault/file", async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return reply.code(400).send(notFound("BAD_REQUEST", "缺少 path 参数"));
    }
    try {
      const file = vaultService.getFile(query.path);
      if (!file) {
        return reply.code(404).send(notFound("VAULT_FILE_NOT_FOUND", "文件不存在"));
      }
      return { file };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("ACCESS_DENIED")) {
        return reply.code(403).send(notFound("VAULT_ACCESS_DENIED", "路径不在白名单目录内"));
      }
      throw error;
    }
  });

  // 二进制文件流（PDF/图片预览 + 下载）
  app.get("/api/vault/binary", async (request, reply) => {
    const query = request.query as { path?: string; download?: string };
    if (!query.path) {
      return reply.code(400).send(notFound("BAD_REQUEST", "缺少 path 参数"));
    }
    try {
      const file = vaultService.getBinary(query.path);
      if (!file) {
        return reply.code(404).send(notFound("VAULT_FILE_NOT_FOUND", "文件不存在"));
      }
      const mime = vaultService.mimeFor(file.name);
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Content-Length": String(file.size),
        "Cache-Control": "no-cache"
      };
      if (query.download === "1") {
        headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
      } else if (mime.startsWith("application/pdf") || mime.startsWith("image/")) {
        // 内联预览
        headers["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`;
      }
      return reply.code(200).headers(headers).send(file.data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("ACCESS_DENIED")) {
        return reply.code(403).send(notFound("VAULT_ACCESS_DENIED", "路径不在白名单目录内"));
      }
      throw error;
    }
  });

  // ───── Compiled Truth + Timeline API（GBrain 机制A）─────
  const truthCreateSchema = z.object({
    title: z.string().min(1),
    compiledTruth: z.string().optional(),
    sourceHint: z.string().optional(),
    tags: z.array(z.string()).optional()
  });

  const truthRewriteSchema = z.object({
    compiledTruth: z.string().min(1),
    source: z.string().optional()
  });

  const truthEntrySchema = z.object({
    content: z.string().min(1),
    entryType: z.string().optional(),
    source: z.string().optional(),
    confidence: z.number().min(0).max(1).optional()
  });

  app.get("/api/truth/pages", async () => ({
    pages: await truthService.listPages()
  }));

  // V328: 知识 PR 草稿状态（P1-7 前端展示）— drafts 表按状态统计
  app.get("/api/truth/drafts", async () => {
    try {
      const { pool: tp } = await import("../db/pool.js");
      const [byStatus, recent] = await Promise.all([
        tp.query("select status, count(*)::int as n from knowledge_page_drafts group by status order by n desc"),
        tp.query("select id, title, status, review_verdict, proposer_model, reviewer_model, created_at from knowledge_page_drafts order by id desc limit 10"),
      ]);
      return { statusCounts: byStatus.rows, recent: recent.rows };
    } catch {
      return { statusCounts: [], recent: [] };
    }
  });

  app.post("/api/truth/pages", async (request, reply) => {
    const input = truthCreateSchema.parse(request.body);
    const page = await truthService.createOrGetPage(input);
    return reply.code(201).send({ page });
  });

  app.get("/api/truth/pages/:pageId", async (request, reply) => {
    const params = request.params as { pageId: string };
    z.string().uuid().parse(params.pageId);
    const detail = await truthService.getPageWithTimeline(params.pageId);
    if (!detail) {
      return reply.code(404).send(notFound("PAGE_NOT_FOUND", "知识页面不存在"));
    }
    return detail;
  });

  app.get("/api/truth/pages/title/:title", async (request, reply) => {
    const params = request.params as { title: string };
    const detail = await truthService.getPageByTitle(params.title);
    if (!detail) {
      return reply.code(404).send(notFound("PAGE_NOT_FOUND", "知识页面不存在"));
    }
    return detail;
  });

  app.put("/api/truth/pages/:pageId/compiled-truth", async (request, reply) => {
    const params = request.params as { pageId: string };
    z.string().uuid().parse(params.pageId);
    const input = truthRewriteSchema.parse(request.body);
    const result = await truthService.rewriteCompiledTruth(params.pageId, input.compiledTruth, input.source);
    return { result };
  });

  app.post("/api/truth/pages/:pageId/entries", async (request, reply) => {
    const params = request.params as { pageId: string };
    z.string().uuid().parse(params.pageId);
    const input = truthEntrySchema.parse(request.body);
    const entry = await truthService.appendEntry({ pageId: params.pageId, ...input });
    return reply.code(201).send({ entry });
  });

  // 删除时间线条目
  app.delete("/api/truth/pages/:pageId/entries/:entryId", async (request, reply) => {
    const params = request.params as { pageId: string; entryId: string };
    z.string().uuid().parse(params.pageId);
    z.string().uuid().parse(params.entryId);
    const deleted = await truthService.deleteEntry(params.pageId, params.entryId);
    if (!deleted) {
      return reply.code(404).send(notFound("ENTRY_NOT_FOUND", "时间线条目不存在"));
    }
    return { deleted: true };
  });

  // 删除知识页面（级联删除时间线）
  app.delete("/api/truth/pages/:pageId", async (request, reply) => {
    const params = request.params as { pageId: string };
    z.string().uuid().parse(params.pageId);
    const deleted = await truthService.deletePage(params.pageId);
    if (!deleted) {
      return reply.code(404).send(notFound("PAGE_NOT_FOUND", "知识页面不存在"));
    }
    return { deleted: true };
  });

  // Dream Cycle：夜间自整理（GBrain 机制4）
  app.post("/api/truth/dream-cycle", async (request, reply) => {
    try {
      const result = await truthService.runDreamCycle();
      return reply.code(201).send(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "dream cycle failed");
      return reply.code(500).send(notFound("DREAM_CYCLE_FAILED", "自整理失败"));
    }
  });

  // 检索即记忆：检索结果关联知识页（GBrain 机制5）
  const associateSchema = z.object({
    query: z.string().min(1),
    evidence: z.array(z.object({
      title: z.string(),
      content: z.string()
    })).min(1)
  });

  app.post("/api/truth/associate", async (request, reply) => {
    const input = associateSchema.parse(request.body);
    try {
      const result = await truthService.associateSearch(input);
      return reply.code(201).send(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "associate search failed");
      return reply.code(500).send(notFound("ASSOCIATE_FAILED", "关联知识页失败"));
    }
  });

  // ───── MarxSphere 本地文献库 API ─────
  const literatureQuerySchema = z.object({
    topic: z.string().optional(),
    author: z.string().optional(),
    year: z.string().optional(),
    keyword: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional()
  });

  app.get("/api/literature", async (request) => {
    const query = request.query as { topic?: string; author?: string; year?: string; keyword?: string; page?: string; pageSize?: string };
    const input = literatureQuerySchema.parse(query);
    return literatureService.list(input);
  });

  app.get("/api/literature/catalog", async () => ({
    catalog: literatureService.catalog(),
    scanDir: literatureService.scanDir
  }));

  app.get("/api/literature/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = literatureService.getDetail(params.id);
    if (!detail) {
      return reply.code(404).send(notFound("LITERATURE_NOT_FOUND", "文献不存在"));
    }
    return { detail };
  });

  // 文献引文：从 original.md 提取参考文献块（轨道2 本地提取）
  app.get("/api/literature/:id/citations", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = literatureService.getDetail(params.id);
    if (!detail) {
      return reply.code(404).send(notFound("LITERATURE_NOT_FOUND", "文献不存在"));
    }
    const block = citationService.extractForPaper(detail.path, detail.id, detail.title || detail.paperTitle || "");
    if (!block) {
      return { citations: null, note: "未在原文中找到参考文献块" };
    }
    return { citations: block };
  });

  // 引文全库统计（扫描有多少篇含参考文献）
  app.get("/api/citations/stats", async () => {
    const records = literatureService.list({ pageSize: 1000 });
    let withCitations = 0;
    let totalEntries = 0;
    let scanned = 0;
    for (const r of records.items) {
      scanned += 1;
      try {
        const block = citationService.extractForPaper(r.path, r.id, r.title || r.paperTitle || "");
        if (block) {
          withCitations += 1;
          totalEntries += block.count;
        }
      } catch {
        // 单篇失败跳过
      }
    }
    return {
      scanned,
      withCitations,
      coverage: scanned > 0 ? Math.round((withCitations / scanned) * 100) : 0,
      totalEntries
    };
  });

  // PDF 检索：全部 1 万篇 PDF 按主题/关键词检索
  const pdfSearchSchema = z.object({
    topic: z.string().optional(),
    keyword: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional()
  });

  app.get("/api/literature/pdfs", async (request) => {
    const query = request.query as { topic?: string; keyword?: string; page?: string; pageSize?: string };
    const input = pdfSearchSchema.parse(query);
    return literatureService.searchPdfs(input);
  });

  // ───── 中国政府网政策检索（gov.cn MCP）─────
  const policySearchSchema = z.object({
    keyword: z.string().min(1),
    pageSize: z.coerce.number().int().min(1).max(20).optional(),
    startdate: z.string().optional(),
    enddate: z.string().optional()
  });

  app.get("/api/policy/search", async (request) => {
    const query = request.query as { keyword?: string; pageSize?: string; startdate?: string; enddate?: string };
    const input = policySearchSchema.parse(query);
    return policyService.search(input);
  });

  // ───── 外部数据源（29 源体系）─────
  app.get("/api/external-sources", async () => ({
    sources: externalSourcesService.getSourceList(),
    total: externalSourcesService.registry.count
  }));

  // V412: URL 一键导入（数据源页粘贴网址 → 抓取 → ingest 入库）
  app.post("/api/sources/import-url", async (request) => {
    const body = request.body as { url?: string; title?: string; sourceId?: string };
    return externalSourcesService.importFromUrl({
      url: body.url || "",
      title: body.title,
      sourceId: body.sourceId,
    });
  });

  const externalSearchSchema = z.object({
    source: z.enum(["openalex", "core", "worldbank", "github", "qstheory", "people_theory", "xuexi", "gmw_theory", "studytimes", "ce_theory", "cssn", "aisixiang"]),
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(20).optional()
  });

  app.get("/api/sources/search", async (request) => {
    const query = request.query as { source?: string; q?: string; limit?: string };
    const input = externalSearchSchema.parse({
      source: query.source,
      query: query.q,
      limit: query.limit
    });
    if (input.source === "openalex") {
      return externalSourcesService.searchOpenAlex({ query: input.query ?? "", perPage: input.limit ?? 5 });
    }
    if (input.source === "worldbank") {
      return externalSourcesService.searchWorldBank({ query: input.query ?? "", limit: input.limit ?? 5 });
    }
    if (input.source === "core") {
      return externalSourcesService.searchCore({ query: input.query ?? "", limit: input.limit ?? 5 });
    }
    if (input.source === "github") {
      return externalSourcesService.searchGitHub({ query: input.query ?? "", perPage: input.limit ?? 8 });
    }
    // 网页源：CDP 抓取
    return externalSourcesService.searchWebSource({ source: input.source, query: input.query, limit: input.limit ?? 8 });
  });

  // 检索步骤详情文档（GBrain 教学台：面板 echo 后端真实代码）
  app.get("/api/search/step-docs", async () => ({
    steps: stepDocs.list
  }));

  // 消融实验（GBrain 消融总览）：同一查询跑完整版 + 关掉各算子，对比 top5 命中变化
  const ablationSchema = z.object({
    query: z.string().min(1),
    sourceIds: z.array(z.string().uuid()).min(1)
  });
  app.post("/api/search/ablation", async (request) => {
    const input = ablationSchema.parse(request.body);
    // 全部可消融算子（与 search-service 的 ablation.includes 对齐）
    const OPERATORS = [
      "compiled_truth", "title", "chronicle_type", "backlink",
      "cosine", "dedup", "alias", "relational", "expansion",
      "graph_traversal", "multi_query", "rerank"
    ];
    const base = { query: input.query, sourceIds: input.sourceIds, strategy: "multi", searchMode: "fast", topK: 10, noTrace: true };
    const [baseline, ...ablated] = await Promise.all([
      searchService.search(base as never),
      ...OPERATORS.map((op) => searchService.search({ ...base, ablation: [op] } as never))
    ]);
    const baselineIds = new Set(baseline.sections.map((s) => s.chunkId));
    return {
      baselineCount: baseline.sections.length,
      operators: OPERATORS.map((op, i) => {
        const ablatedIds = new Set(ablated[i].sections.map((s) => s.chunkId));
        const overlap = [...baselineIds].filter((id) => ablatedIds.has(id)).length;
        return {
          operator: op,
          ablatedCount: ablated[i].sections.length,
          overlapWithBaseline: overlap,
          // 命中变化：关掉后 top 变化比例（越小说明该算子贡献越大）
          hitChangePct: baselineIds.size === 0 ? 0 : Math.round(((baselineIds.size - overlap) / baselineIds.size) * 100)
        };
      })
    };
  });

  // 自定义组合消融：传 ablation 数组（如 ["backlink","title"]）关掉指定算子，对比基线
  const customAblationSchema = z.object({
    query: z.string().min(1),
    sourceIds: z.array(z.string().uuid()).min(1),
    ablation: z.array(z.string()).max(12).optional()
  });
  app.post("/api/search/ablation/custom", async (request) => {
    const input = customAblationSchema.parse(request.body);
    const base = { query: input.query, sourceIds: input.sourceIds, strategy: "multi", searchMode: "fast", topK: 10, noTrace: true };
    const [baseline, ablated] = await Promise.all([
      searchService.search(base as never),
      searchService.search({ ...base, ablation: input.ablation ?? [] } as never)
    ]);
    const baselineIds = new Set(baseline.sections.map((s) => s.chunkId));
    const ablatedIds = new Set(ablated.sections.map((s) => s.chunkId));
    const overlap = [...baselineIds].filter((id) => ablatedIds.has(id)).length;
    return {
      baselineCount: baseline.sections.length,
      ablatedCount: ablated.sections.length,
      overlapWithBaseline: overlap,
      hitChangePct: baselineIds.size === 0 ? 0 : Math.round(((baselineIds.size - overlap) / baselineIds.size) * 100),
      closedOperators: input.ablation ?? []
    };
  });

  // ───── GitHub 需求直通（技能页 GitHub 发现）─────
  const githubDiscoverSchema = z.object({
    need: z.string().min(1).max(300),
    mode: z.enum(["api", "claude"]).default("api"),
    perSource: z.coerce.number().int().min(1).max(10).optional()
  });

  app.post("/api/github/discover", async (request, reply) => {
    const input = githubDiscoverSchema.parse(request.body);
    const result = await githubDiscoverService.discoverGitHub(input);
    if (result.rateLimited && result.items.length === 0) {
      return reply.code(429).send(notFound("GITHUB_RATE_LIMITED", "GitHub 限流，请稍后再试或配置 GITHUB_TOKEN"));
    }
    return result;
  });

  // ───── 政策资料库（浏览 + 保存）─────
  app.get("/api/policy-library/tree", async () => policyLibraryService.getTree());

  const savePolicySchema = z.object({
    title: z.string().min(1),
    url: z.string(),
    date: z.string().optional(),
    summary: z.string().optional(),
    category: z.string().optional()
  });

  app.post("/api/policy-library/save", async (request, reply) => {
    const input = savePolicySchema.parse(request.body);
    const result = policyLibraryService.savePolicy(input);
    if (!result.ok) {
      return reply.code(400).send(notFound("SAVE_POLICY_FAILED", result.error ?? "保存失败"));
    }
    return reply.code(201).send(result);
  });

  if (fs.existsSync(webIndexFile)) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send(notFound("NOT_FOUND", "接口不存在"));
      }
      return reply.type("text/html").send(fs.readFileSync(webIndexFile, "utf8"));
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof z.ZodError ? 400 : 500;
    // 完整错误信息（error 对象 pino 可能序列化成空 {}，显式提取 message/stack）
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 5).join(" | ") : "";
    const logPayload = { errMsg, errStack, statusCode };
    if (statusCode >= 500) {
      logger.error(logPayload, "request failed");
    } else {
      logger.warn(logPayload, "request validation failed");
    }
    // 外部持 token 请求: 屏蔽内部错误细节 (防路径/堆栈/API报错泄露); 400 验证错误保留通用文案
    const isExternal = !!((request as any).tokenCtx);
    const message = isExternal && statusCode !== 400 ? "内部错误，请稍后重试" : getErrorMessage(error);
    reply.code(statusCode).send({
      error: {
        code: statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
        message
      }
    });
  });

  return app;
}

// V437: 迁移完成后由 index.ts 调用（runMigrationsWithRetry 完成 → 服务放行）
export function markMigrationsReady(): void {
  // 通过模块级闭包变量传递 — buildHttpServer 实例内捕获同一引用
  (globalThis as any).__marxsphere_migrations_ready = true;
}

/** V437: 迁移完成标记（buildHttpServer 内部读取） */
export function isMigrationsReady(): boolean {
  return (globalThis as any).__marxsphere_migrations_ready === true;
}
function serializeBatchJob(job: any) {
  return {
    id: job.id, inputDir: job.inputDir, outputDir: job.outputDir,
    status: job.status, total: job.total, done: job.done,
    succeeded: job.succeeded, failed: job.failed, skipped: job.skipped, duplicate: job.duplicate,
    currentFile: job.currentFile, taskIds: job.taskIds,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    maxDailyPages: job.maxDailyPages, pagesToday: job.pagesToday,
    maxFiles: job.maxFiles, retryFailed: job.retryFailed,  // V395-14
    log: job.log.slice(-100),
  };
}

function notFound(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "请求参数无效";
  }
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function startHttpServer(): Promise<void> {
  // 预连接 Graphiti + Cognee MCP (不阻塞 API 启动)
  // MARXSPHERE_PREVIEW=1 时跳过 MCP 池（省内存预览界面，推理/检索不可用）
  if (process.env.MARXSPHERE_PREVIEW !== "1") {
    initMcpClients().catch(() => {});
  }

  const app = buildHttpServer();
  await app.listen({
    host: config.HTTP_HOST,
    port: config.HTTP_PORT
  });

  // 恢复持久化的上传任务（中断的标记 FAILED，活跃的重新进内存——重启不丢）
  webuiService.restoreUploadJobs()
    .then((count) => console.log(`[upload-jobs] 恢复 ${count} 个持久化任务`))
    .catch((error) => console.log(`[upload-jobs] 恢复失败: ${String(error).slice(0, 120)}`));

  // Jobs worker：预览模式也启动（任务很轻：lint/backlinks 等毫秒级，保证三栏队列有真实流转）
  jobsService.startWorker();
  console.log("[jobs] worker started");

  // 任务巡检监控（卡死检测：query_tasks 非终态超阈值 → 标记失败 + 告警；每 2 分钟）
  startTaskPatrol();
  console.log("[task-monitor] patrol started");

  // V379: 告警自愈巡检（每 60 秒自动处理未解决告警）
  selfHealService.startSelfHealPatrol();

  // V395-9: Agent 定时任务调度器（每分钟检查 cron 触发 → 创建 agent 任务）
  try {
    const { agentScheduler } = await import("../services/agent-scheduler.js");
    agentScheduler.startScheduler();
    console.log("[agent-scheduler] 定时任务调度器已启动（每分钟检查）");
  } catch (e: any) {
    console.warn("[agent-scheduler] 启动失败（定时任务不可用）:", e?.message?.slice(0, 100));
  }

  // V395-14: 恢复批量导入历史任务（重启后前端仍可查看）
  try {
    const { p2oBatchService } = await import("../services/p2o-batch-service.js");
    await p2oBatchService.restoreBatchJobs();
    console.log("[p2o-batch] 批量任务历史已恢复");
  } catch (e: any) {
    console.warn("[p2o-batch] 批量历史恢复失败:", e?.message?.slice(0, 100));
  }

  // V376: ③主动行为——每日定时自主研究（03:00 自动入队；记忆巡检+主题研究）
  const runAutonomousResearch = () => {
    void jobsService.enqueue({ jobType: "autonomous_research", payload: { auto: true }, idempotencyKey: `autonomous-${new Date().toISOString().slice(0, 10)}` })
      .then(() => console.log("[autonomous] 自主研究任务已入队"))
      .catch(() => {});
  };
  // 启动时立即跑一次（验证），之后每日 03:00
  const now = new Date();
  const msTo3am = (() => {
    const t = new Date(); t.setHours(3, 7, 0, 0); // 避开整点负载
    return t.getTime() - now.getTime() > 0 ? t.getTime() - now.getTime() : t.getTime() + 86400000 - now.getTime();
  })();
  const autoTimer = setTimeout(() => {
    runAutonomousResearch();
    // unref: 周期性定时器不阻止进程退出（关窗后 Electron 需能干净退出）
    setInterval(runAutonomousResearch, 86400000).unref?.();
  }, msTo3am);
  autoTimer.unref?.();
  console.log(`[autonomous] 自主研究定时器已启动（下次 ${new Date(Date.now() + msTo3am).toLocaleString("zh-CN")}）`);
}
