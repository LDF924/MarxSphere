// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
import fs from "node:fs";
import { dataRoot } from "../services/storage-paths.js";
import { dataPath } from "../services/storage-paths.js";
import { vaultRoot as kbVaultRoot } from "../services/kb-paths.js";
import { selfBaseUrl } from "../services/base-urls.js";
import { getObject, putObject } from "../services/blob-store.js";
import { loginAllowed, loginSucceeded, loginIpLimiter, loginUserLimiter } from "../services/login-guard.js";
import { buildRedisBackendFromEnv } from "../services/redis-rate-limit.js";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import { pool } from "../db/pool.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { backupRoutes } from "./routes-backup.js";
import { SearchSessionStore } from "../services/retrieval-session.js";
import { probeCapabilities } from "../services/capabilities-service.js";
import { universeCogneeQuery, universeDataSources, universeExpand, universeGraphitiQuery, universeJob, universeManifest, universeNodeDetail, universeRebuild, universeSearchEntities, universeTimeline } from "../services/universe-service.js";
import { webuiService } from "../services/webui-service.js";
import {
  OpenAiError,
  formatChatChunk,
  openaiChatCompletionsSchema,
  runOpenAiChatCompletion,
} from "../services/openai-compat.js";
import { randomUUID } from "node:crypto";

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
import { computeDataFingerprint } from "../services/eval-fingerprint.js";
import { mcpAgentService } from "../services/mcp-agent-service.js";
import { aiSettingsService, toChatCompletionsUrl } from "../services/ai-settings-service.js";
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
import { LLM_MODEL_REGISTRY, getRoleModel, getRoleModelMap, resolveModelAlias, setRoleModel, isModelUsable, findModelOption, getProviderEndpoint, isEditorModelSet, type LlmRole } from "../services/llm-model-registry.js";
import { traceService } from "../services/trace-service.js";
import { quotaService } from "../services/quota-service.js";
import { runWithContext } from "../services/request-context.js";
import { InsufficientPointsError, withPoints, pointsEnabled } from "../services/points-gate.js";
import { globalRateLimiter, tokenRateLimiter, tenantRateLimiter, tryAcquireTenantSlot, releaseTenantSlot, tenantConcurrencyLimit, attachRateLimitPool, attachRateLimitBackend, configureRateLimitBackends, PgRateLimitBackend, acquireTenantSlotAsync, releaseTenantSlotAsync, renewTenantSlotAsync, pruneRateLimitCounters, SLOT_HEARTBEAT_MS } from "../services/rate-limiter.js";
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
import { chargeUserForReasonTask } from "../services/reason-billing.js";
import { requestNeedsBudgetCheck } from "../services/budget-gate.js";
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
// SocialSci P0-5 chart-code: LLM 调用
import { getLlmEndpoint, fetchLlm } from "../ai/llm-common.js";
// SocialSci P0-1: 科研项目/DAG 工作台 + SSE 工具
import * as researchPipeline from "../services/research-pipeline-service.js";
import { RESEARCH_STAGES } from "../services/research-stages.js";
import { attachSse } from "./stream-utils.js";
// SocialSci P0-2: 素材库 + DAG 执行引擎
import * as researchMaterials from "../services/research-materials-service.js";
import * as researchEvidence from "../services/research-evidence-service.js";
import * as reviewResponse from "../services/review-response-service.js";
import * as postAcceptance from "../services/post-acceptance.js";
import * as proposalService from "../services/proposal-service.js";
import * as checkupService from "../services/checkup-service.js";
import * as researchExec from "../services/research-exec-engine.js";
// SocialSci P0-3: 审稿任务流 + 期刊库/标准库
import * as reviewService from "../services/review-service.js";
// SocialSci P0-4: 对话式科研绘图 Agent
import * as vizAgent from "../services/viz-agent-service.js";
import * as vizExec from "../services/viz-exec-service.js";
// SocialSci P0-5: 学术文本编辑器
import * as editorService from "../services/editor-service.js";
import * as aiJobService from "../services/editor-ai-job-service.js";
// SocialSci P0-8: 积分商业化 + 微信扫码登录
import * as pointsService from "../services/points-service.js";
import * as wechatAuth from "../services/wechat-auth-service.js";
// SocialSci 补漏R2: 章节技能卡 + 工作台整包快照
import * as chapterSkill from "../services/chapter-skill-service.js";
import { syncSnapshotToNodes } from "../services/workbench-sync.js";

// 桌面端封装（V397）: SAG_ROOT 环境变量覆盖资源根目录（安装目录 vs 运行时目录分离）
//
// 2026-09-11: 前端产物目录改成"候选回退 + 启动时打印实际路径"。
// 起因是本地 worktree 开发: SAG_ROOT 指主仓 → 读主仓的 web/dist, 而新构建的产物在 worktree 里,
// 表现为"改了前端但页面没变", 且没有任何提示(同 migrate.ts 那个坑)。
// 现在优先用 SAG_ROOT(显式配置), 但它下面没有构建产物时回退到模块相对路径, 并把实际用的路径打出来。
const rootDir = process.env.SAG_ROOT || process.cwd();
// ESM 下没有 __dirname(踩过: 直接写会让服务启动即崩)
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function webDistCandidates(): string[] {
  const cands = [path.join(rootDir, "web", "dist")];
  // 源码运行: <repo>/src/api → <repo>/web/dist; 编译后: <repo>/dist/src/api → <repo>/web/dist
  cands.push(path.resolve(moduleDir, "..", "..", "web", "dist"));
  cands.push(path.resolve(moduleDir, "..", "..", "..", "web", "dist"));
  cands.push(path.join(process.cwd(), "web", "dist"));
  return [...new Set(cands)];
}

function resolveWebDist(): string {
  const cands = webDistCandidates();
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, "index.html"))) return d;
    } catch { /* 试下一个 */ }
  }
  return cands[0];
}

const webDistDir = resolveWebDist();
const webIndexFile = path.join(webDistDir, "index.html");
// 明确打印, 免得"页面没变"时要去猜服务读的是哪一份产物
if (fs.existsSync(webIndexFile)) {
  console.log(`[sag] 前端产物: ${webDistDir}`);
} else {
  console.warn(`[sag] 未找到前端产物(index.html), 只提供 API。查找过: ${webDistCandidates().join(" | ")}`);
}

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
  /** G2: 返回请求级检索图(query→entity→event→chunk) */
  returnGraph: z.boolean().optional(),
  /** G10: 游标翻页 — 传 cursor 从快照恢复下一页; 传 pageSize 首次请求建快照 */
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(100).optional(),
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
const ALLOWED_PROVIDER_HOSTS = [
  "api.deepseek.com",
  "dashscope.aliyuncs.com",
  "maas.aliyuncs.com",
];
const isTrustedProviderUrl = (url: string) => {
  try {
    return ALLOWED_PROVIDER_HOSTS.some((h) => new URL(url).hostname === h || new URL(url).hostname.endsWith("." + h));
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
  /** 客户端 IP(反代后取 X-Forwarded-For 首段; 直连取 socket 地址) */
  const clientIp = (request: any): string => {
    const fwd = String(request.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    return fwd || request.socket?.remoteAddress || request.ip || "unknown";
  };
  /** 无鉴权入口(登录/注册/找回)的限流判定 —— IP + 用户名双维度, 多副本共享配额 */
  const allowAuthAttempt = async (request: any, ident: string): Promise<boolean> => {
    const r = await loginAllowed(clientIp(request), ident || "-");
    if (!r.allowed) {
      console.warn(`[auth-guard] 尝试过于频繁, 已拒绝: ip=${clientIp(request)} ident=${String(ident).slice(0, 40)}`);
    }
    return r.allowed;
  };
  const authRateLimited = { error: "尝试过于频繁, 请稍后再试", code: "RATE_LIMITED" };

  // 启动限流器桶清理 (防 Map 无限增长)
  globalRateLimiter.startCleanup();
  tokenRateLimiter.startCleanup();
  tenantRateLimiter.startCleanup();
  loginIpLimiter.startCleanup();
  loginUserLimiter.startCleanup();
  // 多副本: 限流计数落共享后端(各副本共享同一配额)。
  // 后端选择: RATE_LIMIT_BACKEND=redis(需 REDIS_URL) > pg(默认, 需 DATABASE_URL) > 进程内。
  // 两者都配了时, 选中的做主后端、另一个做备用 —— 只有一个存储挂了不会退化成"各发各的"。
  // 关掉: RATE_LIMIT_DB=0
  if (process.env.RATE_LIMIT_DB !== "0") {
    const want = (process.env.RATE_LIMIT_BACKEND || "").toLowerCase();
    const redis = buildRedisBackendFromEnv();
    const pg = new PgRateLimitBackend(pool);
    if (want === "redis" && !redis) {
      // 明确要求了 redis 却没配 URL —— 静默回退会让"以为共享其实没共享", 必须说清楚
      console.error("[rate-limit] RATE_LIMIT_BACKEND=redis 但未配置 REDIS_URL, 回退到 pg");
    }
    const useRedis = Boolean(redis) && (want === "redis" || want === "");
    if (useRedis) {
      // 默认(未指定 want)也优先 redis: 它是为计数场景选的后端, 不压业务库
      configureRateLimitBackends(redis!, pg);
    } else {
      configureRateLimitBackends(pg, redis);
    }
    // 过期计数窗口清理(仅 pg 后端需要; redis 靠键 TTL 自过期)
    const t = setInterval(() => { void pruneRateLimitCounters(60_000); }, 10 * 60_000);
    t.unref?.();
  }
  const app = Fastify({
    // V412: 全局请求体上限 30MB（问卷文件解析/附件上传需要；默认 1MB 会挡掉 base64 大文件）
    //
    // ⚠ 2026-09-28 修: 30MB **不够** —— 界面承诺"最大 25 MB", 而文件是走 JSON+base64 上来的,
    //   base64 把体积撑到 **4/3 倍**: 25MB 文件 → 33.3MB 请求体 → 撞上 30MB 上限 →
    //   Fastify 在**读完 body 之前**就断连, 客户端拿到的是 ECONNRESET 而不是一个 4xx。
    //   实测天花板: 22MB 文件(29.3MB 请求体) 过, 23MB 文件(30.7MB) 挂。
    //   前端按 25MB 放行 → 用户看到的是"文件解析失败(不支持的类型?)" —— **把"太大"报成了"格式不对"**。
    //   所以上限必须**按最坏情况反推**: 25MB 文件 → 33.3MB, 再留一点余量给 JSON 包裹与中文文件名。
    //   这条是全局上限, 调它会让所有路由都能收大 body —— 对附件/数据文件上传是必要的
    //   (它们本来就只走 base64 这一条路), 且比"某个路由悄悄 500"要诚实。
    //   2026-09-28 二次调整: 界面上的附件上限从 25MB 放开到 **100MB**, 这里跟着按 4/3 反推
    //   (100MB → 133.3MB), 再留余量给 JSON 包裹与中文文件名 ⇒ 140MB。
    //
    //   ⚠ **真正的天花板不是这个数, 是内存**。启动参数是 `--max-old-space-size=1200`(1.2GB),
    //     而这条链路的内存峰值约 **4.3 倍文件大小**(base64 串 4/3 → JSON.parse 再复制一份 →
    //     Buffer.from 第三份)。100MB 文件 ⇒ 峰值 ~430MB, 在 1.2GB 里安全;
    //     **300MB 文件 ⇒ 峰值 >1.2GB, 后端 OOM 直接崩** —— 那不是"报错", 是进程死掉。
    //     所以要再往上放, 必须先改成**二进制流式落盘**(去掉 base64 这一段), 只调这个数字不够。
    //     实测过的死区教训: 23MB 文件(30.7MB 请求体)撞 30MB 上限时, 客户端拿到的是
    //     ECONNRESET 而不是 4xx, 用户被告知"文件解析失败(不支持的类型?)"。
    bodyLimit: 140 * 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: "socioseek"
      }
    }
  });
  // 企业微信回调 content-type 为 text/xml — 需注册解析器(返回原始字符串)
  app.addContentTypeParser("text/xml", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/xml", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // ─── 对外 API 鉴权（部署到服务器 + 多用户场景）───
  // 规则: 本机 socket 连接豁免（本机开发便利）; 外部连接强制 Bearer Token
  // 白名单路由: /health /api/mode /api/docs /前端静态资源
  // ⚠ 安全: 不信任 X-Forwarded-For (可伪造绕过 localhost 豁免), 只认 socket 真实连接地址
  // ⚠ /api/tokens 管理端点不在白名单 — 外部连接一律 401 (即使带 token 也拒绝, 避免令牌被盗后直接管理)
  const AUTH_WHITELIST = new Set([
    "/health", "/api/mode", "/api/docs",
    /**
     * 微信支付回调(2026-10-01)。**必须免鉴权** —— 调用方是微信服务器(公网),
     *   它不会带我们的 JWT/sag_ 令牌。放进白名单不等于"不设防":
     *   这条路由的防伪靠在 handler 里**验签 + 解密 + 金额核对 + 幂等**四道,
     *   见 wechat-pay-service.verifyNotifySignature 与 payment-order-service.settleOrder。
     *
     * 若哪天误把它从白名单拿掉, 症状是"微信一直回调失败, 用户付了钱但不到账",
     *   而且本地测试(本机 socket 豁免)完全看不出来 —— 只有在公网部署时才暴露。
     */
    "/api/pay/notify/wechat",
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
    /**
     * V418: 外部服务密钥(填/换/校验)。与 /api/settings、/api/tokens 同类 ——
     *   它能**写入一个会被平台拿去调用外部付费接口的密钥**, 属于部署方的配置面。
     *   不放开给外部令牌: 拿到 sag_xxx 的第三方能改 MinerU 密钥, 等于能把 OCR 结果
     *   导向自己控制的账号(对方文档会被送去解析)。需要远程改的走本机或部署脚本。
     */
    "/api/service-tokens",
  ];
  // V381: 26 个工作台 tab 功能 → 所需令牌权限映射
  // 规则: 精确前缀匹配(先长后短), 命中即要求对应权限。
  //
  // V417 改 fail-closed: 原先"未命中的功能默认放行(任意有效令牌)"。实测后果 —— 只持有
  //   `search` 权限的令牌, 从局域网(非本机豁免)GET /api/cjournal/journals 返回 200 全量期刊库,
  //   因为 /api/cjournal 不在表里。全站 99 个路由前缀而表里只有 33 个, 缺口 66 个。
  //   现在: 未映射 → 按 AGENT 权限(最严的通用权限之一)要求; 确属公开的少量前缀显式列进
  //   PUBLIC_PREFIXES(见下), 仍然放行。
  // 兼容: reason/search/ingest 旧权限仍作用于旧前缀
  // V388: 场景研究 API(classical/academic/writing/quality/theory等)归入 scenarios 权限 — 商业化多用户下防止只读token烧LLM余额
  const PERMISSION_PREFIX_MAP: Array<[string, string]> = [
    // 核心(兼容旧权限)
    ["/api/reason", "reason"],
    ["/api/search", "reason"],       // Ask/检索
    ["/api/openai", "reason"],       // OpenAI 兼容端点(检索+LLM 生成, 与 search 同权限)
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
    // 2026-10-02: 研究速递 — 用户自己的订阅与推送(本机豁免, 外部令牌需 digest 权限)
    ["/api/digest", "digest"],
    // 2026-10-02: 用户通知中心 — 与 /api/alerts 分家(那是全局运维告警)
    ["/api/notifications", "digest"],
    // V395-11: 导航对齐 — PDF2Obsidian / Agent控制台+任务（本机豁免, 外部令牌需对应权限）
    ["/api/p2o", "p2o"],
    ["/api/agent", "agent"],
    // V415: 编排器 — 画布 DAG 的执行入口(会调 agent 工具与各工作台端点), 外部令牌需 agent 权限
    ["/api/orchestrator", "agent"],
    ["/api/backup", "admin"],        // P1: 备份/恢复(破坏性全量替换, 仅 admin)
    ["/api/tokens", "admin"],        // V417: 令牌管理(仅本机或 admin; 缺映射时会被兜底权限挡住)
    // ── V417 补映射: 原先进不了表就"默认放行"的那些 ──
    ["/api/cjournal", "literature"],       // 期刊库/往期审稿(writing-corpus 走同一权限)
    ["/api/writing-corpus", "literature"],
    ["/api/writing-out", "scenarios"],
    ["/api/references", "literature"],
    ["/api/citations", "literature"],
    ["/api/papers", "literature"],
    ["/api/cnki", "ingest"],
    ["/api/zotero", "literature"],
    ["/api/rss", "literature"],
    ["/api/external-sources", "sources"],
    ["/api/review", "scenarios"],          // 论文质量评审
    ["/api/paper-outline", "scenarios"],   // 写作舱后端
    ["/api/research", "scenarios"],        // 研途写作舱(项目/节点/素材/执行引擎)
    // V418: 文档 OCR — 一次任务烧一次外部 OCR 额度 + 在服务端落一个文件,
    //   与 /api/p2o 同性质(都是"解析一份文档"), 给 p2o 权限
    ["/api/ocr", "p2o"],
    ["/api/materials", "scenarios"],
    ["/api/editor", "documents"],
    ["/api/viz", "documents"],
    ["/api/jupyter", "documents"],
    ["/api/knowledge", "documents"],
    ["/api/notes", "documents"],
    ["/api/format-eval", "documents"],
    ["/api/capabilities", "agent"],
    ["/api/meta-skill", "skills"],
    ["/api/prevention-rules", "memory"],
    ["/api/memory-maintenance", "memory"],
    ["/api/strategic-memory", "memory"],
    ["/api/learning-plans", "education"],
    ["/api/provenance", "trace"],
    ["/api/forensics", "trace"],
    ["/api/traces", "trace"],
    ["/api/model-call-logs", "trace"],
    ["/api/snapshot", "documents"],
    ["/api/entities", "graph"],
    ["/api/neo4j", "graph"],
    ["/api/projects", "documents"],
    ["/api/files", "documents"],
    ["/api/components", "documents"],
    ["/api/generations", "scenarios"],
    ["/api/im", "agent"],
    ["/api/github", "agent"],
    ["/api/computer-use", "agent"],
    ["/api/statistics", "empirical"],
    ["/api/statistics-jobs", "empirical"],
    ["/api/clarify", "reason"],
    ["/api/compose-answer", "reason"],
    ["/api/universes", "truth"],
    ["/api/ingest-jobs", "ingest"],
    ["/api/policy-library", "policy"],
    ["/api/quick-links", "documents"],
    ["/api/reader", "documents"],
    ["/api/translate", "documents"],
    ["/api/settings", "agent"],
    ["/api/cost", "agent"],
    ["/api/points", "search"],
    ["/api/billing", "search"],
    ["/api/byoa", "search"],
    ["/api/enterprise", "admin"],
    ["/api/ssh", "admin"],
    ["/api/s3", "admin"],
    // 兜底: 以上都没命中 → 要求 agent 权限(不放进 PUBLIC 前缀的路由, 外部令牌一律 403)
  ];

  /** 未命中 PERMISSION_PREFIX_MAP 时要求的兜底权限(fail-closed) */
  const FALLBACK_PERMISSION = "agent";
  /**
   * 真正的公开前缀 —— 持有效令牌即可访问, 不要求具体权限。
   * 保持极短: 只放"不泄露任何租户数据"的元信息端点。
   * (/api/mode 已在外层 WHITELIST 里, 无令牌也放行; 这里列着是为了语义完整)
   */
  const PUBLIC_PREFIXES = ["/api/mode"];

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
    // V417: 令牌身份在**通过验证后立刻**挂到 request —— 原先放在权限检查通过之后, 于是
    //   权限被拒(403)的请求根本没有 tokenCtx, 审计 hook 也就记不到它。
    //   "谁在反复越权尝试"恰恰是最该留痕的一类, 不能只在成功时记。
    (request as any).tokenCtx = { tokenId: verified.tokenId, tokenName: verified.tokenName, permissions: verified.permissions };
    // 权限检查: 用 tab→权限映射(先长后短匹配)
    let required: string | null = null;
    for (const [prefix, perm] of PERMISSION_PREFIX_MAP) {
      if (url.startsWith(prefix)) { required = perm; break; }
    }
    // V417: 未命中任何前缀 → 不再"默认放行"。公开前缀显式豁免, 其余按兜底权限(agent)要求。
    if (!required && !PUBLIC_PREFIXES.some((p) => url.startsWith(p))) {
      required = FALLBACK_PERMISSION;
    }
    if (required && !apiTokenService.hasPermission(verified.permissions as any, required as any)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: `Token 缺少 ${required} 权限` } });
    }
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
    else if (url.startsWith("/api/openai")) kind = "reason"; // OpenAI 兼容端点走 reason 成本配额
    // V395-11: P2O 走独立次数配额（PDF 解析烧 MinerU/LLM, 不与 other 混桶）
    else if (url.startsWith("/api/p2o/tasks") && request.method === "POST") kind = "p2o";
    // V418: 文档 OCR 与 p2o 同性质(一次任务烧一次外部 OCR + 一次 LLM 拉直), 同样独立计费
    else if (url.startsWith("/api/ocr/jobs") && request.method === "POST") kind = "p2o";

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
    if (url.startsWith("/api/search") || url.startsWith("/api/reason") || url.startsWith("/api/documents/upload") || url.startsWith("/ingest") || url.startsWith("/api/openai")) return;
    // V395-11: P2O 创建已按 p2o kind 记账, 不重复记 other
    if (url.startsWith("/api/p2o/tasks") && request.method === "POST") return;
    if (reply.statusCode >= 400) return;  // 失败请求不记成本
    quotaService.recordUsage(ctx.tokenId, "other", {});
  });

  // ─── 调用者身份上下文(2026-09-11) ───
  // 服务层的 LLM 调用要按用户记账/计费, 但那些函数拿不到 request。
  // 实测: Fastify 的 onRequest hook 里 als.run() **不会**传播到 handler, 必须在处理器入口 run。
  // 故此处统一包装路由注册: handler 执行前从 JWT 解出 userId 放进 AsyncLocalStorage,
  // 覆盖 handler 及其 await 的所有深层服务调用。无 token(本机/匿名)则不设 userId = 不计费。
  const alsUserIdOf = (request: any): { userId?: string; tenantId?: string } => {
    try {
      const token = String((request.headers?.authorization || "").replace("Bearer ", "").trim());
      if (!token) return {};
      const p = authService.verifyToken(token);
      return p ? { userId: p.uid, tenantId: (p as { tenantId?: string }).tenantId } : {};
    } catch { return {}; }
  };
  /** 场景类端点的积分功能键 — 只登记**确定烧 LLM** 的路径。
   *  支持两种形式(按前缀优先, 长的先匹配):
   *    "prefix:/api/xxx/"  整个前缀下的请求都计费
   *    "exact:/api/xxx"    仅该路径计费(列表/控制类接口不能收费) */
  const POINTS_FEATURE_RULES: ReadonlyArray<readonly [string, string]> = [
    ["prefix:/api/writing/", "writing:research"],
    ["prefix:/api/writing-out/", "writing:output"],
    ["prefix:/api/quality/", "quality:check"],
    ["prefix:/api/classical/", "classical:study"],
    ["prefix:/api/theory/", "theory:reflect"],
    ["prefix:/api/academic/", "academic:research"],
    // 评审: **只有真正跑评审的 stream 会烧 LLM**。
    //   注意 POST /api/review/jobs 仅创建 job(返回 jobId) 不调 LLM, 登记它会白收一次费。
    ["exact:/api/review/jobs/:jobId/stream", "review:paper"],
    // 实证分析: 只有执行分析的路径
    ["prefix:/api/empirical/analyze", "empirical:analyze"],
    ["exact:/api/empirical/run", "empirical:analyze"],
  ];
  /** 匹配请求 URL → 功能键(未登记返回 undefined = 不收费) */
  const pointsFeatureOf = (url: string): string | undefined => {
    const path = url.split("?")[0];
    for (const [rule, feature] of POINTS_FEATURE_RULES) {
      const [kind, pat] = rule.split(/:(.*)/s);
      if (kind === "prefix" && path.startsWith(pat)) return feature;
      if (kind === "exact") {
        // 支持 :param 段
        const re = new RegExp("^" + pat.replace(/:[A-Za-z]+/g, "[^/]+") + "$");
        if (re.test(path)) return feature;
      }
    }
    return undefined;
  };

  for (const method of ["get", "post", "put", "delete", "patch", "all", "options", "head"] as const) {
    const orig = (app as any)[method].bind(app);
    (app as any)[method] = (url: string, ...rest: any[]) => {
      const feature = pointsFeatureOf(url);
      const hi = rest.findIndex((x) => typeof x === "function");
      if (hi >= 0) {
        const handler = rest[hi];
        rest[hi] = function (this: unknown, request: any, reply: any) {
          const ctx = alsUserIdOf(request);
          return runWithContext(ctx, async () => {
            if (!feature || !ctx.userId || !pointsEnabled()) return handler.call(this, request, reply);
            // 同步/流式端点: 冻结 → 执行 → 成功核销 / 失败归还(与 viz:chart 同语义)
            try {
              return await withPoints(ctx.userId, feature, randomUUID(), () => handler.call(this, request, reply));
            } catch (e) {
              if (e instanceof InsufficientPointsError) {
                return reply.code(402).send({ error: e.message, code: "INSUFFICIENT_POINTS", needPoints: e.needPoints });
              }
              throw e;
            }
          });
        };
      }
      return orig(url, ...rest);
    };
  }

  // 额度预检: 会对用户产生 LLM 花费的端点(前缀匹配) — 超额直接 402, 不等到跑完才记账
  // 注: 只覆盖"用户主动发起 + 确定烧 token"的路由; 系统/后台任务无 userId 不拦
  const BUDGET_GATED_PREFIXES = [
    "/api/editor/v1/ai/",   // 编辑器 AI 助手(14 按钮)
    "/api/format-eval/",    // 格式检查(可带 llm:true)
    "/api/quality/",        // 论文质量检查
    "/api/review/",         // 论文评审
    "/api/paper-outline/",  // 论文大纲: 生成正文/要件烧 LLM(导出已豁免, 见 budget-gate)
    "/api/academic/",       // 学术场景
    "/api/writing/",        // 写作场景
    // 2026-09-26 补: 写作输出(S51-S55: 段落扩写/要件生成/引文格式化/语体适配/综述生成)
    //   **全在闸门之外**, 却在计费表里(`POINTS_FEATURE_RULES` 的 `prefix:/api/writing-out/`)——
    //   于是超额用户走这条既不被 402 拦住、又照常记账, 是"两家各记一半"的漏账。
    //   同源的还有归属校验那处(见 scenarioSourceCheck 的正则)。
    "/api/writing-out/",
    "/api/classical/",      // 经典文本
    "/api/theory/",         // 理论思辨
    // 2026-09-24 补: 文献提取矩阵**之前不在闸门里** —— 而它是全仓单次调用最贵的端点
    //   (literature-matrix-service 对最多 30 篇**逐篇**调一次 LLM, 每次 12k 字符 prompt,
    //    240s 超时)。写作舱要把它接进资料页, 接上以后再漏就等于"用户点一下烧 30 次调用且不记账"。
    //   ⚠ 只列这一条路径而不是整个 `/api/literature/`: 那个前缀下还有文献检索等接口,
    //   一刀切会重演 2026-09-13 那次"额度用尽后整页空白"的事故(见 budget-gate.ts 文件头)。
    "/api/literature/matrix",
  ];
  app.addHook("preHandler", async (request: any, reply: any) => {
    // 2026-09-13: 不再整段前缀一刀切 —— 纯读的期刊库/评审标准/统计/规则常量等不计费接口放行,
    //   否则额度用尽的用户打开「论文质量评审」看到的是一片空白(面板首屏全 402)。
    //   判定在 budget-gate.ts, 判据是"这次请求烧不烧 token"而不是 GET/POST。
    if (!requestNeedsBudgetCheck(request, BUDGET_GATED_PREFIXES)) return;
    const { userId } = alsUserIdOf(request);
    if (!userId) return;   // 本机/匿名/系统调用不拦
    const r = await billingService.ensureWithinBudget(userId);
    if (r.blocked) {
      return reply.code(402).send({ error: r.reason, code: "QUOTA_EXCEEDED", usedTokens: r.usedTokens, quotaTokens: r.quotaTokens, balanceCents: r.balanceCents });
    }
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
      // 2026-09-26 补 writing-out: 它下面有 5 个吃 sourceId 的端点(综述/空白识别等按库检索),
      //   漏在这个正则外 → 传别人的 sourceId 不做归属校验, 直接把他人私有库的内容检索出来。
      //   同一族的 academic/writing/quality/theory/classical 都在, 单独漏了它。
      const url = request.url.split("?")[0];
      if (!/^\/api\/(classical|academic|writing-out|writing|quality|theory|scenarios)/.test(url)) return;
      const access = await authService.verifySourceAccess(jwtPayload.uid, sourceId);
      if (!access.allowed) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }
    } catch { /* 校验失败不阻断（宽松策略） */ }
  };
  app.addHook("preHandler", scenarioSourceCheck);

  /**
   * V417: 提权类设置的第二道门。
   * 自主级别(auto-edit/full-auto)与沙箱级别(full-access)是**进程全局**状态, 改一下影响所有
   * 并发会话。原实现只要求"登录", 任何一个普通用户都能 POST 一行把沙箱放到 full-access。
   * 这里要求本机或 admin —— 多租户下这类开关不该由普通账号拨。
   */
  const privilegedSettingsCheck = async (request: any, reply: any) => {
    const url = String(request.url).split("?")[0];
    const method = String(request.method).toUpperCase();
    const isAutonomy = url === "/api/agent/autonomy" && method === "POST";
    const isAgentSettings = url === "/api/agent/settings" && (method === "PUT" || method === "POST");
    if (!isAutonomy && !isAgentSettings) return;
    if (isLocalRequest(request)) return;
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = token ? authService.verifyToken(token) : null;
    if (payload?.role === "admin") return;
    const verified = token ? await apiTokenService.validateApiToken(token) : null;
    if (verified?.permissions.includes("admin" as never)) return;
    return reply.code(403).send({ error: { code: "FORBIDDEN", message: "自主级别/沙箱级别为全局设置, 需本机或管理员" } });
  };
  app.addHook("preHandler", privilegedSettingsCheck);

  // V389: 审计日志 — 记录 JWT 用户请求（谁/何时/调了什么/结果）
  // V390: duration_ms 修复 — (reply as any).elapsedTime 非 Fastify 标准字段不可靠, 改为 onRequest 记开始时间 + onResponse 用 Date.now() 差
  app.addHook("onRequest", async (request) => {
    (request as any).auditStartMs = Date.now();
  });
  app.addHook("onResponse", async (request, reply) => {
    try {
      const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
      const payload = token && authService.verifyToken(token);
      const started = (request as any).auditStartMs as number | undefined;
      const durationMs = started ? Date.now() - started : 0;
      const path = request.url.split("?")[0];
      const ip = request.socket?.remoteAddress || "";
      if (payload) {
        void opsService.recordAudit({
          userId: payload.uid, username: payload.username, method: request.method, path,
          statusCode: reply.statusCode, durationMs, ip,
        });
        return;
      }
      // V417: 外部令牌请求此前**完全不进审计**（"非 JWT 用户不记审计"）—— 而持 sag_ 令牌的
      //   外部客户端正是最需要审计的一类：它们有行为、有配额、可能出错，却不留任何痕迹。
      //   这里补记：记到令牌维度（username 用令牌名，便于"哪个集成干了什么"）。
      const tok = (request as any).tokenCtx as { tokenId: string; tokenName?: string } | undefined;
      if (tok?.tokenId) {
        // tokenCtx 由鉴权 hook 写入(tokenName 是 V417 顺手带上的, 免得这里再查库)
        void opsService.recordAudit({
          userId: null, username: `token:${tok.tokenName || tok.tokenId.slice(0, 8)}`,
          method: request.method, path, statusCode: reply.statusCode, durationMs, ip,
        });
      }
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
      // V417: "admin" 原先被有意排除, 但那样 /api/tokens 就永远拿不到(它要求 admin 权限且仅限本机)
      //   → 令牌管理在远程连管理员也做不了。放进来: 它只对**本机或已通过 admin 校验**的调用方开放。
      "admin",
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
  /**
   * `execute` 步骤可以分派到的工具 —— **只有会产生实际产物的那几个**。
   *
   * 为什么必须是白名单而不是"排除检索类": 工具清单有 48 个, 逐个排除随时会漏;
   * 而"什么算动作"就那么几个, 列出来反而稳定。更重要的是**这个清单同时是安全边界** ——
   * execute 是全仓唯一允许产生文件系统副作用的步骤类型, 能碰到的工具越明确越好审。
   */
  const ACTION_TOOL_NAMES = new Set(["run_code", "file_write", "run_command", "apply_patch"]);

  /**
   * 产出物**质检** —— 在工具成功返回之后跑技能自带的质检脚本, 把结论拼进 detail。
   *
   * 抽出来是因为三处分派点(runAgentTaskInner + 对话链两处)都要走同一条质检,
   * 少接一处, 从那条路进来的任务就绕过了验证 —— 而"漏接一处"正是本仓反复踩的形态
   * (工具登记四处清单 / 权限列表多处同步 都栽过)。
   *
   * @returns 一段可拼进 detail 的文案; 质检没跑成时**如实说没跑**, 不假装通过
   */
  /**
   * 任务创建时间 —— 质检的产物基准。
   * 对话链那两个分派点不经过 runAgentTaskInner, 拿不到提前算好的值, 所以单独抽一个。
   */
  function taskCreatedAtOf(t: unknown): number {
    const c = (t as { createdAt?: string | Date } | null)?.createdAt;
    return c ? new Date(c).getTime() - 5000 : 0;
  }

  async function verifyArtifactNote(output: string, since: number, stepTitle = ""): Promise<string> {
    try {
      const { verifyProducedArtifact } = await import("../services/artifact-verify-service.js");
      /**
       * 技能名从**步骤标题 + 输出**里找。
       * 对话链那两个分派点没有 execContext, 但步骤标题通常写着"调用 xxx 技能",
       * 实测够用; 找不到就返回 null, 质检服务会如实报"未识别到技能, 跳过质检"。
       */
      const skillName = ((stepTitle + " " + output).match(/技能[`「\s]*([a-z0-9][a-z0-9-]{2,40})/i) || [])[1];
      const v = await verifyProducedArtifact({ skillName, output, since });
      return v.ran ? `\n【产物质检${v.ok ? "通过" : "未通过"}】${v.summary}（脚本 ${v.script}）` : `\n【产物质检未执行】${v.note ?? ""}`;
    } catch (e) {
      return `\n【产物质检未执行】${String((e as Error)?.message || e).slice(0, 160)}`;
    }
  }
  // 修复1: Agent 步骤执行器 self-fetch base — 统一走 base-urls(AGENT_API_BASE 等显式配置优先,
  // 否则按 HTTP_HOST/HTTP_PORT 推导, 免得"监听在哪"与"自我请求打哪"分叉)
  const SELF_BASE = selfBaseUrl();
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
  /**
   * V417: 依赖服务探测（纯 TCP，1.5s 超时）。
   * 抽成模块级是因为 /health 与 /api/mode 都要它 —— 两份探测很容易漂移成两套判据。
   * 只探"推理链路真的会用到"的几个: 图谱两臂 + 记忆层(OpenViking) + PG。
   * PG 单独由调用方查(它能给出更精确的 up/down, 不只是端口通不通)。
   */
  const probeTcp = (port: number, host = "127.0.0.1"): Promise<"up" | "down"> => new Promise((resolve) => {
    import("node:net").then((net) => {
      const sock = net.connect({ port, host, timeout: 1500 });
      sock.once("connect", () => { sock.destroy(); resolve("up"); });
      sock.once("error", () => resolve("down"));
      sock.once("timeout", () => { sock.destroy(); resolve("down"); });
    }).catch(() => resolve("down"));
  });
  const probeDependencies = async (): Promise<Record<string, "up" | "down">> => {
    const [graphiti, cognee, openviking] = await Promise.all([
      probeTcp(11001), probeTcp(11003), probeTcp(1933),
    ]);
    return { graphiti, cognee, openviking };
  };

  app.get("/health", async (): Promise<{
    ok: boolean; service: string; version?: string; db?: "up" | "down"; queueDepth?: number;
    runningTasks?: number; stuckTasks?: number; agentQueue?: { queued: number; running: number; maxConcurrent: number };
    /** V417: 依赖服务快照 + 是否降级 —— 原实现只查 PG 一条 select 1, 把 Neo4j/记忆层的死亡盖住了 */
    dependencies?: Record<string, "up" | "down">;
    degraded?: boolean;
  }> => {
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
    // V417: 依赖探测。原先 /health 只看 PG —— 实测本机 Neo4j(11001/11003) 与 OpenViking(1933)
    //   全都离线, 而 /health 依旧返回 ok:true, 运维看一眼就以为整站健康。
    //   TCP 探测是廉价的(1.5s 超时)且不依赖被探服务自身实现, 与 /api/mode 的判据保持一致。
    // V418: 版本号。站点内容页此前**没有任何**部署版本信息, 用户提"某功能坏了"时无从判断
    //   跑的是哪一版。从 package.json 读, 读不到就不给字段(不编造)。
    let version: string | undefined;
    try {
      version = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).version;
    } catch { /* 读不到就不报版本 */ }
    const dependencies = await probeDependencies();
    const degraded = db !== "up" || Object.values(dependencies).some((v) => v === "down");
    return {
      ok: db === "up", service: "socioseek", version, db, queueDepth, runningTasks, stuckTasks, agentQueue,
      dependencies, degraded,
    };
  });

  // 运行模式（GBrain 模式徽标）：preview=预览（省内存）/ full=完整（推理+MCP池）
  // V399: 真实健康探测 — mode 显示实际服务状态（Neo4j 双端口 + Python 进程），不再只看 env 标记
  app.get("/api/mode", async () => {
    const mode: "preview" | "full" = process.env.SOCIOSEEK_PREVIEW === "1" ? "preview" : "full";
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

  // ─── 能力探测(对齐 Zleap capabilities) ───
  // 运行时探测: PG/Neo4j 两库/rerank/embedding/LanceDB + 检索源汇总(前端降级提示 + OpenAI 端点能力边界)
  app.get("/api/capabilities", async () => {
    return await probeCapabilities();
  });

  // ─── Explore 图谱数据(阶段4b, 对齐 Zleap universe 快照契约) ───
  // 契约: manifest / timeline(bundle+ordinal+cursor) / expand(patch) / node_detail / rebuild+job
  app.get("/api/universe/manifest", async () => {
    return await universeManifest();
  });
  app.post("/api/universe/expand", async (request) => {
    const body = request.body as { epoch: number; source_id: string; node_kind: "event" | "entity"; node_id: string; limit?: number; cursor?: string | null; snapshot_id?: string | null; after?: string | null; before?: string | null };
    return await universeExpand(body);
  });
  app.post("/api/universe/timeline", async (request) => {
    const body = request.body as { epoch: number; source_id: string; limit?: number; direction?: "older" | "newer"; cursor?: string | null; snapshot_id?: string | null };
    return await universeTimeline(body);
  });
  app.get("/api/universe/nodes/:kind/:nodeId", async (request) => {
    const params = request.params as { kind: "event" | "entity"; nodeId: string };
    const q = request.query as { source_id?: string };
    return await universeNodeDetail({ kind: params.kind, nodeId: params.nodeId, sourceId: q.source_id });
  });
  app.get("/api/universe/neo/query", async (request) => {
    const q = request.query as { source?: string; q?: string; name?: string; limit?: string };
    if (q.source === "graphiti") {
      return await universeGraphitiQuery({ q: q.q, name: q.name, limit: q.limit ? Number(q.limit) : undefined });
    }
    if (q.source === "cognee") {
      return await universeCogneeQuery({ q: q.q, name: q.name, limit: q.limit ? Number(q.limit) : undefined });
    }
    return { entities: [] };
  });
  app.get("/api/universe/sources", async () => {
    return await universeDataSources();
  });
  app.get("/api/universe/search-entities", async (request) => {
    const q = request.query as { q?: string; source_id?: string; limit?: string };
    return await universeSearchEntities({
      q: q.q ?? "",
      sourceId: q.source_id,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });
  app.post("/api/universe/rebuild", async () => {
    return await universeRebuild();
  });
  app.get("/api/universe/jobs/:id", async (request) => {
    const params = request.params as { id: string };
    return await universeJob(params.id);
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

  // ─── V418: 外部服务密钥（值 + 有效期 + 校验）───
  //
  // ⚠ 安全约定(与 /api/agent/credentials 一致): **任何响应都不含密钥本体**。
  //   列表只回脱敏视图(末 6 位 + 日期 + 上次校验结论); 校验路由只回一句结论。
  //   加字段前先问: 这个字段能不能反推出密钥?
  app.get("/api/service-tokens", async () => {
    const { listServiceTokens } = await import("../services/service-token-store.js");
    return { tokens: await listServiceTokens() };
  });
  app.put("/api/service-tokens/:service", async (request, reply) => {
    const { service } = request.params as { service: string };
    const body = (request.body ?? {}) as { token?: string; issuedAt?: string | null; expiresAt?: string | null; note?: string };
    const { saveServiceToken } = await import("../services/service-token-store.js");
    // token 传空 = 只改日期/备注(已经配好的人不该被逼着再贴一遍密钥)
    const r = await saveServiceToken({
      service,
      token: body.token,
      issuedAt: body.issuedAt ?? null,
      expiresAt: body.expiresAt ?? null,
      note: body.note,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "SERVICE_TOKEN_BAD_REQUEST" });
    const { listServiceTokens } = await import("../services/service-token-store.js");
    const list = await listServiceTokens();
    return { ok: true, token: list.find((t) => t.service === service) ?? null };
  });
  /**
   * 校验。body.token 给了就**只测不存**(表单里"先测一下再保存"),
   * 没给就用当前生效的那个并**把结论落库**。
   * 判据是远端状态码, 不是到期日 —— 详见 service-token-store.verifyServiceToken 的注释。
   */
  app.post("/api/service-tokens/:service/verify", async (request, reply) => {
    const { service } = request.params as { service: string };
    const body = (request.body ?? {}) as { token?: string };
    const { verifyServiceToken } = await import("../services/service-token-store.js");
    const r = await verifyServiceToken(service, body.token);
    if (r.status === "not_configured") return reply.code(400).send({ error: r.message, code: "SERVICE_TOKEN_NOT_CONFIGURED" });
    return { ok: r.ok, status: r.status, message: r.message };
  });
  app.delete("/api/service-tokens/:service", async (request) => {
    const { service } = request.params as { service: string };
    const { clearServiceToken } = await import("../services/service-token-store.js");
    return { ok: await clearServiceToken(service) };
  });
  /** 立刻跑一轮巡检(不等每天那次) —— 面板上的"检查一次"也走它 */
  app.post("/api/service-tokens/patrol", async () => {
    const { runServiceTokenPatrol } = await import("../services/service-token-patrol.js");
    return { ok: true, ...(await runServiceTokenPatrol()) };
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

  /**
   * 对**平台文献库**查重 —— 与上面那条互补, 不是替换。
   *
   * 上面那条要求调用方自带 `sourceText`(text-vs-text), 所以写作舱里必须先挑一篇文献才能查;
   * 但平台其实有一个真语料: `documents` 表(本机 504 篇, 全有正文, 平均 1.3 万字)。
   * 这条就是拿它当比对库 —— **不需要用户挑任何东西**。
   *
   * 与上面那条的分工:
   *   · 这条: 确定性字面重合(6-gram + 最长连续命中), **不调 LLM**, 秒级, 可反复跑;
   *   · 上面那条: 带 LLM, 能识别"改写过的不当引用"这类字面查不出来的问题。
   * 两条都返回, 由用户判断看哪条 —— 不做成"一键合并", 因为它们的判据与误报特性完全不同。
   */
  const corpusPlagiarismSchema = z.object({
    text: z.string().min(50).max(200_000),
    limit: z.number().int().min(1).max(5000).optional(),
    /** 只回报最长连续命中达到该字数的文献(默认 0 = 全报, 由前端排序) */
    minRun: z.number().int().min(0).max(10_000).optional(),
  });
  app.post("/api/quality/plagiarism-corpus", async (request, reply) => {
    const parsed = corpusPlagiarismSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 text(50 字以上)" } });
    }
    const { corpusPlagiarismService } = await import("../services/corpus-plagiarism-service.js");
    return corpusPlagiarismService.checkAgainstCorpus(parsed.data.text, {
      limit: parsed.data.limit, minRun: parsed.data.minRun,
    });
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
  // ─── git 无痕快照 API(2026-09-04: 移植 open-science git_snapshot.rs) ───
  // 快照: POST /api/snapshot → 专用 ref 提交工作区(不碰分支); 历史: GET /api/snapshot/history
  app.post("/api/snapshot", async (request, reply) => {
    const { snapshotWorkspace } = await import("../services/git-snapshot-service.js");
    const body = (request.body ?? {}) as { label?: string };
    const result = await snapshotWorkspace(undefined, body.label ? String(body.label).slice(0, 200) : undefined);
    if (!result.ok && result.error) {
      return reply.code(502).send({ error: { code: "SNAPSHOT_FAILED", message: result.error } });
    }
    return { ...result };
  });
  app.get("/api/snapshot/history", async () => {
    const { snapshotHistory } = await import("../services/git-snapshot-service.js");
    return { ok: true, history: await snapshotHistory() };
  });
  // ─── 溯源 API(2026-09-04: 文件级 provenance, 移植 open-science) ───
  // 留痕查询: GET /api/provenance?path=&sessionId=&limit=&cursor=
  app.get("/api/provenance", async (request) => {
    const { queryProvenance } = await import("../services/provenance-service.js");
    const q = request.query as { path?: string; sessionId?: string; limit?: string; cursor?: string };
    const result = await queryProvenance({
      path: q.path || undefined,
      sessionId: q.sessionId || undefined,
      limit: q.limit ? Math.min(Number(q.limit) || 50, 500) : 50,
      cursor: q.cursor || undefined,
    });
    return { ok: true, ...result };
  });
  // 单文件版本历史: GET /api/provenance/file?path=
  app.get("/api/provenance/file", async (request) => {
    const { fileHistory } = await import("../services/provenance-service.js");
    const q = request.query as { path?: string };
    if (!q.path) return { ok: true, records: [] };
    const records = await fileHistory(q.path);
    return { ok: true, path: q.path, records };
  });
  // 复现提示: GET /api/provenance/reproduce?path= → 生成预填复现 prompt(人机环, 不自动执行)
  app.get("/api/provenance/reproduce", async (request) => {
    const { fileHistory, readEnvSnapshot } = await import("../services/provenance-service.js");
    const q = request.query as { path?: string };
    if (!q.path) return { ok: false, error: "缺少 path" };
    const history = await fileHistory(q.path);
    const latest = history[history.length - 1];
    if (!latest) return { ok: true, prompt: "", note: "无留痕记录" };
    const envText = await readEnvSnapshot(latest.envHash);
    const parts = [
      `请复现文件「${q.path}」的最新产出(版本 v${latest.version}, ${latest.tool} 写入于 ${latest.ts})。`,
      latest.runId ? `关联任务: ${latest.runId}` : "",
      `内容哈希: ${latest.contentHash}(${latest.size} B)`,
      envText ? `运行环境快照: ${latest.envHash}\n\`\`\`\n${envText.slice(0, 2000)}\n\`\`\`` : "无环境快照(该记录未关联任务)",
      "请重新运行生成该文件的代码/流程, 对比本次产物是否一致(哈希相同 = 可复现)。",
    ].filter(Boolean).join("\n");
    return { ok: true, prompt: parts };
  });
  // ─── 批量文件解析 API(2026-09-04: 多 PDF/Word/Excel/PPT 上传解析) ───
  // POST /api/files/batch-parse { files: [{name, base64}] } → 逐份文本
  const batchParseSchema = z.object({
    files: z.array(z.object({ name: z.string().max(256), base64: z.string().max(60_000_000) })).min(1).max(50),
    maxChars: z.number().int().min(500).max(50_000).optional(),
  });
  app.post("/api/files/batch-parse", async (request, reply) => {
    const body = batchParseSchema.parse(request.body);
    const { parseBatch } = await import("../services/batch-file-service.js");
    try {
      const result = await parseBatch(body.files, { maxChars: body.maxChars ?? 8000 });
      return { ok: true, ...result };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "BATCH_PARSE_FAILED", message: msg } });
    }
  });

  // ─── PRISMA 综述工作流 API(2026-09-04: 参考 Elicit sysreview) ───
  // ①检索: POST /api/prisma/search {topic, limit?}
  app.post("/api/prisma/search", async (request, reply) => {
    const body = (request.body ?? {}) as { topic?: string; limit?: number };
    if (!body.topic || String(body.topic).trim().length < 2) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "topic 至少 2 字" } });
    }
    const { prismaSearch } = await import("../services/prisma-service.js");
    return { ok: true, ...(await prismaSearch({ topic: String(body.topic), limit: body.limit ?? 30 })) };
  });
  // ②筛选: POST /api/prisma/screen {topic, papers, override?}
  const prismaScreenSchema = z.object({
    topic: z.string().min(2),
    papers: z.array(z.object({ id: z.string(), title: z.string() })).max(50),
    override: z.object({ paperId: z.string(), verdict: z.enum(["included", "excluded"]), reason: z.string().max(60).optional() }).optional(),
  });
  app.post("/api/prisma/screen", async (request) => {
    const body = prismaScreenSchema.parse(request.body);
    const { prismaScreen } = await import("../services/prisma-service.js");
    const decisions = await prismaScreen(body);
    const { prismaSummary } = await import("../services/prisma-service.js");
    return { ok: true, decisions, summary: prismaSummary({ searchTotal: body.papers.length, decisions }) };
  });

  // ─── 文献提取矩阵 API(2026-09-04: 参考 Elicit 数据提取成表) ───
  // POST /api/literature/matrix { paperIds, columns: [{key,label}] }
  const matrixSchema = z.object({
    paperIds: z.array(z.string()).min(1).max(30),
    columns: z.array(z.object({ key: z.string().max(40), label: z.string().max(40) })).min(1).max(12),
    model: z.string().max(128).optional(),
  });
  app.post("/api/literature/matrix", async (request, reply) => {
    const body = matrixSchema.parse(request.body);
    const { buildLiteratureMatrix } = await import("../services/literature-matrix-service.js");
    try {
      const result = await buildLiteratureMatrix(body);
      return { ok: true, ...result };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "MATRIX_FAILED", message: msg } });
    }
  });

  // ─── 论文写作工作台 API(2026-09-04: 大纲编辑器+分章生成+docx 导出) ───
  // 分章生成: POST /api/paper-outline/chapter
  const outlineChapterSchema = z.object({
    nodeId: z.string().max(64),
    title: z.string().min(1).max(200),
    level: z.number().min(0).max(3),
    topic: z.string().min(1).max(500),
    thesis: z.string().max(1000).optional(),
    prevContext: z.string().max(20_000).optional(),
    outlineTree: z.string().max(10_000).optional(),
    style: z.string().max(200).optional(),
    model: z.string().max(128).optional(),
  });
  app.post("/api/paper-outline/chapter", async (request) => {
    const body = outlineChapterSchema.parse(request.body);
    const { generateChapter } = await import("../services/paper-outline-service.js");
    return generateChapter(body);
  });
  // 论文要件(摘要/关键词/结论/讨论): POST /api/paper-outline/component
  //   ⚠ 加档位要**三处同时改**: 这里、paper-outline-service 的 COMPONENT_SPEC 与类型、
  //     以及前端的 label 表与 sections 过滤白名单(见 FinalizeView.genComponent)。
  //     只改这里的话, 前端传上来的新 kind 会被 zod 挡在 400, 报错倒是不静默 —— 但改少了别处
  //     就会变成"参数过了、产出按错误的档生成"(旧实现是嵌套三元, 未知档静默按结论走)。
  const outlineComponentSchema = z.object({
    kind: z.enum(["abstract", "keywords", "conclusion", "discussion"]),
    topic: z.string().min(1).max(500),
    thesis: z.string().max(1000).optional(),
    sections: z.array(z.string()).max(30),
    chapterContents: z.array(z.string()).max(30).optional(),
    model: z.string().max(128).optional(),
  });
  app.post("/api/paper-outline/component", async (request) => {
    const body = outlineComponentSchema.parse(request.body);
    const { generateComponent } = await import("../services/paper-outline-service.js");
    return generateComponent(body);
  });
  // docx 导出: POST /api/paper-outline/export { paperTitle, nodes }
  const outlineExportSchema = z.object({
    paperTitle: z.string().min(1).max(200),
    nodes: z.array(z.unknown()).max(200),
    fontName: z.string().max(60).optional(),
    // R7: 字号来自编辑器预览预设(参考产品 formatPresets.docxFontSize) —— 与 fontName 配套
    fontSize: z.number().min(6).max(36).optional(),
    /**
     * V425: 目标体例 —— 让导出的 docx 带上该体例的行距与页边距。
     *
     * 由来(2026-09-24): 导出脚本里的页边距与行距原先**全是从 Word 模板继承的默认值**
     *   (python-docx 建空 Document 就是 2.54/3.17cm + 单倍行距), 从未显式设置过 ——
     *   于是"按目标期刊体例导出"这句话在 Word 文件上**根本不成立**, 用户拿到手还得自己调。
     *   取值就是 `/api/quality/format` 那四档(FORMAT_RULES 的键), 两处保持一致。
     */
    formatTarget: z.enum(["期刊论文", "学位论文", "党校期刊", "高校学报"]).optional(),
    // V417: 参考文献块。缺省时按"没接出可引文献"处理 → 文档里显式提醒人工补录(不伪造)
    references: z.object({
      text: z.string().max(200_000).optional(),
      needsManual: z.boolean().optional(),
      sources: z.array(z.string().max(40)).max(10).optional(),
    }).optional(),
    // 2026-09-26: 投稿声明(作者贡献/基金/利益冲突/致谢/数据可得性)。
    //   与 references 一样是可选的 —— 没填就不输出这一节(空标题会让编辑以为"声明了但没写")。
    declarations: z.record(z.string().max(4000)).optional(),
  });
  app.post("/api/paper-outline/export", async (request, reply) => {
    const body = outlineExportSchema.parse(request.body);
    const { exportOutlineDocx } = await import("../services/paper-outline-service.js");
    const result = await exportOutlineDocx({
      paperTitle: body.paperTitle, nodes: body.nodes as never[], fontName: body.fontName, fontSize: body.fontSize,
      formatTarget: body.formatTarget,
      references: body.references
        ? { text: body.references.text ?? "", needsManual: body.references.needsManual ?? false, sources: body.references.sources ?? [] }
        : undefined,
      declarations: body.declarations,
    });
    if (!result.ok || !result.base64) {
      return reply.code(502).send({ error: { code: "OUTLINE_EXPORT_FAILED", message: result.error ?? "docx 导出失败" } });
    }
    return { ok: true, base64: result.base64 };
  });
  // PPTX 导出: POST /api/paper-outline/export-pptx
  const outlineExportPptxSchema = z.object({
    paperTitle: z.string().min(1).max(200),
    nodes: z.array(z.unknown()).max(200),
    author: z.string().max(200).optional(),
  });
  app.post("/api/paper-outline/export-pptx", async (request, reply) => {
    const body = outlineExportPptxSchema.parse(request.body);
    const { exportOutlinePptx } = await import("../services/paper-outline-service.js");
    const result = await exportOutlinePptx({ paperTitle: body.paperTitle, nodes: body.nodes as never[], author: body.author });
    if (!result.ok || !result.base64) {
      return reply.code(502).send({ error: { code: "OUTLINE_PPTX_FAILED", message: result.error ?? "pptx 导出失败" } });
    }
    return { ok: true, base64: result.base64 };
  });
  // ─── Word 成品构建(2026-10-01: 自旧项目 AItoolman 移植) ───
  //
  // 补的是两块此前**完全空白**的能力:
  //   ① LaTeX → Word 公式(真 OMML, 不是图片/纯文本)
  //   ② Word 封面页 + 目录(TOC 域)
  // 实现: src/services/docx-build-service.ts → scripts/{latex_to_docx,add_cover_and_toc}.py
  //
  // 依赖自检: GET /api/docx-build/health —— "缺 latex2mathml"这件事必须有个地方能回答,
  //   否则用户点了导出才看到 ModuleNotFoundError(同 service-token 那次的教训)。
  app.get("/api/docx-build/health", async () => {
    const { checkDocxBuildDeps } = await import("../services/docx-build-service.js");
    const r = await checkDocxBuildDeps();
    return {
      ok: r.ok,
      python: r.python,
      missing: r.missing,
      hint: r.ok ? undefined : "缺依赖时执行: pip install python-docx latex2mathml lxml",
    };
  });
  // LaTeX 文本 → docx
  const latexToDocxSchema = z.object({
    content: z.string().min(1).max(2_000_000),
    title: z.string().max(200).optional(),
    fontName: z.string().max(60).optional(),
    fontSize: z.number().min(6).max(36).optional(),
  });
  app.post("/api/docx-build/latex-to-docx", async (request, reply) => {
    const body = latexToDocxSchema.parse(request.body);
    const { latexToDocx } = await import("../services/docx-build-service.js");
    const result = await latexToDocx(body);
    if (!result.ok || !result.base64) {
      return reply.code(502).send({
        error: { code: "LATEX_DOCX_FAILED", message: result.error ?? "LaTeX 转 Word 失败" },
      });
    }
    return { ok: true, base64: result.base64, meta: result.meta };
  });
  // 给已有 docx 加封面 + 目录
  const coverTocSchema = z.object({
    docxBase64: z.string().min(1).max(80_000_000),
    title: z.string().max(200).optional(),
    position: z.enum(["high", "center", "low"]).optional(),
    engine: z.enum(["auto", "python", "com"]).optional(),
  });
  app.post("/api/docx-build/cover-toc", async (request, reply) => {
    const body = coverTocSchema.parse(request.body);
    const { addCoverAndToc } = await import("../services/docx-build-service.js");
    const result = await addCoverAndToc(body);
    if (!result.ok || !result.base64) {
      return reply.code(502).send({
        error: { code: "COVER_TOC_FAILED", message: result.error ?? "封面目录生成失败" },
      });
    }
    return { ok: true, base64: result.base64, meta: result.meta };
  });
  // ═══════════════════════════════════════════════════════════════════════
  // 2026-10-01: 自旧项目 AItoolman 补的能力(共 9 项)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── 文献题录文件导入(WOS/RIS/BibTeX/CNKI/PubMed/Springer/arXiv/OpenAlex/S2/CSV/EndNote) ───
  app.get("/api/literature-import/formats", async () => {
    const { listFormats } = await import("../services/literature-import-service.js");
    return { formats: listFormats() };
  });
  /** 只解析不入库: 先让用户看清"识别成什么格式、前几条长什么样"再决定 */
  const litPreviewSchema = z.object({
    content: z.string().min(1).max(20_000_000),
    fileName: z.string().max(260).optional(),
    maxSample: z.number().int().min(1).max(50).optional(),
  });
  app.post("/api/literature-import/preview", async (request) => {
    const body = litPreviewSchema.parse(request.body);
    const { previewLiteratureFile } = await import("../services/literature-import-service.js");
    return previewLiteratureFile({
      bytes: Buffer.from(body.content, "utf8"),
      fileName: body.fileName,
      maxSample: body.maxSample,
    });
  });
  const litImportSchema = z.object({
    content: z.string().min(1).max(20_000_000),
    fileName: z.string().max(260).optional(),
    format: z.string().max(40).optional(),
    sourceId: z.string().uuid().optional(),
  });
  app.post("/api/literature-import/run", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = litImportSchema.parse(request.body);
    const svc = await import("../services/literature-import-service.js");
    const r = await svc.importLiteratureFile({
      bytes: Buffer.from(body.content, "utf8"),
      fileName: body.fileName ?? "",
      format: body.format as never,
      sourceId: body.sourceId,
    } as never);
    return r;
  });
  app.get("/api/literature-import/batches", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { listImportBatches } = await import("../services/literature-import-service.js");
    return { batches: await listImportBatches({ userId: user.id, limit: parseInt(q.limit || "30", 10) }) };
  });

  // ─── AIGC 率检测(与已有的"降 AIGC"配对, 形成 测→降→复测 闭环) ───
  const aigcSchema = z.object({
    text: z.string().min(1).max(2_000_000),
    lang: z.enum(["auto", "zh", "en"]).optional(),
  });
  app.post("/api/aigc/detect", async (request) => {
    const body = aigcSchema.parse(request.body);
    const { analyzeAigc } = await import("../services/aigc-detect-service.js");
    return analyzeAigc(body.text, { lang: body.lang ?? "auto" });
  });
  /** 改前/改后对比 —— 降重到底有没有用, 这里是判据 */
  app.post("/api/aigc/diff", async (request) => {
    const body = z.object({
      before: z.string().min(1).max(2_000_000),
      after: z.string().min(1).max(2_000_000),
      lang: z.enum(["auto", "zh", "en"]).optional(),
    }).parse(request.body);
    const { diffAigc } = await import("../services/aigc-detect-service.js");
    return diffAigc(body.before, body.after, { lang: body.lang ?? "auto" });
  });
  app.get("/api/aigc/calibration", async (request) => {
    const q = request.query as { lang?: string };
    const { getCalibration } = await import("../services/aigc-detect-service.js");
    return { calibration: getCalibration(q.lang === "en" ? "en" : "zh") };
  });

  // ─── AIGC 外接权威检测平台(2026-10-01) ───
  //
  // 与上面自研检测的分工: 自研那套回答"在我们的刻度上有多像 AI"(离线、免费、随时可跑);
  // 这一组回答"**期刊/学校指定的那一家**会怎么判"。两者结论可以不一致, 界面上并排显示 ——
  // 不一致本身就是有用的信息, 不该被抹平。
  //
  // ⚠ 全部 requireUser: 这里会用到用户的第三方密钥与额度, 必须落在他自己头上。
  /** 服务商清单 + 当前可用性(前端只从这渲染, 不在前端另抄一份) */
  app.get("/api/aigc/external/providers", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { diagnose } = await import("../services/aigc-external-service.js");
    return diagnose(user.id);
  });
  app.get("/api/aigc/external/credentials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { listCredentials } = await import("../services/aigc-external-service.js");
    return { credentials: await listCredentials(user.id) };
  });
  /**
   * ⚠ 用 `verifyToken(...).role` 判管理员, **不能用 `user.isAdmin`** ——
   *   `requireUser` 返回的是 `authService.getUserById` 的 User 对象, 它上面**没有 isAdmin
   *   这个字段**(admin 是 JWT payload 的 `role`, 见 auth-service.ts:25)。
   *   `user.isAdmin` 恒为 undefined ⇒ `!user.isAdmin` 恒真 ⇒ 这两个接口变成管理员也调不了,
   *   而且是 403 静默拒绝, 排查时容易怀疑到密钥本身。
   */
  const isAdminToken = (request: { headers: Record<string, unknown> }): boolean => {
    const token = String((request.headers.authorization || "") as string).replace("Bearer ", "").trim();
    return authService.verifyToken(token)?.role === "admin";
  };
  app.post("/api/aigc/external/credentials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      provider: z.string().min(1).max(60),
      apiKey: z.string().min(1).max(500),
      email: z.string().max(200).optional(),
      note: z.string().max(500).optional(),
      /** 平台级配置是全站共用一把密钥, 只对管理员开放 —— 普通用户配了会影响所有人 */
      scope: z.enum(["personal", "platform"]).optional(),
    }).parse(request.body);
    const scope = body.scope ?? "personal";
    if (scope === "platform" && !isAdminToken(request)) {
      reply.code(403);
      return { error: "平台级密钥会影响全部用户, 仅管理员可配置", code: "FORBIDDEN" };
    }
    const { saveCredential } = await import("../services/aigc-external-service.js");
    const r = await saveCredential({
      userId: scope === "platform" ? null : user.id,
      provider: body.provider, apiKey: body.apiKey, email: body.email, note: body.note,
    });
    if (!r.ok) { reply.code(400); return { error: r.error, code: "BAD_REQUEST" }; }
    return { ok: true };
  });
  app.delete("/api/aigc/external/credentials/:provider", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { provider: string };
    const q = request.query as { scope?: string };
    const scope = q.scope === "platform" ? "platform" : "personal";
    if (scope === "platform" && !isAdminToken(request)) {
      reply.code(403);
      return { error: "平台级密钥仅管理员可删", code: "FORBIDDEN" };
    }
    const { deleteCredential } = await import("../services/aigc-external-service.js");
    return { ok: await deleteCredential(user.id, p.provider, scope) };
  });
  /** 向某一家平台送检 */
  app.post("/api/aigc/external/scan", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      provider: z.string().min(1).max(60),
      text: z.string().min(1).max(2_000_000),
      lang: z.enum(["zh", "en"]).optional(),
    }).parse(request.body);
    const { scanText } = await import("../services/aigc-external-service.js");
    const r = await scanText(user.id, body.provider, body.text, body.lang ?? "zh");
    if (!r.ok) { reply.code(400); return { error: r.error, code: "SCAN_FAILED", scanId: r.scanId }; }
    return r;
  });
  app.get("/api/aigc/external/scans", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { listScans } = await import("../services/aigc-external-service.js");
    return { scans: await listScans(user.id, parseInt(q.limit || "30", 10) || 30) };
  });
  /** 送检包 —— 给不提供 API 的平台(知网/维普/朱雀…)用 */
  app.post("/api/aigc/external/package", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      provider: z.string().min(1).max(60),
      title: z.string().max(300).optional(),
      text: z.string().min(1).max(2_000_000),
    }).parse(request.body);
    const { buildSubmissionPackage } = await import("../services/aigc-external-service.js");
    const r = buildSubmissionPackage({ provider: body.provider, title: body.title ?? "", text: body.text });
    if (!r.ok) { reply.code(400); return { error: r.error, code: "BAD_REQUEST" }; }
    return r;
  });
  /** 人工送检回填 */
  app.post("/api/aigc/external/manual", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      provider: z.string().min(1).max(60),
      title: z.string().max(300).optional(),
      score: z.number().min(0).max(100).nullable().optional(),
      verdict: z.string().max(40).nullable().optional(),
      referenceNo: z.string().max(200).optional(),
      rawExcerpt: z.string().max(4000).optional(),
      evidenceRel: z.string().max(600).optional(),
      text: z.string().max(2_000_000).optional(),
    }).parse(request.body);
    const { submitManual } = await import("../services/aigc-external-service.js");
    const r = await submitManual({
      userId: user.id, provider: body.provider, title: body.title,
      score: body.score ?? null, verdict: body.verdict ?? null,
      referenceNo: body.referenceNo, rawExcerpt: body.rawExcerpt,
      evidenceRel: body.evidenceRel, text: body.text,
    });
    if (!r.ok) { reply.code(400); return { error: r.error, code: "BAD_REQUEST" }; }
    return r;
  });
  app.get("/api/aigc/external/manual", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { listManual } = await import("../services/aigc-external-service.js");
    return { submissions: await listManual(user.id, parseInt(q.limit || "50", 10) || 50) };
  });
  app.delete("/api/aigc/external/manual/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const { deleteManual } = await import("../services/aigc-external-service.js");
    return { ok: await deleteManual(user.id, p.id) };
  });

  // ─── PPT 第二条路径: 走外部技能(2026-10-01) ───
  //
  // 与上面自建管线的分工见 ppt-skill-service.ts 头部。一句话: 自建管线快、可单页重生;
  // 技能路径慢、贵, 但版式与叙事是技能作者迭代过的。
  // ⚠ 技能执行体是 **Agent**, 不是服务端函数 —— 这里只负责选技能/备料/建任务。
  app.get("/api/ppt/skills", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { listPptSkills, SKILL_PATH_NOTE } = await import("../services/ppt-skill-service.js");
    return { skills: listPptSkills(), note: SKILL_PATH_NOTE };
  });
  app.post("/api/ppt/skill-run", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      skillId: z.string().min(1).max(80),
      title: z.string().min(1).max(300),
      topic: z.string().max(500).optional(),
      sourceText: z.string().max(500_000).optional(),
      wishPages: z.number().int().min(1).max(80).optional(),
      extra: z.string().max(2000).optional(),
      projectId: z.string().max(80).optional(),
    }).parse(request.body);
    const { buildSkillPrompt } = await import("../services/ppt-skill-service.js");
    const built = buildSkillPrompt({
      skillId: body.skillId, title: body.title, topic: body.topic,
      sourceText: body.sourceText, wishPages: body.wishPages, extra: body.extra,
    });
    if (!built.ok) { reply.code(400); return { error: built.error, code: "BAD_REQUEST" }; }
    /**
     * ⚠ 建任务但**不自动跑**。
     *
     * 与定时任务同一条纪律(见 agent-scheduled-runner 头部): 自动执行会消耗额度,
     * 而这一步动辄 5–10 分钟、按模型调用计费。用户点了按钮就该看到"任务已建好,
     * 点这里开始跑", 而不是钱在自己没看见的时候花掉。
     * 前端拿到 taskId 后给一个明确的启动入口(agent 任务面板已有启动按钮)。
     */
    const agentTaskService = await import("../services/agent-task-service.js");
    /**
     * ⚠ `projectId` **必须给一个默认值**, 不能留 undefined。
     *
     * 2026-10-01 实测踩到: 留空时任务的 project_id 是 NULL, 而步骤执行器把
     *   `task.projectId || undefined` 当 `sourceId` 发给 /api/reason/query ——
     *   那个字段是 `z.string().uuid()` **必填**, 于是 httpx 回
     *   `{error:{code:"BAD_REQUEST",message:"请求参数无效"}}` → 计划里的
     *   retrieve / reason 两步**双双失败**(且失败被记成"步骤完成")。
     *   更糟的是任务本身照样走到 completed, 用户看到的是一个"成功"的空任务。
     *
     * 用 DEFAULT_SOURCE(与 education-service / agent-tool-router 同一个常量):
     *   它是本仓"没有指定项目时"的既有约定, 指向平台自带的示例语料源。
     */
    const DEFAULT_SOURCE = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";
    /**
     * ⚠ 建任务之前，把**属于该用户的**素材推进 agent_workspace。
     *
     * 由来(2026-10-02): 上一轮给沙箱补了工作区围栏后，模型不能再引用绝对路径 ——
     *   而论文汇报真正要用的素材（上传的图、跑出来的回归图、论文 PDF 里的图表）
     *   都在各自模块的绝对路径上。当时留的取舍是"**把素材推进工作区，而不是
     *   放宽围栏**"，这里是那句话的接线。
     *
     * ⚠ 2026-10-02 修正一处**事实**: 第一版在这里内联读 `empirical/figures/`，
     *   我当时按"这会让任何用户拿到别人的图表"来描述它 —— 核实后**不是这样**：
     *   实证图表的存储**本来就没有归属概念**（图存在扁平的 `empirical/figures/` 下、
     *   没有 user_id；`GET /api/empirical/figures/:file` 也只要求登录、不校验归属）。
     *   所以第一版继承的是**既有现实**，不是我新引入的问题。
     *   但既然新代码要写归属，就按**明确带 user_id 过滤**来写（见 asset-source-service），
     *   别把一个已有的缺口再复制一份。
     *
     * 为什么在**建任务时**推、而不是等 execute 步骤：工作区是全局共享目录，
     *   而沙箱**只生成一次代码、没有第二轮**去看目录里有什么。素材必须开跑前就位，
     *   清单才能被生成提示读到（见 agent-tool-router 的 workspaceAssets）。
     */
    try {
      const { stageUserAssets, describeAssetSources } = await import("../services/asset-source-service.js");
      const r = await stageUserAssets(user.id);
      console.log(`[ppt] 素材: ${describeAssetSources(r)}`);
    } catch (e) {
      // 素材推进失败**不阻断**建任务 —— 没有配图也能出一份纯文字的稿子，
      //   而"因为取图失败就不让用户开始"是本末倒置。
      console.warn(`[ppt] 推进素材失败(不阻断): ${String((e as Error)?.message).slice(0, 160)}`);
    }
    const task = await agentTaskService.createAgentTask({
      projectId: body.projectId || DEFAULT_SOURCE,
      goal: built.prompt!,
      userId: user.id,
      contextHint: `PPT 技能生成：${body.skillId}`,
    });
    return { ok: true, taskId: task.id, skillId: body.skillId, promptChars: built.prompt!.length };
  });

  // ─── 邮箱验证码(OTP) ───
  const otpSendSchema = z.object({
    email: z.string().max(200),
    purpose: z.enum(["register", "reset", "bind", "login"]),
  });
  app.post("/api/auth/otp/send", async (request, reply) => {
    const body = otpSendSchema.parse(request.body);
    const { sendOtp } = await import("../services/email-otp-service.js");
    const ip = String(request.socket?.remoteAddress ?? "");
    const r = await sendOtp({ email: body.email, purpose: body.purpose, ip });
    if (!r.ok) {
      return reply.code(r.code === "rate_limited" ? 429 : 400).send({ error: r.error, code: r.code });
    }
    // 生产路径**不回传验证码**, 只回有效期
    return { ok: true, expiresInSeconds: r.expiresInSeconds };
  });
  app.post("/api/auth/otp/verify", async (request, reply) => {
    const body = z.object({
      email: z.string().max(200),
      code: z.string().max(12),
      purpose: z.enum(["register", "reset", "bind", "login"]),
    }).parse(request.body);
    const { verifyOtp } = await import("../services/email-otp-service.js");
    const r = await verifyOtp(body);
    if (!r.ok) return reply.code(400).send({ error: r.error, code: r.code });
    return { ok: true };
  });

  // ─── 关键词共现聚类图谱 ───
  //
  // 两种输入: 前端直接传文本(`texts`), 或从平台文献库现算(`from-library`)。
  // 服务侧的 `loadLibraryDocs()` 是**同步**的(读的是literatureService内存索引),
  //   所以 from-library 这条要自己把 docs 喂给 build*, 而不是传 userId 进去。
  const kwNetSchema = z.object({
    texts: z.array(z.string().max(500_000)).min(1).max(2000),
    lang: z.enum(["zh", "en", "both"]).optional(),
    windowSize: z.number().int().min(2).max(20).optional(),
    measure: z.enum(["jaccard", "pmi", "count"]).optional(),
    minCount: z.number().int().min(1).max(100).optional(),
    maxNodes: z.number().int().min(5).max(300).optional(),
  });
  app.post("/api/keyword-network/build", async (request) => {
    const body = kwNetSchema.parse(request.body);
    const svc = await import("../services/keyword-network-service.js");
    const docs = body.texts.map((t, i) => ({ id: `inline-${i}`, title: "", text: t }));
    const opts = {
      windowSize: body.windowSize, measure: body.measure,
      minCount: body.minCount, maxNodes: body.maxNodes,
    };
    if (body.lang === "both") return svc.buildBilingualNetworks(docs, opts);
    return svc.buildKeywordNetwork(docs, body.lang ?? "zh", opts);
  });
  /** 直接从平台文献库现算(前端不用把语料传上来) */
  app.post("/api/keyword-network/from-library", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      limit: z.number().int().min(1).max(500).optional(),
      topic: z.string().max(200).optional(),
      keyword: z.string().max(200).optional(),
      lang: z.enum(["zh", "en", "both"]).optional(),
      windowSize: z.number().int().min(2).max(20).optional(),
      measure: z.enum(["jaccard", "pmi", "count"]).optional(),
      maxNodes: z.number().int().min(5).max(300).optional(),
    }).parse(request.body ?? {});
    const svc = await import("../services/keyword-network-service.js");
    const docs = svc.loadLibraryDocs({
      topic: body.topic, keyword: body.keyword, limit: body.limit ?? 80,
    });
    if (!docs.length) {
      return reply.code(400).send({
        error: { code: "NO_DOCS", message: "文献库里没有可用于生成图谱的文本(先入库一些带正文的文献)" },
      });
    }
    const opts = { windowSize: body.windowSize, measure: body.measure, maxNodes: body.maxNodes };
    if (body.lang === "both") return svc.buildBilingualNetworks(docs, opts);
    return svc.buildKeywordNetwork(docs, body.lang ?? "zh", opts);
  });

  // ─── 词云 ───
  app.get("/api/wordcloud/health", async () => {
    const { wordcloudAvailable } = await import("../services/wordcloud-service.js");
    return await wordcloudAvailable();
  });
  app.post("/api/wordcloud/render", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    /**
     * ⚠ 两个字段名必须与服务侧的 `WordCloudInput` 一致。
     *
     * 这里踩过两次(2026-10-01 真机冒烟):
     *   ① 词频表原先写成 `freqs`, 而服务读的是 `frequencies` ——
     *      schema 把它剥掉后服务看到的是"什么都没给", 报「需要 text / texts / frequencies 之一」,
     *      调用方完全看不出是**字段名**的问题。
     *   ② `minCount` 原先没暴露 —— 短文本在默认门槛(2)下抽不出词, 用户只会看到
     *      「文本里没有提取到关键词」, 而那段话里明明有词。(服务侧现在会自动降档重试并回 note。)
     * 对齐口径: 入参直接照抄服务侧接口名, 不要另起简称。
     */
    const body = z.object({
      text: z.string().max(2_000_000).optional(),
      texts: z.array(z.string().max(2_000_000)).max(200).optional(),
      frequencies: z.array(z.object({ word: z.string().max(80), count: z.number() })).max(5000).optional(),
      lang: z.enum(["auto", "zh", "en"]).optional(),
      width: z.number().int().min(200).max(4000).optional(),
      height: z.number().int().min(200).max(4000).optional(),
      maxWords: z.number().int().min(10).max(1000).optional(),
      topK: z.number().int().min(10).max(1000).optional(),
      minCount: z.number().int().min(1).max(100).optional(),
    }).parse(request.body);
    const svc = await import("../services/wordcloud-service.js");
    const r = await svc.getWordCloud(user.id, {
      ...body,
      lang: body.lang === "auto" ? undefined : body.lang,
    } as never);
    if (!r.ok) return reply.code(502).send({ error: { code: "WORDCLOUD_FAILED", message: r.error } });
    return r;
  });

  // ─── 舆情检索 ───
  app.get("/api/opinion/sources", async () => {
    /**
     * ⚠ 用服务侧**已有的** `describeSources()`, 不要自己拼字段。
     *
     * 踩过的坑(2026-10-01 实拍): 第一版猜常量名 `OPINION_SOURCES`(真名是
     *   `PUBLIC_OPINION_SOURCES`), `?? []` 把 undefined 吞成空数组 ——
     *   接口**返回 200 和 `{sources: []}`**, 界面上只显示"0 个源",
     *   既不报错也看不出哪里不对。**猜导出名 + `?? []` 是最容易静默失败的一种写法**。
     */
    const { describeSources } = await import("../services/opinion-sources.js");
    return { sources: describeSources() };
  });
  const opinionSchema = z.object({
    query: z.string().min(1).max(300),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    categories: z.array(z.string().max(40)).max(10).optional(),
    useCache: z.boolean().optional(),
    analyzeSentiment: z.boolean().optional(),
  });
  app.post("/api/opinion/search", async (request) => {
    const body = opinionSchema.parse(request.body);
    const { searchOpinion } = await import("../services/opinion-search-service.js");
    return await searchOpinion(body as never);
  });
  app.post("/api/opinion/sentiment", async (request) => {
    const body = z.object({
      texts: z.array(z.string().max(100_000)).min(1).max(500),
    }).parse(request.body);
    const svc = await import("../services/sentiment-service.js");
    const results = svc.analyzeSentimentBatch(body.texts);
    return { results, distribution: svc.distributionOf(results) };
  });

  // ─── PPT 生成工作台(旧项目 M9 的对位重建) ───
  //
  // 生成是**长任务**: 建任务 → 出大纲 → 改大纲 → 出脚本 → 配图 → 导出。
  // 每一步都靠 jobId 串起来, 中途可停可恢复(见 ppt-workbench-service.recoverJob)。
  app.post("/api/ppt/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({
      kind: z.enum(["topic", "paper", "outline"]).optional(),
      topic: z.string().min(1).max(500),
      title: z.string().max(200).optional(),
      sourceRef: z.string().max(200).optional(),
      style: z.string().max(300).optional(),
      wishPages: z.number().int().min(3).max(60).optional(),
      maxBullets: z.number().int().min(1).max(12).optional(),
    }).parse(request.body);
    const svc = await import("../services/ppt-workbench-service.js");
    const r = await svc.createJob({
      userId: user.id,
      topic: body.topic,
      title: body.title,
      sourceKind: body.kind,
      sourceRef: body.sourceRef,
      style: body.style,
      maxBullets: body.maxBullets,
    });
    if (!r.ok) return reply.code(400).send({ error: { code: "PPT_JOB_FAILED", message: r.error } });
    /**
     * 建任务**顺手把大纲也生成了**。
     *
     * 由来(2026-10-01 真机冒烟): `createJob` 只插了一行 job 记录, **一页都没有** ——
     *   而 `generateJobOutline` 服务里一直有、路由却**没接**。前端于是停在"0 页"上,
     *   后面"生成脚本/配图/导出"全都没得可做, 用户看到的是"点了新建, 什么都没发生"。
     *   现在建完直接出大纲(失败不阻断建任务: 用户还能改名/重试)。
     */
    let outlinePages = 0;
    try {
      const o = await svc.generateJobOutline({
        userId: user.id, jobId: r.job!.id, wantPages: body.wishPages,
      });
      if (o.ok) outlinePages = o.outline?.pages?.length ?? 0;
    } catch { /* 大纲失败不阻断 —— 前端有"重新生成大纲"可用 */ }
    return { ...r, wishPages: body.wishPages, outlinePages };
  });
  /** 单独重生成大纲(改了主题/页数后重来) */
  app.post("/api/ppt/jobs/:id/outline", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const body = z.object({
      wantPages: z.number().int().min(3).max(60).optional(),
      sourceText: z.string().max(500_000).optional(),
    }).parse(request.body ?? {});
    const { generateJobOutline } = await import("../services/ppt-workbench-service.js");
    const r = await generateJobOutline({ userId: user.id, jobId: p.id, ...body });
    if (!r.ok) return reply.code(502).send({ error: { code: "PPT_OUTLINE_FAILED", message: r.error } });
    return { ok: true, pages: r.outline?.pages?.length ?? 0 };
  });
  app.get("/api/ppt/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { listJobs } = await import("../services/ppt-workbench-service.js");
    return { jobs: await listJobs(user.id) };
  });
  app.get("/api/ppt/jobs/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const svc = await import("../services/ppt-workbench-service.js");
    const job = await svc.getJob(user.id, p.id);
    if (!job) return reply.code(404).send({ error: "任务不存在" });
    return { job, progress: await svc.jobProgress(user.id, p.id) };
  });
  app.get("/api/ppt/jobs/:id/pages", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const { listPages } = await import("../services/ppt-workbench-service.js");
    return { pages: await listPages(user.id, p.id) };
  });
  app.put("/api/ppt/jobs/:id/outline", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const body = z.object({
      action: z.enum(["add", "remove", "update", "move", "resize"]),
      pageIndex: z.number().int().optional(),
      toIndex: z.number().int().optional(),
      patch: z.record(z.unknown()).optional(),
      wantPages: z.number().int().min(3).max(60).optional(),
    }).parse(request.body);
    const svc = await import("../services/ppt-workbench-service.js");
    const r = await svc.editOutline({ userId: user.id, jobId: p.id, ...body } as never);
    if (!(r as { ok?: boolean }).ok) {
      return reply.code(400).send({ error: (r as { error?: string }).error ?? "大纲编辑失败" });
    }
    return r;
  });
  app.post("/api/ppt/jobs/:id/scripts", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const { generateScripts } = await import("../services/ppt-workbench-service.js");
    // 一次生成**所有还没脚本的页**(服务侧自己跳过已完成的, 支持中断续跑)
    return await generateScripts({ userId: user.id, jobId: p.id });
  });
  /** 单页重生 —— 只动这一页, 其它页不受影响 */
  app.post("/api/ppt/jobs/:id/pages/:seq/regen", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string; seq: string };
    const body = z.object({
      instruction: z.string().max(2000).optional(),
      force: z.boolean().optional(),
    }).parse(request.body ?? {});
    const { regenPage } = await import("../services/ppt-workbench-service.js");
    return await regenPage({ userId: user.id, jobId: p.id, seq: parseInt(p.seq, 10), ...body });
  });
  /** 批注重绘: 框选一块 → 只改那一块 */
  app.post("/api/ppt/jobs/:id/pages/:seq/annotate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string; seq: string };
    const body = z.object({
      note: z.string().max(2000),
      rect: z.object({
        x: z.number(), y: z.number(), w: z.number(), h: z.number(),
      }),
    }).parse(request.body);
    const { annotateAndRegen } = await import("../services/ppt-workbench-service.js");
    return await annotateAndRegen({
      userId: user.id, jobId: p.id, seq: parseInt(p.seq, 10), note: body.note, rect: body.rect,
    } as never);
  });
  app.post("/api/ppt/jobs/:id/illustrate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const body = z.object({ seq: z.number().int().min(0).optional() }).parse(request.body ?? {});
    const svc = await import("../services/ppt-workbench-service.js");
    // 传 seq = 只配这一页; 不传 = 配所有还没图的正文页
    if (body.seq !== undefined) {
      return await svc.illustratePage({ userId: user.id, jobId: p.id, seq: body.seq });
    }
    return await svc.illustrateAll({ userId: user.id, jobId: p.id });
  });
  app.get("/api/ppt/jobs/:id/pages/:seq/versions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string; seq: string };
    const { pageVersions } = await import("../services/ppt-workbench-service.js");
    return { versions: await pageVersions(user.id, p.id, parseInt(p.seq, 10)) };
  });
  app.post("/api/ppt/jobs/:id/pages/:seq/rollback", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string; seq: string };
    const body = z.object({ version: z.number().int().min(0) }).parse(request.body);
    const { rollbackPage } = await import("../services/ppt-workbench-service.js");
    return await rollbackPage(user.id, p.id, parseInt(p.seq, 10), body.version);
  });
  /** 导出: mode=editable(可改) / image(每页位图, 不可改) */
  app.post("/api/ppt/jobs/:id/export", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const body = z.object({
      mode: z.enum(["editable", "image"]).optional(),
      includeNotes: z.boolean().optional(),
    }).parse(request.body ?? {});
    const svc = await import("../services/ppt-workbench-service.js");
    const r = await svc.exportPptx({ userId: user.id, jobId: p.id, ...body } as never);
    if (!(r as { ok?: boolean }).ok) {
      return reply.code(502).send({ error: { code: "PPT_EXPORT_FAILED", message: (r as { error?: string }).error } });
    }
    return r;
  });
  app.delete("/api/ppt/jobs/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { id: string };
    const { deleteJob } = await import("../services/ppt-workbench-service.js");
    return await deleteJob(user.id, p.id);
  });
  app.get("/api/ppt/health", async () => {
    const { diagnose } = await import("../services/ppt-workbench-service.js");
    return await diagnose();
  });

  // ─── 论文取证 API(2026-09-04: integrity-auditor forensics_tools, ai4s MIT) ───  // 图片查重: POST { images: [{name, base64}] } → 两两比较 dHash/aHash
  const forensicsImageSchema = z.object({
    images: z.array(z.object({ name: z.string().max(256), base64: z.string() })).min(2, "至少 2 张图片").max(12),
  });
  app.post("/api/forensics/image-dup", async (request, reply) => {
    const body = forensicsImageSchema.parse(request.body);
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { imageDuplicateCheck, cleanupTemp } = await import("../services/forensics-service.js");
    const tmpFiles: string[] = [];
    try {
      for (const img of body.images) {
        const ext = path.extname(img.name) || ".png";
        const tmp = path.join(os.tmpdir(), `fimg-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        fs.writeFileSync(tmp, Buffer.from(img.base64, "base64"));
        tmpFiles.push(tmp);
      }
      const result = await imageDuplicateCheck(tmpFiles);
      if (!result.ok) return reply.code(502).send({ error: { code: "FORENSICS_FAILED", message: result.error ?? "图片查重失败" } });
      return { ok: true, raw: result.raw };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "FORENSICS_ERROR", message } });
    } finally {
      cleanupTemp(...tmpFiles);
    }
  });
  // 数值取证: POST { files: [{name, base64}], mode: "decimal"|"magnitude"|"aggregate" }
  const forensicsNumSchema = z.object({
    files: z.array(z.object({ name: z.string().max(256), base64: z.string() })).min(1).max(6),
    mode: z.enum(["decimal", "magnitude", "aggregate"]).default("decimal"),
  });
  app.post("/api/forensics/numeric", async (request, reply) => {
    const body = forensicsNumSchema.parse(request.body);
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { numericForensics, cleanupTemp } = await import("../services/forensics-service.js");
    const tmpFiles: string[] = [];
    try {
      for (const f of body.files) {
        const ext = path.extname(f.name) || ".xlsx";
        const tmp = path.join(os.tmpdir(), `fnum-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        fs.writeFileSync(tmp, Buffer.from(f.base64, "base64"));
        tmpFiles.push(tmp);
      }
      const result = await numericForensics(tmpFiles, body.mode);
      if (!result.ok) return reply.code(502).send({ error: { code: "FORENSICS_FAILED", message: result.error ?? "数值取证失败" } });
      return { ok: true, raw: result.raw };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "FORENSICS_ERROR", message } });
    } finally {
      cleanupTemp(...tmpFiles);
    }
  });
  // ─── 格式智能评测 API(2026-09-03: 规则引擎+LLM 双层) ───
  // 模板清单: GET → { templates: FormatTemplate[] }
  app.get("/api/format-eval/templates", async () => {
    const { BUILTIN_TEMPLATES } = await import("../services/format-eval-templates.js");
    return { templates: BUILTIN_TEMPLATES };
  });
  // 规则目录: GET → { rules: RuleCatalogItem[] }(前端评测前常驻清单)
  app.get("/api/format-eval/rules", async () => {
    const { RULE_CATALOG } = await import("../services/format-eval-engine.js");
    return { rules: RULE_CATALOG };
  });
  // 评测: POST { text, templateId?, template?, llm?, model? }
  const formatEvalCheckSchema = z.object({
    text: z.string().min(50, "文本过短, 至少 50 字").max(200_000, "文本过长, 上限 20 万字"),
    templateId: z.string().max(64).optional(),
    template: z.record(z.unknown()).optional(),
    llm: z.boolean().optional(),
    model: z.string().max(128).optional(),
  });
  app.post("/api/format-eval/check", async (request) => {
    const body = formatEvalCheckSchema.parse(request.body);
    const { runFormatEval } = await import("../services/format-eval-service.js");
    return runFormatEval(body);
  });
  // .docx 检查: POST { docxBase64, fileName?, templateId?, preset? } — base64 JSON 传输(免 multipart)
  const formatDocxSchema = z.object({
    docxBase64: z.string().min(100, "docx 内容过短").max(50_000_000, "docx 过大(>50MB base64)"),
    fileName: z.string().max(256).optional(),
    templateId: z.string().max(64).optional(),
    template: z.record(z.unknown()).optional(),
    preset: z.string().max(64).optional(),
  });
  app.post("/api/format-eval/check-docx", async (request, reply) => {
    const body = formatDocxSchema.parse(request.body);
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { resolveTemplate } = await import("../services/format-eval-templates.js");
    const { checkDocxFull, extractDocxTemplate } = await import("../services/format-docx-service.js");
    // docx 也要服务端算真实统计(score/规则清单), 前端不硬编码
    const { summarizeForDocx } = await import("../services/format-eval-engine.js");
    const tmpFile = path.join(os.tmpdir(), `fmt-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
    try {
      fs.writeFileSync(tmpFile, Buffer.from(body.docxBase64, "base64"));
      const tpl = resolveTemplate(body.templateId, body.template);
      const result = await checkDocxFull(tmpFile, tpl, body.preset ?? "ncwu");
      if (!result.ok) {
        return reply.code(502).send({ error: { code: "DOCX_CHECK_FAILED", message: result.error ?? "docx 检查失败" } });
      }
      // 合并 style+text findings → 完整 stats(score 等) + 规则清单
      const all = [...result.styleFindings, ...result.textFindings];
      const { ruleStatuses, score, stats } = summarizeForDocx(all);
      return {
        ok: true,
        styleFindings: result.styleFindings,
        textFindings: result.textFindings,
        ruleStatuses,
        stats: { score, totalRules: ruleStatuses.length, passed: stats.passed, errors: stats.errors, warnings: stats.warnings, infos: stats.infos, byCategory: stats.byCategory },
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "DOCX_CHECK_ERROR", message } });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* 忽略清理失败 */ }
    }
  });
  // 学校模板规则提取: POST { docxBase64(学校模板) }
  const templateExtractSchema = z.object({
    docxBase64: z.string().min(100).max(50_000_000),
  });
  app.post("/api/format-eval/extract-template", async (request, reply) => {
    const body = templateExtractSchema.parse(request.body);
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { extractDocxTemplate } = await import("../services/format-docx-service.js");
    const tmpFile = path.join(os.tmpdir(), `tpl-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
    try {
      fs.writeFileSync(tmpFile, Buffer.from(body.docxBase64, "base64"));
      const result = await extractDocxTemplate(tmpFile);
      if (!result.ok || !result.output) {
        return reply.code(502).send({ error: { code: "TEMPLATE_EXTRACT_FAILED", message: result.error ?? "模板提取失败" } });
      }
      const rules = fs.readFileSync(result.output, "utf8");
      try { fs.unlinkSync(result.output); } catch { /* 忽略 */ }
      const parsed = JSON.parse(rules);
      return { ok: true, rules: parsed, warnings: result.warnings ?? [] };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "TEMPLATE_EXTRACT_ERROR", message } });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
    }
  });
  // 自动格式化: POST { docxBase64, formatGuideBase64? } — 调 paper_format_agent(MIT, 内容指纹保护)
  // 产物: 格式化 docx(base64 回传) + 指纹报告(前后评分/指纹一致性)
  const formatRunSchema = z.object({
    docxBase64: z.string().min(100, "docx 内容过短").max(50_000_000, "docx 过大(>50MB base64)"),
    formatGuideBase64: z.string().max(50_000_000).optional(),
  });
  app.post("/api/format-eval/format", async (request, reply) => {
    const body = formatRunSchema.parse(request.body);
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { formatDocxPaper } = await import("../services/format-docx-service.js");
    const tmpPaper = path.join(os.tmpdir(), `fmt-paper-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
    let tmpGuide: string | null = null;
    try {
      fs.writeFileSync(tmpPaper, Buffer.from(body.docxBase64, "base64"));
      if (body.formatGuideBase64) {
        tmpGuide = path.join(os.tmpdir(), `fmt-guide-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
        fs.writeFileSync(tmpGuide, Buffer.from(body.formatGuideBase64, "base64"));
      }
      const result = await formatDocxPaper(tmpPaper, tmpGuide);
      if (!result.ok || !result.formattedBase64) {
        return reply.code(502).send({ error: { code: "FORMAT_FAILED", message: result.error ?? "格式化失败" } });
      }
      return { ok: true, formattedBase64: result.formattedBase64, report: result.report ?? {} };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "FORMAT_ERROR", message } });
    } finally {
      try { fs.unlinkSync(tmpPaper); } catch { /* 忽略 */ }
      if (tmpGuide) { try { fs.unlinkSync(tmpGuide); } catch { /* 忽略 */ } }
    }
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
  //
  // 由来(2026-09-29 用户:「系统管理里的文档中心需要全量更新」): 此前这份索引是**手写死的
  //   25 条**, 而 `docs/` 里实际有 **60 个 md** —— 缺的 35 个正好是近期那批能力文档
  //   (实证台/文献管理/写作证据链/学习引擎/记忆/多Agent/模型/IM/Computer Use 等)。
  //   手写清单只会随"某次有人记得改"而更新, 于是必然腐烂, 而且**没有任何东西会发现**。
  //
  // 现在改为**扫描 docs/ 自动生成**: 标题取文件里的 H1, 分组由一张显式表决定。
  //   新增一个 .md 会自动出现在文档中心 —— 不需要改这里。
  //   `test/docs-index.test.ts` 盯着两件事: 每个文件都被收录、每条都能读到(没有死链)。
  const DOCS_ROOT = path.join(rootDir, "docs");

  /** 显示顺序即此数组顺序 */
  const DOC_GROUP_ORDER = [
    "快速上手", "平台概览", "能力手册", "架构与设计", "接口与集成",
    "Agent", "评测", "运维与部署", "合规", "工程记录", "其他",
  ];

  /**
   * 文件 → 分组。**显式**, 不用正则猜 —— 猜错的分组没人看得见。
   * 没列到的落到「其他」(守卫测试会报出来, 不会静默)。
   */
  const DOC_GROUP_OF: Record<string, string> = {
    // 快速上手
    "index.md": "快速上手", "quickstart.md": "快速上手", "cookbook.md": "快速上手",
    "FAQ.md": "快速上手", "GLOBAL-USAGE.md": "快速上手",
    // 平台概览
    "overview.md": "平台概览", "PROJECT-OVERVIEW.md": "平台概览",
    "project-brief.md": "平台概览", "FEATURES-DETAILED.md": "平台概览",
    // 能力手册(面向使用者)
    "EMPIRICAL-WORKBENCH.md": "能力手册", "LITERATURE-MANAGEMENT.md": "能力手册",
    "WRITING-EVIDENCE-CHAIN.md": "能力手册", "LEARNING-ENGINE.md": "能力手册",
    "MEMORY.md": "能力手册", "MULTI-AGENT.md": "能力手册", "MODELS.md": "能力手册",
    "IM-INTEGRATION.md": "能力手册", "COMPUTER-USE.md": "能力手册",
    // 架构与设计
    "ARCHITECTURE.md": "架构与设计",  // docs/ARCHITECTURE.md（根目录同名旧版已删）
    "DATA-HASH-VERSIONING-DESIGN.md": "架构与设计", "PROVENANCE-DESIGN.md": "架构与设计",
    "COMMERCIAL-ARCHITECTURE.md": "架构与设计",
    // 接口与集成
    "api-reference.md": "接口与集成", "API-INTEGRATION.md": "接口与集成",
    "agent-api.md": "接口与集成", "agent-env.md": "接口与集成",
    "DATA-SOURCES-GUIDE.md": "接口与集成", "SKILLS-GUIDE.md": "接口与集成",
    "integrations/claude-code.md": "接口与集成", "integrations/codex-cli.md": "接口与集成",
    "integrations/deepseek-harness.md": "接口与集成",
    // Agent
    "AGENT-CAPABILITIES.md": "Agent", "AGENT-ARCHITECTURE-NEXT.md": "Agent",
    // 评测
    "SCORING_STANDARD.md": "评测", "EDU-EVALUATION.md": "评测",
    // 运维与部署
    "DEPLOYMENT.md": "运维与部署", "DEPLOYMENT-GUIDE.md": "运维与部署",
    "BACKUP-RESTORE.md": "运维与部署", "CONTRIBUTING.md": "运维与部署",
    "DESKTOP.md": "运维与部署",
    // 合规
    "OPEN-SOURCE-DISCLOSURE.md": "合规",
  };

  /**
   * 少数 H1 不适合直接当标题的, 在这里改。
   * 其余一律用文件里的 H1 —— 标题写在文档里, 不在代码里再抄一份。
   */
  const DOC_TITLE_OVERRIDE: Record<string, string> = {
    "index.md": "文档中心首页",
    "FEATURES-DETAILED.md": "功能明细(52 步/78 场景/158 工具)",
    "LEARNING-ENGINE.md": "学习引擎",
    "DATA-HASH-VERSIONING-DESIGN.md": "文献入库哈希版本化(设计)",
    "PROVENANCE-DESIGN.md": "文件级 provenance(设计)",
    "GLOBAL-USAGE.md": "在任意目录启动",
    "CONTRIBUTING.md": "贡献与质量门禁",
    "BACKUP-RESTORE.md": "知识库备份与恢复",
  };

  const DOC_ID_OVERRIDE: Record<string, string> = {
    "index.md": "overview",   // 默认页沿用老 id
    // ⚠ 2026-09-30 补: `overview.md` 的 basename 恰好也是 `overview`, 与上面 index.md 的 id
    //   **撞车** —— 索引里于是有两条 id:"overview", 而 DocsPanel 按 id 取值时
    //   永远先命中排前面的 index.md, 结果 **`overview.md` 在界面上永久不可达**(41 条只有 40 个唯一 id)。
    //   改完由 `test/docs-index.test.ts` 的「索引 id 不重复」兜住。
    "overview.md": "platform-overview",
    "PROJECT-OVERVIEW.md": "project-overview",
    "project-brief.md": "project-brief",
    "FEATURES-DETAILED.md": "features-detail",
    "OPEN-SOURCE-DISCLOSURE.md": "open-source-disclosure",
    "integrations/claude-code.md": "claude-code",
    "integrations/codex-cli.md": "codex-cli",
    "integrations/deepseek-harness.md": "deepseek-harness",
  };

  /** 组内排序: 列在这里的排前面(按声明顺序), 其余按文件名。 */
  const DOC_PINNED = [
    "index.md", "quickstart.md", "cookbook.md", "FAQ.md", "GLOBAL-USAGE.md",
    "overview.md", "PROJECT-OVERVIEW.md", "project-brief.md", "FEATURES-DETAILED.md",
  ];

  /** 扫描 docs/ 下的 md(跳过点目录与 assets), 生成索引 */
  function buildDocIndex(): Array<{ id: string; path: string; title: string; group: string }> {
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "assets") continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.name.toLowerCase().endsWith(".md")) files.push(rel);
      }
    };
    walk(DOCS_ROOT, "");

    const out: Array<{ id: string; path: string; title: string; group: string }> = [];
    for (const rel of files) {
      let title = "";
      try {
        // 标题取文件里的第一个 H1 —— 不为它在这里再维护一份副本
        const txt = fs.readFileSync(path.join(DOCS_ROOT, rel), "utf-8");
        title = (txt.split("\n").find((l) => l.startsWith("# ")) ?? "").slice(2).trim();
      } catch { /* 读不到就用文件名兜底 */ }
      const base = rel.slice(rel.lastIndexOf("/") + 1, -3);   // 去目录与 .md
      out.push({
        id: DOC_ID_OVERRIDE[rel] ?? base,
        path: rel,
        title: DOC_TITLE_OVERRIDE[rel] ?? title ?? base,
        group: DOC_GROUP_OF[rel] ?? "其他",
      });
    }
    const rank = (r: string) => { const i = DOC_PINNED.indexOf(r); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    out.sort((a, b) =>
      DOC_GROUP_ORDER.indexOf(a.group) - DOC_GROUP_ORDER.indexOf(b.group)
      || rank(a.path) - rank(b.path)
      || a.path.localeCompare(b.path));
    return out;
  }

  /** 启动时扫一次。docs/ 是随代码发布的, 运行期不会变 —— 不必每次请求都扫。 */
  const DOC_INDEX = buildDocIndex();

  app.get("/api/docs", async (request) => {
    const query = request.query as { id?: string };
    const id = query.id || "overview";
    const entry = DOC_INDEX.find((d) => d.id === id) ?? DOC_INDEX[0];
    const filePath = path.join(DOCS_ROOT, entry.path);
    let content = "";
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { content = "# 文档未找到\n\n该文档不存在或已被移动。"; }
    return {
      // path 一起发: 文档正文里的相对链接是按文件名写的, 前端靠它反查成 id 才能"切到该文档"
      index: DOC_INDEX.map((d) => ({ id: d.id, title: d.title, group: d.group, path: d.path })),
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
        const j = JSON.parse(fs.readFileSync(dataPath("education-cases.json"), "utf-8"));
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
      else if (body.kind === "cases") dir = dataRoot();
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

  // ─── L1 学习者画像（2026-08-29, 借鉴 Inno Agent L1 learner profile）───
  // GET /api/education/learner/goals — 学习目标列表
  app.get("/api/education/learner/goals", async (request) => {
    const q = request.query as { studentId?: string };
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.listGoals({ studentId: q.studentId });
  });
  // POST /api/education/learner/goals — 创建/更新学习目标
  app.post("/api/education/learner/goals", async (request) => {
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.upsertGoal(request.body as any);
  });
  // POST /api/education/learner/goals/:id/archive — 归档目标
  app.post("/api/education/learner/goals/:id/archive", async (request) => {
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.archiveGoal({ id: (request.params as any).id, reason: ((request.body ?? {}) as any).reason });
  });
  // GET /api/education/learner/misconceptions — 误解列表
  app.get("/api/education/learner/misconceptions", async (request) => {
    const q = request.query as { studentId?: string; status?: "open" | "resolved" };
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.listMisconceptions({ studentId: q.studentId, status: q.status });
  });
  // POST /api/education/learner/misconceptions — 记录误解(答错诊断)
  app.post("/api/education/learner/misconceptions", async (request) => {
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.recordMisconception(request.body as any);
  });
  // POST /api/education/learner/misconceptions/:id/resolve — 标记已纠正
  app.post("/api/education/learner/misconceptions/:id/resolve", async (request) => {
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.resolveMisconception({ id: (request.params as any).id });
  });
  // GET /api/education/learner/context — 画像上下文包(注入系统提示词)
  app.get("/api/education/learner/context", async (request) => {
    const q = request.query as { studentId?: string; subject?: string };
    const { learnerGoalsService } = await import("../services/learner-goals-service.js");
    return await learnerGoalsService.buildProfileContext({ studentId: q.studentId, subject: q.subject });
  });

  // ─── 自动画像（2026-08-29, 移植 Inno Agent auto-profile.ts）───
  // POST /api/education/learner/events — 学习事件 → 自动更新画像
  app.post("/api/education/learner/events", async (request) => {
    const body = (request.body ?? {}) as {
      studentId?: string;
      event: {
        eventType: string;
        timestamp?: string;
        conceptIds?: string[];
        payload?: Record<string, unknown>;
        derivedSignals?: { masteryDelta?: number; preferenceCandidates?: string[]; misconceptionCandidates?: string[] };
      };
    };
    const { autoProfileService } = await import("../services/auto-profile.js");
    const studentId = body.studentId || "default";
    // 加载画像快照(最新)
    const { pool } = await import("../db/pool.js");
    const snap = await pool.query(
      "select profile from learner_profile_snapshots where student_id=$1 order by created_at desc limit 1",
      [studentId]
    ).catch(() => ({ rows: [] }));
    const profile = snap.rows[0]?.profile || { goals: [], knowledge: [], misconceptions: [], preferences: {} };
    const event = {
      eventType: body.event?.eventType || "exercise_attempt",
      timestamp: body.event?.timestamp || new Date().toISOString(),
      conceptIds: body.event?.conceptIds ?? [],
      payload: body.event?.payload ?? {},
      derivedSignals: body.event?.derivedSignals ?? {},
      eventId: body.event?.timestamp ? `evt:${body.event.timestamp}` : undefined,
    };
    const changed = autoProfileService.applyLearningEventToProfile(profile, event);
    if (changed) {
      await pool.query(
        "insert into learner_profile_snapshots (student_id, profile) values ($1, $2::jsonb)",
        [studentId, JSON.stringify(profile)]
      ).catch(() => {});
    }
    return { ok: true, changed, profile };
  });

  // GET /api/education/learner/events — 查看画像快照
  app.get("/api/education/learner/events", async (request) => {
    const q = request.query as { studentId?: string };
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      "select profile from learner_profile_snapshots where student_id=$1 order by created_at desc limit 1",
      [q.studentId || "default"]
    ).catch(() => ({ rows: [] }));
    return { ok: true, profile: r.rows[0]?.profile || { goals: [], knowledge: [], misconceptions: [], preferences: {} } };
  });

  // POST /api/education/learner/gate — 教学入口判断(前置知识诊断 + 回复协议)
  app.post("/api/education/learner/gate", async (request) => {
    const body = (request.body ?? {}) as { targetConceptId?: string; prerequisiteConceptId?: string; states?: any[] };
    const { teachingEntryGateService } = await import("../services/teaching-entry-gate.js");
    if (!body.targetConceptId || !body.prerequisiteConceptId) {
      return { ok: false, error: "需要 targetConceptId 与 prerequisiteConceptId" };
    }
    const decision = teachingEntryGateService.evaluateTeachingEntry({
      targetConceptId: body.targetConceptId,
      taskScope: `学习「${body.targetConceptId}」`,
      mode: "learning",
      isAtomic: false,
      prerequisites: [{
        targetConceptId: body.targetConceptId,
        prerequisiteConceptId: body.prerequisiteConceptId,
        relation: "required",
        requiredLevel: 0.6,
        importance: 0.8,
        source: "curated",
        sourceConfidence: 0.9,
        rationale: "教学诊断前置",
      }],
    }, (body.states || []) as any);
    const protocol = teachingEntryGateService.formatTeachingEntryDecision(decision);
    return { ok: true, action: decision.action, reason: decision.reason, protocol };
  });

  // POST /api/education/learner/rebuild — 从事件日志重建画像(升级 L1 规则后)
  app.post("/api/education/learner/rebuild", async (request) => {
    const body = (request.body ?? {}) as { studentId?: string };
    const { rebuildProfileService } = await import("../services/rebuild-profile.js");
    return await rebuildProfileService.rebuildProfileFromEvents(body.studentId || "default");
  });

  // GET /api/education/learner/context-pack — 学习者上下文包(每轮注入系统提示词)
  // 组合 context-pack 服务(状态机投影 + 偏好映射 + 复习调度) + 格式化
  app.get("/api/education/learner/context-pack", async (request) => {
    const q = request.query as { studentId?: string };
    const { pool } = await import("../db/pool.js");
    const studentId = q.studentId || "default";
    const snap = await pool.query(
      "select profile from learner_profile_snapshots where student_id=$1 order by created_at desc limit 1",
      [studentId]
    ).catch(() => ({ rows: [] }));
    const profile = snap.rows[0]?.profile || { goals: [], knowledge: [], misconceptions: [], preferences: {} };
    const { contextPackService } = await import("../services/context-pack.js");
    const pack = contextPackService.buildContextPack(profile);
    const formatted = contextPackService.formatContextPackForPrompt(pack);
    return { ok: true, pack, formatted };
  });

  // GET /api/notes/wiki/query — L2 wiki 查询(索引+关键词检索, 供 Agent 注入)
  app.get("/api/notes/wiki/query", async (request) => {
    const q = request.query as { q?: string };
    const { wikiQueryService } = await import("../services/wiki-query.js");
    return { ok: true, result: await wikiQueryService.queryWiki(q?.q || "") };
  });

  // GET /api/notes/wiki/graph — L2 wiki 加权图谱(节点/边/权重/统计)
  app.get("/api/notes/wiki/graph", async (request) => {
    const { wikiGraphService } = await import("../services/wiki-graph.js");
    const graph = await wikiGraphService.buildWikiGraph();
    const stats = await wikiGraphService.computeWikiGraphStats();
    return { ok: true, nodes: graph.nodes, edges: graph.edges, stats };
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
  app.post("/api/mode", async (request) => {
    const body = (request.body ?? {}) as { mode?: string };
    const mode = body.mode === "full" ? "full" : "preview";
    fs.writeFileSync(path.join(rootDir, "mode.json"), JSON.stringify({ mode, updatedAt: new Date().toISOString() }), "utf-8");
    return { ok: true, mode, note: "重启服务后生效（当前模式不变）" };
  });

  app.get("/api/model-call-logs", async (request) => {
    const query = request.query as { after?: string; history?: string; status?: string };
    const after = query.after ? Number(query.after) : 0;
    const live = listModelCallLogs(Number.isFinite(after) ? after : 0);
    // V417: 带 history=1 时把库里那份也带上 —— 内存环只有 500 条且重启即丢、多副本只看得到
    //   自己那一份; 历史读库才能回答"重启前那次为什么失败"。默认不开(热路径轮询别每次都查库)。
    if (query.history === "1") {
      const { listModelCallLogsFromDb } = await import("../observability/model-call-log.js");
      const status = query.status === "FAILED" || query.status === "SUCCEEDED" ? query.status : undefined;
      const dbLogs = await listModelCallLogsFromDb({ limit: 200, status });
      return { ...live, history: dbLogs };
    }
    return live;
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
    const body = request.body as { username?: string; password?: string; email?: string; inviteCode?: string };
    if (!(await allowAuthAttempt(request, body.username || ""))) return reply.code(429).send(authRateLimited);
    // 2026-10-02: 第四参数是邀请码。填错**不阻断注册**(register 内把警告放在 inviteWarning 里回传)
    const r = await authService.register(body.username || "", body.password || "", body.email, body.inviteCode);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // V390修复: 注册即登录 — 直接签发 JWT（原只返回 user, 前端无 token 导致计费/运营接口全部 401）
    const loginRes = await authService.login(body.username || "", body.password || "");
    // 邀请码的提示要**一起回给前端** —— 用户填了码却因"已被使用"没生效的话,
    // 只提示"注册成功"会让他以为奖励到账了
    const inviteExtra = { inviteWarning: r.inviteWarning, inviteBonus: r.inviteBonus };
    if (loginRes.ok && loginRes.token) {
      loginSucceeded(clientIp(request), (body.username || "").toLowerCase());
      return { token: loginRes.token, user: loginRes.user, ...inviteExtra };
    }
    return { user: r.user, ...inviteExtra };
  });
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    if (!(await allowAuthAttempt(request, body.username || ""))) return reply.code(429).send(authRateLimited);
    const r = await authService.login(body.username || "", body.password || "");
    if (!r.ok) return reply.code(401).send({ error: r.error });
    loginSucceeded(clientIp(request), (body.username || "").toLowerCase());
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
    // 发信是有成本的(且可用来轰炸他人邮箱) → 与登录同一套限流
    if (!(await allowAuthAttempt(request, body.email || ""))) return reply.code(429).send(authRateLimited);
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
  // JWT 认证辅助: 从 Authorization 提取用户
  const requireUser = async (request: any, reply: any) => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = authService.verifyToken(token);
    if (!payload) { reply.code(401).send({ error: "未登录" }); return null; }
    const user = await authService.getUserById(payload.uid);
    if (!user) { reply.code(401).send({ error: "用户不存在" }); return null; }
    return user;
  };

  app.get("/api/billing/balance", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const quota = await billingService.getSubscriptionQuota(user.id);
    return { balanceCents: user.balanceCents, ...quota };
  });
  /**
   * ⚠ 这条是**运维手工调账**, 不是充值入口(2026-10-01)。
   *
   * 它直接加余额、不需要任何支付 —— 任何登录用户 POST 一下就能给自己充值。
   * 原先它长这样, 是"还没有支付渠道"时的占位实现; 现在真链路已经有了
   * (`POST /api/pay/orders` → 扫码 → 渠道回调入账), 这里必须收紧成本机/管理员专属,
   * 否则前面那套订单与回调形同虚设(有后门谁还走正门)。
   *
   * 收窄为 LOCAL_ONLY 的代价: 部署在服务器上的运营想远程调账, 得用 admin 令牌 ——
   * 这是有意的, 手工加钱本就该留痕且受限。
   */
  app.post("/api/billing/recharge", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (!isLocalRequest(request)) {
      const jwt = authService.verifyToken(
        String((request.headers.authorization || "").replace("Bearer ", "")).trim());
      if (jwt?.role !== "admin") {
        return reply.code(403).send({
          error: {
            code: "MANUAL_RECHARGE_FORBIDDEN",
            message: "手工调账仅限本机或管理员。充值请走 POST /api/pay/orders(扫码支付)",
          },
        });
      }
    }
    const body = request.body as { amountCents?: number; reason?: string };
    const amount = Math.min(Math.max(Number(body.amountCents) || 0, 100), 10_000_000);
    const r = await billingService.recharge(user.id, amount, "manual");
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

  // ═══ 支付订单(2026-10-01: 补"收款"这条路) ═══
  //
  // 由来: 此前只有 `POST /api/billing/recharge` —— 它**直接给用户加余额, 不需要任何支付**。
  //   也就是说任何登录用户 POST 一下就能自己给自己充值。那是开发期的占位实现, 不是收款。
  //   下面这套才是真链路: 下单 → 扫码 → 渠道回调(验签+解密+核额) → 入账。
  //
  // 安全: ① 只认渠道回调, **绝不相信前端说"我付好了"**  ② 回调验签+解密
  //   ③ 回调金额与订单金额二次核对  ④ 同一渠道流水只能入账一次  ⑤ 订单号不可猜
  app.get("/api/pay/config", async () => {
    const { getPayConfigPublic } = await import("../services/wechat-pay-service.js");
    return await getPayConfigPublic();
  });

  const payCreateSchema = z.object({
    amountCents: z.number().int().positive().max(1_000_000, "单笔上限 10000 元"),
    subject: z.string().max(120).optional(),
    kind: z.enum(["recharge", "subscription", "points"]).optional(),
    targetRef: z.string().max(120).optional(),
    // 幂等键: 前端点两次只产生一单
    idemKey: z.string().max(80).optional(),
  });
  app.post("/api/pay/orders", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = payCreateSchema.parse(request.body);
    const { createOrder } = await import("../services/payment-order-service.js");
    const r = await createOrder({ userId: user.id, ...body });
    if (!r.ok) return reply.code(400).send({ error: { code: "PAY_CREATE_FAILED", message: r.error } });
    return { ok: true, order: r.order, mock: r.mock, reused: r.reused };
  });

  app.get("/api/pay/orders", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { listOrders } = await import("../services/payment-order-service.js");
    return { orders: await listOrders(user.id, parseInt(q.limit || "50", 10)) };
  });

  /**
   * 查单 + 主动同步。
   *
   * `sync=1` 时会**主动向微信查一次**并补入账 —— 前端轮询就带这个参数。
   * 为什么必须: 回调可能永远不来(网络/重启/防火墙), 那笔钱收了但余额没加。
   */
  app.get("/api/pay/orders/:outTradeNo", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const p = request.params as { outTradeNo: string };
    const q = request.query as { sync?: string };
    const svc = await import("../services/payment-order-service.js");

    const order = await svc.getOrder(p.outTradeNo);
    if (!order) return reply.code(404).send({ error: "订单不存在" });
    // 越权: 只能看自己的单
    if (order.userId !== user.id) return reply.code(403).send({ error: "无权查看该订单" });

    if (q.sync === "1" && order.status !== "paid") {
      await svc.syncOrderWithChannel(p.outTradeNo);
      const fresh = await svc.getOrder(p.outTradeNo);
      return { ok: true, order: fresh };
    }
    return { ok: true, order };
  });

  /** 超时关单: 定时调用或运维手动触发。只关 pending/created, 已付的不动 */
  app.post("/api/pay/orders/close-expired", async () => {
    const { closeExpiredOrders } = await import("../services/payment-order-service.js");
    return await closeExpiredOrders();
  });

  /**
   * 微信支付回调 —— **唯一的入账入口**。
   *
   * 处理顺序(每一步都不能省):
   *   ① 验签(平台证书) ② 解密 resource(AES-256-GCM) ③ 金额核对 ④ 幂等入账
   *
   * 返回 HTTP 200 + `{code:"SUCCESS"}` 告诉微信"收到了别再推"; 处理失败要返回非 200
   *   让微信重推(而不是吞掉)。
   * ⚠ 本路由**不能**经过登录鉴权(微信不会带我们的 token), 靠签名保证真实性。
   */
  app.post("/api/pay/notify/wechat", async (request, reply) => {
    const headers = request.headers as Record<string, string | undefined>;
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});

    const pay = await import("../services/wechat-pay-service.js");
    const svc = await import("../services/payment-order-service.js");

    const ver = await pay.verifyNotifySignature({
      timestamp: headers["wechatpay-timestamp"],
      nonce: headers["wechatpay-nonce"],
      signature: headers["wechatpay-signature"],
      serial: headers["wechatpay-serial"],
      body,
    });
    if (!ver.ok) {
      // 401 会让微信重推; 但我们**不会**因为重推而放行 —— 验签不过就是不认
      return reply.code(401).send({ code: "FAIL", message: ver.error });
    }

    const parsed = JSON.parse(body) as {
      event_type?: string;
      resource?: { ciphertext: string; nonce: string; associated_data?: string };
    };
    if (parsed.event_type !== "TRANSACTION.SUCCESS" || !parsed.resource) {
      // 其他事件(如退款结果)当前不处理, 但要**回 200**, 否则微信会一直重推
      return { code: "SUCCESS", message: "已接收" };
    }

    const dec = await pay.decryptNotifyResource(parsed.resource);
    if (!dec.ok || !dec.data) {
      return reply.code(400).send({ code: "FAIL", message: dec.error });
    }
    const d = dec.data as {
      out_trade_no?: string; transaction_id?: string;
      amount?: { total?: number }; trade_state?: string;
    };
    if (d.trade_state !== "SUCCESS" || !d.out_trade_no || !d.transaction_id) {
      return { code: "SUCCESS", message: "非成功态, 忽略" };
    }

    const s = await svc.settleOrder({
      outTradeNo: d.out_trade_no,
      transactionId: d.transaction_id,
      paidAmountCents: d.amount?.total,
      rawCallback: dec.data,
    });

    if (!s.ok) {
      // 入账失败要让微信重推(可能是暂时性故障); 但金额不符这种**确定性**错误重推也没用
      const fatal = (s.error ?? "").includes("金额不符") || (s.error ?? "").includes("订单不存在");
      if (fatal) return { code: "SUCCESS", message: `已记录但拒绝入账: ${s.error}` };
      return reply.code(500).send({ code: "FAIL", message: s.error });
    }
    return { code: "SUCCESS", message: "成功" };
  });

  /** 退款(运营/用户申请)。金额不可超实收, 幂等键防重复退 */
  const payRefundSchema = z.object({
    outTradeNo: z.string().min(6).max(64),
    amountCents: z.number().int().positive().optional(),
    reason: z.string().max(80).optional(),
    idemKey: z.string().max(80).optional(),
  });
  app.post("/api/pay/refunds", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = payRefundSchema.parse(request.body);
    const svc = await import("../services/payment-order-service.js");
    const order = await svc.getOrder(body.outTradeNo);
    if (!order) return reply.code(404).send({ error: "订单不存在" });
    if (order.userId !== user.id) return reply.code(403).send({ error: "无权操作该订单" });
    const r = await svc.refundOrder(body);
    if (!r.ok) return reply.code(400).send({ error: { code: "PAY_REFUND_FAILED", message: r.error } });
    return { ok: true, refundedCents: r.refundedCents, duplicate: r.duplicate };
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
  // V405(P0 成本账本): 平台成本审计 — 按模型/端点/来源聚合 + 每日曲线(与用户计费解耦)
  app.get("/api/admin/cost-ledger", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { days?: string };
    const { getLedgerSummary } = await import("../services/cost-ledger-service.js");
    const summary = await getLedgerSummary(parseInt(q.days || "7", 10));
    return { summary };
  });
  app.get("/api/admin/cost-ledger/daily", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { days?: string };
    const { getLedgerDaily } = await import("../services/cost-ledger-service.js");
    return { daily: await getLedgerDaily(parseInt(q.days || "14", 10)) };
  });
  // V405(P1 三档路由): 路由决策审计(仅 ROUTER_ENABLED=1 时有数据)
  app.get("/api/admin/router-audit", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { days?: string };
    const { getRouterAudit } = await import("../services/tier-router-service.js");
    return { audit: await getRouterAudit(parseInt(q.days || "7", 10)) };
  });
  app.post("/api/admin/user/:id/plan", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { plan?: string };
    if (!body.plan || !billingService.PLANS[body.plan]) return reply.code(400).send({ error: "未知计划" });
    await pool.query("update users set plan = $2 where id = $1", [params.id, body.plan]);
    // V417: 原实现连 admin 身份都没取(requireAdmin 的返回值被丢弃), 更没有审计
    void opsService.recordAdminAction({
      adminUserId: admin.uid, adminUsername: (admin as { username?: string }).username,
      action: "user.plan", targetId: params.id, detail: `plan=${body.plan}`,
      ip: request.socket?.remoteAddress || "",
    });
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
    void opsService.recordAdminAction({
      adminUserId: admin.uid, adminUsername: (admin as { username?: string }).username,
      action: "user.status", targetId: params.id, detail: `status=${body.status}`,
      ip: request.socket?.remoteAddress || "",
    });
    return { ok: true };
  });
  app.post("/api/admin/user/:id/balance", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { deltaCents?: number };
    const r = await authService.adminAdjustBalance(admin.uid, params.id, Number(body.deltaCents) || 0);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // 余额变更必须留痕: 改动的是钱, "没记上"本身就是事故
    await opsService.recordAdminAction({
      adminUserId: admin.uid, adminUsername: (admin as { username?: string }).username,
      action: "user.balance", targetId: params.id,
      detail: `deltaCents=${Number(body.deltaCents) || 0} balanceAfter=${r.balanceCents ?? "?"}`,
      ip: request.socket?.remoteAddress || "",
    });
    return { ok: true, balanceCents: r.balanceCents };
  });
  app.post("/api/admin/user/:id/reset-password", async (request, reply) => {
    const admin = await requireAdmin(request, reply); if (!admin) return;
    const params = request.params as { id: string };
    const body = request.body as { newPassword?: string };
    const r = await authService.adminResetPassword(admin.uid, params.id, body.newPassword || "");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // 只记"重置了谁的密码", 绝不记密码本身
    void opsService.recordAdminAction({
      adminUserId: admin.uid, adminUsername: (admin as { username?: string }).username,
      action: "user.reset-password", targetId: params.id,
      ip: request.socket?.remoteAddress || "",
    });
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
      // V399-2 修复: 登录后合并 [PUBLIC_TENANT, 用户租户, DEFAULT_TENANT_ID] —
      // 原只查 [PUBLIC_TENANT, 用户租户] 导致 default 租户项目(未登录创建)登录后不可见
      if (u.rows.length > 0) tenantIds = [PUBLIC_TENANT, u.rows[0].tenant_id, config.DEFAULT_TENANT_ID];
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
    // V392+ 修复: 更新与 GET 对齐多租户(公共库 + 用户租户 + default),
    // 原 DEFAULT_TENANT_ID 单租户导致公共库项目更新报"项目不存在"
    const authHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const jwtPayload = authHdr && authService.verifyToken(authHdr);
    let tenantIds: string[] = [];
    if (jwtPayload) {
      const u = await pool.query("select tenant_id from users where id = $1", [jwtPayload.uid]);
      tenantIds = [PUBLIC_TENANT, ...(u.rows[0]?.tenant_id ? [String(u.rows[0].tenant_id)] : []), config.DEFAULT_TENANT_ID];
    } else {
      tenantIds = [PUBLIC_TENANT, config.DEFAULT_TENANT_ID];
    }
    const project = await webuiService.updateProjectByTenants(params.projectId, input, tenantIds);
    if (!project) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "项目不存在" } });
    return { project };
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

  // ═══ V404-13: WriterLease/ChangeSet/锚点(借鉴 OpenSquilla artifact_session, 最小) ═══
  // 编辑协议: acquire(持锁拿 token) → apply(带 token 原子改, 冲突返回最新版) → release
  app.post("/api/documents/:id/session/acquire", async (request, reply) => {
    const { docSessionService } = await import("../services/doc-session-service.js");
    const body = request.body as { holder?: string; ttlSeconds?: number };
    const holder = String(body.holder || "agent");
    const r = await docSessionService.acquireWriterLease(String((request.params as any).id), holder, Number(body.ttlSeconds) || 300);
    if (!r.ok) return reply.code(409).send({ error: r.error, code: "LEASE_BUSY" });
    return { ok: true, token: r.token, hint: "编辑后调 apply(带 token) 或 release" };
  });
  app.post("/api/documents/:id/session/release", async (request) => {
    const { docSessionService } = await import("../services/doc-session-service.js");
    const body = request.body as { holder?: string };
    await docSessionService.releaseWriterLease(String((request.params as any).id), String(body.holder || "agent"));
    return { ok: true };
  });
  app.post("/api/documents/:id/session/apply", async (request, reply) => {
    const { docSessionService } = await import("../services/doc-session-service.js");
    const body = request.body as { holder?: string; token?: number; summary?: string; ops: Array<{ op: string; start: number; end: number; text: string }> };
    const ops = (body.ops || []).map((o) => ({ op: "replace" as const, start: Number(o.start), end: Number(o.end), text: String(o.text ?? "") }));
    const r = await docSessionService.applyChangeSet({
      documentId: String((request.params as any).id), holder: String(body.holder || "agent"),
      token: Number(body.token ?? -1), summary: body.summary, ops,
    });
    if (!r.ok) return reply.code(r.currentVersion !== undefined ? 409 : 400).send({ error: r.error, code: r.currentVersion !== undefined ? "VERSION_CONFLICT" : "APPLY_FAILED", currentVersion: r.currentVersion });
    return { ok: true, changeSetId: r.changeSetId, newVersion: r.newVersion };
  });
  app.post("/api/documents/:id/anchors", async (request, reply) => {
    const { docSessionService } = await import("../services/doc-session-service.js");
    const body = request.body as { version?: number; start?: number; end?: number; quote?: string; note?: string };
    const r = await docSessionService.createAnchor({
      documentId: String((request.params as any).id), version: Number(body.version ?? 1),
      start: Number(body.start ?? 0), end: Number(body.end ?? 0), quote: body.quote, note: body.note,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "ANCHOR_FAILED" });
    return { ok: true, anchorId: r.id };
  });
  app.get("/api/documents/:id/anchors", async (request) => {
    const { docSessionService } = await import("../services/doc-session-service.js");
    return { anchors: await docSessionService.listAnchors(String((request.params as any).id)) };
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
    const py = process.env.COGNEE_PYTHON || "python";   // ⚠ 别用 "" —— spawn("") 同步抛错
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

  /**
   * 平台能力与数据底盘的**实时真数**(首页统计条用)。
   *
   * 由来(2026-09-29 用户:「首页的各项数据, 比如研究能力也需要更新」): 首页那两组数字
   *   此前全是源码里手抄的字面量 —— 它们只会随**某次有人记得改**而更新, 于是漂成了
   *   另一个平台的快照: 技能兜底写 192(真 209)、文献一处 501 一处 500、
   *   图谱实体 188,259 而文档口径是 118,592。
   *
   * 这里把每个数字都**现算**, 并带上它是否可信:
   *   · Neo4j 两个引擎**可能是关着的** —— 连不上就报 connected:false(前端显示「未连接」),
   *     而不是拿一个陈旧数字冒充实时值。这正是不久前 MinerU 密钥过期 11 天没人知道的同一类教训。
   *   · PG 的四项永远可算(它就是本服务的库)。
   *
   * ⚠ 不聚合「三引擎实体总数」这种**跨引擎相加**的值: 单位不同(节点 vs 关系 vs join 行),
   *   之前的 516,309 就是把 PG 的 event_entities 连接行加进了各引擎的关系数里。
   *   逐引擎报, 谁是谁一目了然。
   */
  app.get("/api/platform/stats", async (request) => {
    const { pool } = await import("../db/pool.js");
    const one = async (sql: string): Promise<number | null> => {
      try { return Number((await pool.query(sql)).rows[0]?.c ?? 0); } catch { return null; }
    };

    /** 一个 Neo4j 引擎的节点/关系数; 连不上返回 connected:false 而不是抛 */
    const engine = async (name: "graphiti" | "cognee") => {
      try {
        const { neo4jQuery } = await import("../db/neo4j-query.js");
        const port = name === "graphiti" ? 11001 : 11003;
        const num = (v: unknown) => (typeof v === "object" && v !== null ? Number((v as { low: number }).low ?? 0) : Number(v ?? 0));
        const [n] = await neo4jQuery<{ n: unknown }>(port, `match (n) return count(n) as n`, {}, 8000);
        const [r] = await neo4jQuery<{ n: unknown }>(port, `match ()-[x]->() return count(x) as n`, {}, 8000);
        return { engine: name, connected: true, nodes: num(n?.n), relations: num(r?.n) };
      } catch {
        // 连不上就明说 —— 不猜、不缓存旧值、不用 0 冒充"没有数据"
        return { engine: name, connected: false, nodes: null, relations: null };
      }
    };

    const [graphiti, cognee, skillsLen, toolsLen] = await Promise.all([
      engine("graphiti"),
      engine("cognee"),
      (async () => { try { const m = await import("../services/skills-service.js"); return m.listSkills().length; } catch { return null; } })(),
      (async () => { try { const m = await import("../services/agent-tool-router.js"); return (await m.buildAgentTools({})).length; } catch { return null; } })(),
    ]);
    // 推理步数取后端权威表(reason-steps.ts)的长度 —— 它同时是 retrieve_steps.step_no 的取值域
    let reasonSteps: number | null = null;
    try { const m = await import("../services/reason-steps.js"); reasonSteps = m.REASON_STEPS.length; } catch { /* 取不到就 null */ }

    const [documents, chunks, entities, events, projects] = await Promise.all([
      one(`select count(*)::int c from documents`),
      one(`select count(*)::int c from source_chunks`),
      one(`select count(*)::int c from entities`),
      one(`select count(*)::int c from events`),
      one(`select count(*)::int c from research_projects`),
    ]);

    return {
      engines: { graphiti, cognee },
      /** 本服务的库(PG) —— 这几项一定算得出来 */
      pg: { documents, chunks, entities, events, projects },
      /** 实时从注册表/清单数的, 不是字面量 */
      live: { tools: toolsLen, skills: skillsLen, reasonSteps },
      checkedAt: new Date().toISOString(),
    };
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
    const body = searchSchema.parse(request.body);
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    // G10: cursor 翻页 — 有 cursor 则从快照恢复, 否则执行检索并建快照
    if (body.cursor) {
      const store = new SearchSessionStore();
      const page = await store.resume(body.cursor, body);
      // 快照 items → sections(前端契约)
      const pageResult = page.result as { items: unknown[] };
      return { sections: pageResult.items, cursor: page.nextCursor, pageTotal: page.total };
    }
    const input = { ...body, cursor: undefined } as any;
    const result = await searchService.search(input);
    if (ctx) {
      // 外部 token: 按 traceId 聚合真实 LLM token 用量 (trace_spans 已落库) → 记账
      void recordSearchUsage(ctx.tokenId, result.traceId);
    }
    // 快照建页(首次请求): 服务端存结果, 返回第一页 + nextCursor
    if (body.pageSize && body.pageSize > 0) {
      const store = new SearchSessionStore();
      const page = await store.create({
        request: body,
        result: { items: result.sections },
        pageSize: body.pageSize,
        ttlSeconds: 300,
      });
      // 快照 items → sections(前端契约)
      const pageResult = page.result as { items: unknown[] };
      return { ...result, sections: pageResult.items, cursor: page.nextCursor, pageTotal: page.total };
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

  // ─── OpenAI 兼容端点(Zleap-AI/SAG 评审回溯吸收 P0)───
  // POST /api/openai/chat/completions (+ /api/openai/v1/chat/completions 别名, 兼容 OpenAI SDK base_url)
  // 把本地知识库当"模型"调用: 取最后 user 消息 → SAG 检索 → 基于证据带引用生成
  // 响应: 标准 chat.completion + 顶层 sag.citations; 流式走 OpenAI SSE 格式(data: 块 + data: [DONE])
  // 鉴权: PERMISSION_PREFIX_MAP 已注册 /api/openai → reason; 配额 kind=reason
  const openaiCompletionsHandler = async (request: any, reply: any) => {
    let body: any;
    try {
      body = openaiChatCompletionsSchema.parse(request.body);
    } catch (e) {
      // zod 失败显式转 OpenAI 格式 400(z.parse 抛错无 statusCode, 单独处理)
      const detail = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({
        error: { message: detail || "请求参数无效", type: "invalid_request_error", code: "BAD_REQUEST" }
      });
    }
    const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
    const mapBody = (b: any) => ({
      model: b.model,
      messages: b.messages,
      temperature: b.temperature,
      maxTokens: b.max_tokens ?? b.maxTokens,
    });

    // ── 非流式 ──
    if (!body.stream) {
      try {
        const result = await runOpenAiChatCompletion({ ...mapBody(body), stream: false, tokenCtx: ctx });
        return reply.send(result);
      } catch (e) {
        if (e instanceof OpenAiError) {
          return reply.code(e.statusCode).send({ error: { message: e.message, type: e.type, code: e.code } });
        }
        logger.error({ error: getErrorMessage(e) }, "openai chat failed");
        return reply.code(500).send({ error: { message: "内部错误", type: "server_error", code: "INTERNAL_ERROR" } });
      }
    }

    // ── 流式: 先写 SSE 头再编排(检索阶段错误也只能走 SSE 通道)──
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });
    const streamId = "chatcmpl-" + randomUUID().slice(0, 16);
    const created = Math.floor(Date.now() / 1000);
    const streamModel = body.model ?? getRoleModel("reason");
    const sendChunk = (delta: { role?: string; content?: string }, finishReason: string | null = null, extra?: Record<string, unknown>) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return; // 客户端断开
      reply.raw.write(formatChatChunk({ id: streamId, created, model: streamModel, delta, finishReason, extra }));
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") flush.call(reply.raw);
    };
    try {
      sendChunk({ role: "assistant", content: "" }); // 首块带 role
      await runOpenAiChatCompletion({
        ...mapBody(body), stream: true, tokenCtx: ctx,
        onDelta: (delta) => { if (delta) sendChunk({ content: delta }); },
        onFinal: (extra) => sendChunk({}, "stop", extra), // 末块 finish_reason + sag.citations + usage
      });
      reply.raw.write("data: [DONE]\n\n");
    } catch (e) {
      const err = e instanceof OpenAiError
        ? { message: e.message, type: e.type, code: e.code }
        : { message: "内部错误", type: "server_error", code: "INTERNAL_ERROR" };
      sendChunk({}, null, { error: err }); // OpenAI 标准: error chunk
      reply.raw.write("data: [DONE]\n\n");
    } finally {
      reply.raw.end();
    }
  };
  app.post("/api/openai/chat/completions", openaiCompletionsHandler);
  app.post("/api/openai/v1/chat/completions", openaiCompletionsHandler); // OpenAI SDK base_url=/api/openai/v1 兼容

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
    const session = await mcpAgentService.createSession(input);
    return reply.code(201).send({ session });
  });

  // V398: 会话重命名（AI 对话页/项目会话通用）
  app.post("/api/mcp/sessions/:sessionId/rename", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(request.body);
    const session = await mcpAgentService.updateTitle(params.sessionId, title);
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
    const result = await mcpAgentService.deleteMessage(params.sessionId, params.messageId);
    if (!result) {
      return reply.code(404).send(notFound("MCP_MESSAGE_NOT_FOUND", "消息不存在"));
    }
    return result;
  });

  // V398: 通用 AI 对话会话列表（kind=chat）
  app.get("/api/chat/sessions", async () => ({
    sessions: await mcpAgentService.listSessions({ kind: "chat" })
  }));

  // ─── 会话回放（2026-08-29, 借鉴 Inno Agent case-exporter）───
  // GET /api/chat/sessions/replay/list — 可回放会话列表
  app.get("/api/chat/sessions/replay/list", async () => {
    const { sessionReplayService } = await import("../services/session-replay.js");
    return { ok: true, sessions: await sessionReplayService.listReplayableSessions() };
  });
  // GET /api/chat/sessions/:id/replay — 导出会话回放 JSON(消息+工具调用+脱敏)
  app.get("/api/chat/sessions/:id/replay", async (request) => {
    const { sessionReplayService } = await import("../services/session-replay.js");
    return await sessionReplayService.exportSessionReplay((request.params as any).id);
  });

  app.get("/api/mcp/sessions", async () => ({
    sessions: await mcpAgentService.listSessions()
  }));

  app.get("/api/projects/:projectId/mcp/sessions", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      sessions: await mcpAgentService.listSessions({ sourceId: params.projectId })
    };
  });

  app.get("/api/mcp/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.getSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.post("/api/mcp/sessions/:sessionId/clear", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.clearSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.delete("/api/mcp/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    return mcpAgentService.deleteSession(params.sessionId);
  });

  app.post("/api/mcp/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const result = await mcpAgentService.runUserMessage({
      sessionId: params.sessionId,
      content: input.content
    });
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
    const fileName = `${randomUUID()}.${ext}`;
    // 走 blob-store: 上传的图片随对话在副本间共享, 多副本下不会再"附件在本副本上没有"
    await putObject(`chat-uploads/${fileName}`, raw);
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
  app.post("/api/chat/approvals/:approvalId", async (request, reply) => {
    const params = request.params as { approvalId: string };
    const { approved } = z.object({ approved: z.boolean() }).parse(request.body);
    const ok = await mcpAgentService.approveToolCall(params.approvalId, approved);
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

    const detail = await mcpAgentService.getSession(params.sessionId);
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
        // 租户频率限制（60s 窗口; DB 模式跨副本共享配额, 单机退化为进程内）
        const rateCheck = await tenantRateLimiter.checkAsync(`tenant:${tenantId}`, 30);
        if (!rateCheck.allowed) {
          return reply.code(429).send({ error: { code: "TENANT_RATE_LIMITED", message: "租户请求过于频繁, 请稍后再试", retryAfterSec: rateCheck.retryAfterSec } });
        }
        // 并发槽位(DB 模式跨副本共享; 否则 free 2 并发 × N 副本)
        if (!(await acquireTenantSlotAsync(tenantId, plan))) {
          return reply.code(429).send({ error: { code: "TENANT_BUSY", message: `租户并发推理已达上限(${tenantConcurrencyLimit(plan)}), 请稍后再试` } });
        }
        reasonQuery.tenantId = tenantId;
        // 心跳续期: 否则超过 10 分钟的长推理会被其他副本当成陈旧槽位回收 → 并发上限被突破
        const hb = setInterval(() => { void renewTenantSlotAsync(tenantId); }, SLOT_HEARTBEAT_MS);
        hb.unref?.();
        reasonQuery.releaseTenantSlot = () => { clearInterval(hb); void releaseTenantSlotAsync(tenantId); };
      }
    }
    try {
      const result = await startReasonFlow(reasonQuery);
      // V391(P1-3): 释放租户并发槽位
      reasonQuery.releaseTenantSlot?.();
      const ctx = (request as any).tokenCtx as { tokenId: string } | undefined;
      if (ctx) {
        // reason 计月成本: 从 taskId 聚合 retrieve_steps 真实 tokens
        const taskId = result?.taskId ?? (result as any)?.id;
        void recordReasonUsage(ctx.tokenId, taskId);
      }
      // V389: JWT 用户计费 — 聚合 retrieve_steps tokens → chargeUser（订阅额度→超额扣余额）
      // V405(P0 成本账本): 抽 helper 复用 stream 路由; 按 retrieve_steps 真实模型扣费（修恒 flash 定价）
      if (jwtPayload && reasonQuery.userId) {
        void chargeUserForReasonTask(reasonQuery.userId, result?.taskId ?? (result as any)?.id);
      }
      return reply.code(201).send(result);
    } catch (e: any) {
      const msg = e?.message || String(e);
      // P0-12 错误扣留: 失败也要把 taskId 交出去 —— 否则客户端只拿到一个错误码, 不知道去查
      //   哪个任务, 失败详情(query_tasks.error + 失败的 retrieve_steps)就只能翻服务端日志。
      //   带上 taskId, 前端可查 GET /api/reason/tasks/:id 看跑到哪一步、哪步失败。
      //   (恢复成功的中间态不会走到这里, 所以不违反"扣留中间态错误"。)
      const failedTaskId = (e as { taskId?: string })?.taskId ?? null;
      const withTask = (body: Record<string, unknown>) => (failedTaskId ? { ...body, taskId: failedTaskId } : body);
      if (msg.includes('_TIMEOUT') || msg.includes('MCP_TIMEOUT')) {
        return reply.code(503).send(withTask({ error: { code: "RETRIEVAL_TIMEOUT", message: "检索超时，请稍后重试" } }));
      }
      if (e instanceof z.ZodError) {
        return reply.code(400).send(withTask({ error: { code: "BAD_REQUEST", message: "请求参数无效" } }));
      }
      logger.error({ error: msg }, "reason flow failed");
      return reply.code(500).send(withTask({ error: { code: "INTERNAL_ERROR", message: "推理服务暂时不可用" } }));
    }
  });

  // 2026-08-07 流式输出：推理完成后答案分块 SSE 推送（长答案逐步渲染）
  // V405(P0 成本账本): 补 JWT 解析 + 用户计费(原 stream 路由漏计费; 与 /api/reason/query 同 helper)
  app.post("/api/reason/query/stream", async (request, reply) => {
    const input = reasonSchema.parse(request.body);
    const reasonQuery: any = { sourceId: input.sourceId, query: input.query };
    if (input.topK) reasonQuery.topK = input.topK;
    if (input.paperId && input.paperId.length > 0) reasonQuery.paperId = input.paperId;
    if (input.ablation && input.ablation.length > 0) reasonQuery.ablation = input.ablation;
    if (input.mode) reasonQuery.mode = input.mode;
    if (input.sessionId) reasonQuery.sessionId = input.sessionId;
    const streamAuthHdr = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const streamJwt = streamAuthHdr && authService.verifyToken(streamAuthHdr);
    if (streamJwt) {
      const llmCfg = await authService.getUserLlmConfig(streamJwt.uid);
      if (llmCfg.provider === "byok" && llmCfg.apiKey) reasonQuery.userLlmConfig = { provider: "byok", apiKey: llmCfg.apiKey };
      reasonQuery.userId = streamJwt.uid;
    }
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
      // V405(P0 成本账本): 流式路由补用户计费(漏计费修复)
      if (streamJwt && reasonQuery.userId) {
        void chargeUserForReasonTask(reasonQuery.userId, result?.taskId ?? (result as any)?.id);
      }
      const content = (result.trace?.hypothesis as any)?.content || "";
      // 分块推送答案（每 120 字一块，80ms 间隔——模拟打字效果）
      const CHUNK = 120;
      for (let i = 0; i < content.length; i += CHUNK) {
        send("token", { type: "token", text: content.slice(i, i + CHUNK), index: i / CHUNK });
        await new Promise((r) => setTimeout(r, 80));
      }
      send("done", { type: "done", result });
    } catch (e: any) {
      // P0-12: 失败事件带 taskId(由 inference-service 挂在错误上) —— 前端据此查失败详情
      send("error", { type: "error", message: getErrorMessage(e), taskId: e?.taskId ?? null });
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
        ? toChatCompletionsUrl(process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions")
        : toChatCompletionsUrl(process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1");
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

  /**
   * 中文三大库检索(知网/万方/维普) —— **借用户浏览器里的机构登录态**。
   *
   * 为什么不是普通 API 调用: 这三家**都没有对外检索接口**, 检索页是 SPA 空壳, 必须渲染后取。
   *   产品前提: **平台不存这三家的密码** —— 走用户自己浏览器里的登录态。
   *   所以本端点在"用户未登录"时返回 `needsLogin: true`(而不是 502), 让前端能说清原因。
   *
   * 实测(2026-09-19, 用户机构 = 南宁师范大学):
   *   万方 total=329,426 / 维普 20 条 / 知网 total=136,905。
   */
  const litSearchSchema = z.object({
    source: z.enum(["cnki", "wanfang", "cqvip"]),
    query: z.string().min(1).max(200)
  });
  app.post("/api/literature/search", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = litSearchSchema.parse(request.body);
    const { searchInBrowserSource } = await import("../services/literature-browser-service.js");
    const r = await searchInBrowserSource(input.source, input.query);
    if (r.needsLogin) {
      // ⚠ 用 409 而不是 502: 这不是"服务端坏了", 是**需要用户去浏览器里登录一次**。
      //   有区别 —— 前端据此显示"去登录"而不是"重试"。
      return reply.code(409).send({
        error: { code: "NEEDS_LOGIN", message: r.error ?? "需要先在浏览器里登录该文献源" },
        needsLogin: true,
        source: input.source
      });
    }
    if (!r.ok) {
      return reply.code(502).send({ error: { code: "LIT_SEARCH_FAILED", message: r.error ?? "检索失败" } });
    }
    return r;
  });

  /**
   * 当前浏览器里的知网身份(供前端显示"现在拿谁的身份在查")。
   *
   * ⚠ 与"用户选择账户"的关系: 平台**不保存知网账号密码** —— 知网访问走用户自己浏览器的登录态。
   *   所以这个端点做的是"**读出来给你看**", 不是"帮你登录"。
   *   实测返回: `{loggedIn:true, userName:"GZ0041", showName:"南宁师范大学", userType:"bk", isInstitution:true}`。
   */
  app.get("/api/cnki/identity", async (_request, reply) => {
    const r = await cnkiCitationProxy.readIdentity();
    if (!r.ok && r.error) return reply.code(502).send(notFound("CNKI_IDENTITY_FAILED", r.error));
    return r;
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
        // V399-2 P2: 当前数据指纹（前端 stale 判定用; 失败降级 null）
        const currentFp = await computeDataFingerprint(DEFAULT_SOURCE, { warn: (m) => console.warn("[eval] " + m) });
        return { file: safeName, data: content, agentSummary, currentFingerprint: currentFp };
      } catch (e: any) {
        return { error: "JSON 解析失败: " + (e?.message || String(e)).substring(0, 100) };
      }
    }
    // 列表：扫描 evaluation/ + 根目录 eval_*.json（V399: 文件已移入 evaluation/）
    try {
      const scanDirs = [evalDir, rootDir];
      const files: Array<{ name: string; updatedAt: Date; size: number; questionCount: number; overallAvg: number; fingerprint: string | null; stale: boolean }> = [];
      // V399-2 P2: 当前数据指纹（列表/单文件 stale 判定共用; 失败降级 null 不阻塞）
      const currentFp = await computeDataFingerprint(DEFAULT_SOURCE, { warn: (m) => console.warn("[eval] " + m) });
      for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith("eval_") || !f.endsWith(".json") || f.startsWith("eval_results_")) continue;
          if (files.some((x) => x.name === f)) continue;  // evaluation/ 优先，根目录同名校跳
          const stat = fs.statSync(path.join(dir, f));
          let questionCount = 0;
          let overallAvg = 0;
          let fingerprint: string | null = null;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
            // V399-2 P1: 列表统计跳过指纹元数据条目（question_id='__fingerprint__', overall=null）
            const fp = Array.isArray(data)
              ? (data.find((r: any) => r?.question_id === '__fingerprint__')?.fingerprint as any)
              : (data as any)?.fingerprint;
            if (fp && typeof fp.value === "string") fingerprint = fp.value;
            if (Array.isArray(data) && data.length > 0) {
              const real = data.filter((r: any) => r?.question_id !== '__fingerprint__');
              questionCount = real.length;
              const valid = real.filter((r: any) => typeof r?.overall === "number" && !r?.error);
              overallAvg = valid.length > 0 ? valid.reduce((s: number, r: any) => s + r.overall, 0) / valid.length : 0;
            }
          } catch { /* 解析失败跳过统计 */ }
          // V399-2 P2: stale 判定 — 该结果的数据指纹 ≠ 当前数据指纹 → 数据已变更, 结果过期
          const stale = fingerprint !== null && currentFp.value !== null && fingerprint !== currentFp.value;
          files.push({ name: f, updatedAt: stat.mtime, size: stat.size, questionCount, overallAvg, fingerprint, stale });
        }
      }
      files.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { files, currentFingerprint: currentFp };
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
  // V417: bad case → gold 候选提名（一键触发）。
  //   背景: 回流此前只有命令行脚本, 产物停在 2026-08-07 —— 材料(30 条已归因失败)现成, 缺的是入口。
  //   限 admin: 评测集的构成不该由普通账号改动。
  //   红线: 只产 draft 候选, **不改 gold_dataset.json**。
  app.post("/api/eval/failures/promote", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = (request.body ?? {}) as { minConfidence?: number; maxItems?: number; evalRunId?: string };
    const { proposeGoldCandidates } = await import("../services/eval-failure-promotion.js");
    const r = await proposeGoldCandidates({
      minConfidence: typeof body.minConfidence === "number" ? body.minConfidence : undefined,
      maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
      evalRunId: typeof body.evalRunId === "string" ? body.evalRunId : undefined,
    });
    if (!r.ok) return reply.code(500).send({ error: r.error, code: "PROMOTE_FAILED" });
    return r;
  });

  // GET /api/eval/failures — 查 eval_failures 表（类别统计 + 逐题归因列表）
  app.get("/api/eval/failures", async () => {    try {
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
  // V417: OpenViking 状态与一键拉起。
  //   原先靠 schtasks 每 5 分钟探活 —— 太频繁。改为: 前端记忆面板轮询状态, 离线时显示
  //   "一键激活"按钮, 点击调 start(由 SAG 进程拉起, 处理残留进程占 LOCK 的坑)。
  //   权限: 状态读不限(健康信息无敏感); 拉起限本机或 admin(启动进程是机器级动作)。
  app.get("/api/memory/openviking/status", async () => {
    try {
      const { isOpenvikingListening } = await import("../services/openviking-process.js");
      const listening = await isOpenvikingListening();
      if (!listening) return { listening: false };
      try {
        const r = await fetch("http://127.0.0.1:1933/health", { signal: (AbortSignal as any).timeout(3000) });
        const body = await r.json().catch(() => ({}));
        return { listening: true, healthy: r.ok, version: (body as any)?.version };
      } catch {
        return { listening: true, healthy: false };
      }
    } catch {
      return { listening: false };
    }
  });
  app.post("/api/memory/openviking/start", async (request, reply) => {
    if (isLocalRequest(request)) { /* 本机放行 */ }
    else {
      const admin = await requireAdmin(request, reply); if (!admin) return;
    }
    const { startOpenviking } = await import("../services/openviking-process.js");
    const r = await startOpenviking();
    if (!r.ok) return reply.code(500).send({ error: r.error, code: "OV_START_FAILED", ...r });
    return r;
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
      const p = dataPath("memory-recall-report.json");
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

  // V386: 版本化学习计划链(借鉴 TraitTutor: 只重规划未开始尾部 + supersede 审计)
  // GET  /api/learning-plans — 计划列表(含 superseded 审计链)
  // POST /api/learning-plans — 创建/重建计划{subject, goal, ...} (重建时保留已开始前缀)
  // PATCH /api/learning-plans/:id/components/:componentId — 组件状态推进{status}
  app.get("/api/learning-plans", async (request) => {
    const { learningPlanService } = await import("../services/learning-plan-service.js");
    const q = request.query as Record<string, string | undefined>;
    return learningPlanService.listPlans({ studentId: q.studentId, subject: q.subject });
  });
  app.post("/api/learning-plans", async (request) => {
    const { learningPlanService } = await import("../services/learning-plan-service.js");
    return learningPlanService.createOrRebuildPlan(request.body as any);
  });
  app.patch("/api/learning-plans/:id/components/:componentId", async (request, reply) => {
    const { learningPlanService } = await import("../services/learning-plan-service.js");
    const body = z.object({ status: z.enum(["started", "completed", "skipped"]) }).parse(request.body);
    const r = await learningPlanService.updateComponentStatus({
      planId: (request.params as any).id,
      componentId: (request.params as any).componentId,
      status: body.status,
    });
    if (!r.ok) return reply.code(400).send({ error: { code: "PLAN_INVALID", message: r.error } });
    return r;
  });

  // V391: 间隔重复复习队列(借鉴 TraitTutor learning/scheduler.py)
  // POST /api/education/reviews/enqueue — 注册知识点进复习队列{subject, knowledgePoint}
  // POST /api/education/reviews/result — 记录复习结果{subject, knowledgePoint, question, userAnswer?, expectedAnswer?}
  // GET  /api/education/reviews/due — 到期复习队列(错误未修复优先)
  app.post("/api/education/reviews/enqueue", async (request) => {
    const { spacedRepetitionService } = await import("../services/spaced-repetition-service.js");
    return spacedRepetitionService.enqueueReview(request.body as any);
  });
  app.post("/api/education/reviews/result", async (request) => {
    const { spacedRepetitionService } = await import("../services/spaced-repetition-service.js");
    return spacedRepetitionService.recordReviewResult(request.body as any);
  });
  app.get("/api/education/reviews/due", async (request) => {
    const { spacedRepetitionService } = await import("../services/spaced-repetition-service.js");
    const q = request.query as Record<string, string | undefined>;
    return spacedRepetitionService.dueReviews({ studentId: q.studentId, subject: q.subject, limit: q.limit ? Number(q.limit) : undefined });
  });
  // V396: 状态更新提案(借鉴 LingxiLearn: proposal-only, 只提案不写入)
  app.get("/api/education/reviews/proposal", async (request) => {
    const { spacedRepetitionService } = await import("../services/spaced-repetition-service.js");
    const q = request.query as Record<string, string | undefined>;
    return spacedRepetitionService.proposeStateUpdate({ studentId: q.studentId, subject: q.subject });
  });
  // V397: Capability 注册表 + 确定性候选生成(借鉴 LingxiLearn 三词汇表分层)
  // GET /api/education/capabilities — 注册表清单(能力/成本/前置)
  // GET /api/education/capabilities/recommend — 按学习者状态生成确定性候选
  app.get("/api/education/capabilities", async () => {
    const { capabilityRegistryService } = await import("../services/capability-registry-service.js");
    return { ok: true, capabilities: capabilityRegistryService.CAPABILITY_REGISTRY };
  });
  app.get("/api/education/capabilities/recommend", async (request) => {
    const { capabilityRegistryService } = await import("../services/capability-registry-service.js");
    const q = request.query as Record<string, string | undefined>;
    return capabilityRegistryService.recommendForIntent({ intent: q.intent, subject: q.subject, studentId: q.studentId });
  });

  // V390: 组件校验 + Compass 记忆治理(借鉴 TraitTutor components/validation.py + Reflection/Compass)
  // POST /api/components/validate — 组件白名单校验{component} → {ok, reason?}
  app.post("/api/components/validate", async (request) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    return materialReviewService.validateComponentInstance((request.body as any)?.component);
  });
  // GET/POST /api/memory/preferences — 偏好列表 / 记录偏好(三态+TTL)
  // POST /api/memory/preferences/:id/decide — 用户确认/拒绝{decision}
  // POST /api/memory/preferences/:id/evidence — 追加独立证据{evidenceRef}
  // GET /api/memory/compass — 编译 Compass(仅 confirmed 且未过期)
  app.get("/api/memory/preferences", async (request) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    const q = request.query as Record<string, string | undefined>;
    return educationCompassService.listPreferences({ studentId: q.studentId });
  });
  app.post("/api/memory/preferences", async (request) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    return educationCompassService.recordPreference(request.body as any);
  });
  app.post("/api/memory/preferences/:id/decide", async (request) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    const body = z.object({ decision: z.enum(["confirm", "reject"]), note: z.string().optional(), key: z.string().optional() }).parse(request.body);
    // V393: 支持按 key 定位(Agent 无 id 场景); :id 传 "by-key" 时走 key
    return educationCompassService.decidePreference(
      (request.params as any).id === "by-key"
        ? { key: body.key, decision: body.decision, note: body.note }
        : { id: (request.params as any).id, decision: body.decision, note: body.note }
    );
  });
  app.post("/api/memory/preferences/:id/evidence", async (request) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    const body = z.object({ evidenceRef: z.string() }).parse(request.body);
    return educationCompassService.addPreferenceEvidence({ id: (request.params as any).id, evidenceRef: body.evidenceRef });
  });
  app.get("/api/memory/compass", async (request) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    const q = request.query as Record<string, string | undefined>;
    return educationCompassService.buildCompass({ studentId: q.studentId, subject: q.subject });
  });
  // V392: Compass 删除(删除即重建语义)
  app.delete("/api/memory/preferences/:id", async (request, reply) => {
    const { educationCompassService } = await import("../services/education-compass-service.js");
    const r = await educationCompassService.deletePreference({ id: (request.params as any).id });
    if (!r.ok) return reply.code(404).send({ error: { code: "PREF_NOT_FOUND", message: r.error } });
    return r;
  });

  // V392: 一材多工件(源码移植: 工件共享学习包, 只经 generation_id 挂载, 答案服务端持有)
  // POST /api/learning-plans/:id/artifacts — 挂载 confirmed 产物 {generationId}
  // GET  /api/learning-plans/:id/artifacts — 工件列表(投影剥除答案键)
  app.post("/api/learning-plans/:id/artifacts", async (request, reply) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    const body = z.object({ generationId: z.string().uuid() }).parse(request.body);
    const r = await materialReviewService.attachArtifactToPlan({ generationId: body.generationId, planId: (request.params as any).id });
    if (!r.ok) return reply.code(400).send({ error: { code: "ARTIFACT_INVALID", message: r.error } });
    return r;
  });
  app.get("/api/learning-plans/:id/artifacts", async (request) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    return materialReviewService.listPlanArtifacts({ planId: (request.params as any).id });
  });

  // V388: 学习意图双层路由(借鉴 TraitTutor learning/intent.py: 注入扫描→LLM分类→低置信度确认)
  // POST /api/education/intent — {text, attachmentsText?} → {mode, confidence, safetyAction, fallbackRequired}
  // V394: 组件执行器(对照 TraitTutor executors — 生成组件真实内容)
  // POST /api/education/components/lesson — 概念讲解/例题/目标地图{subject, knowledgePoint, kind}
  // POST /api/education/components/assessment — 题目生成{subject, knowledgePoint, kind}
  // POST /api/education/components/assessment/grade — 判分{item, userAnswer}
  // POST /api/education/components/retrieval — 回忆卡生成{subject, knowledgePoint, count?}
  app.post("/api/education/components/lesson", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ subject: z.string(), knowledgePoint: z.string(), goal: z.string().optional(), kind: z.enum(["concept_explanation", "worked_example", "goal_map", "visual_map"]), sourceId: z.string().optional() }).parse(request.body);
    return componentExecutorService.generateLesson(body);
  });
  app.post("/api/education/components/assessment", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ subject: z.string(), knowledgePoint: z.string(), kind: z.enum(["guided_practice", "transfer_challenge", "diagnostic_check"]), sourceId: z.string().optional() }).parse(request.body);
    return componentExecutorService.generateAssessment(body);
  });
  app.post("/api/education/components/assessment/grade", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ assessmentId: z.string(), questionId: z.number(), userAnswer: z.string() }).parse(request.body);
    return componentExecutorService.gradeAssessmentItem(body);
  });
  app.post("/api/education/components/retrieval", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ subject: z.string(), knowledgePoint: z.string(), count: z.number().optional(), sourceId: z.string().optional() }).parse(request.body);
    return componentExecutorService.generateRetrievalCards(body);
  });
  // V397: 学习多 Agent 协作(讲解→出题→反馈, 借鉴 LingxiLearn)
  app.post("/api/education/agents/orchestrate", async (request) => {
    const { learningAgentOrchestrator } = await import("../services/learning-agent-orchestrator.js");
    const body = z.object({ studentId: z.string().optional(), subject: z.string(), knowledgePoint: z.string(), userAnswer: z.string().optional(), sourceId: z.string().optional() }).parse(request.body);
    return learningAgentOrchestrator.orchestrateLearningAgents(body);
  });
  // V394: 执行器产物 → needs_review 三态机(确认后可挂载到学习计划)
  // V395: 批量生成工作流(计划全部组件 → 执行器 → 三态机)
  app.post("/api/education/components/batch", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ studentId: z.string().optional(), subject: z.string(), goal: z.string(), components: z.array(z.object({ type: z.string(), knowledgePoint: z.string().optional() })), sourceId: z.string().optional() }).parse(request.body);
    return componentExecutorService.generatePlanComponents(body);
  });

  app.post("/api/education/components/submit", async (request) => {
    const { componentExecutorService } = await import("../services/component-executor-service.js");
    const body = z.object({ studentId: z.string().optional(), subject: z.string(), goal: z.string(), kind: z.enum(["courseware", "flashcards", "quiz"]), content: z.any(), issues: z.any().optional() }).parse(request.body);
    return componentExecutorService.submitToReview(body as any);
  });

  app.post("/api/education/intent", async (request, reply) => {
    const { educationIntentService } = await import("../services/education-intent-service.js");
    const body = z.object({ text: z.string().max(4000), attachmentsText: z.string().max(20000).optional() }).parse(request.body);
    const r = await educationIntentService.classifyLearnIntent({ text: body.text, attachmentsText: body.attachmentsText });
    if (r.safetyAction === "block") return reply.code(400).send({ error: { code: "INTENT_BLOCKED", message: r.rationale }, result: r });
    return r;
  });

  // V387: 产物审查三态机 + 材料分析(借鉴 TraitTutor needs_review)
  // POST /api/materials/analyze — 材料分析快照{title, content, sourceId?}
  // POST /api/generations — 登记生成产物{subject, goal, kind, content, issues?} → needs_review/confirmed
  // POST /api/generations/:id/confirm | /discard | /attach — 三态机流转
  // GET  /api/generations?status=needs_review — 待审查列表
  app.post("/api/materials/analyze", async (request) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    return materialReviewService.analyzeMaterial(request.body as any);
  });
  app.post("/api/generations", async (request) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    return materialReviewService.createGeneration(request.body as any);
  });
  app.get("/api/generations", async (request) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    const q = request.query as Record<string, string | undefined>;
    return materialReviewService.listReviews({ studentId: q.studentId, status: q.status });
  });
  app.post("/api/generations/:id/confirm", async (request, reply) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    const r = await materialReviewService.confirmGeneration({ id: (request.params as any).id });
    if (!r.ok) return reply.code(400).send({ error: { code: "REVIEW_INVALID", message: r.error } });
    return r;
  });
  app.post("/api/generations/:id/discard", async (request, reply) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    const body = (request.body || {}) as { note?: string };
    const r = await materialReviewService.discardGeneration({ id: (request.params as any).id, note: body.note });
    if (!r.ok) return reply.code(400).send({ error: { code: "REVIEW_INVALID", message: r.error } });
    return r;
  });
  app.post("/api/generations/:id/attach", async (request, reply) => {
    const { materialReviewService } = await import("../services/material-review-service.js");
    const body = (request.body || {}) as { planId?: string };
    const r = await materialReviewService.attachToPlan({ id: (request.params as any).id, planId: body.planId ?? "" });
    if (!r.ok) return reply.code(400).send({ error: { code: "REVIEW_INVALID", message: r.error } });
    return r;
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
    // V413: 可选课题归属 — 完成后落 pipeline_runs(流水线总览可见)
    projectId: z.string().uuid().optional().nullable(),
    method: z.enum(["descriptive", "ols", "did", "did_twfe", "event_study", "iv", "rdd", "panel_fe", "psm", "scm", "logit", "ologit", "mnl", "crosstab", "genvars", "filter", "meta_analysis"]),
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
        { id: "mediation", label: "中介效应", en: "Mediation", desc: "三步法+Bootstrap 中介检验(X→M→Y)", category: "机制分析", engine: "statsmodels", skills: ["10-Jill0099-causal-inference-mixtape"] },
        { id: "moderation", label: "调节效应", en: "Moderation", desc: "交互项检验(中心化后 X*M) 边际效应", category: "机制分析", engine: "statsmodels", skills: ["10-Jill0099-causal-inference-mixtape"] },
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
        { id: "meta_analysis", label: "元分析", en: "Meta-Analysis", desc: "固定/随机效应合并 + 异质性(Q/I²/τ²) + 森林图/漏斗图 (easymeta 方法论)", category: "证据综合", engine: "python", skills: ["easymeta"] },
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

  // ───── Computer Use（2026-08-27, ScienceX 对照: 截屏/鼠标/键盘）─────
  // 默认关闭: COMPUTER_USE_ENABLED=true 启用
  const cu = async () => (await import("../services/computer-use-service.js")).computerUseService;

  // GET /api/computer-use/status
  app.get("/api/computer-use/status", async () => {
    const s = await cu();
    return { enabled: s.isEnabled(), platform: process.platform };
  });

  // POST /api/computer-use/screenshot — 截屏 base64
  app.post("/api/computer-use/screenshot", async (request, reply) => {
    const s = await cu();
    if (!s.isEnabled()) return reply.code(403).send({ error: { code: "DISABLED", message: "Computer Use 未启用 (COMPUTER_USE_ENABLED=true)" } });
    return await s.screenshot();
  });

  // POST /api/computer-use/mouse — 鼠标 {action: move|click|dblclick, x, y}
  app.post("/api/computer-use/mouse", async (request, reply) => {
    const s = await cu();
    if (!s.isEnabled()) return reply.code(403).send({ error: { code: "DISABLED", message: "Computer Use 未启用" } });
    const body = z.object({ action: z.enum(["move", "click", "dblclick"]), x: z.number(), y: z.number() }).parse(request.body);
    return await s.mouseAction(body.action, body.x, body.y);
  });

  // POST /api/computer-use/type — 键盘输入 {text}
  app.post("/api/computer-use/type", async (request, reply) => {
    const s = await cu();
    if (!s.isEnabled()) return reply.code(403).send({ error: { code: "DISABLED", message: "Computer Use 未启用" } });
    const body = z.object({ text: z.string().min(1).max(500) }).parse(request.body);
    return await s.typeText(body.text);
  });

  // GET /api/computer-use/windows — 窗口列表
  app.get("/api/computer-use/windows", async (request, reply) => {
    const s = await cu();
    if (!s.isEnabled()) return reply.code(403).send({ error: { code: "DISABLED", message: "Computer Use 未启用" } });
    return await s.windowList();
  });

  // ───── SSH 远程访问（2026-08-27, Agentero 对照: 远程访问/数据留在用户服务器）─────
  // POST /api/ssh/tunnel — 建立 SSH 隧道 {localPort}
  app.post("/api/ssh/tunnel", async (request, reply) => {
    const body = z.object({ localPort: z.number().int().min(1024).max(65535).default(24173) }).parse(request.body);
    const { sshTunnelService } = await import("../services/ssh-tunnel-service.js");
    if (!sshTunnelService.sshConfigured()) return reply.code(403).send({ error: { code: "DISABLED", message: "SSH 未配置 (SSH_HOST/SSH_USER)" } });
    return sshTunnelService.openSshTunnel(body.localPort);
  });

  // DELETE /api/ssh/tunnel/:port — 关闭隧道
  app.delete("/api/ssh/tunnel/:port", async (request) => {
    const { port } = request.params as { port: string };
    const { sshTunnelService } = await import("../services/ssh-tunnel-service.js");
    return { ok: sshTunnelService.closeSshTunnel(Number(port)) };
  });

  // GET /api/ssh/tunnels — 隧道状态
  app.get("/api/ssh/tunnels", async () => {
    const { sshTunnelService } = await import("../services/ssh-tunnel-service.js");
    return { tunnels: sshTunnelService.tunnelStatus(), configured: sshTunnelService.sshConfigured() };
  });

  // GET /api/ssh/proxy?port=xxx&path=/api/documents — 通过隧道浏览远程知识库
  app.get("/api/ssh/proxy", async (request) => {
    const q = request.query as { port?: string; path?: string };
    const { sshTunnelService } = await import("../services/ssh-tunnel-service.js");
    return await sshTunnelService.proxyRemoteRequest(Number(q.port || 24173), String(q.path || "/api/projects"));
  });

  // ───── S3 云同步（2026-08-27, Agentero 对照: 云同步）─────
  // POST /api/s3/sync — 文献库快照同步到 S3
  app.post("/api/s3/sync", async () => {
    const { s3SyncService } = await import("../services/s3-sync-service.js");
    return await s3SyncService.syncToS3();
  });

  // GET /api/s3/backups — S3 里的同步文件
  app.get("/api/s3/backups", async () => {
    const { s3SyncService } = await import("../services/s3-sync-service.js");
    return await s3SyncService.listS3Backups();
  });

  // GET /api/s3/status — S3 配置状态
  app.get("/api/s3/status", async () => {
    const { s3SyncService } = await import("../services/s3-sync-service.js");
    return { configured: s3SyncService.s3Configured(), endpoint: process.env.S3_ENDPOINT || "" };
  });

  // ───── RSS / arXiv（2026-08-27, Agentero 对照: 文献导入源）─────
  // GET /api/rss/fetch?url=xxx — 抓取 RSS 源
  app.get("/api/rss/fetch", async (request, reply) => {
    const q = request.query as { url?: string };
    if (!q.url) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 url 参数" } });
    const { rssService } = await import("../services/rss-service.js");
    return await rssService.fetchRss(q.url);
  });

  // GET /api/rss/arxiv?topic=xxx — arXiv 今日推荐
  app.get("/api/rss/arxiv", async (request) => {
    const q = request.query as { topic?: string; max?: string };
    const { rssService } = await import("../services/rss-service.js");
    return await rssService.fetchArxivToday(q.topic || "machine learning", Math.min(30, Math.max(1, Number(q.max) || 10)));
  });

  // POST /api/rss/subscribe — 订阅 RSS {url, name, sourceId}
  app.post("/api/rss/subscribe", async (request) => {
    const body = z.object({ url: z.string().url(), name: z.string().min(1).max(100), sourceId: z.string().uuid() }).parse(request.body);
    const { rssService } = await import("../services/rss-service.js");
    return { ok: await rssService.saveRssSubscription(body.url, body.name, body.sourceId) };
  });

  // ───── BYOA / ACP（2026-08-27, Agentero 对照: 连接本机 Agent）─────
  // GET /api/byoa/status — ACP 配置状态
  app.get("/api/byoa/status", async () => {
    const { acpService } = await import("../services/acp-service.js");
    return { configured: acpService.byoaConfigured(), agent: process.env.BYOA_AGENT_NAME || "未配置" };
  });

  // POST /api/byoa/run — 外部 Agent 执行任务 {task, context?}
  app.post("/api/byoa/run", async (request) => {
    const body = z.object({ task: z.string().min(1).max(5000), context: z.string().max(20_000).optional() }).parse(request.body);
    const { acpService } = await import("../services/acp-service.js");
    return await acpService.runExternalAgent(body.task, body.context);
  });

  // ───── Agent 管理（2026-08-29, Agentero 对照: 支持快速安装、配置、卸载 Agent）─────
  // GET /api/byoa/agent-status — 运行状态(进程/配置/命令)
  app.get("/api/byoa/agent-status", async () => {
    const { acpService } = await import("../services/acp-service.js");
    return acpService.agentStatus();
  });

  // POST /api/byoa/agent/start — 启动 Agent 进程
  app.post("/api/byoa/agent/start", async () => {
    const { acpService } = await import("../services/acp-service.js");
    return acpService.startAgent();
  });

  // POST /api/byoa/agent/stop — 停止 Agent 进程
  app.post("/api/byoa/agent/stop", async () => {
    const { acpService } = await import("../services/acp-service.js");
    return acpService.stopAgent();
  });

  // POST /api/byoa/agent/test — 测试连接(发 initialize 请求)
  app.post("/api/byoa/agent/test", async () => {
    const { acpService } = await import("../services/acp-service.js");
    try {
      const r = await acpService.acpRequest("initialize", { protocolVersion: "2024-11-05" }, 15_000);
      return { ok: true, result: r };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  });

  // ───── 双链笔记 + 知识图谱（2026-08-27, Agentero 对照）─────
  // GET /api/notes — 笔记列表
  app.get("/api/notes", async (request) => {
    const q = request.query as { sourceId?: string };
    const { notesService } = await import("../services/notes-service.js");
    return { notes: await notesService.listNotes(q.sourceId) };
  });

  // POST /api/notes — 创建/更新笔记 {title, content, sourceId?}
  app.post("/api/notes", async (request) => {
    const body = z.object({ title: z.string().min(1).max(200), content: z.string().max(200_000), sourceId: z.string().uuid().optional() }).parse(request.body);
    const { notesService } = await import("../services/notes-service.js");
    return { note: await notesService.saveNote(body) };
  });

  // GET /api/notes/:id — 单笔记（含出链/入链）
  app.get("/api/notes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { notesService } = await import("../services/notes-service.js");
    return { note: await notesService.getNote(id) };
  });

  // GET /api/notes/graph — 知识图谱（节点+边）
  app.get("/api/notes/graph", async () => {
    const { notesService } = await import("../services/notes-service.js");
    return await notesService.noteGraph();
  });

  // ───── L2 wiki 维护器（2026-08-29, 借鉴 Inno Agent L2 wiki-maintainer）─────
  // GET /api/notes/audit — 巡检: 破损链接/孤立页/过期/重定向建议
  app.get("/api/notes/audit", async (request) => {
    const q = request.query as { days?: string };
    const { wikiMaintainerService } = await import("../services/wiki-maintainer.js");
    return await wikiMaintainerService.auditWiki(Number(q.days) || 60);
  });
  // POST /api/notes/audit/fix — 一键创建缺失笔记(createAll=true 忽略重定向建议)
  app.post("/api/notes/audit/fix", async (request) => {
    const body = (request.body ?? {}) as { createAll?: boolean };
    const { wikiMaintainerService } = await import("../services/wiki-maintainer.js");
    return await wikiMaintainerService.createMissingNotes(!!body.createAll);
  });

  // ───── 论文翻译（2026-08-27, Agentero 对照: 全局翻译+划词并排）─────
  // POST /api/translate — 全局翻译 {text, targetLang?}
  app.post("/api/translate", async (request) => {
    const body = z.object({ text: z.string().min(1).max(50_000), targetLang: z.string().max(20).optional() }).parse(request.body);
    const { translationService } = await import("../services/translation-service.js");
    return await translationService.translateText(body.text, body.targetLang);
  });

  // POST /api/translate/snippet — 划词并排 {snippet, context?, targetLang?}
  app.post("/api/translate/snippet", async (request) => {
    const body = z.object({ snippet: z.string().min(1).max(5000), context: z.string().max(5000).optional(), targetLang: z.string().max(20).optional() }).parse(request.body);
    const { translationService } = await import("../services/translation-service.js");
    return await translationService.translateSnippet(body.snippet, body.context, body.targetLang);
  });

  // POST /api/reader/ai — PDF 选中文本 AI 卡片（Agentero 对照: 解释/总结/翻译/追问）
  app.post("/api/reader/ai", async (request) => {
    const body = z.object({
      action: z.enum(["explain", "summarize", "translate", "ask"]),
      snippet: z.string().min(1).max(5000),
      context: z.string().max(5000).optional(),
      question: z.string().max(1000).optional()
    }).parse(request.body);
    const { readerAiService } = await import("../services/reader-ai-service.js");
    return await readerAiService.readerAiAction(body);
  });

  // ───── 参考文献解析（2026-08-27, Agentero 对照: 参考文献管理）─────
  // POST /api/references/parse — 解析文本中的参考文献 {content}
  app.post("/api/references/parse", async (request) => {
    const body = z.object({ content: z.string().min(10).max(500_000) }).parse(request.body);
    const { referenceService } = await import("../services/reference-service.js");
    return { references: referenceService.parseReferencesFromContent(body.content) };
  });

  // POST /api/references/import — 导入参考文献到项目 {sourceId, refs}
  app.post("/api/references/import", async (request) => {
    const body = z.object({
      sourceId: z.string().uuid(),
      refs: z.array(z.object({ raw: z.string(), title: z.string().nullable().optional(), doi: z.string().nullable().optional(), arxivId: z.string().nullable().optional(), url: z.string().nullable().optional() })),
    }).parse(request.body);
    const { referenceService } = await import("../services/reference-service.js");
    return await referenceService.importReferences(body.refs, body.sourceId);
  });

  // ───── 论文搜索导入（2026-08-27, Agentero 对照: 搜索论文名导入）─────
  // GET /api/papers/search?q=xxx — 搜索论文（arXiv + Semantic Scholar 双源）
  app.get("/api/papers/search", async (request) => {
    const q = request.query as { q?: string; max?: string };
    const { paperSourceService } = await import("../services/paper-source-service.js");
    if (!q.q) return { papers: [], error: "需要 q 参数" };
    return { papers: await paperSourceService.searchPapers(q.q, Math.min(10, Math.max(1, Number(q.max) || 5))) };
  });

  // POST /api/papers/import — 导入搜索结果到项目 {sourceId, paper}
  app.post("/api/papers/import", async (request, reply) => {
    const body = z.object({
      sourceId: z.string().uuid(),
      paper: z.object({ title: z.string().min(1), abstract: z.string().optional(), authors: z.array(z.string()).optional(), year: z.number().optional(), doi: z.string().optional(), url: z.string().optional(), source: z.string().optional(), externalId: z.string().optional() }),
    }).parse(request.body);
    const { paperSourceService } = await import("../services/paper-source-service.js");
    return await paperSourceService.importPaper(body.paper, body.sourceId);
  });

  // ───── Cool Papers / 魔搭导入（2026-08-29, Agentero 对照: 软件内浏览 Cool Papers 并导入文献）─────
  // GET /api/papers/coolpapers/topics — 可用主题列表
  app.get("/api/papers/coolpapers/topics", async () => {
    const { paperSourceService } = await import("../services/paper-source-service.js");
    return { topics: paperSourceService.coolPapersTopics() };
  });

  // GET /api/papers/coolpapers?topic=cs.AI&max=20 — Cool Papers 每日精选
  app.get("/api/papers/coolpapers", async (request) => {
    const q = request.query as { topic?: string; max?: string };
    const { paperSourceService } = await import("../services/paper-source-service.js");
    return { papers: await paperSourceService.fetchCoolPapers(q.topic || "cs.AI", Math.min(50, Math.max(1, Number(q.max) || 20))) };
  });

  // GET /api/papers/modelscope/status — 魔搭站点可达性
  app.get("/api/papers/modelscope/status", async () => {
    const { paperSourceService } = await import("../services/paper-source-service.js");
    return await paperSourceService.modelscopeReachable();
  });

  // POST /api/papers/modelscope/import — 魔搭链接导入 {sourceId, url}
  app.post("/api/papers/modelscope/import", async (request, reply) => {
    const body = z.object({ sourceId: z.string().uuid(), url: z.string().url().max(500) }).parse(request.body);
    const { paperSourceService } = await import("../services/paper-source-service.js");
    const paper = await paperSourceService.fetchModelScopeLink(body.url);
    if (!paper) return reply.code(400).send({ error: { code: "FETCH_FAILED", message: "无法解析魔搭链接, 请确认链接可访问" } });
    return await paperSourceService.importPaper(paper, body.sourceId);
  });

  // ───── 论文分享链接(2026-08-29, 借鉴 frowang /s/:token 分享模式)─────
  // POST /api/papers/share — 生成分享链接 {documentId, expiresHours?, maxUses?}
  app.post("/api/papers/share", async (request, reply) => {
    const body = z.object({ documentId: z.string().uuid(), expiresHours: z.number().optional(), maxUses: z.number().optional() }).parse(request.body);
    const { paperShareService } = await import("../services/paper-share-service.js");
    const r = await paperShareService.createShareLink({ documentId: body.documentId, expiresHours: body.expiresHours, maxUses: body.maxUses });
    if (!r.ok) return reply.code(400).send({ error: { code: "SHARE_FAILED", message: r.error } });
    return { ok: true, url: r.url, token: r.share!.token, share: r.share };
  });
  // GET /api/papers/share/:token — 解析分享链接(校验过期/次数, 返回论文信息)
  app.get("/api/papers/share/:token", async (request, reply) => {
    const { paperShareService } = await import("../services/paper-share-service.js");
    const r = await paperShareService.resolveShare((request.params as any).token);
    if (!r.ok) return reply.code(404).send({ error: { code: "SHARE_INVALID", message: r.error } });
    return { ok: true, title: r.document?.title, share: r.share };
  });
  // POST /api/papers/share/:token/receive — 接收导入 {sourceId}
  app.post("/api/papers/share/:token/receive", async (request, reply) => {
    const body = z.object({ sourceId: z.string().uuid() }).parse(request.body);
    const { paperShareService } = await import("../services/paper-share-service.js");
    const r = await paperShareService.receiveShare({ token: (request.params as any).token, sourceId: body.sourceId });
    if (!r.ok) return reply.code(404).send({ error: { code: "SHARE_INVALID", message: r.error } });
    return { ok: true, imported: r.imported, title: r.title };
  });
  // GET /api/papers/share/my — 我的分享列表
  app.get("/api/papers/share/my", async () => {
    const { paperShareService } = await import("../services/paper-share-service.js");
    return { ok: true, shares: await paperShareService.listMyShares() };
  });

  // ───── 论文结构解析（2026-08-29, Agentero 对照: 解析论文中的图/表/公式/算法并结合上下文理解）─────
  // POST /api/papers/structure — 从文本定位图表公式算法 {content}
  app.post("/api/papers/structure", async (request) => {
    const body = z.object({ content: z.string().min(10).max(1_000_000) }).parse(request.body);
    const { paperStructureService } = await import("../services/paper-structure-service.js");
    return { overview: paperStructureService.structureOverview(body.content) };
  });

  // POST /api/papers/structure/explain — 对单个块生成理解摘要 {block}
  app.post("/api/papers/structure/explain", async (request) => {
    const body = z.object({
      block: z.object({
        kind: z.enum(["figure", "table", "formula", "algorithm"]),
        label: z.string(), content: z.string().max(2000),
        contextBefore: z.string().max(300), contextAfter: z.string().max(300),
      }),
    }).parse(request.body);
    const { paperStructureService } = await import("../services/paper-structure-service.js");
    return await paperStructureService.explainBlock(body.block);
  });

  // POST /api/papers/links — arXiv/alphaXiv 跳转链接解析 {arxivId?, doi?, title?}
  app.post("/api/papers/links", async (request) => {
    const body = z.object({
      arxivId: z.string().max(100).optional(),
      doi: z.string().max(200).optional(),
      title: z.string().max(300).optional(),
    }).parse(request.body);
    const { paperSourceService } = await import("../services/paper-source-service.js");
    return { links: paperSourceService.resolvePaperLinks(body) };
  });

  // ───── 引用库文献→查找新文献（2026-08-29, Agentero 对照: 一键查找引用库文献的新文献）─────
  // GET /api/papers/discover?sourceId=&maxSeeds=3 — 以库中文献为种子找新文献(OpenAlex 引用)
  app.get("/api/papers/discover", async (request) => {
    const q = request.query as { sourceId?: string; maxSeeds?: string; maxPerSeed?: string };
    const { citationDiscoveryService } = await import("../services/citation-discovery-service.js");
    const candidates = await citationDiscoveryService.discoverNewPapers(
      q.sourceId && /^[0-9a-f-]{36}$/i.test(q.sourceId) ? q.sourceId : null,
      Math.min(5, Math.max(1, Number(q.maxSeeds) || 3)),
      Math.min(10, Math.max(1, Number(q.maxPerSeed) || 6))
    );
    return { candidates, seeds: await citationDiscoveryService.getSeedTitles(q.sourceId && /^[0-9a-f-]{36}$/i.test(q.sourceId) ? q.sourceId : null, 5) };
  });

  // ───── Zotero 集成（2026-08-27, Agentero 对照: Zotero 生态衔接）─────
  // POST /api/zotero/import — 导入 Zotero 书库到项目 {sourceId}
  app.post("/api/zotero/import", async (request, reply) => {
    const body = z.object({ sourceId: z.string().uuid() }).parse(request.body);
    const { zoteroService } = await import("../services/zotero-service.js");
    try {
      const r = await zoteroService.importZoteroLibrary(body.sourceId);
      return { ok: true, imported: r.imported, skipped: r.skipped };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message || e).slice(0, 200) } });
    }
  });

  // POST /api/zotero/plugin-import — 浏览器插件/书签导入（2026-08-29, Agentero 对照）
  // 兼容 Zotero 浏览器插件 translators 输出: {items: [{title, creators, DOI, url, date, abstractNote, tags}]}
  app.post("/api/zotero/plugin-import", async (request, reply) => {
    const body = z.object({
      sourceId: z.string().uuid(),
      items: z.array(z.object({
        title: z.string().optional(), creators: z.array(z.object({ firstName: z.string().optional(), lastName: z.string().optional(), name: z.string().optional() })).optional(),
        date: z.string().optional(), DOI: z.string().optional(), url: z.string().optional(), abstractNote: z.string().optional(),
        tags: z.array(z.union([z.object({ tag: z.string().optional() }), z.string()])).optional(),
        itemType: z.string().optional(),
      })).min(1).max(200),
    }).parse(request.body);
    const { zoteroService } = await import("../services/zotero-service.js");
    const r = await zoteroService.importFromBrowserPlugin(body.items, body.sourceId);
    return { ok: true, imported: r.imported, skipped: r.skipped };
  });

  // GET /api/zotero/export — 导出 BibTeX（可选 sourceId 过滤）
  // ⚠ 2026-08-29 修复: 无论是否带 download 参数都直接下载 .bib 文件 —
  //   旧 bundle 的 <a target="_blank"> 打开 JSON 页面导致"闪退到新页面", 彻底消除该场景
  app.get("/api/zotero/export", async (request, reply) => {
    const { zoteroService } = await import("../services/zotero-service.js");
    const items = await zoteroService.fetchViaHttp();
    const bib = zoteroService.exportBibtex(items || []);
    // RFC 5987: 中文文件名用 filename* UTF-8 编码
    reply.header("Content-Disposition", `attachment; filename="bibliography.bib"; filename*=UTF-8''bibliography.bib`);
    reply.header("Content-Type", "application/x-bibtex; charset=utf-8");
    return reply.send(bib);
  });

  // GET /api/zotero/status — Zotero 可用性
  app.get("/api/zotero/status", async () => {
    const { zoteroService } = await import("../services/zotero-service.js");
    const items = await zoteroService.fetchViaHttp();
    return { connected: Array.isArray(items), itemCount: Array.isArray(items) ? items.length : 0 };
  });

  // ───── IM 接入（2026-08-27, ScienceX 对照: 飞书/钉钉/Telegram 远程对话）─────
  // POST /api/im/feishu — 飞书机器人回调（需在飞书开放平台配置事件订阅指向此 URL）
  app.post("/api/im/feishu", async (request, reply) => {
    const { imService } = await import("../services/im-service.js");
    const msg = imService.parseFeishuCallback(request.body);
    if (!msg) return { challenge: (request.body as any)?.challenge };  // 飞书 URL 验证
    const r = await imService.handleImCommand(msg);
    const imCfg = await imService.getImConfig().catch(() => null);
    if (imCfg?.feishuWebhook) await imService.sendFeishu(imCfg.feishuWebhook, r.text).catch(() => {});
    return { ok: true };
  });

  // POST /api/im/dingtalk — 钉钉机器人回调
  app.post("/api/im/dingtalk", async (request, reply) => {
    const { imService } = await import("../services/im-service.js");
    const msg = imService.parseDingtalkCallback(request.body);
    if (!msg) return { ok: true };
    const r = await imService.handleImCommand(msg);
    const imCfg = await imService.getImConfig().catch(() => null);
    if (imCfg?.dingtalkWebhook) await imService.sendDingtalk(imCfg.dingtalkWebhook, r.text).catch(() => {});
    return { ok: true };
  });

  // POST /api/im/telegram — Telegram bot webhook 回调
  app.post("/api/im/telegram", async (request, reply) => {
    const { imService } = await import("../services/im-service.js");
    const msg = imService.parseTelegramCallback(request.body);
    if (!msg) return { ok: true };
    const r = await imService.handleImCommand(msg);
    const imCfg = await imService.getImConfig().catch(() => null);
    if (imCfg?.telegramToken && msg.from) {
      await imService.sendTelegram(imCfg.telegramToken, msg.from, r.text).catch(() => {});
    }
    return { ok: true };
  });

  // 企业微信: 自建应用回调(GET=URL 验证 echostr; POST=加密消息) + 群机器人 webhook 发送
  // 企业微信: GET=URL 验证(echostr 解密回显); POST=加密消息回调
  app.get("/api/im/wecom", async (request, reply) => {
    const { imService } = await import("../services/im-service.js");
    const { wecomVerifySignature, wecomDecrypt } = await import("../services/wecom-service.js");
    const q = request.query as Record<string, string>;
    const cfg = await imService.getImConfig().catch(() => null);
    const token = cfg?.wecomCallbackToken, aesKey = cfg?.wecomEncodingAesKey, corpId = cfg?.wecomCorpId;
    if (!token || !aesKey || !corpId) return reply.code(500).send("wecom 未配置(corp_id/token/encoding_aes_key)");
    if (!q.echostr) return reply.code(400).send("missing echostr");
    const ok = wecomVerifySignature(token, q.timestamp || "", q.nonce || "", q.echostr, q.msg_signature || "");
    if (!ok) return reply.code(403).send("signature mismatch");
    try {
      const decrypted = wecomDecrypt(aesKey, q.echostr, corpId);
      reply.type("text/plain").send(decrypted);
      return;
    } catch (e: any) { return reply.code(500).send(`decrypt failed: ${String(e?.message || e).slice(0, 80)}`); }
  });
  app.post("/api/im/wecom", async (request, reply) => {
    const { imService } = await import("../services/im-service.js");
    const { wecomVerifySignature, wecomDecrypt, parseWeComCallback, extractXmlText, extractXmlCdata } = await import("../services/wecom-service.js");
    const cfg = await imService.getImConfig().catch(() => null);
    const token = cfg?.wecomCallbackToken, aesKey = cfg?.wecomEncodingAesKey, corpId = cfg?.wecomCorpId;
    if (!token || !aesKey || !corpId) return reply.code(500).send("wecom 未配置(corp_id/token/encoding_aes_key)");
    // 消息回调: body 是 XML(Encrypt/MsgSignature/Nonce 为 CDATA, TimeStamp 纯文本)
    const rawBody = String(request.body || "");
    const encrypt = extractXmlCdata(rawBody, "Encrypt");
    const sig = extractXmlCdata(rawBody, "MsgSignature");
    const ts = extractXmlText(rawBody, "TimeStamp");
    const nonce = extractXmlCdata(rawBody, "Nonce");
    if (!encrypt) return reply.code(400).send("no Encrypt");
    const ok = wecomVerifySignature(token, ts, nonce, encrypt, sig);
    if (!ok) return reply.code(403).send("signature mismatch");
    try {
      const xml = wecomDecrypt(aesKey, encrypt, corpId);
      const msg = parseWeComCallback(xml);
      if (msg) {
        const r = await imService.handleImCommand(msg);
        // 回复走自建应用 message/send(touser=发送者)
        if (cfg.wecomCorpSecret && cfg.wecomAgentId && msg.from) {
          const { wecomSendText } = await import("../services/wecom-service.js");
          await wecomSendText({ corpId, corpSecret: cfg.wecomCorpSecret, agentId: cfg.wecomAgentId, content: r.text, touser: msg.from }).catch(() => {});
        }
      }
      reply.type("text/plain").send("success");
      return;
    } catch (e: any) {
      return reply.code(500).send(`decrypt failed: ${String(e?.message || e).slice(0, 80)}`);
    }
  });
  // 企业微信测试发送: mode=app(自建应用) / mode=webhook(群机器人)
  app.post("/api/im/wecom/send", async (request, reply) => {
    const body = (request.body ?? {}) as { mode?: string; content?: string; touser?: string };
    const { imService } = await import("../services/im-service.js");
    const { wecomSendText, wecomWebhookSend } = await import("../services/wecom-service.js");
    const cfg = await imService.getImConfig().catch(() => null);
    const content = body.content || "SocioSeek 企业微信测试 ✅";
    if (body.mode === "webhook") {
      if (!cfg?.wecomWebhook) return reply.code(400).send({ ok: false, error: "未配置群机器人 webhook" });
      const ok = await wecomWebhookSend(cfg.wecomWebhook, content);
      return ok ? { ok: true } : reply.code(502).send({ ok: false, error: "群机器人发送失败(检查 webhook 与关键词)" });
    }
    if (!cfg?.wecomCorpId || !cfg?.wecomCorpSecret || !cfg?.wecomAgentId) {
      return reply.code(400).send({ ok: false, error: "未配置自建应用(corp_id/corp_secret/agent_id)" });
    }
    const touser = body.touser || cfg.wecomTouser || "@all";
    const r = await wecomSendText({ corpId: cfg.wecomCorpId, corpSecret: cfg.wecomCorpSecret, agentId: cfg.wecomAgentId, content, touser });
    return r.ok ? { ok: true } : reply.code(502).send(r);
  });

  // POST /api/im/send — 手动推送（测试/告警广播）
  app.post("/api/im/send", async (request) => {
    const body = z.object({ text: z.string().min(1).max(2000) }).parse(request.body);
    const { imService } = await import("../services/im-service.js");
    return { sent: await imService.imBroadcast(body.text) };
  });

  // GET /api/im/status — IM 配置状态(DB 优先 + env 兜底)
  app.get("/api/im/status", async () => {
    const { getImConfig } = await import("../services/im-service.js");
    const cfg = await getImConfig();
    return {
      feishu: !!cfg.feishuWebhook,
      dingtalk: !!cfg.dingtalkWebhook,
      telegram: !!(cfg.telegramToken && cfg.telegramChatId),
      config: {
        feishuWebhook: cfg.feishuWebhook ? `…${cfg.feishuWebhook.slice(-24)}` : "",
        dingtalkWebhook: cfg.dingtalkWebhook ? `…${cfg.dingtalkWebhook.slice(-24)}` : "",
        telegramConfigured: !!(cfg.telegramToken && cfg.telegramChatId),
      },
    };
  });
  // GET /api/im/config — IM 完整配置(前端编辑用; 令牌类打码展示)
  app.get("/api/im/config", async () => {
    const { getImConfig } = await import("../services/im-service.js");
    const cfg = await getImConfig();
    return {
      config: {
        feishuWebhook: cfg.feishuWebhook,
        dingtalkWebhook: cfg.dingtalkWebhook,
        telegramToken: cfg.telegramToken ? `••••${cfg.telegramToken.slice(-4)}` : "",
        telegramTokenSet: !!cfg.telegramToken,
        telegramChatId: cfg.telegramChatId,
        wecomCorpId: cfg.wecomCorpId,
        wecomCorpSecret: cfg.wecomCorpSecret ? `••••${cfg.wecomCorpSecret.slice(-4)}` : "",
        wecomCorpSecretSet: !!cfg.wecomCorpSecret,
        wecomAgentId: cfg.wecomAgentId,
        wecomCallbackToken: cfg.wecomCallbackToken ? `••••${cfg.wecomCallbackToken.slice(-4)}` : "",
        wecomCallbackTokenSet: !!cfg.wecomCallbackToken,
        wecomEncodingAesKey: cfg.wecomEncodingAesKey ? `••••${cfg.wecomEncodingAesKey.slice(-4)}` : "",
        wecomEncodingAesKeySet: !!cfg.wecomEncodingAesKey,
        wecomWebhook: cfg.wecomWebhook,
        wecomTouser: cfg.wecomTouser,
      },
    };
  });
  // POST /api/im/config — 保存 IM 配置(DB, 即时生效)
  app.post("/api/im/config", async (request, reply) => {
    const body = (request.body ?? {}) as {
      feishuWebhook?: string; dingtalkWebhook?: string;
      telegramToken?: string; telegramChatId?: string;
      wecomCorpId?: string; wecomCorpSecret?: string; wecomAgentId?: string;
      wecomCallbackToken?: string; wecomEncodingAesKey?: string;
      wecomWebhook?: string; wecomTouser?: string;
    };
    const { saveImConfig } = await import("../services/im-service.js");
    const cfg = await saveImConfig({
      feishuWebhook: body.feishuWebhook,
      dingtalkWebhook: body.dingtalkWebhook,
      telegramToken: body.telegramToken,
      telegramChatId: body.telegramChatId,
      wecomCorpId: body.wecomCorpId,
      wecomCorpSecret: body.wecomCorpSecret,
      wecomAgentId: body.wecomAgentId,
      wecomCallbackToken: body.wecomCallbackToken,
      wecomEncodingAesKey: body.wecomEncodingAesKey,
      wecomWebhook: body.wecomWebhook,
      wecomTouser: body.wecomTouser,
    });
    return { ok: true, config: {
      feishu: !!cfg.feishuWebhook, dingtalk: !!cfg.dingtalkWebhook,
      telegram: !!(cfg.telegramToken && cfg.telegramChatId),
      wecom: !!(cfg.wecomCorpId && cfg.wecomCorpSecret && cfg.wecomAgentId) || !!cfg.wecomWebhook,
    } };
  });
  // POST /api/jupyter/execute — 执行一个代码单元（复用实证 venv 沙箱）
  // body: { code, sessionId?, restart?, cellIndex? } → { ok, output, variables, figures, sessionId }
  app.post("/api/jupyter/execute", async (request, reply) => {
    const schema = z.object({
      code: z.string().min(1).max(50_000),
      sessionId: z.string().max(64).optional(),
      restart: z.boolean().optional(),
      cellIndex: z.number().int().optional(),
    });
    const body = schema.parse(request.body);
    const { jupyterService } = await import("../services/jupyter-service.js");
    try {
      return { result: await jupyterService.executeJupyterCell(body) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message || e).slice(0, 200) } });
    }
  });

  // POST /api/jupyter/reset — 重置会话（Restart 语义: 清变量 + 日志）
  app.post("/api/jupyter/reset", async (request) => {
    const body = z.object({ sessionId: z.string().max(64) }).parse(request.body);
    const { jupyterService } = await import("../services/jupyter-service.js");
    jupyterService.resetJupyterSession(body.sessionId);
    return { ok: true };
  });

  // GET /api/jupyter/logs?sessionId=xxx — 会话执行日志（Restart & Run All 进度）
  app.get("/api/jupyter/logs", async (request) => {
    const q = request.query as { sessionId?: string };
    const { jupyterService } = await import("../services/jupyter-service.js");
    if (!q.sessionId) return { logs: [] };
    return { logs: jupyterService.getJupyterSessionLog(q.sessionId) };
  });

  // GET /api/jupyter/ready — venv 就绪检查
  app.get("/api/jupyter/ready", async () => {
    const { jupyterService } = await import("../services/jupyter-service.js");
    return jupyterService.checkJupyterReady();
  });

  // POST /api/jupyter/upload — 上传数据文件（存 .cache/jupyter-uploads, pandas 可用相对路径读）
  app.post("/api/jupyter/upload", async (request, reply) => {
    const schema = z.object({
      fileName: z.string().min(1).max(200).regex(/^[^\\\/:*?"<>|]+$/),  // 防路径穿越
      content: z.string().max(5_000_000),
    });
    const body = schema.parse(request.body);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const rootDir = process.env.SAG_ROOT || process.cwd();
    const uploadsDir = dataPath("jupyter", "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(uploadsDir, body.fileName), body.content, "utf-8");
      return { ok: true, fileName: body.fileName, dir: uploadsDir };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message || e).slice(0, 200) } });
    }
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
      // 审查 P2-5: recordId 分支补 docx(历史卡导出) — 取第一条表生成三线表 Word
      if (body.format === "docx") {
        if (!tables.length) return reply.code(422).send({ error: { code: "NO_TABLE", message: "该记录无表格可导出" } });
        const r = await empiricalService.exportTableDocx(tables[0]);
        if (!r.ok || !r.base64) return reply.code(500).send({ error: { code: "EXPORT_FAILED", message: r.error ?? "docx 生成失败" } });
        return { ok: true, base64: r.base64, fileName: r.fileName };
      }
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "format 需为 latex/csv/docx" } });
    }
    if (!body.table) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需要 table 或 recordId" } });
    if (body.format === "latex") {
      return reply.type("text/plain").send(empiricalService.latexTable(body.table));
    }
    if (body.format === "csv") {
      return reply.type("text/csv").send(empiricalService.csvTable(body.table));
    }
    // C4(参考产品三线表 Word 导出): python-docx 生成 booktabs 风格 docx
    if (body.format === "docx") {
      const r = await empiricalService.exportTableDocx(body.table);
      if (!r.ok || !r.base64) return reply.code(500).send({ error: { code: "EXPORT_FAILED", message: r.error ?? "docx 生成失败" } });
      return { ok: true, base64: r.base64, fileName: r.fileName };
    }
    return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "format 需为 latex/csv/docx" } });
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
  /**
   * ⚠ 实证台这两个路由的鉴权是**刻意宽松**的 —— 改之前先读迁移 156 的注释。
   *
   * 实证台的老前端在本机/未登录状态下是可用的, 直接加 `requireUser` 会让它 401
   * (注意 `requireUser` **要求 JWT 且不放行本机**, 本机豁免在另一个 onRequest 钩子层)。
   * 所以这里用 `optionalUser`: 有 token 就记归属并按归属过滤, 没有就沿用旧行为。
   * 效果是"新数据开始有归属, 老数据不消失", 同时给后续逐路由收紧留了路径
   * (实证台其余 60 个路由**尚未**做归属校验, 这一点迁移 156 里写明了)。
   */
  const optionalUser = async (request: any) => {
    const token = String((request.headers.authorization || "").replace("Bearer ", "").trim());
    const payload = token ? authService.verifyToken(token) : null;
    if (!payload) return null;
    return (await authService.getUserById(payload.uid)) ?? null;
  };

  app.post("/api/empirical/projects", async (request, reply) => {
    const body = empProjectSchema.parse(request.body);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    const user = await optionalUser(request);
    try {
      return { project: await questionnaireService.createProject({ ...body, userId: user?.id ?? null }) };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 200) } });
    }
  });
  app.get("/api/empirical/projects", async (request) => {
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    const user = await optionalUser(request);
    return { projects: await questionnaireService.listProjects(user?.id ?? null) };
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
      const tmpDir = dataPath("questionnaire_tmp");
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

  // V413: 课题流水线总览(问卷+数据版本+全阶段分析 runs 时间线)
  app.get("/api/empirical/projects/:projectId/pipeline", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    z.string().uuid().parse(projectId);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    return { overview: await questionnaireService.projectPipelineOverview(projectId) };
  });

  // V413: 课题全套报告导出(流水线 → LaTeX + Word)
  app.post("/api/empirical/projects/:projectId/report", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    z.string().uuid().parse(projectId);
    const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
    const { empiricalService } = await import("../services/empirical-service.js");
    try {
      const overview = await questionnaireService.projectPipelineOverview(projectId);
      const r = await empiricalService.exportProjectReport({ overview: overview as Record<string, unknown> });
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "导出失败" } });
      return { ok: true, taskId: r.taskId };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  // V413: 报告文件下载(data/agent_workspace/reports/)
  app.get("/api/empirical/reports/:file", async (request, reply) => {
    // 鉴权: 这三条静态路由原本完全开放(实测: 未登录 curl 能下到别人的报告/图/聊天附件)
    const user = await requireUser(request, reply); if (!user) return;
    void user;
    const nodePath = await import("node:path");
    const raw = String((request.params as { file?: string }).file ?? "");
    // 单层文件名(旧实现允许子路径, 这里收紧; 脚本产出始终是平铺文件名)
    if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..") || raw.includes(":")) {
      return reply.code(400).send({ error: "文件名非法" });
    }
    // 走 blob-store: 本地盘 / 共享卷 / 对象存储同一套代码 —— 多副本下不会再"文件在本副本上没有"
    const data = await getObject(`empirical/reports/${raw}`);
    if (!data) return reply.code(404).send({ error: "文件不存在" });
    const ext = nodePath.extname(raw).toLowerCase();
    const mime = ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : ext === ".tex" ? "text/plain" : ext === ".pdf" ? "application/pdf" : "application/octet-stream";
    reply.header("Content-Type", mime);
    reply.header("Content-Disposition", `attachment; filename="${nodePath.basename(raw)}"`);
    return reply.send(data);
  });

  const dataVersionSchema = z.object({
    projectId: z.string().uuid().optional(),
    name: z.string().min(1).max(200),
    columns: z.array(z.string().min(1)).min(1),
    nRows: z.number().int().min(0).default(0),
    // V399-2 P2 补齐: 上传数据内容 sha256（同内容重传判重, 数据变更感知）
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    // V399-2 P2 补齐(登记时自动画像): 数据行(可选) — 服务端自动算列画像存 meta.profile
    rows: z.array(z.array(z.unknown())).optional(),
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

  // ═══════════ V413: 问卷仿真数据 + 论文级图表生成（补齐工作台两缺口）═══════════
  // POST /api/empirical/simulate — 按已识别问卷 structure 生成 N 份带内在结构的模拟作答
  app.post("/api/empirical/simulate", async (request, reply) => {
    const schema = z.object({
      projectId: z.string().uuid().optional().nullable(),      // V413: 落流水线(pipeline_runs)用
      questionnaireId: z.string().uuid().optional(),          // 从库取结构
      questionnaire: z.array(z.unknown()).optional(),          // 或直接传结构
      params: z.record(z.unknown()).default({}),               // { n, seed, design?, skip?, missing? }
    });
    const body = schema.parse(request.body);
    const { empiricalService } = await import("../services/empirical-service.js");
    try {
      let qs = body.questionnaire;
      if (!qs || qs.length === 0) {
        if (!body.questionnaireId) {
          return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "需 questionnaireId 或 questionnaire" } });
        }
        const { questionnaireService } = await import("../services/empirical-questionnaire-service.js");
        const rec = await questionnaireService.getQuestionnaire(body.questionnaireId);
        if (!rec) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "问卷不存在" } });
        qs = Array.isArray(rec.structure) ? rec.structure : [];
      }
      const r = await empiricalService.simulateQuestionnaireData({ questionnaire: qs as unknown[], params: body.params, projectId: body.projectId ?? null });
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "生成失败" } });
      return { ok: true, taskId: r.taskId, questionnaireId: body.questionnaireId ?? null };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  // POST /api/empirical/figures — 实证结果 → 论文级 matplotlib 图(alpha_bar/boxplot/heatmap/forest/compare)
  app.post("/api/empirical/figures", async (request, reply) => {
    const body = z.object({ spec: z.record(z.unknown()) }).parse(request.body);
    const { empiricalService } = await import("../services/empirical-service.js");
    try {
      const r = await empiricalService.generateEmpiricalFigures({ spec: body.spec });
      if (!r.ok) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: r.error ?? "绘图失败" } });
      return { ok: true, taskId: r.taskId };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: String(e?.message ?? e).slice(0, 300) } });
    }
  });

  // GET /api/empirical/figures/:file — 生成的图表静态服务(blob-store: empirical/figures/)
  app.get("/api/empirical/figures/:file", async (request, reply) => {
    // V414 fix: 原来无条件 requireUser —— 但前端是用 <img src> / <a href> 加载这张图的
    //   (web/src/components/empirical/PipelineOverview.tsx:85-87), 浏览器这两种方式
    //   **都带不了 Authorization 头** → 本机开发时图全是碎的(实测 401)。
    //   本机 socket 连接按全局鉴权口径放行; 远程仍需登录。
    if (!isLocalRequest(request)) {
      const user = await requireUser(request, reply); if (!user) return;
      void user;
    }
    const nodePath = await import("node:path");
    const raw = String((request.params as { file?: string }).file ?? "");
    if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..") || raw.includes(":")) {
      return reply.code(400).send({ error: "文件名非法" });
    }
    // 走 blob-store —— 多副本下不会再"图在本副本上没有"
    const data = await getObject(`empirical/figures/${raw}`);
    if (!data) return reply.code(404).send({ error: "文件不存在" });
    const ext = nodePath.extname(raw).toLowerCase();
    const mime = ext === ".pdf" ? "application/pdf" : ext === ".svg" ? "image/svg+xml" : "image/png";
    reply.header("Content-Type", mime);
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(data);
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
  // usable: 只含"所属 provider 已配置密钥"的模型(前端下拉直接用, 避免选了必然失败的项)
  app.get("/api/llm/models", async () => ({
    models: LLM_MODEL_REGISTRY,
    usable: LLM_MODEL_REGISTRY.filter((m) => isModelUsable(m.id)),
    roleMap: getRoleModelMap(),
  }));

  // V389: Quota Rotation 路由熔断状态(前端诊断用)
  app.get("/api/llm/circuit-state", async () => {
    const { modelCircuitStats } = await import("../ai/llm-common.js");
    return { ok: true, circuits: modelCircuitStats() };
  });

  // V404-11: 路由诊断面(差距文档⑤) — 决策日志聚合: tier/模型分布/成功率/低估 flagged/节省提示
  app.get("/api/llm/routing-diagnostics", async () => {
    const { routingDiagnostics } = await import("../services/routing-log.js");
    return { ok: true, diag: routingDiagnostics() };
  });

  app.put("/api/llm/models", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { role?: LlmRole; modelId?: string };
    if (!body.role || !body.modelId) return reply.code(400).send({ error: "role 和 modelId 必填" });
    if (!findModelOption(body.modelId)) return reply.code(400).send({ error: `未知模型: ${body.modelId}` });
    if (!isModelUsable(body.modelId)) {
      const opt = findModelOption(body.modelId)!;
      return reply.code(400).send({ error: `${opt.label} 的密钥未配置(${getProviderEndpoint(opt.provider).keyEnv}), 无法使用` });
    }
    setRoleModel(body.role, body.modelId);
    await saveModelSelection();
    return { ok: true, roleMap: getRoleModelMap() };
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
    // S3: 防并发双跑 — running 不可重复入队; planning 是首次执行(允许); completed 不可重跑
    if (task.status === "running" || task.status === "completed") {
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
    // 执行方式登记: 别的实例(或本进程重启后)从队列表里领到这条时, 用它重建执行闭包。
    //   request 不能跨实例传, 所以重建时用一个最小 request(只带必要头部)。
    await registerAgentQueueRunners();
    agentTaskQueue.enqueueTask({
      taskId: params.id,
      priority,
      run: () => runAgentTaskInner(params.id, task, request),
      runner: "agent-task",
      payload: { taskId: params.id, auth: String(request.headers.authorization || "") },
    });
    return { ok: true, taskId: params.id, queued: true, priority };
  });

  // V394-4: 队列内部执行器（原 run 路由的后台执行逻辑抽出）
  /**
   * 注册"可跨实例重建"的执行方式。
   * 队列表里存的是 runner 名字 + payload; 任何实例(或本进程重启后)领取时用它重建闭包,
   * 这样副本缩容时任务不会蒸发。request 不能跨界传, 所以用 payload 里的 auth 重建最小 request。
   * 幂等: 模块级只注册一次。
   */
  let queueRunnersRegistered = false;
  async function registerAgentQueueRunners(): Promise<void> {
    const agentTaskQueueMod = await import("../services/agent-task-queue.js");
    if (queueRunnersRegistered) return;
    queueRunnersRegistered = true;
    const { registerQueueRunner } = agentTaskQueueMod;
    registerQueueRunner("agent-task", async (payload) => {
      const id = String(payload.taskId ?? "");
      if (!id) return;
      const r = await pool.query("select * from agent_tasks where id = $1::uuid", [id]);
      const task = r.rows[0];
      if (!task) return;
      // request 不能跨实例传 → 用 payload 里的 auth 重建一个最小请求对象(执行器只读 headers)
      const fakeReq = { headers: { authorization: String(payload.auth ?? "") } } as unknown as Parameters<typeof runAgentTaskInner>[2];
      await runAgentTaskInner(id, task, fakeReq);
    });
    registerQueueRunner("orchestrator", async (payload) => {
      const id = String(payload.taskId ?? "");
      if (!id) return;
      const { agentOrchestrator } = await import("../services/agent-orchestrator.js");
      // 工人执行仍走本实例的推理接口(与入队时同一条路径), 目标/项目从 payload 重建
      await agentOrchestrator.dispatchWorkers({
        parentTaskId: id,
        goal: String(payload.goal ?? ""),
        workerRunner: async (worker) => {
          const res = await fetch(SELF_BASE + "/api/reason/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sourceId: (payload.projectId as string) || undefined, query: worker.goal, mode: "adaptive" }),
          });
          const data: any = await res.json();
          // ⚠ data.error 是对象({code,message}) —— 直接当字符串用会在下游炸出 TypeError,
        //   把真正的错误盖掉。取 message(见 8002 处那条更详细的说明)。
        const errMsg9 = typeof data?.error === "string" ? data.error : data?.error?.message;
        return data?.trace?.hypothesis?.content || errMsg9 || "（无结果）";
        },
      });
    });
  }

  async function runAgentTaskInner(id: string, task: any, request: any): Promise<void> {
    /**
     * 本任务产出的文件都晚于它的创建时间 —— 质检用这个当基准, **不用"本步开始时间"**。
     *
     * ⚠ 2026-10-01 实测踩到: 用本步开始时间时, 一个"核验已有 pptx"的步骤会找不到文件 ——
     *   因为那个 pptx 是**上一步**产出的, mtime 早于本步起点。表现为质检永远报
     *   "本次执行没有在产出目录里找到新文件"(而文件明明在)。
     *   任务内的产物归属是**任务级**的, 不是步骤级的: 看的是"这个任务做出了什么",
     *   而不是"这一步新建了什么"。
     */
    const taskCreatedAt = task?.created_at ? new Date(task.created_at).getTime() - 5000 : 0;
    await agentTaskService.runAgentTask(id, async (step) => {
      /**
       * 本步开始的时间戳 —— 用于事后认"这次新产出的文件"。
       * (取整: 文件系统 mtime 与 Date.now() 有细微偏差, 往回让 2 秒更稳)
       */
      const stepStartedAt = Date.now() - 2000;
      // 步骤执行器：V393-1 先 LLM 动态选工具（真·工具调用），失败回退类型调度
      try {
        // ── V393-1: LLM 动态工具选择（V393-4/5: 带角色+白名单策略; V393-8: 失败降级链）──
        // V1: sourceId 动态化 — 用任务关联的项目(而非写死的 c609acbf), 检索与用户研究项目对齐
        const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
        const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
        /**
         * ⚠ **工具分派只对 retrieve / reason 生效** —— 2026-10-01 修。
         *
         * 原来不管什么类型都先问 LLM "选哪个工具", 选出来且执行成功就直接返回工具输出。
         * 而 LLM 面对任何步骤几乎都选 `sag_search`, 于是 **write / review 步骤也在检索**:
         * 实测一个标题为"撰写农村集体经济主要实现形式综述报告"的 write 步骤,
         * 产出的内容是 `【知识库检索】10 条结果 …` —— 一次都没写过东西。
         *
         * 后果不是"写作质量差点", 而是**这条链从来产不出成品**: reflect 每轮都判
         * "仅有检索片段, 未形成综述报告", 任务跑满 3 轮以 0.1~0.3 分收场。
         * (这个缺陷比我这几轮修的都更早、更根本 —— 它一直被"谎报成功"盖着, 没人看见。)
         *
         * 判据是**步骤类型**, 不是"工具选得好不好": write 要的是生成, review 要的是评判,
         * 两者都有下面各自专用的 LLM 处理器, 不该被检索工具截胡。
         */
        /**
         * ⚠ 工具分派按步骤类型分两种, **不能混为一谈**(2026-10-01):
         *
         *   · retrieve / reason —— 分派**全部**工具, 由 LLM 挑(检索类为主)。
         *   · execute —— 分派**只含动作类工具**(写文件/跑代码/终端/补丁), 且把前序步骤的
         *     材料(技能指令就在其中)作为 extraContext 一起给模型。
         *     ⚠ 这个收窄是关键: 不收窄的话 LLM 面对"生成 .pptx"照样会选 `sag_search`
         *     (实测它面对任何步骤都选检索), 于是动作步骤又变回一次检索 ——
         *     与修复前 write 被截胡是同一个病。
         *   · write / review —— 不参与分派, 走下面各自专用的 LLM 处理器。
         *     (它们要的是"写字"和"评判", 不是"动手"; 实测写综述的步骤曾被
         *      `sag_search` 截胡成检索结果。)
         */
        const allowToolDispatch = step.type === "retrieve" || step.type === "reason" || step.type === "execute";
        /**
         * 工具失败/被拦时的原始返回 —— 兜底分支要把它报出去, 不能只剩一句"你检查环境吧"。
         * 见下面赋值处的说明。
         */
        let toolFailureNote = "";
        const actionTools = step.type === "execute"
          ? tools.filter((t) => ACTION_TOOL_NAMES.has(t.name))
          : tools;
        // execute 步骤把前序材料(含技能指令)交给选型, 否则模型不知道该拿什么去执行
        let execContext: string | undefined;
        if (step.type === "execute") {
          const live = (await agentTaskService.getAgentTask(task.id)) as
            { plan?: Array<{ id: string; status?: string; title?: string; result?: string; detail?: string }> } | null;
          const lp = live?.plan || [];
          const at = lp.findIndex((s) => s.id === step.id);
          execContext = lp.slice(0, at < 0 ? lp.length : at)
            .filter((s) => s.status === "done")
            .map((s) => `【${s.title ?? ""}】\n${String(s.detail || s.result || "")}`)
            .join("\n\n")
            .slice(0, 12_000);
        }
        const chosen = allowToolDispatch
          ? await chooseToolByLlm(task.goal, step.title, actionTools, execContext)
          : null;
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
          // execute 类型强制走人工审批门, 用户批准的是**这一步要做什么**; 传递下去避免工具级重复索要(无门可进)
          const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, {
            role: agentRole,
            // 授权来源: 本步已批, **或**任务行上有 autonomyGrant(replan 会冲掉步骤级标记)
            stepApproved: step.type === "execute"
              && ((step as { approved?: boolean }).approved === true || !!(task as { autonomyGrant?: string }).autonomyGrant),
          });
          if (exec.ok) {
            /**
             * ⚠ execute 步骤成功后, **跑一次技能自带的质检脚本**。
             *
             * 2026-10-01: 在此之前技能自带的脚本从没被调用过, 而
             * `nature-paper2ppt/scripts/audit_pptx_quality.py` 查的正是技能自己
             * 定的交付标准。实测把生成物丢给它: `high=20` —— 几乎每页文字溢出画布。
             * **标准写在文档里、产物没人验**, 所以"符合技能标准"从未被检验。
             *
             * 质检结论作为**信号**回报(reflect 能看到哪里不行), 不在这里自动修 ——
             * 修需要重新生成, 那是 agent 的活; 本仓在 p2o 领域引擎上踩过
             * "代码替模型做判断"的坑, 不重蹈。
             * 脚本不可用时如实记"未验证", 不假装通过。
             */
            let verifyNote = "";
            if (step.type === "execute") {
              /**
               * ⚠ execute 步骤成功后, **跑一次技能自带的质检脚本**。
               *
               * 2026-10-01: 在此之前技能自带的脚本从没被调用过, 而
               * `nature-paper2ppt/scripts/audit_pptx_quality.py` 查的正是技能自己
               * 定的交付标准。实测把生成物丢给它: `high=20` —— 几乎每页文字溢出画布。
               * **标准写在文档里、产物没人验**, 所以"符合技能标准"从未被检验过。
               *
               * 质检结论作为**信号**回报(reflect 能看到哪里不行), 不在这里自动修 ——
               * 修需要重新生成, 那是 agent 的活; 本仓在 p2o 领域引擎上踩过
               * "代码替模型做判断"的坑, 不重蹈。
               */
              const { verifyProducedArtifact } = await import("../services/artifact-verify-service.js");
              const skillName = (execContext?.match(/技能[`「\s]*([a-z0-9][a-z0-9-]{2,40})/i) || [])[1];
              // 基准取**任务创建时间**: 产物归属是任务级的, 不是步骤级的(见上方说明)
              const v = await verifyProducedArtifact({ skillName, output: exec.result, since: taskCreatedAt });
              if (v.ran && !v.ok) {
                /**
                 * 质检没过 ⇒ **这一步不能报成功**。
                 * 理由与 execute 兜底分支一致: 交付一个明确不合格的文件却标成功,
                 * 用户拿到的就是"生成好了"的假信号。让 reflect 看到失败项,
                 * 它才有机会再来一轮把缺陷改掉。
                 */
                const list = v.findings.map((f) => `  · ${f.slide ? `第${f.slide}页 ` : ""}${f.code}: ${f.message}`).join("\n");
                return {
                  result: exec.result.substring(0, 120),
                  detail: `【工具调用】${chosen.tool.label}(${chosen.tool.name})\n【结果】\n${exec.result}\n\n【产物质检未通过】${v.summary}\n脚本: ${v.script}\n${list || "  （缺陷明细见质检报告）"}`,
                  source: `工具: ${chosen.tool.label}`,
                  ok: false,
                };
              }
              verifyNote = v.ran
                ? `\n【产物质检通过】${v.summary}（脚本 ${v.script}）`
                : `\n【产物质检未执行】${v.note ?? ""}`;
            }
            return {
              result: exec.result.substring(0, 120),
              detail: `【工具调用】${chosen.tool.label}(${chosen.tool.name}) [角色:${agentRole}]${exec.usedFallback ? `\n【降级】主工具失败 → ${exec.usedFallback}` : ""}\n【参数】${JSON.stringify(chosen.args).slice(0, 200)}\n【结果】\n${exec.result}${verifyNote}`,
              source: `工具: ${chosen.tool.label}${exec.usedFallback ? `(降级→${exec.usedFallback})` : ""}`,
            };
          }
          /**
           * 工具执行失败/策略拒绝 → 回退类型调度（不阻断任务）。
           *
           * ⚠ 但**要把失败原因留住**。2026-10-01 实测: 沙箱以"代码含 subprocess"拦下
           *   整段执行, 工具返回 `_sandbox-blocked 【代码执行】python · 662ms …` ——
           *   那句才是真诊断。原来它只进 console.log, 然后函数一路走到 execute 的兜底
           *   分支, 交给用户的是"没有可用工具或工具执行失败"。**真因在用户可见的地方消失了**,
           *   只剩"你检查一下环境吧"。所以存进一个变量, 兜底时报出去。
           */
          console.log(`[agent] tool ${chosen.tool.name} blocked/failed: ${exec.result.slice(0, 80)}, fallback to type dispatch`);
          /**
           * ⚠ 保留 4000 字, 不是 1500 —— 2026-10-01 实测。
           *
           * 工具失败时最有价值的信息常在**末尾**: Python traceback 的最后一两行才是
           * 异常类型与原因, 前面全是几十层调用栈。截太短会把那两行切掉, 只留下
           * 一堆 "File ... line N, in ..." —— 用户看到的是"有错但不知道什么错"。
           * 实测 1500 字截断正好把 `PermissionError` 那行切没了。
           */
          toolFailureNote = `【${chosen.tool.label}(${chosen.tool.name})】${exec.result}`.slice(0, 4000);
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
          /**
           * ⚠ `data.error` 是**对象**(`{code, message}`), 不是字符串 —— 规范见本文件顶部的
           *   错误格式约定。原代码 `trace?.hypothesis?.content || data?.error` 在推理没有
           *   产出 hypothesis 时会把那个**对象**赋给 content, 紧接着 `.substring()` 抛
           *   `content.substring is not a function`。
           *
           *   这个 TypeError 的两层危害(2026-10-01 实测):
           *     ① 它**盖住了真正的错误**——调用方看到的是"substring 不是函数"这种内部
           *        TypeError, 而不是"少传了必填的 sourceId"这类能直接照做的信息;
           *     ② `runAgentTask` 把抛异常的步骤记成"执行失败"但**任务照样走到 completed**,
           *        于是用户拿到一个"成功"的空任务(实测: 三步全失败, reflect 还给 0.70 pass)。
           *   所以这里把错误对象**取 message 转成字符串**, 让它照常走"步骤失败"这条路。
           */
          const errMsg = typeof data?.error === "string" ? data.error : data?.error?.message;
          const content = trace?.hypothesis?.content || errMsg || "（无结果）";
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
            /**
             * 失败的两种形态, 必须都判到:
             *   ① 带回 data.error —— 请求都没成功;
             *   ② `hypothesis.degraded` —— 请求通了但生成超时, 服务侧降级返回了
             *      一句"生成超时，请重试"。**它的形状与真结果完全一样**, 从内容上
             *      分辨不出(所以才要服务侧显式打标, 见 generateHypothesis 的说明)。
             * 漏掉任一种, 这一步就会被上层记成成功 → reflect 看不到失败 → 任务报"完成"。
             */
            ok: !errMsg && !(trace?.hypothesis as { degraded?: boolean } | undefined)?.degraded,
          };
        }
        if (step.type === "write") {
          /**
           * 写作步骤：基于检索结果生成（真实 LLM 调用）
           *
           * ⚠ 2026-10-01 补**前序步骤产出作为依据**。
           *   原来的 prompt 只有 `主题: <标题> / 目标: <query>`, 一个证据字都没有 ——
           *   检索步骤辛苦捞回来的材料**根本没进写作的上下文**, 写出来全是模型自己编的。
           *   (本仓对"反幻觉"是有纪律的: 实证工作台那条明确要求白名单+坐标读系数。
           *    这里补的是同一条纪律在 agent 链上的缺失。)
           *   取前序 done 步骤的正文, 截断到 6000 字, 避免超窗。
           */
          /**
           * ⚠ 必须取**实时**计划, 不能用 `task` —— 那是开跑时抓的快照。
           *
           * 快照里所有步骤的 status 还是 "pending"、result 还是空, 于是
           * `.filter((s) => s.status === "done")` 筛出 **0 条** → evidence 为空 →
           * prompt 走"没有材料"分支 → 模型写下"在缺乏可核验检索材料的前提下, 本报告
           * 仅构建综述框架"。实测就是这样: 检索步骤明明返回了 2000+ 字真实材料
           * (自主经营型/村社自主型/T村/S村…), 写作步骤却一个字都没拿到。
           *
           * 这个坑很隐蔽 —— 它不报错, 只是让整条链的检索白做, 成品退化成空框架。
           */
          const liveTask = (await agentTaskService.getAgentTask(task.id)) as
            { plan?: Array<{ id: string; status?: string; title?: string; result?: string; detail?: string }> } | null;
          const livePlan = liveTask?.plan || [];
          const myIdx = livePlan.findIndex((s) => s.id === step.id);
          const evidence = livePlan
            .slice(0, myIdx < 0 ? livePlan.length : myIdx)
            .filter((s) => s.status === "done")
            .map((s) => `【${s.title ?? ""}】\n${String(s.detail || s.result || "")}`)
            .join("\n\n")
            .slice(0, 6000);
          const dsKey = process.env.DEEPSEEK_API_KEY || "";
          const llmRes = await fetch(
            dsKey ? toChatCompletionsUrl(process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : toChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
              body: JSON.stringify({
                model: resolveModelAlias(getRoleModel("reason")),
                messages: [{
                  role: "user",
                  content: `撰写研究段落。主题: ${step.title}\n目标: ${step.query}\n`
                    + (evidence
                      ? `\n**只依据下面已检索到的材料撰写**，不要引入材料之外的事实、数据或文献；\n材料没有提到的内容宁可略过。\n\n=== 已检索材料 ===\n${evidence}\n=== 材料结束 ===\n`
                      : "\n（本次没有可依据的检索材料 —— 请只做框架性论述，**不要编造具体数据、案例或文献引用**。）\n")
                    + "\n用中文，400-600字，结构化。",
                }],
                temperature: 0.3,
                /**
                 * ⚠ 这里必须是 4000, 不能是 1200 —— 2026-10-01 实测:
                 *
                 *   本步骤用的 `deepseek-flash` 是**推理模型**, `reasoning_content`(思考链)
                 *   与 `content`(正文)**共用** max_tokens。实测同一条请求:
                 *     max_tokens=1200 → reasoning 1078 + content 210 且 finish_reason=length
                 *     (正文被硬截断, 而它本该写 400-600 字)
                 *   也就是说 90% 的预算花在了思考上, 正文只剩零头。
                 *   评审步骤更糟(它设 800): 思考就把额度占满了, `content` 直接为空,
                 *   于是每一步都报"（写作失败）", 而表现为"任务跑满三轮、什么都产不出"。
                 *
                 *   4000 是按"思考约 1500 + 正文 1200 字≈2400 token"留的余量。
                 *   提高上限**不会**让每次调用都变贵 —— 它只解除截断, 模型写完就停。
                 */
                max_tokens: 4000,
              }),
            }
          );
          const data: any = await llmRes.json();
          const text = data?.choices?.[0]?.message?.content || "（写作失败）";
          // 没拿到 content 就是失败 —— 别让"（写作失败）"这四个字被当成一篇写好的段落
          return { result: text.substring(0, 120), detail: `【写作结果】\n${text}`, source: "LLM 写作（deepseek-flash）", ok: !!data?.choices?.[0]?.message?.content };
        }
        if (step.type === "review") {
          // 评审步骤：对前序产出做质量检查（真实 LLM 评审）
          const dsKey = process.env.DEEPSEEK_API_KEY || "";
          const llmRes = await fetch(
            dsKey ? toChatCompletionsUrl(process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : toChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
              body: JSON.stringify({
                model: resolveModelAlias(getRoleModel("reason")),
                messages: [{ role: "user", content: `评审研究产出质量。任务: ${step.title}\n目标: ${step.query}\n输出：1) 主要问题 2) 修正建议 3) 总体评分(0-1)。简洁中文。` }],
                temperature: 0.1,
                // 同写作步骤: deepseek-flash 的思考链与正文共用 max_tokens,
                //   800 会被思考吃光导致 content 为空(实测每步都报"（评审失败）")。
                max_tokens: 3000,
              }),
            }
          );
          const data: any = await llmRes.json();
          const text = data?.choices?.[0]?.message?.content || "（评审失败）";
          return { result: `评审完成: ${text.substring(0, 100)}`, detail: `【评审意见】\n${text}`, source: "评审 Agent（deepseek-flash）", ok: !!data?.choices?.[0]?.message?.content };
        }
        /**
         * execute 落到这里 = **工具没选出来**(选出来且成功的话上面就返回了)。
         *
         * 这种情况必须**明确报失败**, 不能悄悄降级成"写一段文字" ——
         * 那正是修复前的病: 一个要求产出 .pptx 的步骤, 最后交出一份
         * "关于怎么生成 pptx 的报告", 任务标成功、磁盘上什么都没有。
         * 动作步骤没做成, 就是没做成。
         */
        if (step.type === "execute") {
          return {
            result: toolFailureNote
              ? `（执行未完成）${toolFailureNote.replace(/^_sandbox-blocked\s*/, "").slice(0, 200)}`
              : `（执行未完成：没有可用工具或工具执行失败）`,
            detail: (toolFailureNote
              ? `动作工具返回了失败：\n${toolFailureNote}\n\n`
              : "")
              + "execute 步骤未能产生任何产物。可检查：动作类工具是否可用(需 python/终端环境)、"
              + "所需技能是否已安装、步骤描述是否明确到能选出工具。",
            source: "执行步骤",
            ok: false,
          };
        }
        return { result: `（未知步骤类型: ${step.type}）`, ok: false };
      } catch (e: any) {
        return { result: `执行失败: ${String(e?.message || e).slice(0, 300)}`, detail: String(e?.message || e).slice(0, 500), ok: false };
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

  // V400 B1: Steer 转向输入 — 任务运行中注入新输入(合并进下轮评估)
  app.post("/api/agent/tasks/:id/steer", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { input: string };
    if (!(await assertTaskOwnership(request, reply, params.id))) return;
    const r = await agentTaskService.steerAgentTask(params.id, body.input || "");
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_STEER_FAILED" });
    return { task: r.task };
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
      /**
       * ⚠ 批准之后**必须重新拉起执行** —— 2026-10-01 修。
       *
       * 原来的实现只做了一半: `approveAgentStep` 把状态改回 `running`、给步骤打上
       * `approved:true`, 但**没有任何东西再启动执行循环**。而执行循环早在
       * `awaiting_approval` 那一跳就 `break` 退出了:
       *
       *     const latest = await getAgentTask(taskId);
       *     if (!latest || latest.status !== "running") break;   // ← 挂起时从这里退出
       *
       * 于是"用户批准了"之后, 任务永远停在 `running` 却没人跑它 —— 死在批准这一步上。
       * 实测: 批准后 13 分钟零事件, `current_step` 不动, 界面显示"运行中"。
       * **HITL 审批门等于一条死路**, 而这个门恰恰是所有 write/review 步骤的必经之路。
       *
       * 这里复用队列执行器(与 /run 同一条路径): 它按 payload 里的 auth 重建 request,
       * 不需要把闭包塞进队列。租约(`acquireTaskLease`)会挡住重复拉起 ——
       * 旧循环若还在跑, 新的这次会因拿不到租约直接返回, 不会双跑。
       */
      if (body.approve || body.action === "approve" || body.action === "edit" || body.action === "respond") {
        try {
          const { enqueueTask } = await import("../services/agent-task-queue.js");
          const authedReq = { headers: { authorization: String(request.headers.authorization || "") } } as unknown as Parameters<typeof runAgentTaskInner>[2];
          await enqueueTask({
            taskId: params.id,
            priority: 1,
            runner: "agent-task",
            payload: { taskId: params.id, auth: String(request.headers.authorization || "") },
            // 本实例直接执行; 跨实例/重启后由 runner 注册表按 payload.auth 重建(见 registerAgentQueueRunners)
            run: async () => {
              const fresh = await agentTaskService.getAgentTask(params.id);
              if (!fresh) return;
              await runAgentTaskInner(params.id, fresh, authedReq);
            },
          });
        } catch (e: any) {
          // 拉起失败不能让"批准"这个动作本身看起来没成功 —— 但也不能静默: 用户会以为任务在跑
          console.warn(`[agent] 批准后重新入队失败: ${String(e?.message || e).slice(0, 200)}`);
        }
      }
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

  /**
   * 沙箱档位说明 —— 让前端拉**真值**，不在前端另存一份。
   *
   * 2026-10-02: 前端此前自己硬编码了一组描述，而 `workspace-write` 那条写的是
   *   "仅允许 agent_workspace 内读写" —— 与后端一样是**假话**（实测能写到任意绝对路径，
   *   见 code-sandbox-service 的说明）。后端标签当时改了，前端那份没跟着动，
   *   于是同一个档位在设置界面上仍然承诺一个它做不到的隔离。
   *
   *   本仓的老毛病就是"清单在多处各存一份"（工具登记四处、权限列表多处），
   *   这里直接给一个读取口，前端渲染它。
   */
  app.get("/api/agent/sandbox-profiles", async () => {
    const { SANDBOX_PROFILE_LABELS, defaultSandboxProfile } = await import("../services/code-sandbox-service.js");
    return {
      profiles: Object.entries(SANDBOX_PROFILE_LABELS).map(([value, label]) => ({ value, label })),
      current: defaultSandboxProfile(),
    };
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

  // ═══ V415: MetaSkill 执行接口(list/run/progress/input) ═══
  // 原使用者是 web/src/components/MetaSkillPanel.tsx(已删)。这些接口**不能跟着删** ——
  // 「课题流程编排 → 声明式 DAG」区把面板的"▶ 运行 / 澄清表单 / 进度"搬了过去, 现在由它调用。
  // (2026-09-13 我先删了它们, 结果搬过来的 ▶ 运行 直接 404; 是残留审计查出来的。)
  // 另: meta_invoke / meta_list 两个 agent 工具是进程内调用, 与这些接口无关。
  app.get("/api/meta-skill/list", async () => {
    const { loadAllMetaSkills } = await import("../services/meta-skill-defs.js");
    const skills = await loadAllMetaSkills(); // V404-10: 静态 + DB 动态(人工审 accept)合并
    return { skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, steps: s.steps.map((x) => ({ id: x.id, kind: x.kind, label: x.label })) })) };
  });
  app.post("/api/meta-skill/run", async (request, reply) => {
    const { runMetaSkill } = await import("../services/meta-skill-runtime.js");
    const { getMetaSkillAsync } = await import("../services/meta-skill-defs.js");
    const body = request.body as { skillId?: string; input?: string; model?: string };
    const def = await getMetaSkillAsync(String(body.skillId || "")); // V404-10: 动态 DAG 可跑
    if (!def) return reply.code(404).send({ error: "MetaSkill 不存在", code: "AGENT_NOT_FOUND" });
    if (!body.input?.trim()) return reply.code(400).send({ error: "input 必填(综述主题等)", code: "AGENT_BAD_REQUEST" });
    // 后台执行; 返回 runId, 进度走 /api/meta-skill/progress 轮询(user_input 阶段前端弹表单)
    const { listLiveRuns } = await import("../services/meta-skill-runtime.js");
    void runMetaSkill(def, body.input, { model: body.model }).then(() => {}).catch(() => {});
    const runId = [...listLiveRuns()].pop()?.runId;
    return runId ? { ok: true, runId } : reply.code(500).send({ error: "任务启动失败", code: "AGENT_INTERNAL_ERROR" });
  });
  app.get("/api/meta-skill/progress", async (request, reply) => {
    const { getLiveRunSnapshot } = await import("../services/meta-skill-runtime.js");
    const q = request.query as { runId?: string };
    const snap = getLiveRunSnapshot(String(q.runId || ""));
    if (!snap) return { ok: false, error: "运行不存在或已结束(结束后请用任务结果)" };
    return { ok: true, ...snap };
  });
  app.post("/api/meta-skill/input", async (request, reply) => {
    const { resumeMetaSkillInput } = await import("../services/meta-skill-runtime.js");
    const body = request.body as { runId?: string; values?: Record<string, string> };
    const r = resumeMetaSkillInput(String(body.runId || ""), body.values || {});
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true };
  });

  // ═══ V404-10: auto_propose→MetaSkill DAG 衔接 — 技能组→DAG 提案(隔离区人工审)→accept 注册可跑 ═══
  app.post("/api/meta-skill/propose-dag", async (request, reply) => {
    const { proposeMetaSkillDag } = await import("../services/meta-skill-propose-service.js");
    const body = request.body as { goal?: string; seenCount?: number; skillIds?: number[] };
    if (!body.goal?.trim()) return reply.code(400).send({ error: "goal 必填(高频任务主题)", code: "AGENT_BAD_REQUEST" });
    const p = await proposeMetaSkillDag(String(body.goal).trim(), Number(body.seenCount) || 1, body.skillIds);
    if (!p) return reply.code(500).send({ error: "DAG 组装失败(技能库空/LLM 解析失败)", code: "AGENT_INTERNAL_ERROR" });
    return { ok: true, proposal: p };
  });
  app.get("/api/meta-skill/proposals", async () => {
    const { listDagProposals, repairProposalSourceIds } = await import("../services/meta-skill-propose-service.js");
    // V415: 先补历史提案里丢失的来源 id(2026-09-13 前的提案 sourceSkillIds 全 null)。
    // 放在读接口里而不是定时任务里: 只在真有人看提案时才查一次技能表, 不占后台开销。
    await repairProposalSourceIds().catch(() => 0);
    return { proposals: listDagProposals() };
  });
  app.post("/api/meta-skill/proposals/accept", async (request, reply) => {
    const { acceptDagProposal } = await import("../services/meta-skill-propose-service.js");
    const body = request.body as { id?: string };
    const r = await acceptDagProposal(String(body.id || ""));
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true, dagId: r.dagId };
  });
  app.post("/api/meta-skill/proposals/reject", async (request, reply) => {
    const { rejectDagProposal } = await import("../services/meta-skill-propose-service.js");
    const body = request.body as { id?: string };
    const r = rejectDagProposal(String(body.id || ""));
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true };
  });

  // ═══ V415: 编排器 — 能力注册表 + 模板 + 运行(画布 DAG 真执行) ═══
  // 由来(2026-09-12 用户: 课题流程编排前后端/组件/产出/功能都不完善, 尤其没有真正自由组合编排,
  //   且只有一个工作流, 没反映 SocioSeek 的全部科研能力):
  //   旧画布节点写死 5+4 个, 边不参与执行, 暂停只停前端轮询。
  //   这里提供能力清单(100+ 项)、模板(10 条)、以及"按 edges 拓扑执行"的运行入口。
  app.get("/api/orchestrator/capabilities", async (request) => {
    const { listCapabilities } = await import("../services/capability-registry.js");
    const { capabilityStats } = await import("../services/orchestrator-service.js");
    const q = request.query as { refresh?: string };
    const caps = await listCapabilities({ refresh: q.refresh === "1" });
    return { ok: true, stats: await capabilityStats(), capabilities: caps };
  });
  app.get("/api/orchestrator/templates", async () => {
    const { listTemplatesWithCost } = await import("../services/orchestrator-service.js");
    return { ok: true, templates: await listTemplatesWithCost() };
  });
  // V418: 一句话 → 可执行流程图(速览模式「生成流程」按钮)。
  // 为什么不是复用项目级那个 POST /research/projects/:id/nl-to-dag: 那个往
  //   `research_projects.canvas` 落库, 而速览模式的画布是**纯客户端状态**, 它的「开始执行」
  //   走 POST /orchestrator/run(自包含, 不读 canvas 列)—— 两条路不通用。落库那条留着给
  //   项目工作台; 这个入口直接把拆解结果按 OrchestratorGraph 回给前端画布。
  app.post("/api/orchestrator/nl-to-dag", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { description?: string };
    if (!body?.description?.trim()) return reply.code(400).send({ error: "请描述研究任务" });
    const { nlToOrchestratorGraph } = await import("../services/research-pipeline-service.js");
    const r = await nlToOrchestratorGraph(body.description.trim());
    if ("error" in r) return reply.code(422).send({ error: r.error });
    return { ok: true, graph: r.graph };
  });
  // V415: 把 MetaSkill(声明式 DAG, 含提案 accept 进来的)搬进画布 ——
  //   列清单 + 反解成图。用户要求"MetaSkill DAG 的能力融合进课题流程编排"。
  app.get("/api/orchestrator/meta-skills", async () => {
    const { listMetaSkillsForCanvas } = await import("../services/orchestrator-service.js");
    return { ok: true, skills: await listMetaSkillsForCanvas() };
  });
  app.get("/api/orchestrator/meta-skills/:id/graph", async (request, reply) => {
    const { metaSkillToGraph } = await import("../services/orchestrator-service.js");
    const id = String((request.params as { id?: string }).id || "");
    const graph = await metaSkillToGraph(id);
    if (!graph) return reply.code(404).send({ error: { code: "ORCH_NOT_FOUND", message: `MetaSkill 不存在: ${id}` } });
    return { ok: true, graph };
  });
  app.post("/api/orchestrator/run", async (request, reply) => {
    const { startOrchestration } = await import("../services/orchestrator-service.js");
    const body = (request.body ?? {}) as {
      graph?: { id?: string; name?: string; nodes: any[]; edges: any[] };
      templateId?: string; input?: string; model?: string;
      userValues?: Record<string, string>; wait?: boolean;
    };
    // 画布执行权限: 与 agent 工具同等 —— 外部令牌需 agent 权限(编排会调工具与工作台端点)
    const auth = request.headers.authorization as string | undefined;
    // V415: 带上发起人身份 —— 编排在请求之外执行, 而部分工作台端点要求登录, 身份必须显式传下去
    const caller = alsUserIdOf(request);
    try {
      const r = await startOrchestration({
        graph: body.graph as any, templateId: body.templateId, input: body.input,
        model: body.model, userValues: body.userValues,
        userId: caller.userId, tenantId: caller.tenantId,
        authToken: auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined,
      });
      if (!body.wait) return { ok: true, runId: r.runId, steps: r.steps, order: r.order };
      // 同步等待(供"子编排"节点内嵌调用): 轮询到终态再返回
      const { getRunProgress } = await import("../services/orchestrator-service.js");
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1500));
        const p = await getRunProgress(r.runId);
        if (["done", "failed", "cancelled"].includes(p.status)) {
          return { ok: p.status === "done", runId: r.runId, status: p.status, stepLog: p.stepLog, outputs: p.outputs };
        }
        if (p.status === "waiting_input" || p.status === "paused") {
          return { ok: false, runId: r.runId, status: p.status, stepLog: p.stepLog, note: "子编排需要人工输入或已暂停, 无法同步完成" };
        }
      }
      return reply.code(202).send({ ok: false, runId: r.runId, status: "running", note: "子编排超时(15 分钟)" });
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "ORCH_BAD_REQUEST", message: String(e?.message || e).slice(0, 300) } });
    }
  });
  app.get("/api/orchestrator/progress", async (request) => {
    const { getRunProgress } = await import("../services/orchestrator-service.js");
    const q = request.query as { runId?: string };
    return getRunProgress(String(q.runId || ""));
  });
  app.post("/api/orchestrator/control", async (request, reply) => {
    const svc = await import("../services/orchestrator-service.js");
    const body = (request.body ?? {}) as { runId?: string; action?: string; values?: Record<string, string> };
    const runId = String(body.runId || "");
    if (!runId) return reply.code(400).send({ error: { code: "ORCH_BAD_REQUEST", message: "runId 必填" } });
    const r = body.action === "cancel" ? svc.cancelRun(runId)
      : body.action === "pause" ? svc.pauseRun(runId)
      : body.action === "resume" ? await svc.resumeRun(runId, alsUserIdOf(request))
      : body.action === "input" ? svc.submitRunInput(runId, body.values || {})
      : { ok: false, error: `未知动作: ${body.action}` };
    if (!r.ok) return reply.code(400).send({ error: { code: "ORCH_BAD_REQUEST", message: r.error } });
    return { ok: true, action: body.action };
  });
  app.get("/api/orchestrator/runs", async (request) => {
    const { listRuns } = await import("../services/orchestrator-service.js");
    const q = request.query as { limit?: string };
    return { ok: true, runs: await listRuns(Number(q.limit) || 30) };
  });
  /**
   * V416: 一次运行的事件流(计划历史浮层的数据源)。
   *
   * 与 /progress 的分工: progress 给"每步现在什么状态"(快照), 这里给"依次发生过什么"(时间线)。
   * `since` 是游标 —— 前端轮询时只取增量, 不用每次重拉全量。
   * `available:false` 表示**事件表都还没建**(老库未迁移), 与"表在但这次运行没事件"是两回事,
   *   浮层要能分开说 —— 前者是环境问题, 后者是真的"暂无执行事件"。
   */
  app.get("/api/orchestrator/events", async (request) => {
    const { getRunEventLog } = await import("../services/orchestrator-service.js");
    const q = request.query as { runId?: string; since?: string };
    const runId = String(q.runId || "");
    if (!runId) return { ok: false, events: [], available: true, error: "runId 必填" };
    const r = await getRunEventLog(runId, Number(q.since) || 0);
    return { ok: true, events: r.events, available: r.available };
  });
  // V415: Agent 编排开关 —— 前端可见可切(env 为总闸; env 未开时前端只读展示)
  app.get("/api/orchestrator/settings", async () => {
    const { getAgentOrchestrationSetting } = await import("../services/orchestrator-service.js");
    return { ok: true, settings: await getAgentOrchestrationSetting() };
  });
  app.put("/api/orchestrator/settings", async (request, reply) => {
    const { setAgentOrchestrationSetting } = await import("../services/orchestrator-service.js");
    const body = (request.body ?? {}) as { enabled?: boolean; maxNodes?: number; requireConfirm?: boolean };
    try {
      const s = await setAgentOrchestrationSetting(body);
      return { ok: true, settings: s };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: "ORCH_FORBIDDEN", message: String(e?.message || e).slice(0, 200) } });
    }
  });
  // 用户自定义图的保存/读取(模板在代码里, 这里只存改过的)
  app.get("/api/orchestrator/graphs", async () => {
    const { listGraphs } = await import("../services/orchestrator-service.js");
    return { ok: true, graphs: await listGraphs() };
  });
  app.get("/api/orchestrator/graphs/:id", async (request, reply) => {
    const { loadGraph } = await import("../services/orchestrator-service.js");
    const g = await loadGraph(String((request.params as { id: string }).id));
    if (!g) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "编排图不存在" } });
    return { ok: true, graph: g };
  });
  app.put("/api/orchestrator/graphs/:id", async (request, reply) => {
    const { saveGraph } = await import("../services/orchestrator-service.js");
    const body = (request.body ?? {}) as { name?: string; description?: string; nodes?: any[]; edges?: any[]; basedOn?: string };
    if (!Array.isArray(body.nodes)) return reply.code(400).send({ error: { code: "ORCH_BAD_REQUEST", message: "nodes 必须是数组" } });
    const id = String((request.params as { id: string }).id);
    const r = await saveGraph({ id, name: body.name, description: body.description, nodes: body.nodes as any, edges: body.edges ?? [], basedOn: body.basedOn });
    return { ok: true, id: r.id };
  });
  app.delete("/api/orchestrator/graphs/:id", async (request) => {
    const { deleteGraph } = await import("../services/orchestrator-service.js");
    await deleteGraph(String((request.params as { id: string }).id));
    return { ok: true };
  });

  // ═══ V404-7: 记忆 Dream 巩固 — 扫描/候选/人工审提升(借鉴 OpenSquilla memory/dream) ═══
  // 回合捕获(task_experience)→ 证据门控(≥2次+跨天, 负评拦)→ 确定性评分 → 打磨(LLM 可选)
  // → proposals 隔离区 → 人工 accept 写 strategic_memory / reject 进 quarantine / rollback 回滚
  app.post("/api/memory/dream/run", async (request, reply) => {
    const { runDream } = await import("../services/dream-consolidation-service.js");
    const body = (request.body ?? {}) as { useLlm?: boolean; days?: number; limit?: number };
    try {
      const proposals = await runDream({ useLlm: !!body.useLlm, days: body.days ?? 30, limit: body.limit });
      return { ok: true, count: proposals.length, proposals };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: { code: "DREAM_FAILED", message: msg } });
    }
  });
  app.get("/api/memory/dream/state", async () => {
    const { listDreamState } = await import("../services/dream-consolidation-service.js");
    return listDreamState();
  });
  app.post("/api/memory/dream/accept", async (request, reply) => {
    const { acceptProposal } = await import("../services/dream-consolidation-service.js");
    const body = request.body as { id?: string; projectId?: string };
    const r = await acceptProposal(String(body.id || ""), { projectId: body.projectId });
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true, receipt: r.receipt };
  });
  app.post("/api/memory/dream/reject", async (request, reply) => {
    const { rejectProposal } = await import("../services/dream-consolidation-service.js");
    const body = request.body as { id?: string; reason?: string };
    const r = rejectProposal(String(body.id || ""), body.reason);
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true };
  });
  app.post("/api/memory/dream/rollback", async (request, reply) => {
    const { rollbackAccepted } = await import("../services/dream-consolidation-service.js");
    const body = request.body as { id?: string };
    const r = await rollbackAccepted(String(body.id || ""));
    if (!r.ok) return reply.code(400).send({ error: r.error, code: "AGENT_BAD_REQUEST" });
    return { ok: true };
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
  // ⚠ 2026-08-29 升级: L3 评分+阈值门控(借鉴 Inno Agent), 低相关片段不召回
  app.get("/api/agent/sessions/search", async (request) => {
    const q = request.query as { q?: string; threshold?: string; limit?: string };
    const { l3SessionRecallService } = await import("../services/l3-session-recall.js");
    const r = await l3SessionRecallService.recallSessions(q?.q || "", {
      threshold: Number(q.threshold) || undefined,
      limit: Number(q.limit) || undefined,
    });
    return { sessions: r.hits, gated: r.gated };
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

  // V400: 工具执行 REST 端点（前端面板调用; 支持 V399 5 个 Agent 工具）
  app.post("/api/agent/tools/:name/run", async (request, reply) => {
    const params = request.params as { name: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { buildAgentTools } = await import("../services/agent-tool-router.js");
    const tools = await buildAgentTools({});
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return reply.code(404).send({ error: `工具 ${params.name} 不存在`, code: "TOOL_NOT_FOUND" });
    // 高危工具需审批（走既有审批门语义）
    if (tool.risk === "review") {
      return reply.code(403).send({ error: `工具 ${tool.label} 为高危操作, 需经 Agent 任务审批门`, code: "TOOL_NEEDS_APPROVAL" });
    }
    try {
      const result = await tool.run(body);
      return { ok: true, tool: tool.name, result };
    } catch (e: any) {
      return reply.code(500).send({ error: String(e?.message || e).slice(0, 300), code: "TOOL_EXEC_FAILED" });
    }
  });

  // V400: 运行时状态聚合（预算/Elicitation/审批/熔断 — 前端状态面板, 内容级）
  app.get("/api/agent/runtime-status", async () => {
    const out: Record<string, unknown> = { reminders: {}, elicitation: {}, approvals: {}, guardian: {} };
    try {
      const { agentReminderService } = await import("../services/agent-reminder-service.js");
      out.reminders = { contextWindowLimit: agentReminderService.contextWindowLimit(), threshold: 6144, log: agentReminderService.getReminderLog() };
    } catch { /* 状态不可用 */ }
    try {
      const { agentElicitationService } = await import("../services/agent-elicitation-service.js");
      out.elicitation = { paused: agentElicitationService.isPaused(), pending: agentElicitationService.listPendingElicitations() };
    } catch { /* 状态不可用 */ }
    try {
      const { guardianService } = await import("../services/agent-guardian-service.js");
      out.guardian = guardianService.guardianBreakerDetail();
    } catch { /* 状态不可用 */ }
    // V404-29: 运行时防护状态(事件计数/最近事件/子进程树) — 供"防护状态页"
    try {
      const { guardStatusSnapshot } = await import("../services/runtime-guard-events.js");
      out.guards = guardStatusSnapshot();
    } catch { /* 防护状态不可用 */ }
    return out;
  });

  // V404-30: 防护事件审计(跨重启持久化查询)
  app.get("/api/agent/guards/events", async (request) => {
    const q = request.query as { guard?: string; limit?: string; days?: string };
    const { runtimeGuardEvents } = await import("../services/runtime-guard-events.js");
    const [events, counts] = await Promise.all([
      runtimeGuardEvents.listPersistedGuardEvents(q.guard, Math.min(Number(q.limit) || 50, 200)),
      runtimeGuardEvents.persistedGuardCounts(Number(q.days) || 7),
    ]);
    return { ok: true, events, counts };
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
  // 2026-08-29 Practice Lab: 持久运行时执行 Python(全局复用, 变量跨调用保持)
  app.post("/api/agent/persistent-runtime/exec", async (request, reply) => {
    const body = (request.body ?? {}) as { code?: string; timeoutMs?: number };
    if (!body.code?.trim()) return reply.code(400).send({ error: "code 必填", code: "BAD_REQUEST" });
    const { agentPersistentRuntime } = await import("../services/agent-persistent-runtime.js");
    return await agentPersistentRuntime.execLab(body.code, body.timeoutMs || 30_000);
  });
  // Practice Lab: 重置运行时
  app.post("/api/agent/persistent-runtime/reset", async () => {
    const { agentPersistentRuntime } = await import("../services/agent-persistent-runtime.js");
    agentPersistentRuntime.closeLab();
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
    const workspace = dataPath("agent_workspace");
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
    const user = await requireUser(request, reply); if (!user) return;
    void user;
    const raw = String((request.params as { "*"?: string })["*"] ?? "");
    // 兼容两种相对路径：`chat_uploads/xxx.png`（上传接口返回值）或 `xxx.png`（直接文件名）
    const rel = raw.replace(/^[/\\]+/, "").replace(/^chat_uploads[/\\]/, "");
    const path = await import("node:path");
    // 单层文件名(与 viz 产物同一约束: 不收子路径/盘符/上跳)
    if (!rel || rel.includes("/") || rel.includes("\\") || rel.includes("..") || rel.includes(":")) {
      return reply.code(400).send({ error: "文件名非法", code: "AGENT_BAD_REQUEST" });
    }
    const data = await getObject(`chat-uploads/${rel}`);
    if (!data) return reply.code(404).send({ error: "文件不存在", code: "AGENT_NOT_FOUND" });
    const ext = path.extname(rel).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : ext === ".bmp" ? "image/bmp" : "image/jpeg";
    reply.header("Content-Type", mime);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(data);
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
  // V395: 保存运行时设置(沙箱级别/预设/自主级别) — 即时同步 env 全局生效
  app.put("/api/agent/settings", async (request) => {
    const { agentSettingsService } = await import("../services/agent-settings.js");
    const body = z.object({ preset: z.string().optional(), autonomy: z.string().optional(), sandbox_profile: z.enum(["read-only", "workspace-write", "full-access"]).optional() }).parse(request.body);
    const saved: string[] = [];
    if (body.preset) { await agentSettingsService.setAgentSetting("preset", body.preset); saved.push("preset"); }
    if (body.autonomy) {
      await agentSettingsService.setAgentSetting("autonomy", body.autonomy);
      // 即时同步 autonomy 模块
      const { setAutonomyLevel } = await import("../services/agent-autonomy.js");
      setAutonomyLevel(body.autonomy as any);
      saved.push("autonomy");
    }
    if (body.sandbox_profile) {
      await agentSettingsService.setAgentSetting("sandbox_profile", body.sandbox_profile);
      // 即时同步 env(影响整个 AI Agent 全部沙箱工具执行)
      process.env.AGENT_SANDBOX_PROFILE = body.sandbox_profile;
      saved.push("sandbox_profile");
    }
    return { ok: true, saved, activeSandbox: process.env.AGENT_SANDBOX_PROFILE || "read-only" };
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
    const body = z.object({ level: z.enum(["suggest", "auto-edit", "full-auto"]) }).parse(request.body);
    const { setAutonomyLevel, AUTONOMY_LABELS } = await import("../services/agent-autonomy.js");
    if (!setAutonomyLevel(body.level)) {
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
    // 多副本: 内存缓冲是**执行者进程**的, 连到别的实例时它是空的 → 从库里回放历史事件。
    //   不回放的话, 用户只收到 snapshot + 心跳, 永久卡"运行中"且不报错(实测路径)。
    const { replayAgentEvents } = await import("../services/agent-progress.js");
    let replayCursor = lastEventId || missed.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    try {
      const history = await replayAgentEvents(params.id, replayCursor);
      for (const ev of history) { send(ev.type, ev.data, ev.seq); replayCursor = Math.max(replayCursor, ev.seq ?? 0); }
    } catch { /* 表不可用 → 退化成实时推送 */ }
    // 终态任务: 回放完直接收尾, 不让客户端等一个永远不会来的 done
    const TERMINAL = ["completed", "failed", "cancelled"];
    if (TERMINAL.includes(String(task.status))) {
      send("done", { status: task.status, result: task.result ?? null, progress: task.progress ?? "" }, replayCursor + 1);
      clearInterval(heartbeat);
      try { reply.raw.end(); } catch { /* 已关闭 */ }
      return;
    }
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
    await registerAgentQueueRunners();
    agentTaskQueue.enqueueTask({
      taskId: parent.id,
      priority,
      runner: "orchestrator",
      payload: { taskId: parent.id, goal: body.goal.trim(), projectId: parent.projectId ?? null },
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
            dsKey ? toChatCompletionsUrl(process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : toChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"),
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
        // ⚠ data.error 是对象({code,message}) —— 直接当字符串用会在下游炸出 TypeError,
        //   把真正的错误盖掉。取 message(见 8002 处那条更详细的说明)。
        const errMsg9 = typeof data?.error === "string" ? data.error : data?.error?.message;
        return data?.trace?.hypothesis?.content || errMsg9 || "（无结果）";
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

  // POST /api/p2o/ocr — 扫描件 PDF OCR 识别（MinerU 强制 OCR, 划词兜底）
  // pageBase64: 前端提取的单页 PDF(base64) → 精确对页; 缺省走整篇
  app.post("/api/p2o/ocr", async (request, reply) => {
    const body = z.object({
      path: z.string().min(1).max(2000).optional(),
      pageBase64: z.string().max(50_000_000).optional()
    }).parse(request.body);
    const { pdf2obsidianAdapter } = await import("../services/pdf2obsidian-adapter.js");
    let ocrPath = "";
    if (body.pageBase64) {
      // 单页 PDF: base64 → 临时文件 → OCR
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(path.join(tmpdir(), "sag-ocr-"));
      ocrPath = path.join(dir, "page.pdf");
      await writeFile(ocrPath, Buffer.from(body.pageBase64, "base64"));
      const result = await pdf2obsidianAdapter.parsePdfViaP2O(ocrPath, 100_000, { ocr: true });
      await rm(dir, { recursive: true, force: true });
      if (!result.ok) return reply.code(500).send(notFound("OCR_FAILED", result.error || "OCR 失败"));
      return { ok: true, content: result.content };
    }
    if (!body.path) return reply.code(400).send(notFound("OCR_PATH_REQUIRED", "缺少 path"));
    // 路径校验: 仅允许文献库/资料库(VAULT_ROOT)/桌面(VAULT_DIR 兼容)目录内
    const abs = path.resolve(body.path);
    const scanDir = path.resolve(literatureService.scanDir);
    // vaultRoot 与 vault-service 同源(kb-paths): 未配 VAULT_ROOT 时回退 <数据根>/kb/vault
    const vaultRoot = path.resolve(kbVaultRoot());
    const vaultDir = path.resolve(process.env.VAULT_DIR || "");
    const allowed = abs.startsWith(scanDir + path.sep) || abs.startsWith(vaultRoot + path.sep) || (vaultDir && abs.startsWith(vaultDir + path.sep));
    if (!allowed) {
      return reply.code(403).send(notFound("OCR_PATH_FORBIDDEN", "路径不在允许目录内"));
    }
    const result = await pdf2obsidianAdapter.parsePdfViaP2O(abs, 100_000, { ocr: true });
    if (!result.ok) return reply.code(500).send(notFound("OCR_FAILED", result.error || "OCR 失败"));
    // MinerU 输出无页级标记, 无法按页截取 → 整篇返回(识别质量已验证: 无乱码/标题清晰)
    return { ok: true, content: result.content };
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
          // 本步开始时间 —— 供产物质检认"这次新生成的文件"
          const stepStartedAt = Date.now() - 2000;
          const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
          // V1: 用任务项目 sourceId（对话续作任务无项目时回退默认）
          const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
          // 同 runAgentTaskInner: 分派按类型收窄 —— write/review 不参与, execute 只给动作类工具
          const chosen = (step.type === "retrieve" || step.type === "reason" || step.type === "execute")
            ? await chooseToolByLlm(task.goal, step.title,
                step.type === "execute" ? tools.filter((t) => ACTION_TOOL_NAMES.has(t.name)) : tools)
            : null;
          if (chosen) {
            // V417: 显式传角色。此前不传 → executeAgentTool 兜底 manager, 三级角色闸全失效。
            //   任务要么记着创建者角色, 要么回落到 analyst(不再有"默认最高权限"这条路径)。
            const taskRole: "reader" | "analyst" | "manager" =
              (task as { agent_role?: string }).agent_role === "manager" ? "manager"
              : (task as { agent_role?: string }).agent_role === "reader" ? "reader" : "analyst";
            const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, {
              role: taskRole, taskId: task.id,
              /**
               * 授权来源有两条, **任一**成立即视为已批:
               *   · 这一步本身被批准过(plan 里的 approved);
               *   · 任务行上有 autonomyGrant —— 同一任务里前面的动作类步骤已获批准,
               *     而 replan 会重建计划、把步骤级的 approved 冲掉(见 173 号迁移)。
               */
              stepApproved: step.type === "execute"
                && ((step as { approved?: boolean }).approved === true || !!(task as { autonomyGrant?: string }).autonomyGrant),
            });
            // 对话链同样要过产物质检 —— 少一处接, 从对话建的 PPT 任务就绕过验证
            if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}${await verifyArtifactNote(exec.result, taskCreatedAtOf(task))}`, source: `工具: ${chosen.tool.label}` };
          }
          const res = await fetch(SELF_BASE + "/api/reason/query", {
            method: "POST", headers: { "Content-Type": "application/json" },
            // G24: sourceId 动态化 — 用任务项目(未关联时省略走服务端默认)
            body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive" }),
          });
          const data: any = await res.json();
          const errMsgA = typeof data?.error === "string" ? data.error : data?.error?.message;
          const content = data?.trace?.hypothesis?.content || errMsgA || "（无结果）";
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
            const stepStartedAt = Date.now() - 2000;
            const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("../services/agent-tool-router.js");
            // V1: 用任务项目 sourceId
            const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
            // 同 runAgentTaskInner: 分派按类型收窄
            const chosen = (step.type === "retrieve" || step.type === "reason" || step.type === "execute")
              ? await chooseToolByLlm(task.goal, step.title,
                  step.type === "execute" ? tools.filter((t) => ACTION_TOOL_NAMES.has(t.name)) : tools)
              : null;
            if (chosen) {
              // V417: 同 8040 处 — 必须显式传角色, 不能靠缺省值
              const taskRole: "reader" | "analyst" | "manager" =
                (task as { agent_role?: string }).agent_role === "manager" ? "manager"
                : (task as { agent_role?: string }).agent_role === "reader" ? "reader" : "analyst";
              const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, {
              role: taskRole, taskId: task.id,
              /**
               * 授权来源有两条, **任一**成立即视为已批:
               *   · 这一步本身被批准过(plan 里的 approved);
               *   · 任务行上有 autonomyGrant —— 同一任务里前面的动作类步骤已获批准,
               *     而 replan 会重建计划、把步骤级的 approved 冲掉(见 173 号迁移)。
               */
              stepApproved: step.type === "execute"
                && ((step as { approved?: boolean }).approved === true || !!(task as { autonomyGrant?: string }).autonomyGrant),
            });
              if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}${await verifyArtifactNote(exec.result, taskCreatedAtOf(task))}`, source: `工具: ${chosen.tool.label}` };
            }
            const res = await fetch(SELF_BASE + "/api/reason/query", {
              method: "POST", headers: { "Content-Type": "application/json" },
              // G24: sourceId 动态化 — 用任务项目(未关联时省略走服务端默认)
              body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive" }),
            });
            const data: any = await res.json();
            const errMsgA = typeof data?.error === "string" ? data.error : data?.error?.message;
          const content = data?.trace?.hypothesis?.content || errMsgA || "（无结果）";
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
      // 2026-10-02: 补「按学科 / 按首字母 / 按拼音」三种检索。
      // 三个筛选参数**可叠加**(level + field + q), 用参数化数组拼而不是字符串拼 —— 见下面 push。
      const q2 = request.query as { level?: string; field?: string; q?: string; sort?: string };
      const conds: string[] = [];
      const params: any[] = [];
      if (q2.level) { params.push(q2.level); conds.push(`level = $${params.length}`); }
      if (q2.field) { params.push(q2.field); conds.push(`field = $${params.length}`); }
      if (q2.q) {
        const kw = `%${q2.q.trim()}%`;
        params.push(kw);
        const i = params.length;
        // 三路匹配: 刊名 / 全拼 / 首字母。拼音与首字母两列由 177 迁移 + journal-browse 回填,
        // 所以「zgshehui」「zgshkx」这样不分大小写的输入都能搜到。
        conds.push(`(name ilike $${i} or pinyin ilike $${i} or abbr ilike $${i})`);
      }
      const where = conds.length ? `where ${conds.join(" and ")}` : "";
      // 排序: 默认按级别+刊名; sort=pinyin 时按音序(首字母选择器用它)
      const order = q2.sort === "pinyin" ? "order by pinyin asc" : "order by level desc, name asc";
      const r = await pool.query(
        `select id, name, level, org, topic_tags, style, official_site, updated_at, last_sync_status,
                field, language, pinyin, abbr
         from cjournal_journals ${where} ${order}`,
        params
      );
      return {
        journals: r.rows.map((j: any) => ({
          id: j.id, name: j.name, level: j.level, org: j.org,
          topicTags: j.topic_tags, style: j.style, officialSite: j.official_site,
          updatedAt: j.updated_at, lastSyncStatus: j.last_sync_status,
          field: j.field, language: j.language, pinyin: j.pinyin, abbr: j.abbr
        })),
        total: r.rows.length,
        // 供前端渲染筛选项 —— 不必再让前端硬编码学科清单
        fields: [...new Set(r.rows.map((j: any) => j.field).filter(Boolean))].sort(),
        legacy: cjournalService.JOURNAL_PROFILES,  // 兼容旧引用
      };
    } catch {
      // 库不可用降级到内置
      return { journals: cjournalService.JOURNAL_PROFILES.map((j) => ({ name: j.name, style: j.style })), total: 0, legacy: cjournalService.JOURNAL_PROFILES };
    }
  });
  // ═══ 飞书自建应用 (2026-10-02) ═══
  // 与 /api/im/* 的 webhook 机器人是**两条通道**: webhook 只往固定群推文本,
  // 应用可发到指定人(通知中心按人推送的前提)。
  app.get("/api/im/feishu-app/status", async () => {
    const { getFeishuAppConfig, isFeishuAppConfigured } = await import("../services/feishu-app-service.js");
    const c = await getFeishuAppConfig();
    return {
      configured: await isFeishuAppConfigured(),
      appId: c.appId ? `${c.appId.slice(0, 8)}…` : "",   // 面板回显只看前缀, 不回传完整凭据
      hasSecret: Boolean(c.appSecret),
      hasVerificationToken: Boolean(c.verificationToken),
      hasEncryptKey: Boolean(c.encryptKey),
    };
  });
  app.post("/api/im/feishu-app/config", async (request, reply) => {
    const body = z.object({
      appId: z.string().max(200).optional(),
      appSecret: z.string().max(500).optional(),
      verificationToken: z.string().max(500).optional(),
      encryptKey: z.string().max(500).optional(),
    }).parse(request.body);
    const { pool } = await import("../db/pool.js");
    // 只覆盖**传了的**字段 —— 面板上留空的输入框表示"不改这一项",
    // 否则用户每次保存都会把没重新填的 secret 清成空串
    const sets: string[] = [];
    const vals: any[] = [];
    const push = (col: string, v?: string) => { if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); } };
    push("feishu_app_id", body.appId);
    push("feishu_app_secret", body.appSecret);
    push("feishu_verification_token", body.verificationToken);
    push("feishu_encrypt_key", body.encryptKey);
    if (sets.length) {
      await pool.query(`insert into im_config (id) values (1) on conflict (id) do nothing`);
      await pool.query(`update im_config set ${sets.join(", ")}, updated_at = now() where id = 1`, vals);
    }
    return { ok: true };
  });
  app.post("/api/im/feishu-app/test", async () => {
    const { testFeishuConnection } = await import("../services/feishu-app-service.js");
    // 只换 token 不发消息 —— 发消息会在用户群里留下一条测试垃圾
    return await testFeishuConnection();
  });

  // ═══ 用户通知中心 (2026-10-02) ═══
  // 与 /api/alerts 的分工: alerts 是**全局运维事实**(无 user_id, 本机豁免);
  // 这里是**给某个登录用户的消息**(按 user.id 隔离, 必须登录)。
  app.get("/api/notifications", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string; unread?: string; category?: string };
    const { listNotifications } = await import("../services/notification-service.js");
    return {
      notifications: await listNotifications(user.id, {
        limit: parseInt(q.limit || "50", 10),
        unreadOnly: q.unread === "1" || q.unread === "true",
        category: q.category
      })
    };
  });
  app.get("/api/notifications/unread", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { unreadNotificationCount } = await import("../services/notification-service.js");
    return { unread: await unreadNotificationCount(user.id) };
  });
  app.post("/api/notifications/read", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = (request.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
    const { markNotificationsRead } = await import("../services/notification-service.js");
    return { marked: await markNotificationsRead(user.id, ids) };
  });
  app.post("/api/notifications/clear", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { clearReadNotifications } = await import("../services/notification-service.js");
    return { cleared: await clearReadNotifications(user.id) };
  });

  // ═══ 研究速递 (2026-10-02) ═══
  // 条目表 digest_items 是**全局**的(无 user_id), 订阅与已读按用户分离;
  // 所以查询侧必须显式按「我的订阅」过滤 —— 见 digest-service.getDigest 的 where。
  app.get("/api/digest", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { days?: string };
    const { getDigest } = await import("../services/digest/digest-service.js");
    return getDigest(user.id, q.days ? { days: parseInt(q.days, 10) } : {});
  });
  app.get("/api/digest/dates", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { getDigestDates } = await import("../services/digest/digest-service.js");
    return { dates: await getDigestDates(user.id, parseInt(q.limit || "30", 10)) };
  });
  app.get("/api/digest/unread", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { unreadDigestCount } = await import("../services/digest/digest-service.js");
    return { unread: await unreadDigestCount(user.id) };
  });
  // 主题/期刊偏好: GET 读、POST 整体写(同 Respal 的 /api/topics 契约)
  app.get("/api/digest/topics", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { getSubscription, checkJournalCoverage } = await import("../services/digest/digest-service.js");
    const sub = await getSubscription(user.id);
    // 连"哪些刊取不到动态"一起返回 —— 否则用户订了库外的刊, 界面只会一片空白
    const coverage = await checkJournalCoverage(sub.preferredJournals).catch(() => ({ covered: [], uncovered: [] }));
    return { ...sub, uncoveredJournals: coverage.uncovered };
  });
  app.post("/api/digest/topics", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = (request.body ?? {}) as { topics?: unknown; preferredJournals?: unknown; days?: unknown };
    const asArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map((x) => String(x)) : undefined;
    const { setSubscription, checkJournalCoverage } = await import("../services/digest/digest-service.js");
    const sub = await setSubscription(user.id, {
      topics: asArr(body.topics),
      preferredJournals: asArr(body.preferredJournals),
      days: body.days === undefined ? undefined : Number(body.days)
    });
    const coverage = await checkJournalCoverage(sub.preferredJournals).catch(() => ({ covered: [], uncovered: [] }));
    return { ...sub, uncoveredJournals: coverage.uncovered };
  });
  app.post("/api/digest/read", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = (request.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
    const { markDigestRead } = await import("../services/digest/digest-service.js");
    return { marked: await markDigestRead(user.id, ids) };
  });
  // 手动触发一轮抓取(面板上的"立即刷新")。抓的是全体订阅的并集, 与定时任务同一条路径。
  app.post("/api/digest/refresh", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { runDailyDigest } = await import("../services/digest/digest-service.js");
    return { ok: true, ...(await runDailyDigest()) };
  });
  // 抓取批次台账 —— "今天为什么只有 3 条"唯一能查的地方
  app.get("/api/digest/runs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string };
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      `select started_at, finished_at, trigger, topics, per_source, inserted, dup, ok, error
         from digest_runs order by started_at desc limit $1`,
      [Math.min(Math.max(parseInt(q.limit || "10", 10), 1), 50)]
    );
    return { runs: r.rows };
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

  // ───── Skill 导入（2026-08-29, Agentero 对照: 支持 Skill 导入）─────
  // GET /api/agent/skills/installed — 已安装技能(目录含 SKILL.md)
  app.get("/api/agent/skills/installed", async () => {
    const { skillImportService } = await import("../services/skill-import-service.js");
    return { skills: skillImportService.listInstalledSkills(), home: skillImportService.SKILLS_HOME };
  });
  // V404-12: SKILL.md 全量体检(机制5 技能体检) — frontmatter/重复名/引用完整性
  app.get("/api/agent/skills/health-all", async () => {
    const { skillImportService } = await import("../services/skill-import-service.js");
    return skillImportService.healthCheckAllSkills();
  });
  // V404-14: 技能语义分类审计(做法 vs 记忆/事实 — 只输出建议不自动改)
  app.get("/api/agent/skills/semantic-audit", async () => {
    const { skillImportService } = await import("../services/skill-import-service.js");
    return skillImportService.auditAllSkillSemantics();
  });

  // POST /api/agent/skills/import — 从本地路径导入 {sourcePath}
  app.post("/api/agent/skills/import", async (request, reply) => {
    const body = z.object({ sourcePath: z.string().min(1).max(1000) }).parse(request.body);
    const { skillImportService } = await import("../services/skill-import-service.js");
    const r = skillImportService.importSkillPackage(body.sourcePath);
    if (!r.ok) return reply.code(400).send({ error: { code: "IMPORT_FAILED", message: r.error } });
    return { ok: true, name: r.name };
  });

  // POST /api/agent/skills/:name/remove — 卸载技能
  app.post("/api/agent/skills/:name/remove", async (request, reply) => {
    const params = request.params as { name: string };
    const { skillImportService } = await import("../services/skill-import-service.js");
    const r = skillImportService.removeSkillPackage(params.name);
    if (!r.ok) return reply.code(400).send({ error: { code: "REMOVE_FAILED", message: r.error } });
    return { ok: true };
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
  // V404-8: 技能自我进化(auto_propose) + 技能体检 — 高频任务反查→覆盖判定→自动蒸馏→EDV
  app.post("/api/agent/skills/auto-propose", async (request) => {
    const body = (request.body ?? {}) as { days?: number; minCount?: number; maxProposals?: number };
    const { skillAutoProposeService } = await import("../services/skill-auto-propose.js");
    const r = await skillAutoProposeService.runAutoPropose({ days: body.days, minCount: body.minCount, maxProposals: body.maxProposals });
    return { ok: true, ...r };
  });
  // V404-20: 滞留 pending 技能补 EDV 验证(中断/超时遗留清理)
  app.post("/api/agent/skills/reconcile-pending", async () => {
    const { skillAutoProposeService } = await import("../services/skill-auto-propose.js");
    const r = await skillAutoProposeService.reconcilePendingSkills();
    return { ok: true, ...r };
  });
  // V404-21: 技能库近重复检测(bigram 分组, 供人工去重 — 不自动删)
  app.get("/api/agent/skills/duplicates", async () => {
    const { skillAutoProposeService } = await import("../services/skill-auto-propose.js");
    return { ok: true, groups: await skillAutoProposeService.detectDuplicateSkills() };
  });
  app.get("/api/agent/skills/health", async () => {
    const { skillAutoProposeService } = await import("../services/skill-auto-propose.js");
    return skillAutoProposeService.skillHealthCheck();
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

  // 技能审计（P1-2）— **实时扫描技能目录**（60 秒缓存）。
  // V327 时读的是 skill-audit-report.md 快照；V332 起不读文件了（快照已删）。
  app.get("/api/skills/audit", async () => {
    try {
      const r = await skillsService.auditSkillsLive();
      return { exists: true, total: r.total, complete: r.complete, gaps: r.gaps };
    } catch (e: any) {
      return { exists: false, error: String(e).substring(0, 100) };
    }
  });

  // V417: 技能热度榜 —— "越用越熟"的可视化依据。
  // 用**单独的路径** /api/skills/usage, 避免与下面的 /api/skills/:name/detail 抢路由。
  app.get("/api/skills/usage", async (request) => {
    const params = request.query as { limit?: string };
    try {
      const { listSkillUsage } = await import("../services/skill-usage-tracker.js");
      return await listSkillUsage(Math.min(parseInt(params.limit ?? "50", 10) || 50, 200));
    } catch (e: any) {
      return { total: 0, used: 0, rows: [], error: String(e).substring(0, 100) };
    }
  });

  // 某技能用在了哪些任务上（面板展开看明细）
  app.get("/api/skills/:id/usage-events", async (request) => {
    const params = request.params as { id: string };
    const id = parseInt(params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return { events: [] };
    try {
      const { listSkillUsageEvents } = await import("../services/skill-usage-tracker.js");
      return { events: await listSkillUsageEvents(id) };
    } catch {
      return { events: [] };
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

  // ───── SocioSeek 本地文献库 API ─────
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

  /**
   * 引用网络(文献耦合 + 共被引) —— 现算, 不落库。
   *
   * 由来(2026-09-24): `citation-graph-service` 一直是"算法参考实现, 全仓零调用",
   *   因为它头部写着数据源接入等"方案A批量入库 vs 方案B接Neo4j"的决定(用户暂缓)。
   *   但图上要的东西**不需要先做那个决定**: 库里 210 篇已经解析出参考文献表(共 2477 条),
   *   现读现算就能连出边(本机 threshold 0.05 → 60 节点 / 71 边)。
   *   所以这条路线只做"取数据 + 调算法", 不碰入库方案; Neo4j 那条将来若做, 是另一条路。
   *
   * ⚠ 路径必须排在 `/:id` **之前** —— 否则 "network" 会被当成文献 id 吃掉(本仓踩过这类)。
   *   放在 catalog 后面正合适。
   */
  app.get("/api/literature/network", async (request) => {
    const qq = request.query as { seedId?: string; threshold?: string; nodeMax?: string; edgeMax?: string };
    const num = (v: string | undefined, d: number, lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
    };
    const { citationNetworkService } = await import("../services/citation-network-service.js");
    return citationNetworkService.buildCitationNetwork({
      seedId: qq.seedId && /^[\w-]{1,64}$/.test(qq.seedId) ? qq.seedId : undefined,
      threshold: num(qq.threshold, 0.08, 0.001, 1),
      nodeMax: num(qq.nodeMax, 60, 5, 300),
      edgeMax: num(qq.edgeMax, 150, 5, 2000),
    });
  });

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

  // 引文三维核验（V399: citation-lab 移植）: 断言+引用上下文 → 元数据真伪/语境相关性/断言支持度
  const citationVerifySchema = z.object({
    claim: z.string().min(5).max(3000),
    referenceTitle: z.string().optional(),
    referenceDoi: z.string().optional(),
    referenceText: z.string().optional(),   // 官方摘要/全文(可选, 缺省走 OpenAlex/Crossref 拉取)
    context: z.string().optional(),        // 引用所在段落上下文(可选)
  });
  app.post("/api/citations/verify", async (request) => {
    const input = citationVerifySchema.parse(request.body);
    const { citationVerifyService } = await import("../services/citation-verify-service.js");
    return citationVerifyService.verifyClaim(input);
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

  // PDF 文件下载（PdfReader 深度阅读用）: 传 path（扫描出的磁盘路径）或 id（文献 id）
  // 安全: 仅允许 literature 扫描目录内的绝对路径, 拒绝 ../ 等越界
  app.get("/api/literature/pdf-file", async (request, reply) => {
    const query = request.query as { path?: string; id?: string };
    let filePath: string | undefined;
    if (query.id) {
      const detail = literatureService.getDetail(query.id);
      if (!detail) return reply.code(404).send(notFound("LITERATURE_NOT_FOUND", "文献不存在"));
      filePath = detail.path;
    } else if (query.path) {
      filePath = query.path;
    }
    if (!filePath) return reply.code(400).send(notFound("PDF_PATH_REQUIRED", "缺少 path 或 id 参数"));
    const abs = path.resolve(filePath);
    const base = path.resolve(literatureService.scanDir);
    if (!abs.startsWith(base + path.sep) && abs !== base) {
      return reply.code(403).send(notFound("PDF_PATH_FORBIDDEN", "PDF 路径不在文献库目录内"));
    }
    if (!fs.existsSync(abs)) return reply.code(404).send(notFound("PDF_NOT_FOUND", "PDF 文件不存在"));
    return reply.type("application/pdf").send(fs.createReadStream(abs));
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

  // P1: 知识库备份/恢复路由(admin 权限, 异步任务)
  app.register(backupRoutes);

  if (fs.existsSync(webIndexFile)) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
    // 页面 HTML 禁止缓存(每次构建 hash 变化, 防浏览器缓存旧 index 引用旧 chunk)
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/" || request.url.endsWith(".html")) {
        reply.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        reply.header("Pragma", "no-cache");
      }
      return payload;
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send(notFound("NOT_FOUND", "接口不存在"));
      }
      // V414: 缺失的静态资源必须 404, 不能回落到 SPA 的 index.html。
      //   静态站（@fastify/static）与 SPA 不同：资源路径是"文件"不是"路由"，
      //   拼错/不存在的路径回落 index.html 会把 HTML 当脚本/页面交付 ——
      //   实测后果：web/dist/soc/（SocialSci Vue 子应用）未构建时，/soc/index.html
      //   返回 React 应用，iframe 里的"课题流程编排"等 5 个 tab 全被渲染成 AI 对话页。
      //   浏览器本来就按扩展名认 MIME，这里只做兜底澄清。
      if (/\.(js|mjs|css|json|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|wasm|pdf|txt|xml|zip)$/i.test(request.url.split("?")[0])) {
        return reply.code(404).send(notFound("NOT_FOUND", "静态资源不存在"));
      }
      reply.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      return reply.type("text/html").send(fs.readFileSync(webIndexFile, "utf8"));
    });
  }

  app.setErrorHandler((error, request, reply) => {
    // PG 列类型错误(非 uuid 打 :id 路由等)归 404 — 防畸形输入 500(任务1走查: research/review/projects 三域实测 500)
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("invalid input syntax for type uuid") || msg.includes("22P02")) {
      reply.code(404).send({ error: "资源不存在" });
      return;
    }
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

  // ═══ SocialSci P0-1: 科研项目/可视化DAG工作台(迁移114/115) ═══
  // 项目容器 CRUD + 画布乐观锁 + 执行任务 + 节点快照/回滚 + 版本发布 + DAG模板/NL转DAG + 主控分析
  // 形态对齐参考产品交互语义, 原创实现(见 docs/SOCIALSCI-GAP-ANALYSIS.md S-01~S-10)

  app.get("/api/research/projects", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { projects: await researchPipeline.listProjects(user.id) };
  });

  // V417: 写作舱「数据源」下拉 —— 文献检索要检索哪些库。
  //   /api/sources 按**用户租户**过滤, 而本机的知识库都在公共租户下 → 那个接口返回空,
  //   用户看不出自己其实有 500 篇可检索文献。这里按"能访问到"列出: 公共库 + 本租户库。
  app.get("/api/research/available-sources", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
    const r = await pool.query(
      `select s.id, s.name, s.tenant_id,
              (select count(*) from documents d where d.source_id = s.id) as doc_count
         from sources s
        where s.tenant_id = $1 or s.tenant_id = $2
        order by (s.tenant_id = $2) desc, doc_count desc
        limit 50`,
      [user.tenantId, PUBLIC_TENANT]
    );
    return {
      sources: r.rows.map((row) => ({
        id: row.id,
        name: row.name,
        docCount: Number(row.doc_count ?? 0),
        isPublic: row.tenant_id === PUBLIC_TENANT,
      })),
    };
  });

  app.post("/api/research/projects", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { title?: string; topic?: string; thesis?: string; style?: string; template?: string; sourceIds?: string[] };
    if (!body?.title?.trim()) return reply.code(400).send({ error: "请填写研究标题" });
    const { id } = await researchPipeline.createProject({
      userId: user.id, title: body.title.trim(),
      topic: body.topic ?? "", thesis: body.thesis ?? "", style: body.style ?? "",
    });
    // 标准五阶段模板: 建项目即铺画布(模板流)
    if (body.template === "five-stage") {
      await researchPipeline.putCanvas(user.id, id, researchPipeline.dagTemplateFiveStage(body.title.trim()));
    }
    // V417: 建项目时绑定检索数据源(写作舱文献检索用; 空 = 回退默认公共库)
    if (Array.isArray(body.sourceIds)) {
      const ids = body.sourceIds.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10);
      await pool.query(`update research_projects set source_ids = $2::uuid[] where id = $1 and user_id = $3`,
        [id, ids, user.id]);
    }
    return { id };
  });

  // V417: 改项目绑定的数据源(写作舱"选题界定"页可改)
  app.put("/api/research/projects/:projectId/sources", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { sourceIds?: string[] };
    if (!Array.isArray(body?.sourceIds)) return reply.code(400).send({ error: "缺少 sourceIds" });
    const ids = body.sourceIds.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10);
    const r = await pool.query(
      `update research_projects set source_ids = $2::uuid[], updated_at = now() where id = $1 and user_id = $3 returning id`,
      [projectId, ids, user.id]
    );
    if (!r.rows.length) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, sourceIds: ids };
  });

  app.get("/api/research/projects/:projectId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const project = await researchPipeline.getProject(user.id, projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { project };
  });

  app.patch("/api/research/projects/:projectId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    // 2026-09-15: 补 phase/phaseLabel —— 写作舱推进阶段时前端只写了 workbench 快照,
    //   research_projects.phase 全仓零写入方, 项目列表/版本门禁读到的阶段恒为 0。
    const body = request.body as { title?: string; topic?: string; thesis?: string; style?: string; phase?: number; phaseLabel?: string };
    const updated = await researchPipeline.updateProjectMeta(user.id, projectId, body);
    if (!updated) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true };
  });

  app.post("/api/research/projects/:projectId/archive", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchPipeline.archiveProject(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true };
  });

  // 删除项目 —— **软删**(status='deleted'), 与 archiveProject 同一套状态机。
  // 2026-09-21: 此路由此前**不存在**(DELETE 恒 404「接口不存在」)。语义按既有约定取软删, 理由有三:
  //   1) 114 迁移的列注释就写着 `active / archived / deleted`, 'deleted' 一直是预留值;
  //   2) listProjects 早已在 `where status<>'deleted'` 过滤 —— 只差一个写入方, 是半截工程;
  //   3) 硬删要级联 research_tasks / research_nodes / research_versions / research_materials,
  //      但 research_tasks.project_id 与 research_materials.project_id 都是**裸 uuid 无外键**
  //      (见 115/116 迁移), 库里没有 ON DELETE 可依赖, 硬删会留下一片取不到也删不掉的孤儿行。
  // 所以这里不删数据, 只置灰: 项目列表不再出现, 历史/版本仍可按 id 直查。
  app.delete("/api/research/projects/:projectId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchPipeline.deleteProject(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, deleted: true };
  });

  // 画布(乐观锁: 提交带 expectedVersion)
  app.get("/api/research/projects/:projectId/canvas", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const c = await researchPipeline.getCanvas(user.id, projectId);
    if (!c) return reply.code(404).send({ error: "项目不存在" });
    return { canvas: c.canvas, canvasVersion: c.canvasVersion };
  });

  app.put("/api/research/projects/:projectId/canvas", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { canvas?: unknown; expectedVersion?: number };
    if (!body.canvas) return reply.code(400).send({ error: "缺少 canvas" });
    const r = await researchPipeline.putCanvas(user.id, projectId, body.canvas as never, body.expectedVersion);
    if (!r.ok) {
      if (r.code === "NOT_FOUND") return reply.code(404).send({ error: "项目不存在" });
      return reply.code(409).send({ error: "画布已被其他窗口修改, 请刷新", currentVersion: (r as { currentVersion?: number }).currentVersion });
    }
    return { ok: true, canvasVersion: r.canvasVersion };
  });

  // NL → DAG(画布任务)
  app.post("/api/research/projects/:projectId/nl-to-dag", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { description?: string };
    if (!body?.description?.trim()) return reply.code(400).send({ error: "请描述研究任务" });
    const r = await researchPipeline.nlToDag(user.id, projectId, body.description.trim());
    if ("error" in r) return reply.code(422).send({ error: r.error });
    return { canvas: r.canvas };
  });

  // DAG 模板
  app.get("/api/research/templates/five-stage", async (request) => {
    const title = ((request.query as { title?: string })?.title) ?? "未命名研究";
    return { canvas: researchPipeline.dagTemplateFiveStage(title) };
  });

  // 执行任务
  app.get("/api/research/tasks", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { projectId?: string; status?: string };
    return { tasks: await researchPipeline.listTasks(user.id, q.projectId, q.status) };
  });

  app.post("/api/research/tasks", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; dagNodeId?: string; module?: string; jobKind?: string; goal?: string; dependsOn?: string[]; phase?: number; plan?: unknown[]; inputSnapshot?: Record<string, unknown> };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const task = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, dagNodeId: body.dagNodeId,
      module: body.module, jobKind: body.jobKind, goal: body.goal,
      dependsOn: body.dependsOn, phase: body.phase, plan: body.plan,
      inputSnapshot: body.inputSnapshot,
    });
    return { task };
  });

  // ═══ SocialSci HistoryView 对齐: 历史中心统一多源端点 ═══
  // 参考产品语义: 6 模块(workflow/review/statistics/viz/editor/knowledge)分区展示,
  //   每卡=模块归属+标题+状态+相对时间, 点击恢复对应工作台条目。
  // 数据源: research_tasks(workflow, 含跨模块容器 module 字段真值) / review_jobs(review)
  //   / empirical_results(statistics, 全局共享分析记录) / viz_sessions(viz)
  //   / documents_v2(editor 文档资产) / search_query_history(knowledge, 131 迁移)
  app.get("/api/research/history", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const rt = await pool.query(
      `select id, project_id, module, job_kind, phase, phase_label, goal, status, error, created_at, updated_at
         from research_tasks where user_id=$1 order by updated_at desc limit 100`,
      [user.id]
    );
    const rj = await pool.query(
      `select id, kind, title, status, created_at, updated_at
         from review_jobs where user_id=$1 order by updated_at desc limit 50`,
      [user.id]
    );
    const vs = await pool.query(
      `select s.id, s.title, s.status, s.created_at, s.updated_at
         from viz_sessions s where s.user_id=$1 order by s.updated_at desc limit 50`,
      [user.id]
    );
    // 实证历史为全局共享记录(empirical/run 无鉴权, user_id 恒 NULL), 不去重归属
    const { empiricalService } = await import("../services/empirical-service.js");
    const es = await empiricalService.listEmpiricalHistory(30);
    const dc = await pool.query(
      `select d.id, d.title, d.word_count, d.status, d.tags, d.updated_at
         from documents_v2 d where d.user_id=$1 order by d.updated_at desc limit 50`,
      [user.id]
    );
    const kh = await pool.query(
      `select id, query, source_id, created_at
         from search_query_history where user_id=$1 order by created_at desc limit 30`,
      [user.id]
    );
    const done = (s: string | null) => s === "done" || s === "failed" || s === "cancelled";
    return {
      tasks: rt.rows.map((t) => ({
        id: t.id, projectId: t.project_id ?? "", module: t.module === "workflow" || !t.module ? "workflow" : t.module,
        title: t.goal || "未命名任务", phase: t.phase ?? 0, phase_label: t.phase_label ?? "",
        status: t.status, created_at: t.created_at, updated_at: t.updated_at,
        error: t.error ?? null, active: !done(t.status), kind: t.job_kind ?? "",
      })),
      review: rj.rows.map((r) => ({
        id: r.id, title: r.title || "审稿任务", phase: 0, phase_label: "审稿",
        status: r.status, created_at: r.created_at, updated_at: r.updated_at,
        active: !done(r.status), kind: r.kind ?? "text",
      })),
      viz: vs.rows.map((v) => ({
        id: v.id, title: v.title || "未命名绘图会话", phase: 0, phase_label: "绘图",
        status: v.status, created_at: v.created_at, updated_at: v.updated_at,
        active: false, kind: "viz",
      })),
      statistics: es.map((e) => ({
        id: String(e.id), title: e.title || `实证分析 · ${e.method ?? "unknown"}`, phase: 0,
        phase_label: "统计", status: "done", created_at: e.created_at as string,
        updated_at: e.created_at as string, active: false,
        kind: String(e.method ?? "analysis"),
      })),
      editor: dc.rows.map((d) => ({
        id: d.id, title: d.title || "未命名文档", phase: 0, phase_label: "编辑器",
        status: d.status, created_at: d.updated_at, updated_at: d.updated_at,
        active: false, kind: "doc", wordCount: Number(d.word_count ?? 0),
      })),
      knowledge: kh.rows.map((k) => ({
        id: k.id, title: k.query, phase: 0, phase_label: "检索",
        status: "done", created_at: k.created_at, updated_at: k.created_at,
        active: false, kind: "search",
      })),
    };
  });

  // knowledge 查询历史静默记录(AskPanel 检索 done 后 fire-and-forget)
  app.post("/api/research/history/knowledge", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { query?: string; sourceId?: string };
    const q = String(body?.query ?? "").trim();
    if (!q) return reply.code(400).send({ error: "缺少查询内容" });
    if (q.length > 500) return reply.code(400).send({ error: "查询过长" });
    await pool.query(
      `insert into search_query_history (user_id, query, source_id) values ($1,$2,$3)`,
      [user.id, q.slice(0, 500), String(body?.sourceId ?? "")]
    );
    return { ok: true };
  });

  // 清除历史记录(参考产品 deleteAll 语义): ACTIVE_JOB 保护 + failed 明细 + 资产保护
  // - research_tasks: 跳过运行中/排队任务(ACTIVE_JOB 保护, 2s 调度泵会续跑), 删终态
  // - review_jobs: 跳过非终态(审稿 SSE 流运行中)
  // - viz_sessions / search_query_history: 整删(会话/查询记录)
  // - 资产不删: documents_v2(用户稿件) / empirical_results(全局共享分析记录)
  app.delete("/api/research/tasks/history", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;

    const deleted: Array<{ id: string; module: string }> = [];
    const failed: Array<{ id: string; module: string; reason: string }> = [];
    const active = ["queued", "running", "paused", "waiting_user", "segmenting", "summarizing", "streaming"];
    // 1. research_tasks(workflow 全模块): 先分区, 保护 active
    const rt = await pool.query(
      `select id, module, status from research_tasks where user_id=$1`, [user.id]
    );
    const killT: string[] = [];
    for (const t of rt.rows) {
      if (active.includes(t.status)) {
        failed.push({ id: t.id, module: t.module || "workflow", reason: "ACTIVE_JOB" });
      } else {
        killT.push(t.id);
      }
    }
    if (killT.length) {
      const r = await pool.query(
        `delete from research_tasks where id = any($1::uuid[]) returning id, module`,
        [killT]
      );
      for (const row of r.rows) deleted.push({ id: row.id, module: row.module || "workflow" });
    }
    // 2. review_jobs: 非终态保护
    const rj = await pool.query(
      `select id, status from review_jobs where user_id=$1`, [user.id]
    );
    const killR: string[] = [];
    for (const j of rj.rows) {
      if (active.includes(j.status)) {
        failed.push({ id: j.id, module: "review", reason: "ACTIVE_JOB" });
      } else {
        killR.push(j.id);
      }
    }
    if (killR.length) {
      const r = await pool.query(
        `delete from review_jobs where id = any($1::uuid[]) returning id`,
        [killR]
      );
      for (const row of r.rows) deleted.push({ id: row.id, module: "review" });
    }
    // 3. viz_sessions + knowledge 查询历史(无运行态会话判定, 整删)
    const rv = await pool.query(
      `delete from viz_sessions where user_id=$1 returning id`, [user.id]
    );
    for (const row of rv.rows) deleted.push({ id: row.id, module: "viz" });
    const rk = await pool.query(
      `delete from search_query_history where user_id=$1 returning id`, [user.id]
    );
    for (const row of rk.rows) deleted.push({ id: row.id, module: "knowledge" });
    return { deleted, failed };

  });

  // ═══ SocialSci 补漏组4: P3/P4/P5 子任务端点(HAR 语义: 章节素材三件套/批量章节/合稿) ═══
  // P3: 单节文献检索(→ citation 素材)
  app.post("/api/research/jobs/phase3/material-plan", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; goal?: string; l1Sections?: Array<{ id: string; title: string }>; variables?: Array<{ name: string; role?: string }>; hasDataFile?: boolean };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, module: "workflow", jobKind: "material-plan",
      goal: body.goal ?? "素材生成计划",
      inputSnapshot: { l1Sections: body.l1Sections ?? [], variables: body.variables ?? [], hasDataFile: Boolean(body.hasDataFile) },
    });
    return { job: t };
  });
  app.post("/api/research/jobs/phase3/literature-search", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { taskId?: string; projectId?: string; sectionId?: string; sectionTitle?: string; keywords?: string[]; count?: number };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, dagNodeId: body.sectionId ?? "",
      module: "workflow", jobKind: "literature-search",
      goal: body.sectionTitle ? `文献检索 · ${body.sectionTitle}` : "文献检索",
      inputSnapshot: { sectionId: body.sectionId, sectionTitle: body.sectionTitle, keywords: body.keywords, count: body.count ?? 5 },
    });
    return { job: t };
  });
  // P3: 理论框架生成(→ theory 素材)
  app.post("/api/research/jobs/phase3/theory-generate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { taskId?: string; projectId?: string; sectionId?: string; sectionTitle?: string; title?: string; prompt?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, dagNodeId: body.sectionId ?? "",
      module: "workflow", jobKind: "theory-generate",
      goal: body.sectionTitle ? `理论框架 · ${body.sectionTitle}` : "理论框架梳理",
      inputSnapshot: { sectionId: body.sectionId, sectionTitle: body.sectionTitle, title: body.title, prompt: body.prompt },
    });
    return { job: t };
  });
  // P3: 表格设计(→ data_result 素材)
  app.post("/api/research/jobs/phase3/table-generate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { taskId?: string; projectId?: string; sectionId?: string; sectionTitle?: string; title?: string; prompt?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, dagNodeId: body.sectionId ?? "",
      module: "workflow", jobKind: "table-generate",
      goal: body.sectionTitle ? `表格设计 · ${body.sectionTitle}` : "表格设计",
      inputSnapshot: { sectionId: body.sectionId, sectionTitle: body.sectionTitle, title: body.title, prompt: body.prompt },
    });
    return { job: t };
  });
  // P4: 章节批量生成(携带 sections 清单含 skill_prompt/requirements)
  app.post("/api/research/jobs/phase4/batch", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; taskId?: string; goal?: string; sections?: Array<Record<string, unknown>> };
    if (!body?.projectId || !Array.isArray(body.sections) || !body.sections.length) return reply.code(400).send({ error: "缺少 projectId/sections" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, module: "workflow", jobKind: "phase4_batch",
      goal: body.goal ?? "批量生成论文章节",
      inputSnapshot: { sections: body.sections, taskId: body.taskId },
    });
    return { job: t };
  });
  // P5: 合并(摘要/关键词要件)/审查/修订
  app.post("/api/research/jobs/phase5/merge", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; goal?: string; sections?: Array<{ title?: string }>; chapterContents?: string[]; enableDeAIFyMerge?: boolean };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, module: "workflow", jobKind: "merge",
      goal: body.goal ?? "合并定稿",
      inputSnapshot: { sections: body.sections, chapterContents: body.chapterContents, enableDeAIFyMerge: body.enableDeAIFyMerge },
    });
    return { job: t };
  });
  app.post("/api/research/jobs/phase5/review", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; goal?: string; sections?: Array<{ title?: string }> };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, module: "workflow", jobKind: "review",
      goal: body.goal ?? "全文审查",
      inputSnapshot: { sections: body.sections },
    });
    return { job: t };
  });
  app.post("/api/research/jobs/phase5/revise", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; goal?: string; sections?: Array<{ title?: string }>; chapterContents?: string[] };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const t = await researchPipeline.createTask({
      userId: user.id, projectId: body.projectId, module: "workflow", jobKind: "revise",
      goal: body.goal ?? "修订",
      inputSnapshot: { sections: body.sections, chapterContents: body.chapterContents },
    });
    return { job: t };
  });
  // 执行一轮(手动调度, 处理就绪任务)
  app.post("/api/research/jobs/run", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string };
    // 同上: 归属必须是登录者本人的任务
    const r = await researchExec.runSchedulingRound(body?.projectId, user.id);
    return { executed: r.executed, results: r.results };
  });

  app.get("/api/research/tasks/:taskId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { taskId } = request.params as { taskId: string };
    const task = await researchPipeline.getTask(user.id, taskId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { task };
  });

  app.post("/api/research/tasks/:taskId/control", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { taskId } = request.params as { taskId: string };
    const body = request.body as { action?: string };
    const action = (["cancel", "pause", "resume", "retry"] as const).find((a) => a === body?.action);
    if (!action) return reply.code(400).send({ error: "action 需为 cancel/pause/resume/retry" });
    const task = await researchPipeline.controlTask(user.id, taskId, action);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { task };
  });

  // 节点快照
  app.get("/api/research/projects/:projectId/nodes", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    return { nodes: await researchPipeline.listNodes(user.id, projectId) };
  });

  app.get("/api/research/projects/:projectId/nodes/:nodeKey", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey } = request.params as { projectId: string; nodeKey: string };
    const node = await researchPipeline.getNode(user.id, projectId, nodeKey);
    if (!node) return reply.code(404).send({ error: "节点不存在" });
    return { node };
  });

  app.put("/api/research/projects/:projectId/nodes/:nodeKey", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey } = request.params as { projectId: string; nodeKey: string };
    const body = request.body as { payload?: unknown; taskId?: string; sourceRole?: string; note?: string };
    if (body.payload === undefined) return reply.code(400).send({ error: "缺少 payload" });
    const r = await researchPipeline.putNode(user.id, projectId, nodeKey, body.payload, {
      taskId: body.taskId, sourceRole: body.sourceRole, note: body.note,
    });
    if (!r.ok) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, version: r.version };
  });

  // ═══ 节点字段级合并(浅合并, 保留未列出的键) ═══
  // 由来(2026-09-16): 合稿页手改标题/摘要/正文后, 之前只能走 PUT 整块替换 ——
  //   前端得先 GET 再把几个字段并进去, 是**读改写**, 并发下(比如后台 merge 任务同时写)
  //   后写覆盖先写; 而且一旦漏并某个键(reviewReport 等), 就被静默抹掉。
  //   这里用 jsonb `||` 在**一条语句里**合并, 调用方只需给出要改的键。
  //   注: 顶层浅合并 —— 传 `{mergedTitle:"x"}` 只改这一个字段。
  app.patch("/api/research/projects/:projectId/nodes/:nodeKey/merge", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey } = request.params as { projectId: string; nodeKey: string };
    const body = request.body as { patch?: Record<string, unknown>; sourceRole?: string; note?: string };
    if (!body?.patch || typeof body.patch !== "object") return reply.code(400).send({ error: "缺少 patch" });
    const r = await researchPipeline.mergeNode(user.id, projectId, nodeKey, body.patch, {
      sourceRole: body.sourceRole ?? "user", note: body.note ?? "",
    });
    if (!r.ok) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, version: r.version };
  });

  // UI审计T8: 批量回滚(最近一次 batch:pre 锚点 → 恢复批量前状态)
  app.post("/api/research/projects/:projectId/nodes/sections/undo-batch", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await pool.query(
      `select h.id from research_node_history h
         join research_nodes n on n.id=h.node_id
         join research_projects p on p.id=n.project_id
        where n.project_id=$1 and n.node_key='sections' and p.user_id=$2
          and h.note='batch:pre'
        order by h.created_at desc limit 1`,
      [projectId, user.id]);
    if (!r.rows.length) return reply.code(404).send({ error: "没有可回滚的批量记录" });
    const res = await researchPipeline.rollbackNode(user.id, projectId, "sections", r.rows[0].id);
    if (!res.ok) return reply.code(422).send({ error: res.code });
    return { ok: true, rolledBack: true };
  });


  app.get("/api/research/projects/:projectId/nodes/:nodeKey/history", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey } = request.params as { projectId: string; nodeKey: string };
    return { history: await researchPipeline.listNodeHistory(user.id, projectId, nodeKey) };
  });

  /**
   * 取某条历史的完整 payload(只读) —— 版本对比的前置。
   * 放在 rollback 之前是刻意的: 两者读同一张表, 但这条**不改任何数据**,
   * 顺序上让"看"在"改"前面, 读代码时不容易把两者混为一谈。
   */
  app.get("/api/research/projects/:projectId/nodes/:nodeKey/history/:historyId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey, historyId } = request.params as { projectId: string; nodeKey: string; historyId: string };
    const h = await researchPipeline.getNodeHistoryDetail(user.id, projectId, nodeKey, historyId);
    if (!h) return reply.code(404).send({ error: { code: "HISTORY_NOT_FOUND", message: "历史版本不存在" } });
    return { history: h };
  });

  app.post("/api/research/projects/:projectId/nodes/:nodeKey/rollback", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, nodeKey } = request.params as { projectId: string; nodeKey: string };
    const body = request.body as { historyId?: string };
    if (!body?.historyId) return reply.code(400).send({ error: "缺少 historyId" });
    const r = await researchPipeline.rollbackNode(user.id, projectId, nodeKey, body.historyId);
    if (!r.ok) return reply.code(404).send({ error: r.code === "HISTORY_NOT_FOUND" ? "历史版本不存在" : "节点不存在" });
    return { ok: true, version: r.version };
  });

  // 版本发布(指针快照)
  app.post("/api/research/projects/:projectId/publish", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { label?: string };
    const r = await researchPipeline.publishVersion(user.id, projectId, body?.label ?? "");
    if (!r.ok) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, version: r.version };
  });

  app.get("/api/research/projects/:projectId/versions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    return { versions: await researchPipeline.listVersions(user.id, projectId) };
  });

  /**
   * 项目整包导出(V425 A3) —— ZIP, 内容: 论文/章节/素材清单/版本沿革/研究信息/Word。
   *
   * GET + 二进制流(而不是像 /paper-outline/export 那样返回 base64 JSON):
   *   整包是**多文件**, 体积随素材量线性涨, base64 还要再多三分之一, 而前端拿到 base64 后
   *   仍要再转一次 Blob。直接给 application/zip 让浏览器原生下载, 也省掉一次内存里的
   *   双份拷贝(实测一个带 5 条素材的项目约几十 KB, 但素材多的项目会到 MB 级)。
   *   文件名走 RFC 5987 的 filename* —— 中文名用普通 filename 会乱码(本仓导出链踩过)。
   */
  app.get("/api/research/projects/:projectId/export-bundle", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const { exportProjectBundle } = await import("../services/project-export-service.js");
    const r = await exportProjectBundle(user.id, projectId);
    if (!r.ok || !r.buffer) {
      return reply.code(r.error === "PROJECT_NOT_FOUND" ? 404 : 500)
        .send({ error: { code: r.error ?? "EXPORT_FAILED", message: r.error === "PROJECT_NOT_FOUND" ? "项目不存在" : "导出失败" } });
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition",
      `attachment; filename="project-export.zip"; filename*=UTF-8''${encodeURIComponent(r.fileName ?? "project-export.zip")}`);
    return reply.send(r.buffer);
  });

  // P-A 终稿激活(参考产品 phase5/version/:ver/activate 语义: 版本置 published + project.revision_of_version)
  app.post("/api/research/projects/:projectId/versions/:version/activate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, version } = request.params as { projectId: string; version: string };
    const r = await researchPipeline.activateVersion(user.id, projectId, Number(version));
    if (!r.ok) return reply.code(404).send({ error: r.code === "VERSION_NOT_FOUND" ? "版本不存在" : "项目不存在" });
    return { ok: true, version: r.version };
  });

  // 主控 Agent P1 分析(→ analysis 节点, SSE 事件流)
  app.post("/api/research/projects/:projectId/analyze", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { taskId?: string };
    const sse = attachSse(reply);
    sse.send("pipe.started", { projectId });
    try {
      const r = await researchPipeline.runMainAgentAnalysis(user.id, projectId, { taskId: body?.taskId });
      if (!r.ok) { sse.error({ code: "NOT_FOUND", userMessage: "项目不存在", canRetry: false }); return sse.end(); }
      sse.send("pipe.node", { nodeKey: "analysis", payload: r.payload });
      sse.send("pipe.done", { nodeKey: "analysis" });
    } catch (e) {
      sse.error(e instanceof Error ? e : String(e), "ANALYZE_FAILED");
    } finally {
      sse.end();
    }
  });

  // ═══ SocialSci P0-2: 素材库 + DAG 执行引擎(迁移116) ═══
  // 素材 CRUD(跨模块导入钩子: 实证/审稿/绘图产物 → research_materials)
  // 执行引擎: 手动触发调度轮 + 画布依赖同步
  app.get("/api/research/materials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { projectId?: string; kind?: string };
    return { materials: await researchMaterials.listMaterials(user.id, q.projectId, q.kind) };
  });

  app.post("/api/research/materials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as {
      projectId?: string; kind?: string; title?: string; contentMd?: string;
      tags?: string[]; sourceRef?: string; producedByDagNode?: string; meta?: Record<string, unknown>;
      // V417: 以下扩展列 service 层早就支持(write 到对应列), 但路由没转发 → 中间层丢字段,
      //   导致这些列在前端看永远是空的(素材挂章、引用池、图表数据、附件说明…)。
      sectionId?: string | string[]; sectionIds?: string[]; references?: unknown[];
      summary?: string; caption?: string; sourceType?: string; sourceUrl?: string;
      imagePath?: string; tableData?: unknown; analysisMethod?: string; notes?: string; sortOrder?: number;
    };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const kind = ["note", "citation", "data_result", "figure", "file", "theory", "table"].includes(body.kind ?? "") ? body.kind : "note";
    // 挂章: 前端发的是 sectionIds 数组(snake 列 section_ids 是 text[]), 兼容单值 sectionId
    const sectionIds = Array.isArray(body.sectionIds)
      ? body.sectionIds.map(String)
      : Array.isArray(body.sectionId) ? body.sectionId.map(String)
      : typeof body.sectionId === "string" && body.sectionId ? [body.sectionId] : [];
    const { id } = await researchMaterials.createMaterial({
      projectId: body.projectId, userId: user.id, kind: kind as never,
      title: body.title, contentMd: body.contentMd, tags: body.tags,
      sourceRef: body.sourceRef, producedByDagNode: body.producedByDagNode, meta: body.meta,
      ...(sectionIds.length ? { sectionIds } : {}),
      ...(Array.isArray(body.references) ? { references: body.references } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.caption !== undefined ? { caption: body.caption } : {}),
      ...(body.sourceType !== undefined ? { sourceType: body.sourceType } : {}),
      ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
      ...(body.imagePath !== undefined ? { imagePath: body.imagePath } : {}),
      ...(body.tableData !== undefined ? { tableData: body.tableData } : {}),
      ...(body.analysisMethod !== undefined ? { analysisMethod: body.analysisMethod } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    });
    return { id };
  });

  app.get("/api/research/materials/:materialId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const m = await researchMaterials.getMaterial(user.id, materialId);
    if (!m) return reply.code(404).send({ error: "素材不存在" });
    return { material: m };
  });

  app.put("/api/research/materials/:materialId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const body = request.body as { title?: string; contentMd?: string; tags?: string[]; kind?: string; references?: unknown[] };
    const r = await researchMaterials.updateMaterial(user.id, materialId, body);
    if (!r) return reply.code(404).send({ error: "素材不存在" });
    return { ok: true };
  });

  app.delete("/api/research/materials/:materialId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const r = await researchMaterials.deleteMaterial(user.id, materialId);
    if (!r) return reply.code(404).send({ error: "素材不存在" });
    return { ok: true };
  });

  app.post("/api/research/materials/reorder", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    // taskId 是参考产品(及素材列表接口)对"项目"的叫法, 本项目其余路由叫 projectId —— 两者都收,
    //   作为归属校验的收窄条件(参考产品前端发 {taskId, ids})。
    const body = request.body as { ids?: string[]; projectId?: string; taskId?: string };
    if (!Array.isArray(body?.ids)) return reply.code(400).send({ error: "缺少 ids" });
    const projectId = body.projectId || body.taskId;
    const r = await researchMaterials.reorderMaterials(user.id, body.ids, projectId);
    if (!r) return reply.code(404).send({ error: "素材不存在或不属于该项目" });
    return r;
  });

  // 素材上下文(写作节点注入预览)
  app.get("/api/research/projects/:projectId/materials-context", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    return { context: await researchMaterials.buildMaterialsContext(user.id, projectId) };
  });

  // 体验厚度: AI素材审视
  // V417: 项目级素材审视 —— 前端 MaterialsView 的「审视素材」一直调这个路径, 但后端
  //   只有单条路由 /materials/:materialId/review, 于是 POST /materials/review 会命中
  //   那条路由、materialId="review" → 404「接口不存在」。按钮 100% 失败(实测确认)。
  //   这里补上: 取项目全部素材, 逐条审阅后汇总一份报告, 并落进 workbench 快照供回读。
  app.post("/api/research/materials/review", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; topic?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const list = await researchMaterials.listMaterials(user.id, body.projectId);
    const items = (Array.isArray(list) ? list : []) as Array<{ id: string; title?: string; kind?: string }>;
    if (!items.length) return reply.code(422).send({ error: "该项目暂无素材可审视" });
    // 逐条审(上限 12 条, 免得素材多时把请求拖死); 失败的跳过不阻断整体
    const parts: string[] = [];
    let okCount = 0;
    for (const m of items.slice(0, 12)) {
      try {
        const r = await researchMaterials.reviewMaterial(user.id, m.id, body.topic ?? undefined);
        if (r.ok && r.review) {
          okCount += 1;
          const rv = r.review as Record<string, unknown>;
          const line = Object.entries(rv).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
          parts.push(`### ${m.title ?? "(未命名素材)"}\n${line}`);
        }
      } catch { /* 单条失败不阻断 */ }
    }
    if (!okCount) return reply.code(422).send({ error: "素材审视全部失败(模型不可用或素材为空)" });
    const report = `素材审视报告(${okCount}/${items.length} 条)\n\n${parts.join("\n\n")}`;
    // 落进快照: store.materialReviewReport 走 saveProject, 但后端也应留一份, 供刷新后回读
    try {
      const cur = await chapterSkill.getWorkbenchSnapshot(user.id, body.projectId);
      await chapterSkill.saveWorkbenchSnapshot(user.id, body.projectId, {
        ...((cur?.snapshot as Record<string, unknown>) ?? {}),
        materialReviewReport: report,
      });
    } catch { /* 快照写失败不影响返回 */ }
    return { report, okCount, total: items.length };
  });

  app.post("/api/research/materials/:materialId/review", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const body = request.body as { topic?: string };
    const r = await researchMaterials.reviewMaterial(user.id, materialId, body?.topic);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { review: r.review };
  });

  // P0-6: 素材导入钩子收口(跨模块产物 → research_materials 统一入口)
  // 支持: 审稿结果(review_job) / 绘图产物(viz_artifact) / 编辑器图表(chart-code 产物路径) 等
  app.post("/api/research/materials/import", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as {
      projectId?: string;
      sourceType?: string;   // review_job / viz_artifact / chart_image / manual
      sourceId?: string;
      title?: string;
      note?: string;
    };
    if (!body?.projectId || !body?.sourceType) return reply.code(400).send({ error: "缺少 projectId/sourceType" });
    const id = randomUUID();
    const meta = { sourceType: body.sourceType, sourceId: body.sourceId ?? "", importedAt: new Date().toISOString() };
    // 按来源类型取内容(原创实现, 自研来源: viz_artifact 从 viz_artifacts 表; review_job 取结果摘要)
    let title = body.title ?? "";
    let contentMd = body.note ?? "";
    let kind = "note" as string;
    if (body.sourceType === "viz_artifact" && body.sourceId) {
      const r = await pool.query(`select * from viz_artifacts where id=$1 and user_id=$2`, [body.sourceId, user.id]);
      if (r.rows[0]) {
        const a = r.rows[0];
        title = `${a.prompt?.slice(0, 40) || "科研图表"} (v${a.version})`;
        contentMd = `![图表](/api/viz/files/${a.png_path})\n\nSVG 可编辑: /${a.svg_editable_path}\n\n${a.python_code ? "生成代码:\n```python\n" + a.python_code.slice(0, 800) + "\n```" : ""}`;
        kind = "figure";
      }
    } else if (body.sourceType === "review_job" && body.sourceId) {
      const r = await pool.query(`select * from review_jobs where id=$1 and user_id=$2`, [body.sourceId, user.id]);
      if (r.rows[0]?.result) {
        const res = r.rows[0].result;
        title = `审稿意见 · ${res.paperTitle ?? "未命名"}`;
        contentMd = `**总体评语**: ${res.overall ?? ""}\n\n**维度评分**:\n${(res.dimensions ?? []).map((d: { name: string; score: number; comment?: string }) => `- ${d.name}: ${d.score}分 ${d.comment ?? ""}`).join("\n")}`;
        kind = "data_result";
      }
    }
    if (!title) title = body.title ?? `素材 · ${body.sourceType}`;
    if (!contentMd) contentMd = body.note ?? title;
    await pool.query(
      `insert into research_materials (id, project_id, user_id, kind, title, content_md, source_ref, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.projectId, user.id, kind, title, contentMd, body.sourceId ?? "", JSON.stringify(meta)]
    );
    return { id };
  });

  // 执行引擎: 手动调度轮(前端"开始执行"或测试触发; 常驻定时后续批)
  app.post("/api/research/engine/run", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string };
    // user.id 必须传: 否则这条链能跑他人项目下 queued 的任务(以他人素材烧 LLM)
    const r = await researchExec.runSchedulingRound(body?.projectId, user.id);
    return { executed: r.executed, results: r.results };
  });

  // 画布依赖同步(画布改完调用, 使 depends_on 与画布边一致)
  app.post("/api/research/projects/:projectId/sync-deps", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const owned = await researchPipeline.getProject(user.id, projectId);
    if (!owned) return reply.code(404).send({ error: "项目不存在" });
    return await researchExec.syncTaskDependenciesFromCanvas(projectId);
  });

  // ═══ SocialSci P0-3: 审稿任务流 + 期刊库/标准库(迁移117) ═══
  app.post("/api/review/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string; title?: string; kind?: string; journalId?: string; standardId?: string;
      settings?: { strictness?: string; standardIds?: string[]; customRequirements?: string };
      sidebarTaskId?: string; sourceFileId?: string; sourceFileName?: string; sourceFileType?: string };
    if (!body?.text?.trim()) return reply.code(400).send({ error: "请提供稿件文本(或稍后支持文件上传)" });
    // 上限与前端 MAX_REVIEW_CHARS 一致: 此前 API 对长度不设防, 30 万字能建出 75 段任务
    //   (每段一次 LLM → 成本失控), 而前端静默砍到 12 万, 两端口径还对不上
    const MAX_REVIEW_CHARS = 120_000;
    const textIn = String(body.text).slice(0, MAX_REVIEW_CHARS);
    const r = await reviewService.createReviewJob({
      userId: user.id, title: body.title, text: textIn, kind: body.kind,
      journalId: body.journalId, standardId: body.standardId,
      settings: body.settings, sidebarTaskId: body.sidebarTaskId,
      sourceFileId: body.sourceFileId, sourceFileName: body.sourceFileName, sourceFileType: body.sourceFileType,
    });
    return { jobId: r.id, segmentCount: r.segmentCount, dimensions: r.dimensions,
      truncated: String(body.text).length > MAX_REVIEW_CHARS, chars: textIn.length };
  });

  app.get("/api/review/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { limit?: string; offset?: string };
    // clamp: limit=-5 会让 PG 直接报 "LIMIT must not be negative" → 500
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const [jobs, total] = await Promise.all([
      reviewService.listReviewJobs(user.id, limit, offset),
      reviewService.countReviewJobs(user.id),
    ]);
    // total 让前端能显示"共 N 条"并决定还要不要"加载更多"(否则只能靠"这页满没满"猜)
    return { jobs, total };
  });

  app.get("/api/review/jobs/:jobId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const job = await reviewService.getReviewJob(user.id, jobId);
    if (!job) return reply.code(404).send({ error: "审稿任务不存在" });
    return { job };
  });

  // 删除审稿记录(报告+批注+进度)。
  // 2026-09-11: 前端一直有这个按钮, 但后端从来没有这条路由 —— 404 被前端的 .catch 吞掉,
  //   UI 弹"已删除"而记录仍在。现在补齐, 并把失败原因如实回给前端。
  app.delete("/api/review/jobs/:jobId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const ok = await reviewService.deleteReviewJob(user.id, jobId);
    if (!ok) {
      // 区分"不存在/不是你的"与"正在跑不能删": 前者 404, 后者要告诉用户先取消
      const job = await reviewService.getReviewJob(user.id, jobId);
      if (!job) return reply.code(404).send({ error: "审稿任务不存在" });
      return reply.code(409).send({ error: "该任务正在执行或排队中, 请先取消再删除" });
    }
    return { ok: true };
  });

  // SSE 流式审稿(review.started/status/delta/completed)
  app.get("/api/review/jobs/:jobId/stream", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const sse = attachSse(reply);
    // 集群级闸: 抢任务租约(防同一任务被两个执行者审两遍) + 抢全局槽位(限制同时执行数)
    const gate = await reviewService.acquireReviewSlot({ userId: user.id, jobId, sse });
    if (!gate.ok) {
      // 没拿到执行权: 任务可能正被别的实例/标签页推进 —— 不关流, 让本页继续收进度
      // (审稿没有事件回放, 关掉的话用户会看不到任何进展)
      return;
    }
    try {
      await reviewService.runReviewJob(user.id, jobId, sse, { guard: gate.guard });
    } finally {
      gate.release();
    }
    sse.end();
  });

  app.post("/api/review/jobs/:jobId/control", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const body = request.body as { action?: string };
    const action = (["cancel", "retry"] as const).find((a) => a === body?.action);
    if (!action) return reply.code(400).send({ error: "action 需为 cancel/retry" });
    const job = await reviewService.controlReviewJob(user.id, jobId, action);
    if (!job) return reply.code(404).send({ error: "审稿任务不存在" });
    return { job };
  });

  // 审稿报告 Word 批注导出(SocialSci P0-3 补漏: export-report)
  app.post("/api/review/jobs/:jobId/export-word", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const r = await reviewService.exportReportWord(user.id, jobId);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { ok: true, base64: r.base64, fileName: r.fileName };
  });

  // T6: 审稿排版 HTML 报告(对齐参考产品 export-report; base64 供新窗口打印/存 PDF)
  app.post("/api/review/jobs/:jobId/export-html", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const r = await reviewService.exportReportHtml(user.id, jobId);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { ok: true, html: Buffer.from(r.html ?? "", "utf-8").toString("base64") };
  });

  // 期刊库
  app.get("/api/review/journals", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { journals: await reviewService.listJournals(user.id) };
  });

  app.post("/api/review/journals", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { name?: string; level?: string; scope?: string; submissionGuideText?: string };
    if (!body?.name?.trim()) return reply.code(400).send({ error: "请填写期刊名" });
    return await reviewService.createJournal({ ...body, name: body.name.trim(), userId: user.id });
  });

  app.put("/api/review/journals/:journalId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { journalId } = request.params as { journalId: string };
    const body = request.body as { name?: string; level?: string; scope?: string; submissionGuideText?: string; parsedRules?: unknown };
    const r = await reviewService.updateJournal(user.id, journalId, body);
    if (!r) return reply.code(404).send({ error: "期刊不存在或无权限" });
    return { ok: true };
  });

  app.delete("/api/review/journals/:journalId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { journalId } = request.params as { journalId: string };
    const r = await reviewService.deleteJournal(user.id, journalId);
    if (!r) return reply.code(404).send({ error: "期刊不存在或无权限" });
    return { ok: true };
  });

  app.post("/api/review/journals/parse", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { rawText?: string; text?: string };
    const raw = body?.rawText ?? body?.text;
    if (!raw?.trim()) return reply.code(400).send({ error: "请粘贴投稿须知原文" });
    const parsed = await reviewService.parseSubmissionGuide(raw);
    // 面板读 {data:{name,category,structuredRules}} — 只回 {parsed} 时它拿不到任何字段
    return {
      parsed,
      data: {
        name: "", category: "",
        structuredRules: {
          formatRules: parsed.formatRules, reviewFocus: parsed.reviewFocus,
          citationRules: parsed.citationRules, scope: parsed.scope,
        },
      },
      error: (parsed as { error?: string }).error,
    };
  });

  // 批量补规则: 一次粘贴多刊投稿须知 → 逐刊解析入库(封面上的"待补规则 80"就是靠它消)
  // ⚠ 必须注册在 /journals/:journalId 之前吗? 不需要 —— 路径字面量 /journals/batch-parse 不会被
  //   :journalId 吞掉(Fastify 静态段优先于参数段), 但 POST /journals 是同段不同方法, 无冲突。
  app.post("/api/review/journals/batch-parse", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string; rawText?: string; overwrite?: boolean };
    const raw = body?.text ?? body?.rawText;
    if (!raw?.trim()) return reply.code(400).send({ error: "请粘贴投稿须知原文(可一次粘多刊, 用《刊名》投稿须知 作分隔)" });
    const out = await reviewService.batchParseJournals({ text: raw, userId: user.id, overwrite: !!body?.overwrite });
    return out;
  });

  // 一键回退重解析: 用当初喂给 AI 的原文重抽规则(手工填的刊没有原文可退, 如实报错)
  app.post("/api/review/journals/:journalId/reparse", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { journalId } = request.params as { journalId: string };
    const r = await reviewService.reparseJournalRules(user.id, journalId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, rules: r.rules, ruleCount: r.ruleCount };
  });

  // 分批预览: 只切分不解析(不烧 token), 让用户先确认切得对不对再提交
  app.post("/api/review/journals/split-preview", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string; rawText?: string };
    const raw = body?.text ?? body?.rawText;
    if (!raw?.trim()) return reply.code(400).send({ error: "请粘贴投稿须知原文" });
    const blocks = reviewService.splitMultiJournalText(raw);
    return { blocks: blocks.map((b) => ({ name: b.name, chars: b.text.length, preview: b.text.slice(0, 120) })) };
  });

  // 审稿使用统计(2026-09-12): 分数分布 / 常见问题严重度 / 高发维度 / 各刊审稿均分
  app.get("/api/review/stats", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return reviewService.reviewStats(user.id);
  });

  // 审核标准库
  app.get("/api/review/standards", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { standards: await reviewService.listStandards(user.id) };
  });

  app.post("/api/review/standards", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { name?: string; sourceText?: string; description?: string; dimensions?: unknown };
    if (!body?.name?.trim()) return reply.code(400).send({ error: "请填写标准名" });
    // 只取白名单字段: 原来 {...body} 会把 builtIn/isDefault 一起透传 —— 任何用户都能造一条
    //   "内置"标准, 被全站用户看到/选用/删除(实测可污染所有人的默认审稿维度)
    return await reviewService.createStandard({
      name: body.name.trim(), sourceText: body.sourceText, description: body.description,
      dimensions: body.dimensions, userId: user.id,
    });
  });

  app.put("/api/review/standards/:standardId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { standardId } = request.params as { standardId: string };
    const body = request.body as { name?: string; sourceText?: string; description?: string; dimensions?: unknown; isDefault?: boolean };
    const r = await reviewService.updateStandard(user.id, standardId, {
      name: body.name, sourceText: body.sourceText, description: body.description,
      dimensions: body.dimensions, isDefault: body.isDefault,
    });
    if (!r) return reply.code(404).send({ error: "标准不存在或无权限" });
    return { ok: true };
  });

  app.delete("/api/review/standards/:standardId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { standardId } = request.params as { standardId: string };
    const r = await reviewService.deleteStandard(user.id, standardId);
    if (!r) return reply.code(404).send({ error: "标准不存在或无权限" });
    return { ok: true };
  });

  app.post("/api/review/standards/:standardId/default", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { standardId } = request.params as { standardId: string };
    const body = request.body as { isDefault?: boolean };
    return await reviewService.setDefaultStandard(user.id, standardId, body?.isDefault ?? true);
  });

  app.post("/api/review/standards/parse", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { rawText?: string; text?: string };
    const raw = body?.rawText ?? body?.text;
    if (!raw?.trim()) return reply.code(400).send({ error: "请粘贴评分标准原文" });
    return await reviewService.parseStandardText(raw);
  });

  // ═══ SocialSci P0-4: 对话式科研绘图 Agent(迁移118) ═══
  app.post("/api/viz/sessions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { title?: string };
    return await vizAgent.createSession(user.id, body?.title ?? "未命名绘图会话");
  });

  app.get("/api/viz/sessions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { sessions: await vizAgent.listSessions(user.id) };
  });

  // 一轮对话(SSE: plan/model/thinking/tool/chart/critique/critique_fix/done)
  app.post("/api/viz/sessions/:sessionId/turns", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as { message?: string; csv?: string; columnOrder?: string[]; spec?: Record<string, unknown> };
    if (!body?.message?.trim()) return reply.code(400).send({ error: "请描述要画的图" });
    const sse = attachSse(reply);
    sse.send("viz.created", { sessionId });
    await vizAgent.runTurn(user.id, sessionId, body.message.trim(), sse, {
      csv: body.csv, columnOrder: body.columnOrder, spec: body.spec,
    });
    sse.end();
  });

  // D4(参考产品 VizView job 体系): 中长绘图任务 — 建 job(后台执行)→ SSE 观察(可断线重连重放)
  app.post("/api/viz/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as {
      sessionId?: string; message?: string; csv?: string; columnOrder?: string[]; spec?: Record<string, unknown>;
      fileId?: string; fileName?: string; journalConfig?: Record<string, unknown>;
    };
    if (!body?.sessionId || !body?.message?.trim()) return reply.code(400).send({ error: "需要 sessionId 与 message" });
    const vizJobService = await import("../services/viz-job-service.js");
    try {
      const r = await vizJobService.createVizJob(user.id, body.sessionId, body.message.trim(), {
        csv: body.csv, columnOrder: body.columnOrder, spec: body.spec,
        // 数据接入统一(2026-09-11): 前端上传发的 fileId 此前被丢弃 → 服务端按 fileId 取真实数据
        fileId: body.fileId, fileName: body.fileName,
        // 参考产品 VizView journalConfig(期刊/双栏/DPI/字号/配色) — 此前前端发了后端没用
        journalConfig: body.journalConfig,
      });
      return r;
    } catch (e) {
      const code = (e as { code?: string }).code;
      return reply.code((e as { status?: number }).status ?? 500).send({ error: code === "NOT_FOUND" ? "会话不存在" : String((e as Error).message) });
    }
  });
  // 可用作图表的已上传数据(数据源选择器)
  app.get("/api/viz/data-files", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const vizExec = await import("../services/viz-exec-service.js");
    return { files: await vizExec.listDataFiles(user.id) };
  });
  app.get("/api/viz/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const vizJobService = await import("../services/viz-job-service.js");
    const limit = Number((request.query as { limit?: string }).limit ?? 20);
    return { jobs: await vizJobService.listVizJobs(user.id, Math.min(limit, 100)) };
  });

  app.get("/api/viz/jobs/:jobId/dataset", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const vizJobService = await import("../services/viz-job-service.js");
    const ds = await vizJobService.getVizJobDataset(user.id, jobId, 200);
    if (!ds) return reply.code(404).send({ error: "任务不存在" });
    return ds;
  });
  app.get("/api/viz/jobs/:jobId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const vizJobService = await import("../services/viz-job-service.js");
    const job = await vizJobService.getVizJob(user.id, jobId);
    if (!job) return reply.code(404).send({ error: "任务不存在" });
    return { job };
  });
  app.get("/api/viz/jobs/:jobId/stream", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const q = request.query as { after?: string };
    const vizJobService = await import("../services/viz-job-service.js");
    const sse = attachSse(reply);
    try { await vizJobService.streamVizJob(user.id, jobId, sse, Number(q.after) || 0); }
    catch { sse.error({ code: "STREAM_FAILED", userMessage: "观察流失败", canRetry: true }); sse.end(); }
  });
  app.post("/api/viz/jobs/:jobId/cancel", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const vizJobService = await import("../services/viz-job-service.js");
    return { ok: await vizJobService.cancelVizJob(user.id, jobId) };
  });
  app.post("/api/viz/jobs/:jobId/retry", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const vizJobService = await import("../services/viz-job-service.js");
    const r = await vizJobService.retryVizJob(user.id, jobId);
    return r ?? reply.code(404).send({ error: "任务不存在或不可重试" });
  });

  app.get("/api/viz/sessions/:sessionId/messages", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sessionId } = request.params as { sessionId: string };
    const q = request.query as { limit?: string };
    return { messages: await vizAgent.listMessages(user.id, sessionId, Number(q.limit) || 100) };
  });

  app.get("/api/viz/sessions/:sessionId/artifacts", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sessionId } = request.params as { sessionId: string };
    return { artifacts: await vizAgent.listArtifacts(user.id, sessionId) };
  });

  // 我的全部绘图产物(跨会话, 最近优先) — 编辑器「辅助工具→图表」可直接插入工坊产出的图
  app.get("/api/viz/artifacts", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const r = await pool.query(
      `select a.id, a.session_id, a.png_path, a.svg_editable_path, a.version, a.prompt, a.created_at
         from viz_artifacts a join viz_sessions s on s.id=a.session_id
        where s.user_id=$1
        order by a.created_at desc limit 30`, [user.id]);
    return { artifacts: r.rows };
  });

  // 产物静态文件(路径形如 data/viz-files/{userId}/{hash}.png|svg)
  app.get("/api/viz/files/*", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const url = request.url; // /api/viz/files/data/viz-files/...
    const rel = url.replace(/^\/api\/viz\/files\//, "");
    // 归属校验 + 目录钉死都在 readVizFile 内完成(它只认 .../viz-files/<自己uid>/<单层文件名>)
    const buf = await vizExec.readVizFile(rel, user.id);
    if (!buf) return reply.code(404).send({ error: "文件不存在" });
    const isSvg = rel.endsWith(".svg");
    reply.header("Content-Type", isSvg ? "image/svg+xml" : "image/png");
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(buf);
  });

  // 产物 → 素材库(研究素材闭环)
  app.post("/api/viz/artifacts/:artifactId/to-materials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { artifactId } = request.params as { artifactId: string };
    const body = request.body as { projectId?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const r = await pool.query(
      `select * from viz_artifacts where id=$1 and user_id=$2`, [artifactId, user.id]);
    if (!r.rows.length) return reply.code(404).send({ error: "产物不存在" });
    const a = r.rows[0];
    const mid = randomUUID();
    await pool.query(
      `insert into research_materials
         (id, project_id, user_id, kind, title, content_md, source_ref, produced_by_dag_node, meta)
       values ($1,$2,$3,'figure',$4,$5,$6,'',$7)`,
      [mid, body.projectId, user.id,
       `${a.prompt?.slice(0, 40) || "科研图表"} (v${a.version})`,
       `![图表](/api/viz/files/${a.png_path})\n\nSVG 可编辑: /${a.svg_editable_path}`,
       artifactId, JSON.stringify({ vizArtifact: artifactId, version: a.version })]);
    return { id: mid };
  });

  // ═══ SocialSci P0-5: 学术文本编辑器(迁移119) ═══
  app.get("/api/editor/v1/documents", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    // R8a: 列表分页响应(HAR: GET /documents?page&page_size → items+pagination)
    const q = request.query as { page?: string; page_size?: string };
    const res = await editorService.listDocs(user.id, { page: Number(q.page) || 1, pageSize: Number(q.page_size) || 20 });
    return {
      data: {
        items: res.items,
        pagination: { total: res.total, page: res.page, page_size: res.pageSize },
      },
    };
  });

  app.post("/api/editor/v1/documents", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { title?: string; content?: string };
    const r = await editorService.createDoc(user.id, body?.title ?? "", body?.content ?? "");
    const doc = await editorService.getDoc(user.id, r.id);
    return reply.code(201).send(doc ?? { id: r.id });
  });

  app.get("/api/editor/v1/documents/:docId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    const doc = await editorService.getDoc(user.id, docId);
    if (!doc) return reply.code(404).send({ error: "文档不存在" });
    // 审查 P0-1A: 带出当前版本 content_hash(前端初始化乐观锁基准用)
    let contentHash = "";
    try {
      const hv = await pool.query(
        `select content_hash from doc2_versions where id=$1`, [doc.current_version_id]
      );
      contentHash = hv.rows[0]?.content_hash ?? "";
    } catch { /* hash 取不到不阻断 */ }
    return { document: { ...doc, content_hash: contentHash } };
  });

  app.put("/api/editor/v1/documents/:docId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    // A1(参考产品 content_hash 乐观锁): 前端带 expectedContentHash → 与当前版本 hash 对比,
    // 不一致 = 他窗口已改 → 409 冲突(前端提示刷新)
    const body = request.body as { title?: string; content?: string; tags?: string[]; expectedContentHash?: string };
    if (body.expectedContentHash && body.content !== undefined) {
      const cur = await pool.query(
        `select v.content_hash, v.content from doc2_versions v
           join documents_v2 d on d.current_version_id = v.id
          where d.id=$1 and d.user_id=$2`,
        [docId, user.id]
      );
      const curHash = cur.rows[0]?.content_hash ?? null;
      const curContent = String(cur.rows[0]?.content ?? "");
      if (curHash && curHash !== body.expectedContentHash && curContent !== body.content) {
        return reply.code(409).send({ error: "文档已在其他窗口被修改, 请刷新后继续", code: "DOC_CONFLICT" });
      }
    }
    // 审查 P0-1B: expectedContentHash 仅用于冲突检测, 不能进 saveDoc(表无此列 → 500)
    const { expectedContentHash: _ech, ...saveBody } = body;
    const r = await editorService.saveDoc(user.id, docId, saveBody as { title?: string; content?: string; tags?: string[] });
    if (!r) return reply.code(404).send({ error: "文档不存在" });
    return { ok: true, wordCount: r.word_count, currentVersion: r.currentVersion ?? null };
  });

  // R8c: 文档版本链(HAR: PUT 后 current_version_id 递增; 前端版本历史用)
  app.get("/api/editor/v1/documents/:docId/versions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    const owner = await pool.query(`select id from documents_v2 where id=$1 and user_id=$2`, [docId, user.id]);
    if (!owner.rows.length) return reply.code(404).send({ error: "文档不存在" });
    const r = await pool.query(
      `select version, content_hash, title, content_len, by_editor, created_at from doc2_versions
        where document_id=$1 order by version desc limit 50`, [docId]);
    // 沿用 items 这条链自己的线格式(api.listDocs 回的就是 items; 前端内联的参考产品契约也是
    //   {items,pagination}) —— 版本列表比文档列表更小, 不需要分页, 只带 items。
    // api.ts 的 q() 直接返回整个响应体(不像 axios 那样剥 data), 所以**不能再套一层信封**,
    //   否则前端拿到的是对象: `!versions.length` 恒 false 会渲染「暂无版本记录」的兄弟分支,
    //   而 v-for 会去遍历这个对象。
    const items = r.rows.map((row) => ({
      // 前端 :key / 恢复调用都用 id; 版本表的主键(参考产品版本列表同字段)
      id: String(row.version),
      version_num: row.version,
      created_at: row.created_at,
      word_count: row.content_len,
      title: row.title,
      content_hash: row.content_hash,
      by_editor: row.by_editor,
    }));
    return { items };
  });

  // Word 导入(docx 二进制 → HTML): 前端「导入 Word」的唯一落点。
  // 形态与 /paper-outline/export 对称(那边 HTML→docx 也是服务端做), 同为 base64 JSON、
  //   同受 bodyLimit 30MB 约束。用 mammoth 而非手写解包: docx 的 XML 关系与样式继承
  //   自己实现必然漏(且仓库早在依赖里就有这两个包, 只是一直零 import)。
  // 注意前端把返回值喂给 TipTap 的 setContent, **要的是 HTML 而不是 markdown**。
  app.post("/api/editor/v1/documents/import", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { filename?: string; base64?: string };
    const b64 = String(body?.base64 ?? "").replace(/^data:[^;]+;base64,/, "");
    if (!b64) return reply.code(400).send({ error: "缺少 base64" });
    let buf: Buffer;
    try { buf = Buffer.from(b64, "base64"); } catch { return reply.code(400).send({ error: "base64 无法解码" }); }
    if (!buf.length) return reply.code(400).send({ error: "文件内容为空" });
    // 旧版 .doc 是 OLE 复合文档, mammoth 只吃 OOXML —— 明确拒绝, 别让它抛一句看不懂的错
    if (buf.subarray(0, 4).toString("hex") === "d0cf11e0") {
      return reply.code(400).send({ error: "暂不支持旧版 .doc, 请先另存为 .docx" });
    }
    try {
      const mammoth = (await import("mammoth")) as unknown as {
        convertToHtml: (o: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
      };
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      const filename = String(body?.filename ?? "");
      // 标题: 文件名兜底(参考产品同口径); 前端另有 .docx 后缀剥离
      const title = filename.replace(/\.docx?$/i, "") || "导入文档";
      return { html: value, title };
    } catch (e) {
      request.log.error({ err: e }, "docx 解析失败");
      return reply.code(400).send({ error: "Word 文件解析失败(可能已损坏或非 .docx)" });
    }
  });

  // 版本回档(取历史 content 写回 + 新版本行; 编辑器"版本历史"面板用)
  app.post("/api/editor/v1/documents/:docId/restore", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    const body = request.body as { version?: number };
    if (!body?.version) return reply.code(400).send({ error: "缺少 version" });
    const r = await editorService.restoreDocVersion(user.id, docId, Number(body.version));
    if (!r) return reply.code(404).send({ error: "文档或版本不存在" });
    return { ok: true, ...r };
  });

  app.delete("/api/editor/v1/documents/:docId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    const r = await editorService.deleteDoc(user.id, docId);
    if (!r) return reply.code(404).send({ error: "文档不存在" });
    return { ok: true };
  });

  // 文档锁(编辑会话; 超5分钟自动释放)
  app.post("/api/editor/v1/documents/:docId/lock", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    return await editorService.lockDoc(user.id, docId);
  });
  app.post("/api/editor/v1/documents/:docId/unlock", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { docId } = request.params as { docId: string };
    return await editorService.unlockDoc(user.id, docId);
  });

  // R6(参考产品 Editor AI job 契约): 统一 AI job + SSE + cancel/retry
  app.post("/api/editor/v1/ai/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { action?: string; text?: string; mode?: string; context?: string; document_id?: string; model?: string };
    // createAiJob 抛错: 并发超限 → 429; 积分不足 → 402
    let job: Awaited<ReturnType<typeof aiJobService.createAiJob>>;
    try {
      job = await aiJobService.createAiJob(user.id, body);
    } catch (e) {
      if (e instanceof InsufficientPointsError) {
        return reply.code(402).send({ error: e.message, code: "INSUFFICIENT_POINTS", needPoints: e.needPoints });
      }
      return reply.code(429).send({ error: (e as Error).message });
    }
    if (!job) return reply.code(400).send({ error: "action 需为 rewrite/check/title/format_refs" });
    return { job_id: job.id, model: job.model, pointsCost: job.points?.cost ?? 0 };
  });

  /**
   * 角色→模型映射落库(agent_settings.llm_roles)
   * 此前 setRoleModel 只写内存, 服务重启即回默认值 — 与同面板"格式预设存 localStorage"两套标准
   */
  async function saveModelSelection(): Promise<void> {
    try {
      const { setAgentSetting } = await import("../services/agent-settings.js");
      await setAgentSetting("llm_roles", { modelMap: getRoleModelMap(), editorSet: isEditorModelSet() });
    } catch { /* 持久化失败不影响本次切换 */ }
  }

  // 编辑器 AI 模型: 读/切「学术写作」角色模型(独立于推理链 reason 角色, 互不影响)
  // 2026-09-10: 只返回 provider 密钥已配置的模型 — 未配置的选了必然报错, 不该出现在下拉里
  app.get("/api/editor/v1/ai/model", async () => {
    const usable = LLM_MODEL_REGISTRY.filter((m) => isModelUsable(m.id));
    return {
      current: getRoleModel("editor"),
      roleMap: getRoleModelMap(),
      models: usable,
      // 全量注册表(含不可用), 前端可提示"配了密钥才能选"
      allModels: LLM_MODEL_REGISTRY.map((m) => ({
        ...m,
        usable: isModelUsable(m.id),
        keyEnv: getProviderEndpoint(m.provider).keyEnv,
      })),
    };
  });
  app.put("/api/editor/v1/ai/model", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { modelId?: string };
    if (!body?.modelId) return reply.code(400).send({ error: "modelId 必填" });
    // 校验模型存在且 provider 已配置 — 否则切换会把编辑器 AI 切到一个必然失败的组合
    if (!findModelOption(body.modelId)) {
      return reply.code(400).send({ error: `未知模型: ${body.modelId}` });
    }
    const opt = findModelOption(body.modelId)!;
    if (!isModelUsable(body.modelId)) {
      return reply.code(400).send({
        error: `${opt.label} 的密钥未配置(${getProviderEndpoint(opt.provider).keyEnv}), 无法使用`,
      });
    }
    setRoleModel("editor", body.modelId);
    await saveModelSelection();
    return { ok: true, current: getRoleModel("editor") };
  });
  app.get("/api/editor/v1/ai/jobs/:jobId/stream", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const sse = attachSse(reply);
    try { await aiJobService.streamAiJob(user.id, jobId, sse); }
    catch { sse.error({ code: "STREAM_FAILED", userMessage: "流式连接失败", canRetry: true }); sse.end(); }
  });
  app.post("/api/editor/v1/ai/jobs/:jobId/cancel", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    return { ok: aiJobService.cancelAiJob(user.id, jobId) };
  });
  app.post("/api/editor/v1/ai/jobs/:jobId/retry", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    try {
      const j = await aiJobService.retryAiJob(user.id, jobId);
      return j ? { job_id: j.id, pointsCost: j.points?.cost ?? 0 } : reply.code(404).send({ error: "任务不存在或不可重试" });
    } catch (e) {
      if (e instanceof InsufficientPointsError) {
        return reply.code(402).send({ error: e.message, code: "INSUFFICIENT_POINTS", needPoints: e.needPoints });
      }
      throw e;
    }
  });

  // 选区改写 5 模式 + humanize
  app.post("/api/editor/v1/rewrite", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { mode?: string; text?: string };
    const modes = ["condense", "de-template", "polish", "proofread", "journal-style", "humanize", "expand"];
    if (!modes.includes(body?.mode ?? "")) return reply.code(400).send({ error: `mode 需为 ${modes.join("/")}` });
    if (!body?.text?.trim()) return reply.code(400).send({ error: "缺少选中文本" });
    return await editorService.rewriteText(body.mode as never, body.text);
  });

  // UI审计T9: 引文格式规范化(GB/T7714)
  app.post("/api/editor/v1/format-references", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string };
    if (!body?.text?.trim()) return reply.code(400).send({ error: "缺少文本" });
    return await editorService.formatReferences(body.text);
  });

  // UI审计T5: 标题摘要关键词生成
  app.post("/api/editor/v1/title-abstract", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string };
    if (!body?.text?.trim()) return reply.code(400).send({ error: "缺少全文" });
    return await editorService.generateTitleAbstract(body.text);
  });

  // 全文检查(诚实性: 不验证文献真实性; P-C 按 mode 分支 4 检查模式)
  app.post("/api/editor/v1/check-fulltext", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string; mode?: string };
    if (!body?.text?.trim()) return reply.code(400).send({ error: "缺少全文" });
    return await editorService.checkFulltext(body.text, body.mode);
  });

  // 图表代码(LLM 出图代码 → 复用 viz runner 渲染)
  // UI审计T11: 支持真实数据(实证工作台/统计结果/粘贴 CSV) + 列名与样本进 prompt(防 LLM 猜列名 KeyError)
  app.post("/api/editor/v1/chart-code", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { description?: string; csv?: string; columnOrder?: string[]; chart_type?: string };
    if (!body?.description?.trim()) return reply.code(400).send({ error: "请描述图表需求" });
    const ep = getLlmEndpoint({ model: getRoleModel("reason") });
    // 数据未提供 → 明示无数据(禁止 LLM 写 pd.read_csv), 避免 FileNotFoundError
    const csvText = String(body.csv ?? "").trim();
    const cols = Array.isArray(body.columnOrder) ? body.columnOrder.filter(Boolean) : [];
    const dataBlock = csvText && cols.length
      ? `【数据列名(必须原样使用, 不得改写或翻译)】${cols.join(", ")}
【数据前几行样例(仅用于理解列含义, 不要在代码里硬编码这些值)】
${csvText.split(/\r?\n/).slice(0, 6).join("\n")}
【数据规模】共 ${Math.max(0, csvText.split(/\r?\n/).filter((l) => l.trim()).length - 1)} 行

【运行环境(严格遵守, 否则报错)】
代码运行时 df 与 ax 已由宿主准备好, 不要重新创建:
  - 不要 import matplotlib.pyplot / pandas, 不要 plt.subplots(), 不要 pd.read_csv()
  - 绝对不要给 DATA_CSV 赋值(宿主已注入正确路径, 覆盖它会导致找不到文件)
  - 直接用 df 取列(如 df['${cols[1] ?? cols[0]}']), 用 ax 画图(ax.bar / ax.plot / ax.scatter ...)
  - 中文字符串直接写在标签/图例里(python 字符串), 列名保持英文原样`
      : `【数据】本次无数据文件 —— 不要写 pd.read_csv, 也不要引用 df。
宿主已准备好 ax, 请直接用 ax 画图, 数值用示例数据(自拟并在标签中标注为"示意")。`;
    const chartType = String(body.chart_type ?? "echarts_bar");
    const typeHint = chartType.startsWith("mermaid")
      ? `图表形式: ${chartType === "mermaid_mindmap" ? "思维导图" : "流程图"}(用 graph TD / mindmap 语法, 本类型不需要数据)`
      : `图表形式: matplotlib 代码(用户选的类型 ${chartType} 仅作参考, 以需求描述为准)`;
    const res = await fetchLlm({
      url: ep.url, key: ep.key, model: ep.model,
      messages: [{ role: "user", content: `你是科研绘图专家。按需求生成绘图代码, 输出 JSON:{"code":"...","title":"图表标题"}

${typeHint}
${dataBlock}

需求: ${body.description?.slice(0, 800)}` }],
      temperature: 0.4, maxTokens: 4000, timeoutMs: 240_000,
    });
    const text = res?.text ?? "";
    let code = "";
    try {
      const j = JSON.parse(text.replace(/```json|```/g, "").trim());
      code = String(j?.code ?? "");
    } catch { /* 解析失败 */ }
    if (!code) return reply.code(422).send({ error: "AI 未能生成代码" });
    // 积分闸门(2026-09-11): 出图是功能级消费 → 冻结 → 渲染 → 成功核销 / 失败归还。
    //   mermaid 分支与下面的 renderChart 都要覆盖, 故整体包在 withPoints 里(用 job 侧同一个
    //   key 空间: refId 用本次请求的随机 id, 便于与退还对账)。
    const refId = randomUUID();
    try {
      return await withPoints(user.id, "viz:chart", refId, async () => {
        // mermaid 类型是前端直接渲染的图代码, 不走 matplotlib runner
        if (chartType.startsWith("mermaid")) {
          return { code, chartType, dataUsed: false };
        }
        const rendered = await vizExec.renderChart(user.id, code, csvText || undefined, csvText ? cols : []);
        if (!rendered.ok) throw new Error(rendered.error ?? "渲染失败");
        return { code, chartType, dataUsed: Boolean(csvText && cols.length), ...rendered };
      });
    } catch (e) {
      if (e instanceof InsufficientPointsError) {
        return reply.code(402).send({ error: e.message, code: "INSUFFICIENT_POINTS", needPoints: e.needPoints });
      }
      // 渲染失败: 积分已归还, 保持原有 422 语义
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  // ═══ SocialSci P0-5: 数据自动 profiling(上传即剖析, 复用 viz analyzeData) ═══
  app.post("/api/empirical/profile", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { csv?: string; columnOrder?: string[]; fileName?: string };
    if (!body?.csv?.trim() || !body?.columnOrder?.length) return reply.code(400).send({ error: "需提供 CSV 文本与列名" });
    const ana = await vizExec.analyzeData(user.id, body.csv, body.columnOrder);
    if (!ana.ok) return reply.code(422).send({ error: ana.error ?? "分析失败" });
    return {
      profile: {
        fileName: body.fileName ?? "data.csv",
        summary: ana.summary ?? "",
        rowCount: 0, // 前端按 csv 行数算
        columns: ana.columns ?? [],
      },
    };
  });

  // ═══ SocialSci P0-8: 积分商业化 + 微信扫码登录(迁移120) ═══
  // ── 积分(用户侧) ──
  // 2026-10-02: 对话里的 @ 引用来源(工作区素材 / 上传文件 / 文献库)
  app.get("/api/agent/mentionables", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { q?: string; kind?: string; limit?: string };
    const { listMentionables } = await import("../services/mention-service.js");
    return {
      items: await listMentionables(user.id, {
        query: q.q,
        kind: (q.kind as any) || undefined,
        limit: parseInt(q.limit || "12", 10),
      }),
    };
  });

  // 2026-10-02: 邀请 —— 生成/查看专属邀请码、邀请人数、累计奖励
  app.get("/api/points/invite", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { inviteService } = await import("../services/invite-service.js");
    return await inviteService.getInviteSummary(user.id);
  });
  app.get("/api/points/me", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { success: true, data: await pointsService.getPoints(user.id) };
  });
  app.post("/api/points/checkin", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const r = await pointsService.checkin(user.id);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { success: true, data: r };
  });
  app.post("/api/points/redeem", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { code?: string };
    if (!body?.code?.trim()) return reply.code(400).send({ error: "缺少兑换码" });
    const r = await pointsService.redeemCode(user.id, body.code);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { success: true, data: r };
  });
  // 消费冻结/核销(供业务模块接入: 章节生成/审稿/绘图等)
  app.post("/api/points/freeze", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { cost?: number; refType?: string; refId?: string };
    if (!body?.cost) return reply.code(400).send({ error: "缺少 cost" });
    const r = await pointsService.freezeCharge(user.id, body.cost, body.refType ?? "misc", body.refId ?? "");
    if (!r.ok) return reply.code(402).send({ error: "积分不足", needPoints: (r as { needPoints?: number }).needPoints });
    return { success: true };
  });
  app.post("/api/points/settle", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { cost?: number; refType?: string; refId?: string };
    if (!body?.cost) return reply.code(400).send({ error: "缺少 cost" });
    const r = await pointsService.settleCharge(user.id, body.cost, body.refType ?? "misc", body.refId ?? "");
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { success: true };
  });
  app.post("/api/points/rollback", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { cost?: number; refType?: string; refId?: string };
    if (!body?.cost) return reply.code(400).send({ error: "缺少 cost" });
    return { success: true, ...(await pointsService.rollbackFreeze(user.id, body.cost, body.refType ?? "misc", body.refId ?? "")) };
  });

  // ── 积分(管理侧) ──
  app.get("/api/admin/points/transactions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const q = request.query as { limit?: string };
    return { transactions: await pointsService.listTransactions(Number(q.limit) || 100) };
  });
  app.post("/api/admin/points/adjust", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const body = request.body as { userId?: string; delta?: number; note?: string };
    if (!body?.userId || !body?.delta) return reply.code(400).send({ error: "缺少 userId/delta" });
    return { success: true, ...(await pointsService.adminAdjust(user.id, body.userId, body.delta, body.note ?? "")) };
  });
  app.get("/api/admin/points/batches", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    return { batches: await pointsService.listRedeemBatches() };
  });
  app.post("/api/admin/points/batches", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const body = request.body as { prefix?: string; count?: number; pointsEach?: number };
    if (!body?.prefix || !body?.count || !body?.pointsEach) return reply.code(400).send({ error: "缺少 prefix/count/pointsEach" });
    return { success: true, ...(await pointsService.createRedeemBatch(user.id, body.prefix, body.count, body.pointsEach)) };
  });
  app.get("/api/admin/points/reconcile", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const q = request.query as { userId?: string };
    return { success: true, ...(await pointsService.reconcile(q.userId)) };
  });

  // ── 微信扫码登录 ──
  app.get("/api/admin/wechat/config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    return await wechatAuth.getMpConfig(true);
  });
  app.post("/api/admin/wechat/config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const body = request.body as { appId?: string; appSecret?: string; baseUrl?: string; enabled?: boolean };
    return await wechatAuth.setConfig({
      appId: body.appId ?? "", appSecret: body.appSecret ?? "",
      baseUrl: body.baseUrl ?? "", enabled: body.enabled ?? false,
    });
  });
  // 登录页/配置态(免登录可用以判断是否展示微信扫码)
  app.get("/api/auth/wechat/config", async (_request, reply) => {
    return await wechatAuth.getMpConfig(false);
  });
  app.post("/api/auth/wechat/qr", async (request, reply) => {
    // 生成扫码 ticket(登录场景, 免登录)
    const cfg = await wechatAuth.getMpConfig(false);
    return { success: true, data: await wechatAuth.createQrTicket(), config: cfg };
  });
  app.get("/api/auth/wechat/status", async (request, reply) => {
    const q = request.query as { ticket?: string };
    if (!q?.ticket) return reply.code(400).send({ error: "缺少 ticket" });
    return { success: true, data: await wechatAuth.pollStatus(q.ticket) };
  });
  // mock 扫码(演示模式)
  app.post("/api/auth/wechat/mock-scan", async (request, reply) => {
    const body = request.body as { ticket?: string };
    if (!body?.ticket) return reply.code(400).send({ error: "缺少 ticket" });
    const r = await wechatAuth.mockScan(body.ticket);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { success: true };
  });
  // 扫码后绑定(已有账号=登录态; 免注册=新号)
  app.post("/api/auth/wechat/bind", async (request, reply) => {
    const body = request.body as { ticket?: string; mode?: "existing" | "new"; nickname?: string };
    if (!body?.ticket) return reply.code(400).send({ error: "缺少 ticket" });
    if (body.mode === "new") {
      const r = await wechatAuth.bindNewUser(body.ticket, body.nickname);
      if (!r.ok) return reply.code(422).send({ error: r.error });
      // 签发 JWT(同登录)
      const u = r.user as { id: string; role: string; tenant_id: string };
      const token = authService.issueToken(u.id, u.role ?? "user", u.tenant_id);
      return { success: true, token, user: { id: u.id, role: u.role ?? "user" } };
    }
    // 既有账号绑定: 需登录态
    const user = await requireUser(request, reply); if (!user) return;
    const rb = await wechatAuth.bindExisting(body.ticket, user.id, body.nickname);
    if (!rb.ok) return reply.code(422).send({ error: rb.error });
    return { success: true };
  });
  app.get("/api/auth/wechat/bound", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { success: true, data: await wechatAuth.getBoundWechat(user.id) };
  });

  // ═══ SocialSci P1: 管理后台补齐(OpenAI-key库/配置原子保存/ai-usage) ═══
  // 存储: ai_provider_settings.metadata(jsonb) — { openaiKeys:[{id,name,key}], appConfig:{...} }
  app.get("/api/admin/keys", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const r = await pool.query(`select metadata->'openaiKeys' as keys from ai_provider_settings where id='global'`);
    const keys = r.rows[0]?.keys ?? [];
    // 脱敏: 只留尾4位
    return { keys: (keys as Array<{ id: string; name: string; key: string }>).map((k) => ({
      id: k.id, name: k.name, keyMasked: `••••${k.key.slice(-4)}`,
    })) };
  });
  app.post("/api/admin/keys", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const body = request.body as { name?: string; key?: string };
    if (!body?.name?.trim() || !body?.key?.trim()) return reply.code(400).send({ error: "缺少 name/key" });
    await pool.query(
      `update ai_provider_settings
        set metadata = jsonb_set(coalesce(metadata,'{}'), '{openaiKeys}',
             coalesce(metadata->'openaiKeys','[]') || $1::jsonb)
       where id='global'`,
      [JSON.stringify([{ id: randomUUID(), name: body.name.trim(), key: body.key.trim() }])]);
    return { ok: true };
  });
  app.delete("/api/admin/keys/:keyId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const { keyId } = request.params as { keyId: string };
    await pool.query(
      `update ai_provider_settings
        set metadata = jsonb_set(coalesce(metadata,'{}'), '{openaiKeys}',
             coalesce((select jsonb_agg(k) from jsonb_array_elements(coalesce(metadata->'openaiKeys','[]')) k where k->>'id' <> $1),'[]'))
       where id='global'`, [keyId]);
    return { ok: true };
  });
  // 配置原子保存(整包替换 appConfig, 单事务天然原子)
  app.get("/api/admin/config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const r = await pool.query(`select metadata->'appConfig' as config from ai_provider_settings where id='global'`);
    return { config: r.rows[0]?.config ?? {} };
  });
  app.put("/api/admin/config", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const body = request.body as { config?: Record<string, unknown> };
    if (!body?.config) return reply.code(400).send({ error: "缺少 config" });
    await pool.query(
      `update ai_provider_settings set metadata = jsonb_set(coalesce(metadata,'{}'), '{appConfig}', $1) where id='global'`,
      [JSON.stringify(body.config)]);
    return { ok: true, config: body.config };
  });
  // ai-usage 看板(全站用量: 调用/积分/token 汇总; 数据跨 user_usage_log/points_usage_daily)
  app.get("/api/admin/ai-usage", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    const q = request.query as { days?: string };
    const days = Math.min(30, Math.max(1, Number(q.days) || 7));
    const r = await pool.query(
      `select date, count(*) as calls,
              coalesce(sum(cost),0) as points_cost,
              count(distinct user_id) as active_users
         from points_usage_daily
        where date >= current_date - ($1::int - 1)
        group by date order by date desc`, [days]);
    return { usage: r.rows };
  });

  // ═══ SocialSci Vue M3: 统计分析 17 法 jobs 全契约(参考产品 decoded-stats-viz §1.5) ═══
  // POST /api/statistics-jobs {tool,fileId,variables,...} → {job:{id,status}}
  // GET /api/statistics-jobs?limit=N → {jobs:[...]}; GET /:id → {job}
  // POST /:id/cancel|retry; GET /:id/stream → SSE(事件 stats.completed/failed/cancelled + job.snapshot)
  app.get("/api/statistics/health", async () => {
    // 参考产品 StatisticsView 徽标轮询(health check); python venv 状态一并回
    let venvReady = false;
    try {
      const { getEmpiricalMeta } = await import("../services/empirical-service.js");
      const meta = await getEmpiricalMeta();
      venvReady = meta.venvReady && meta.statsModels;
    } catch { /* 降级 */ }
    return { ok: true, service: "FlowMaster v5 统计分析后端", venvReady };
  });

  app.post("/api/statistics-jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const job = svc.createStatsJob(user.id, (request.body ?? {}) as Record<string, unknown>);
    if (!job) return reply.code(400).send({ error: "任务创建失败" });
    return { job: { id: job.id, status: job.status, tool: job.tool } };
  });

  // 统计任务的历史回查: 内存只保留本次进程的任务, 重启后必须落库查(此前只读内存 → 历史列表恒空)
  app.get("/api/statistics-jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    // 上界 100: limit=1e9 会让 PG 全表扫, 上限与 /api/review/jobs 同一口径
    const limit = Math.min(Math.max(1, Number((request.query as { limit?: string }).limit ?? 30)), 100);
    const list = await svc.listStatsJobsAsync(user.id, limit);
    return { jobs: list.map((j) => ({
      id: j.id, tool: j.tool, method: j.tool, status: j.status,
      created_at: new Date(j.createdAt).toISOString(),
      source_task_id: j.sourceTaskId ?? null,
      stage: j.stage ?? null
    })) };
  });

  app.get("/api/statistics-jobs/:jobId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const j = await svc.getStatsJobAsync(user.id, jobId);
    if (!j) return reply.code(404).send({ error: "任务不存在" });
    return { job: {
      id: j.id, tool: j.tool, status: j.status,
      result: j.result, result_version_id: j.resultVersionId,
      error: j.error ?? undefined, sourceTaskId: j.sourceTaskId,
      stage: j.stage ?? null
    } };
  });

  /**
   * 「本课题跑过的分析」—— 写作舱 ↔ 统计台之间**唯一**的连接点。
   *
   * 连接规则(全仓仅此一处, 见源由): 写作舱快照里的 `statisticsFileId`(形如 `file_<uuid>`)
   *   → `stats_jobs.input->>'fileId'`(同一个串) → 这次分析就是在这个课题的数据上跑的。
   *   索引见 migrations/153_stats_file_index.sql。
   *
   * ⚠ 前缀两侧都要归一: 快照里存的是**带 `file_` 前缀**的串(server.ts 上传路由返回的就是它),
   *   而 statistics-job-service 取数据前会 `replace(/^file_/,"")`。所以这里两种写法都查一次,
   *   否则会出现"明明跑过分析却一条都列不出来"这种查半天查不出的静默空。
   *
   * 只返回表格元信息, 不带完整 result —— 列表可能几十条, 把每个 job 的 tables/charts 全带上
   *   响应会很大; 真正要插入时再按 jobId 取那一条。
   */
  app.get("/api/research/projects/:projectId/analyses", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const snap = await pool.query<{ workbench_snapshot: Record<string, unknown> | null }>(
      `select workbench_snapshot from research_projects where id=$1 and user_id=$2`, [projectId, user.id]);
    if (!snap.rows.length) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "课题不存在" } });
    const rawId = String((snap.rows[0].workbench_snapshot ?? {}).statisticsFileId ?? "").trim();
    if (!rawId) return { analyses: [], statisticsFileId: "", reason: "本课题还没有上传数据文件" };
    const bare = rawId.replace(/^file_/, "");
    const r = await pool.query<{ id: string; tool: string; status: string; created_at: string; has_table: boolean }>(
      `select id, tool, status, created_at,
              (jsonb_typeof(result -> 'tables') = 'array' and jsonb_array_length(result -> 'tables') > 0) as has_table
         from stats_jobs
        where user_id = $1 and input ->> 'fileId' in ($2, $3)
        order by created_at desc
        limit 50`,
      [user.id, rawId, bare]);
    return {
      statisticsFileId: rawId,
      analyses: r.rows.map((row) => ({
        id: row.id,
        tool: row.tool,
        status: row.status,
        createdAt: row.created_at,
        /** 有没有可直接插入的表格 —— 前端只给"可插入"的显示按钮, 免得点了才报错 */
        hasTable: row.has_table,
      })),
    };
  });

  /**
   * 分析结果 → 写作舱素材(「把回归表写进正文」的数据通道)。
   *
   * 由来(2026-09-24): 写作舱第 3 步可以跳去「数据分析」跑回归, 但结果是**回不来的** ——
   *   两边根本不在一个 id 空间里: 写作舱用 `research_projects.id`, 统计台的结果按 `user_id`
   *   存在 stats_jobs 里, **没有任何一列把它们连起来**(全仓 grep `research_project_id` 零命中)。
   *   于是用户只能看着结果手动抄进正文。
   *
   * 这里补的就是那座桥 —— 与 `POST /api/viz/artifacts/:id/to-materials` 同一形态
   *   (产物 → research_materials), 只是产物类型从图表换成统计表。
   *
   * 为什么走 materials 而不是直接写章节:
   *   ① 素材是写作舱既有的、已接好的通道 —— `research_materials.kind='table'` + `tableData`
   *      在 MaterialsView/WorkspaceView 里本来就渲染成真表格;
   *   ② 出稿后再改章节正文是不可逆的, 而素材可以删、可以改、可以自己选在哪一章用。
   *      (`sectionIds` 直接带上用户选的那一章, 省得他再挂一次。)
   *
   * 表格取值刻意保守: 只取 `result.tables[0]`, 且必须是 `{columns[], rows[][]}` 的形状 ——
   *   不同统计工具的 result 结构差别很大, 猜错了会把一张乱表插进论文里, 比不插更糟。
   *   取不到就 400 说清楚, 前端据此提示"这个结果没有可插入的表格, 请用截图/图表通道"。
   */
  const statsToMaterialSchema = z.object({
    projectId: z.string().min(1),
    sectionId: z.string().max(128).optional(),
  });
  app.post("/api/statistics-jobs/:jobId/to-materials", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const parsed = statsToMaterialSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "缺少 projectId" } });
    const { projectId, sectionId } = parsed.data;
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const job = await svc.getStatsJobAsync(user.id, jobId);
    if (!job) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "统计任务不存在" } });

    const tables = (job.result as { tables?: unknown } | undefined)?.tables;
    const first = Array.isArray(tables) ? (tables[0] as Record<string, unknown> | undefined) : undefined;
    const columns = first && Array.isArray(first.columns) ? (first.columns as unknown[]) : null;
    const rows = first && Array.isArray(first.rows) ? (first.rows as unknown[]) : null;
    if (!columns || !rows) {
      return reply.code(400).send({
        error: {
          code: "NO_TABLE",
          message: "该分析结果里没有可直接插入的统计表 —— 图表类结果请用「科研绘图」的插图通道",
        },
      });
    }

    const title = String((first as { title?: unknown }).title ?? "").trim()
      || String((job as { tool?: string }).tool ?? "统计分析") + "结果表";
    const mid = randomUUID();
    await pool.query(
      `insert into research_materials
         (id, project_id, user_id, kind, title, content_md, table_data, section_ids, source_ref, meta)
       values ($1,$2,$3,'table',$4,$5,$6,$7,$8,$9)`,
      [
        mid, projectId, user.id, title, "",
        JSON.stringify({ columns, rows }),
        JSON.stringify(sectionId ? [sectionId] : []),
        jobId,
        JSON.stringify({ fromStatsJob: jobId, tool: (job as { tool?: string }).tool ?? null }),
      ]);
    return { id: mid, title, columns: columns.length, rows: rows.length };
  });

  /**
   * 任务 → 原始数据集回查(图表 tab「已保存的统计结果」与「送工坊精修」共用)
   * 数据真源: 任务 input.fileId 指向的 user_files
   * rows 默认 200(代理画图够用), 传 rows=5000 可拉全量用于工坊精修; 上限 20000 防超大响应
   * fileId 为空(粘贴/仿真数据临时上传)或文件已删 → 404 + 明确原因, 前端据此提示而不是静默按无数据出图
   */
  app.get("/api/statistics-jobs/:jobId/dataset", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const want = Number((request.query as { rows?: string }).rows);
    const limit = Number.isFinite(want) && want > 0 ? Math.min(want, 20_000) : 200;
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const ds = await svc.getStatsJobDataset(user.id, jobId);
    if (!ds) return reply.code(404).send({ error: "该任务的原始数据集已不可用(粘贴/仿真数据不落文件, 或文件已被删除)" });
    const job = await svc.getStatsJobAsync(user.id, jobId);
    // 两种形状都给(合并 2026-09-11): 两个前端各读各的, 只给一种就得改另一处调用点。
    //   · 顶层 columnOrder/rows/totalRows/fileId —— viz 数据源选择器(要 fileId 走"只传 id 服务端取数")
    //   · dataset 包裹(含 title/sampleRows/truncated) —— 编辑器 AIPanel 与实证面板 UnifiedWorkspace
    return {
      columnOrder: ds.columnOrder,
      rows: ds.rows.slice(0, limit),
      totalRows: ds.rows.length,
      fileName: ds.fileName,
      fileId: ds.fileId,
      dataset: {
        jobId,
        title: job ? `${job.tool} 分析结果` : "统计分析结果",
        fileName: ds.fileName || "分析数据",
        columnOrder: ds.columnOrder,
        rowCount: ds.rows.length,
        truncated: ds.rows.length > limit,
        sampleRows: ds.rows.slice(0, limit),
      },
    };
  });

  app.post("/api/statistics-jobs/:jobId/cancel", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const j = await svc.cancelStatsJob(user.id, jobId);
    if (!j) return reply.code(404).send({ error: "任务不存在" });
    return { job: { id: j.id, status: j.status } };
  });

  app.post("/api/statistics-jobs/:jobId/retry", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const j = await svc.retryStatsJob(user.id, jobId);
    if (!j) return reply.code(404).send({ error: "任务不存在" });
    return { job: { id: j.id, status: j.status } };
  });

  // 任务执行 SSE(参考产品: 可恢复事件流; 完成前挂起等待 → 完成后推送 stats.completed)
  app.get("/api/statistics-jobs/:jobId/stream", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { jobId } = request.params as { jobId: string };
    const { statsJobService: svc } = await import("../services/statistics-job-service.js");
    const { attachSse } = await import("./stream-utils.js");
    // 必须走 DB 回查: 内存 Map 在服务重启/多副本下查不到 → 直接 404"任务不存在"
    const j = await svc.getStatsJobAsync(user.id, jobId);
    if (!j) return reply.code(404).send({ error: "任务不存在" });
    const sse = attachSse(reply);
    // 已终态直接回放
    if (["completed", "failed", "cancelled"].includes(j.status)) {
      if (j.status === "completed") sse.send("stats.completed", { result: j.result, result_version_id: j.resultVersionId });
      else if (j.status === "failed") sse.send("stats.failed", { error: j.error });
      else sse.send("stats.cancelled", {});
      sse.end();
      return;
    }
    // 轮询等待终态(上限 5 分钟)
    const started = Date.now();
    const POLL_TTL = 300_000;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;                       // 上一轮 DB 查询未回来时跳过, 防叠加
      polling = true;
      let cur: Awaited<ReturnType<typeof svc.getStatsJobAsync>> = null;
      try { cur = await svc.getStatsJobAsync(user.id, jobId); } catch { /* 查询失败按未终态继续等 */ }
      polling = false;
      if (!cur || ["completed", "failed", "cancelled"].includes(cur.status ?? "") || Date.now() - started > POLL_TTL) {
        clearInterval(timer);
        if (cur?.status === "completed") sse.send("stats.completed", { result: cur.result, result_version_id: cur.resultVersionId });
        else if (cur?.status === "failed") sse.send("stats.failed", { error: cur.error });
        else if (cur?.status === "cancelled") sse.send("stats.cancelled", {});
        else sse.send("stats.failed", { error: { code: "TIMEOUT", message: "分析超时" } });
        sse.end();
      } else if (cur) {
        sse.send("job.snapshot", { status: cur.status, tool: cur.tool, stage: cur.stage ?? null });
      }
    }, 900);
    request.raw.on("close", () => clearInterval(timer));
  });

  // 注(2026-09-11): 原先此处有 4 条 stats_artifacts 路由。经核实**全仓零调用者**(POST 是唯一写入者,
  //   要求前端传 pngBase64, 而没有任何前端调用它) → 表恒 0 行, 其余 3 条都依赖它产出的行, 故整组移除。
  //   统计图的可用路径: ①「送工坊精修」把原始数据交给 viz 画真 PNG/SVG ②工坊产物 → /api/viz/artifacts/:id/to-materials。
  //   表由迁移 134_drop_stats_artifacts.sql 删除(同批处理)。

  // ═══ UI审计T7: 参考文献批量解析(GB/T7714 正则拆条目→人工核对) ═══
  app.post("/api/research/references/parse", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { rawText?: string };
    if (!body?.rawText?.trim()) return reply.code(400).send({ error: "缺少 rawText" });
    const items = researchMaterials.parseReferences(body.rawText);
    return { ok: true, items, validCount: items.filter((i) => i.valid).length, total: items.length };
  });

  // ═══ SocialSci 补漏组2: 素材深层操作(AI生成/来源文献/采纳/跨任务工件) ═══
  // 素材来源文献(引文摘要)
  app.get("/api/research/materials/:materialId/sources", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const r = await researchMaterials.getMaterialSources(user.id, materialId);
    if (!r) return reply.code(404).send({ error: "素材不存在" });
    return { sources: r.sources, sourceRef: r.sourceRef };
  });
  app.post("/api/research/materials/:materialId/sources", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const body = request.body as { doc?: unknown };
    const r = await researchMaterials.addMaterialSource(user.id, materialId, body?.doc as never);
    if (!r) return reply.code(404).send({ error: "素材不存在" });
    return { ok: true };
  });

  // AI 生成素材(HAR: material/generate 语义: 按目标章节+主题生成 count 条)
  app.post("/api/research/materials/generate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string; targetSectionId?: string; sectionTitle?: string; count?: number; topic?: string; prompt?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const r = await researchMaterials.aiGenerateMaterial(user.id, body.projectId, body);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { materials: r.materials };
  });

  // 素材采纳(挂章节: materialUsages 语义)
  app.post("/api/research/materials/:materialId/adopt", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { materialId } = request.params as { materialId: string };
    const body = request.body as { sectionIds?: string[] };
    const r = await researchMaterials.adoptMaterial(user.id, materialId, body?.sectionIds ?? []);
    if (!r.ok) return reply.code(404).send({ error: r.error });
    return { ok: true };
  });

  // T4-4: AI 自动编排素材到章节(参考产品 MaterialsView allocateMaterials; 建议→前端确认→逐条 adopt)
  app.post("/api/research/materials/allocate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { projectId?: string };
    if (!body?.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    const r = await researchMaterials.allocateMaterialsToSections(user.id, body.projectId);
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { suggestions: r.suggestions };
  });

  // ═══════════════════════════════════════════════════════════════════
  // 研究证据 → 写作(A 批 + B 批)
  //
  // 这一组路由补的是**写作舱最根本的一条断线**: 正文与真实研究之间没有任何通道。
  // 见 src/services/research-evidence-service.ts 文件头(那里记着三条实测事实,
  // 包括"后端早就写好的素材注入是死代码"这一条)。
  //
  // 命名一律走 `/research/projects/:projectId/...` —— 证据、假设、发现都**属于项目**,
  // 挂到 /materials 下会让"这条依据是哪个课题的"变成要顺着 material 反查的事。
  // ═══════════════════════════════════════════════════════════════════

  /** 全项目章节依据(前端一次拉全, 切章不重查) */
  app.get("/api/research/projects/:projectId/evidence", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const q = request.query as { sectionId?: string };
    const r = await researchEvidence.listEvidence(user.id, projectId, q.sectionId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  /** 可选的依据来源清单(素材/分析/假设/发现) —— 勾选面板的数据源 */
  app.get("/api/research/projects/:projectId/evidence-candidates", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    // fileId 用于把"这个课题跑过的分析"捞回来 —— 统计结果按 user_id 存, 与课题的唯一连接点
    //   就是快照里的 statisticsFileId(见迁移 153 的长注释)。前端把 store 里那个值带上来。
    const q = request.query as { fileId?: string };
    const r = await researchEvidence.listEvidenceCandidates(user.id, projectId, q.fileId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  /** 保存某章依据(全量替换 —— 界面看到的就是库里的) */
  app.put("/api/research/projects/:projectId/evidence/:sectionId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, sectionId } = request.params as { projectId: string; sectionId: string };
    const body = request.body as { refs?: Array<{ kind?: string; refId?: string; note?: string }> };
    const refs = Array.isArray(body?.refs) ? body.refs : [];
    const r = await researchEvidence.replaceSectionEvidence(
      user.id, projectId, sectionId,
      refs.map((x) => ({ kind: String(x.kind ?? "material") as never, refId: String(x.refId ?? ""), note: String(x.note ?? "") }))
    );
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 预览某章的依据块(界面里"生成时会给模型的到底是什么" —— 不做黑箱) */
  app.get("/api/research/projects/:projectId/evidence/:sectionId/preview", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, sectionId } = request.params as { projectId: string; sectionId: string };
    const r = await researchEvidence.buildEvidenceBlock(user.id, projectId, sectionId);
    return r;
  });

  /** 假设检验台账 */
  app.get("/api/research/projects/:projectId/hypotheses", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchEvidence.listHypotheses(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  app.put("/api/research/projects/:projectId/hypotheses", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { hypotheses?: Array<Record<string, unknown>> };
    const r = await researchEvidence.saveHypotheses(
      user.id, projectId,
      (Array.isArray(body?.hypotheses) ? body.hypotheses : []).map((h) => ({
        ...(h.id ? { id: String(h.id) } : {}),
        code: String(h.code ?? ""), text: String(h.text ?? ""),
        verdict: String(h.verdict ?? "pending"), evidenceRef: String(h.evidenceRef ?? ""),
        rationale: String(h.rationale ?? ""),
      }))
    );
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 从框架设计的假设草案灌进台账(只补不覆盖 —— 重跑框架设计不该冲掉已写的结论) */
  app.post("/api/research/projects/:projectId/hypotheses/sync", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchEvidence.syncHypothesesFromAnalysis(user.id, projectId);
    if (!r.ok) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  // ─── 投稿与返修(批6) ───
  // 外部审稿意见在此前**平台侧零实现**: `/api/review/*` 是"我方当审稿人",
  // `phase5_revise` 吃的是系统自审报告。这一组路由补的是真实科研里最硬的一环:
  // 收意见 → 逐条回应 → 出修订稿 → 交回应信。

  /** 投稿记录 */
  app.get("/api/research/projects/:projectId/submissions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await reviewResponse.listSubmissions(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  app.put("/api/research/projects/:projectId/submissions", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { submissions?: Array<Record<string, unknown>> };
    const r = await reviewResponse.saveSubmissions(
      user.id, projectId,
      (Array.isArray(body?.submissions) ? body.submissions : []).map((s) => ({
        ...(s.id ? { id: String(s.id) } : {}),
        journalName: String(s.journalName ?? ""), submittedOn: String(s.submittedOn ?? ""),
        status: String(s.status ?? "submitted"), note: String(s.note ?? ""),
        round: Number(s.round) || 1,
        // ── 批9: 录用之后的出版事务。⚠ 路由这里**必须显式透传** ——
        //   本仓踩过"service 早就支持某列, 但路由没转发, 中间层把字段丢了"这个坑
        //   (见上面 materials 那段注释: 结果那些列在前端看永远是空的)。
        license: String(s.license ?? ""), licenseNote: String(s.licenseNote ?? ""),
        oaChoice: String(s.oaChoice ?? ""), oaNote: String(s.oaNote ?? ""),
        proofChecked: s.proofChecked === true, proofNotes: String(s.proofNotes ?? ""),
        acceptedOn: String(s.acceptedOn ?? ""),
      }))
    );
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 审稿意见条目(可按轮次过滤) */
  app.get("/api/research/projects/:projectId/review-responses", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const q = request.query as { round?: string };
    const round = q?.round && /^\d+$/.test(q.round) ? Number(q.round) : undefined;
    const r = await reviewResponse.listReviewResponses(user.id, projectId, round);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  app.put("/api/research/projects/:projectId/review-responses", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { items?: Array<Record<string, unknown>>; round?: number };
    const r = await reviewResponse.saveReviewResponses(
      user.id, projectId,
      (Array.isArray(body?.items) ? body.items : []).map((it) => ({
        ...(it.id ? { id: String(it.id) } : {}),
        round: Number(it.round) || undefined, reviewerLabel: String(it.reviewerLabel ?? ""),
        seq: Number.isInteger(it.seq) ? Number(it.seq) : undefined,
        kind: String(it.kind ?? "revise"), quote: String(it.quote ?? ""), comment: String(it.comment ?? ""),
        response: String(it.response ?? ""), responseType: String(it.responseType ?? ""),
        revisionRefs: Array.isArray(it.revisionRefs) ? (it.revisionRefs as unknown[]).map(Number) : [],
      })),
      Number(body?.round) || undefined
    );
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /**
   * 粘贴一大段审稿意见 → 拆条落库。
   *
   * 拆条走**启发式**(见 review-response-service.splitReviewComments 的长注释):
   * 拆条是格式问题不是理解问题, 而 LLM 拆条会**改写原文** —— 而原文是要原样引用给编辑部的。
   */
  app.post("/api/research/projects/:projectId/review-responses/import", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { text?: string; round?: number; reviewerLabel?: string };
    const text = String(body?.text ?? "");
    if (!text.trim()) return reply.code(400).send({ error: "没有可解析的内容" });
    if (text.length > 200_000) return reply.code(400).send({ error: "内容过长(上限 20 万字符)" });
    const r = await reviewResponse.importReviewComments(user.id, projectId, text, {
      round: Number(body?.round) || undefined,
      reviewerLabel: String(body?.reviewerLabel ?? ""),
    });
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 拆分预览(不落库)—— 让用户在写入前先看一眼拆得对不对, 拆错可改 */
  app.post("/api/research/projects/:projectId/review-responses/split-preview", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { text?: string };
    const parts = reviewResponse.splitReviewComments(String(body?.text ?? ""));
    return { ok: true, count: parts.length, parts };
  });

  // ─── 录用之后的出版事务与传播复用(批9) ───
  // 17 环节里的第 16(录用出版)、17(传播与复用)。**不含 LLM 生成** ——
  // 版权/OA 是标准条款的选择、校样要看到校样, 编出来都是有害的。见 post-acceptance.ts 的注释。

  /** 版权许可 / 开放获取 / 校样清单的选项表(前端据此渲染, 不写死) */
  app.get("/api/research/post-acceptance/options", async () => ({
    licenses: postAcceptance.LICENSE_OPTIONS,
    oa: postAcceptance.OA_OPTIONS,
    proofChecklist: postAcceptance.PROOF_CHECKLIST,
  }));

  /** 成果转化 + 后续研究方向 */
  app.get("/api/research/projects/:projectId/followups", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const q = request.query as { kind?: string };
    const r = await reviewResponse.listFollowups(user.id, projectId, q?.kind);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  app.put("/api/research/projects/:projectId/followups", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { followups?: Array<Record<string, unknown>> };
    const r = await reviewResponse.saveFollowups(
      user.id, projectId,
      (Array.isArray(body?.followups) ? body.followups : []).map((f) => ({
        ...(f.id ? { id: String(f.id) } : {}),
        kind: String(f.kind ?? "direction"), title: String(f.title ?? ""),
        detail: String(f.detail ?? ""), happenedOn: String(f.happenedOn ?? ""),
      }))
    );
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 回应信(给编辑部的逐条回复) */
  app.post("/api/research/projects/:projectId/review-responses/letter", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { items?: Array<Record<string, unknown>>; title?: string };
    const items = (Array.isArray(body?.items) ? body.items : []).map((it) => ({
      round: Number(it.round) || 1, seq: Number(it.seq) || 0,
      reviewerLabel: String(it.reviewerLabel ?? ""), kind: String(it.kind ?? "revise"),
      quote: String(it.quote ?? ""), comment: String(it.comment ?? ""),
      response: String(it.response ?? ""), responseType: String(it.responseType ?? ""),
      revisionRefs: Array.isArray(it.revisionRefs) ? (it.revisionRefs as unknown[]).map(Number) : [],
    }));
    return { ok: true, markdown: reviewResponse.buildResponseLetter(items, projectId, String(body?.title ?? "")) };
  });

  // ─── 中期检查 / 结项验收(2026-09-27) ───
  // 17 环节里此前被明确排除的两项。**不含 LLM 生成** —— 形态是
  // 「上传检查表 → 逐项对着填 → 缺失项明确留空」, 见 checkup-service.ts 开头的长注释。
  //
  // ⚠ auto 项的取值与三分类是**每次读取时现算**的(不存快照), 因为存快照必然漂移,
  //   而"检查表里写着 12 章、实际有 15 章"是会被受理方当场抓出来的。

  /** 读到一份; 没有就返回空文档(空态是正常状态, 不是 404) */
  app.get("/api/research/projects/:projectId/checkup/:kind", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind } = request.params as { projectId: string; kind: string };
    if (!checkupService.CHECKUP_KINDS.includes(kind as never)) {
      return reply.code(400).send({ error: `未知的检查类型: ${kind}（应为 midterm / final）` });
    }
    const doc = await checkupService.getCheckup(user.id, projectId, kind as never);
    if (!doc) return reply.code(404).send({ error: "项目不存在" });
    return { doc };
  });

  /**
   * 上传/粘贴一份检查表 → 拆条 → 三分类 → 落库。**替换而非追加**(同一项目同一类只留一份)。
   * 前端把文件解析成文本后走这条(文件解析用既有的 /api/files/extract-text, 不另造)。
   */
  app.put("/api/research/projects/:projectId/checkup/:kind", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind } = request.params as { projectId: string; kind: string };
    if (!checkupService.CHECKUP_KINDS.includes(kind as never)) {
      return reply.code(400).send({ error: `未知的检查类型: ${kind}（应为 midterm / final）` });
    }
    const body = request.body as { text?: string; sourceName?: string };
    const r = await checkupService.putCheckup(user.id, projectId, kind as never, String(body?.text ?? ""), String(body?.sourceName ?? ""));
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error });
    return r;
  });

  /** 改一项的填写内容 —— 打 edited 标记，之后重算不再覆盖用户改的值 */
  app.patch("/api/research/projects/:projectId/checkup/:kind/items/:seq", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind, seq } = request.params as { projectId: string; kind: string; seq: string };
    if (!checkupService.CHECKUP_KINDS.includes(kind as never)) {
      return reply.code(400).send({ error: `未知的检查类型: ${kind}` });
    }
    const body = request.body as { value?: string };
    const r = await checkupService.setItemValue(user.id, projectId, kind as never, Number(seq), String(body?.value ?? ""));
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error });
    return r;
  });

  /**
   * 导出 —— 一条路由出两种格式。
   *
   * `md`  : Markdown（含每个 auto 项的来源标注 + platform_missing 的集中清单）
   * `docx`: `{ nodes, paperTitle }` —— **交回前端走既有的 `/paper-outline/export`**。
   *         为什么不在这里直接出 docx: 那条路要 python-docx 子进程与一整套版式参数
   *         （字体/字号/行距/页边距/参考文献块），在这里再写一遍必然与它漂移。
   *         但节点的**拼装**在后端（`exportCheckupDocxNodes`），前端只做转发 ——
   *         两条导出路径必须同源，否则会出现"复制出来有来源标注、Word 里没有"。
   */
  app.get("/api/research/projects/:projectId/checkup/:kind/export", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind } = request.params as { projectId: string; kind: string };
    if (!checkupService.CHECKUP_KINDS.includes(kind as never)) {
      return reply.code(400).send({ error: `未知的检查类型: ${kind}` });
    }
    const doc = await checkupService.getCheckup(user.id, projectId, kind as never);
    if (!doc) return reply.code(404).send({ error: "项目不存在" });
    if (!doc.items.length) return reply.code(422).send({ error: "还没有这份检查表，请先上传" });
    const proj = await pool.query(`select title from research_projects where id=$1 and user_id=$2`, [projectId, user.id]);
    const title = String(proj.rows[0]?.title ?? "");
    const fmt = String((request.query as { format?: string })?.format ?? "md");
    if (fmt === "docx") {
      return { ok: true, paperTitle: `${title} · ${checkupService.CHECKUP_CN[doc.kind]}`, nodes: checkupService.exportCheckupDocxNodes(doc, title) };
    }
    return { ok: true, markdown: checkupService.exportCheckupMarkdown(doc, title) };
  });

  /** 删掉整份（重新上传前的清空，或存错了） */
  app.delete("/api/research/projects/:projectId/checkup/:kind", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind } = request.params as { projectId: string; kind: string };
    if (!checkupService.CHECKUP_KINDS.includes(kind as never)) {
      return reply.code(400).send({ error: `未知的检查类型: ${kind}` });
    }
    const r = await checkupService.deleteCheckup(user.id, projectId, kind as never);
    if (!r.ok) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true };
  });

  // ─── 申报与审查(批7) ───
  // 开题报告 / 基金申报 / 伦理审查 / 预注册 —— 这四件事平台此前**后端零实现**,
  // 站内仅有的提及全是提示文案(指向用户本机的技能包)。项目**开始之前**要交的材料,
  // 平台一样都不出。见 proposal-service.ts 的长注释。

  /** 四类文书的固定节次(前端要据此渲染"哪几节"与进度) */
  app.get("/api/research/proposals/specs", async () => ({ specs: proposalService.PROPOSAL_SPECS }));

  /**
   * 生成一份文书。
   *
   * ⚠ 是**同步**接口且逐节生成(七节), 单次要一分钟以上 —— 前端必须给进度反馈
   *   (本仓踩过"点了没反应"的坑: 同步 LLM 接口没有流式时, 用户以为按钮死了)。
   *   不建 job 的理由: 它是个**单次产出**不是流水线, 建 job 会让"生成中断"变成
   *   一个要恢复的状态, 而重跑一次的成本只是再等一分钟。
   */
  app.post("/api/research/projects/:projectId/proposals/generate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as Record<string, unknown>;
    const owned = await pool.query(`select id, title from research_projects where id=$1 and user_id=$2`, [projectId, user.id]);
    if (!owned.rows.length) return reply.code(404).send({ error: "项目不存在" });

    /**
     * 上下文**优先取项目里已有的东西**(研究设计节点 / 假设台账), 而不是让用户重填一遍。
     * 填过的东西再填一次, 是这类工具最常见的浪费。
     *
     * ⚠ 用 `buildDesignBlock`(已有)而不是自己拼 design 节点: 它把方法 id 译成了
     *   "选了这个方法意味着什么"的口径说明(如 ols → "不得由相关推断因果"),
     *   而 id 原样丢给模型是个空词。同理假设台账走 `listHypotheses`。
     */
    const [designBlock, hyps, wb] = await Promise.all([
      researchEvidence.buildDesignBlock(user.id, projectId).catch(() => ""),
      researchEvidence.listHypotheses(user.id, projectId).catch(() => null),
      chapterSkill.getWorkbenchSnapshot(user.id, projectId).catch(() => null),
    ]);
    const hypList = (hyps?.hypotheses ?? []) as Array<{ code?: string; text?: string; verdict?: string; evidenceRef?: string }>;
    const evidence = hypList.length
      ? hypList.map((h) => `${h.code ?? ""} ${h.text ?? ""}${h.verdict ? ` [${h.verdict}]` : ""}${h.evidenceRef ? ` (${h.evidenceRef})` : ""}`).join("\n")
      : "";
    const snap = (wb?.snapshot ?? {}) as Record<string, unknown>;
    const inp = (snap.input ?? {}) as Record<string, unknown>;

    const r = await proposalService.generateProposal({
      kind: String(body?.kind ?? ""),
      topic: String(body?.topic ?? snap.mergedTitle ?? inp.title ?? (owned.rows[0] as { title?: string }).title ?? ""),
      discipline: String(body?.discipline ?? inp.researchMethod ?? ""),
      design: String(body?.design ?? designBlock),
      literature: String(body?.literature ?? ""),
      evidence: String(body?.evidence ?? evidence),
      requirements: String(body?.requirements ?? inp.requirements ?? ""),
      model: body?.model ? String(body.model) : undefined,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error });

    /**
     * 落库 —— 写 `proposal` 节点, 四类文稿按 kind 分键装在同一节点里。
     * ⚠ **读改写而不是整节点覆盖**: 生成「基金申报」不该把已生成的「开题报告」冲掉。
     *   本仓在 workbench 快照上踩过同一形状的坑(整份覆写导致别处数据消失)。
     */
    const cur = await researchPipeline.getNode(user.id, projectId, "proposal").catch(() => null);
    const prev = (cur?.payload ?? {}) as Record<string, unknown>;
    const next = { ...prev, [r.kind]: { content: r.content, title: r.title, generatedAt: new Date().toISOString() } };
    await researchPipeline.putNode(user.id, projectId, "proposal", next, { sourceRole: "editor", note: `生成${r.title}` }).catch(() => null);
    return r;
  });

  /** 读已生成的文书 */
  app.get("/api/research/projects/:projectId/proposals", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const node = await researchPipeline.getNode(user.id, projectId, "proposal").catch(() => null);
    return { proposals: (node?.payload ?? {}) as Record<string, unknown> };
  });

  /**
   * 手改某一节后存回。
   * ⚠ 生成物**必须可编辑** —— 这几份是用户要签字交上去的材料, "生成的不能改"等于没用。
   */
  app.put("/api/research/projects/:projectId/proposals/:kind", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, kind } = request.params as { projectId: string; kind: string };
    const body = request.body as { content?: string };
    if (typeof body?.content !== "string") return reply.code(400).send({ error: "缺少 content" });
    if (!proposalService.getSpec(kind)) return reply.code(400).send({ error: `未知的文书类型: ${kind}` });
    const cur = await researchPipeline.getNode(user.id, projectId, "proposal").catch(() => null);
    const prev = (cur?.payload ?? {}) as Record<string, unknown>;
    const spec = proposalService.getSpec(kind)!;
    const next = { ...prev, [kind]: { ...(prev[kind] as object ?? {}), content: body.content, title: spec.cn, editedAt: new Date().toISOString() } };
    const w = await researchPipeline.putNode(user.id, projectId, "proposal", next, { sourceRole: "user", note: `修改${spec.cn}` });
    if (!w.ok) return reply.code(404).send({ error: "项目不存在" });
    return { ok: true, version: w.version };
  });

  /** 合集导出(markdown) —— 四份已生成的拼成一份, 供一次性下载 */
  app.get("/api/research/projects/:projectId/proposals/export", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const owned = await pool.query(`select title from research_projects where id=$1 and user_id=$2`, [projectId, user.id]);
    if (!owned.rows.length) return reply.code(404).send({ error: "项目不存在" });
    const node = await researchPipeline.getNode(user.id, projectId, "proposal").catch(() => null);
    const md = proposalService.proposalsToMarkdown(
      (node?.payload ?? {}) as Record<string, { content?: string }>,
      String((owned.rows[0] as { title?: string }).title ?? ""));
    if (!md) return reply.code(404).send({ error: "还没有生成过任何申报材料" });
    return { ok: true, markdown: md };
  });

  /**
   * 正文数字核验 —— 只报告, 不改写。
   * 见 research-evidence-service.verifyChapterNumbers 的长注释(为什么不能自动"修正")。
   */
  app.post("/api/research/projects/:projectId/chapters/:sectionId/verify-numbers", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, sectionId } = request.params as { projectId: string; sectionId: string };
    const body = request.body as { content?: string };
    // 正文可以从前端传(编辑器里未保存的版本), 不传就取节点里的
    let content = typeof body?.content === "string" ? body.content : "";
    if (!content.trim()) {
      const r = await pool.query(
        `select payload from research_nodes where project_id=$1 and node_key='sections'`, [projectId]);
      const list = (r.rows[0]?.payload?.sections ?? []) as Array<{ id?: string; content?: string }>;
      content = String(list.find((s) => String(s.id) === sectionId)?.content ?? "");
    }
    const r = await researchEvidence.verifyChapterNumbers(user.id, projectId, sectionId, content);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  /** 发现台账 */
  app.get("/api/research/projects/:projectId/findings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchEvidence.listFindings(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  /**
   * 从一次统计分析里**采集**发现(B 批的入口)。
   *
   * 抽取规则在服务端(research-evidence-service.extractFindings), 按表头精确匹配,
   * **不用 LLM 读数字** —— 报错一个系数整篇论文的可信度就没了。LLM 只在下一步写句子。
   */
  app.post("/api/research/projects/:projectId/findings/harvest", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { jobId?: string };
    if (!body?.jobId) return reply.code(400).send({ error: "缺少 jobId(要从哪次分析里采集)" });
    const r = await researchEvidence.harvestFindings(user.id, projectId, body.jobId);
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error, ...(r.skipped ? { skipped: r.skipped } : {}) });
    return r;
  });

  /** 给已抽取的发现写自然语言结论(LLM 只措辞, 数字写在 prompt 里不许改) */
  app.post("/api/research/projects/:projectId/findings/claim", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { topic?: string; ids?: string[] };
    const r = await researchEvidence.claimFindings(user.id, projectId, String(body?.topic ?? ""), body?.ids);
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error });
    return r;
  });

  /** 采纳/忽略一条发现(采纳后才进"本章依据"的可选清单) */
  app.patch("/api/research/projects/:projectId/findings/:findingId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, findingId } = request.params as { projectId: string; findingId: string };
    const body = request.body as { status?: string; claim?: string };
    if (typeof body?.claim === "string") {
      const r = await researchEvidence.setFindingClaim(user.id, projectId, findingId, body.claim);
      if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    }
    if (typeof body?.status === "string") {
      const r = await researchEvidence.setFindingStatus(user.id, projectId, findingId, body.status);
      if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    }
    return { ok: true };
  });

  /**
   * 从发现台账生成「结果」章草稿(A4)。
   *
   * 与普通章节生成的关键区别: 数字**先由代码写进句子骨架**, 模型只负责把骨架连缀成段。
   * 这样从源头就不会出现"模型把系数写错"这类问题, 而不是写完再靠核验兜底。
   * 返回值里带上骨架与核验结果 —— 界面据此显示"哪些数字是机器写的、有没有对不上的"。
   */
  app.post("/api/research/projects/:projectId/chapters/:sectionId/result-draft", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, sectionId } = request.params as { projectId: string; sectionId: string };
    const body = request.body as { findingIds?: string[]; topic?: string };
    const r = await researchEvidence.generateResultDraft(user.id, projectId, sectionId, {
      findingIds: Array.isArray(body?.findingIds) ? body.findingIds : undefined,
      topic: String(body?.topic ?? ""),
    });
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error });
    return r;
  });

  /**
   * 发现 → 假设的**匹配建议**(B 批)。
   *
   * 只给建议不自动填: 一条假设常常对应多个系数(主效应+交互), 也可能对应的是某个系数
   * **不显著**从而该被否定 —— 这些判断依赖研究设计。系统把"看起来相关的发现"摆到那条
   * 假设旁边(按变量名/系数在假设文本与依据里的出现匹配, 不用 LLM), 结论仍由人填。
   */
  app.get("/api/research/projects/:projectId/hypothesis-links", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const links = await researchEvidence.suggestHypothesisLinks(user.id, projectId);
    return { links };
  });

  // ═══════════════════════════════════════════════════════════════════
  // 实证台绑定(跨 id 空间的第三条线)
  //
  // ⚠⚠ 安全模型 —— 改这几个端点前**先读 research-evidence-service.bindEmpiricalProject 的注释**:
  //   `empirical_projects` 没有 user_id 列, 实证台的 63 个路由没有一处调 requireUser,
  //   服务端对本机连接全豁免。**实证台的数据本来就是实例级的**。
  //   所以这里:
  //     · 绑定必须**用户显式**设定(不自动发现、不按标题猜);
  //     · 只按用户设定的那**一个** empirical_project_id 读, 不提供"列出全部实证数据";
  //     · 越权面与实证台自身一致, 不扩大。
  //   界面上也要如实说明(见 ChapterEvidencePanel 的提示), 否则用户会误以为这是私有数据。
  // ═══════════════════════════════════════════════════════════════════
  app.get("/api/research/projects/:projectId/empirical-binding", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const b = await researchEvidence.getEmpiricalBinding(user.id, projectId);
    if (!b) return reply.code(404).send({ error: "项目不存在" });
    return b;
  });

  app.put("/api/research/projects/:projectId/empirical-binding", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { empiricalProjectId?: string | null };
    const r = await researchEvidence.bindEmpiricalProject(
      user.id, projectId, body?.empiricalProjectId ? String(body.empiricalProjectId) : null);
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 400).send({ error: r.error });
    return r;
  });

  /** 可选实证课题(下拉)。只返回元信息 + 有结果的运行数, 不含任何结果内容。 */
  app.get("/api/research/empirical-projects", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { projects: await researchEvidence.listEmpiricalProjects(user.id) };
  });

  /** 已绑定课题下、有表格产物的运行(证据候选 —— 只有表标题, 不含系数) */
  app.get("/api/research/projects/:projectId/empirical-runs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await researchEvidence.listEmpiricalRuns(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return r;
  });

  /** 从一次实证运行采集发现(与统计台那条同一套抽取与落库) */
  app.post("/api/research/projects/:projectId/empirical-runs/:runId/harvest", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    const body = request.body as { tableIndex?: number };
    const r = await researchEvidence.harvestEmpiricalFindings(
      user.id, projectId, runId, Number.isInteger(body?.tableIndex) ? body.tableIndex : undefined);
    if (!r.ok) return reply.code(r.error === "项目不存在" ? 404 : 422).send({ error: r.error, ...(r.skipped ? { skipped: r.skipped } : {}) });
    return r;
  });

  // 跨任务工件导入(HAR: artifacts/import → wfart + contentHash 溯源)
  app.post("/api/research/artifacts/import", async (request, reply) => {    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { sourceType?: string; sourceId?: string; sourceTaskId?: string; snapshot?: unknown };
    if (!body?.sourceType || !body?.sourceId) return reply.code(400).send({ error: "缺少 sourceType/sourceId" });
    // 取来源内容构造快照 + 哈希
    // 注(2026-09-11): 原 "statistics" 分支读 stats_artifacts, 该表无生产者(恒 0 行), 分支已移除
    let snapshot: Record<string, unknown> = {};
    if (body.sourceType === "viz") {
      const r = await pool.query(`select * from viz_artifacts where id=$1 and user_id=$2`, [body.sourceId, user.id]);
      if (r.rows[0]) snapshot = { title: r.rows[0].prompt, version: r.rows[0].version, pngRel: r.rows[0].png_path };
    } else if (body.sourceType === "material") {
      const r = await pool.query(`select * from research_materials where id=$1 and user_id=$2`, [body.sourceId, user.id]);
      if (r.rows[0]) snapshot = { title: r.rows[0].title, kind: r.rows[0].kind, contentMd: r.rows[0].content_md };
    }
    const merged = { ...snapshot, ...(body.snapshot ?? {}) };
    const hash = researchMaterials.contentHashOf({ sourceType: body.sourceType, sourceId: body.sourceId, ...merged });
    // 幂等: 同哈希已存在则返回已有工件
    const dup = await pool.query(
      `select id from research_artifacts where user_id=$1 and content_hash=$2 limit 1`, [user.id, hash]);
    if (dup.rows.length) return { artifact: { id: dup.rows[0].id, contentHash: hash, sourceType: body.sourceType, sourceId: body.sourceId, deduped: true } };
    const id = randomUUID();
    await pool.query(
      `insert into research_artifacts (id, user_id, source_type, source_id, source_task_id, content_hash, snapshot)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, user.id, body.sourceType, body.sourceId, body.sourceTaskId ?? "", hash, JSON.stringify(merged)]);
    return { artifact: { id, contentHash: hash, sourceType: body.sourceType, sourceId: body.sourceId, deduped: false } };
  });

  // ═══ SocialSci 体验厚度: 文件正文提取(docx→python通道 / txt直接) ═══
  app.post("/api/files/extract-text", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { filename?: string; base64?: string; mime?: string };
    if (!body?.base64) return reply.code(400).send({ error: "缺少 base64 文件内容" });
    const filename = body.filename ?? "file";
    const buf = Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
    const tmp = path.join(os.tmpdir(), `extract-${Date.now()}-${filename.replace(/[^a-zA-Z0-9.]/g, "_")}`);
    fs.writeFileSync(tmp, buf);
    try {
      const { extractDocumentText } = await import("../services/doc-text-extract.js");
      const r = await extractDocumentText(buf, filename, {
        tmpPath: tmp,
        docx: async (p) => {
          const { extractDocxText } = await import("../services/format-docx-service.js");
          return await extractDocxText(p);
        },
      });
      if (!r.ok) return reply.code(422).send({ error: r.error });
      const text = r.result.text.slice(0, 200000);
      // pageCount/extractedPages/truncated 交给前端(此前前端自己拿字符数除 2000 当页数, 是编的)
      return { ok: true, filename, ...r.result, text };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  // ═══ V418: 扫描版文档 OCR(上传 → 后台识别 → 文本回填素材) ═══
  //
  // 由来: 上面那条 extract-text 对扫描件是死路 —— 报"未提取到文字"之后没有下一步。
  //   这组路由就是那个"下一步": 建任务、后台跑 MinerU、轮询取回文本。
  // 归属: 与 /api/ocr/* 同批, LOCAL_ONLY_PREFIXES 里已登记(见该常量)。
  app.post("/api/ocr/jobs", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { filename?: string; base64?: string; mime?: string; fileId?: string };
    const filename = body.filename ?? "file.pdf";
    const { ocrJobService } = await import("../services/ocr-job-service.js");
    /**
     * 两种发起方式:
     *   (a) 直接传字节(既有路径, 写作舱素材上传走这条);
     *   (b) 传 fileId —— 指着一份**已上传**的文件识别。识别完正文会写回那份文件的 text 列,
     *       于是评审页那条「扫描件 → 去识别文字」有回程(2026-09-29)。
     * 二选一, fileId 优先(它有回程, 语义更完整)。
     */
    const srcFileId = String(body?.fileId ?? "").trim();
    const { rawFileId } = await import("../services/file-text-service.js");
    let buf: Buffer;
    if (srcFileId) {
      const r = await pool.query(`select filename, mime, storage_rel from user_files where id=$1 and user_id=$2`,
        [rawFileId(srcFileId), user.id]);
      if (!r.rows.length) return reply.code(404).send({ error: "文件不存在或不属于你" });
      const { getObject } = await import("../services/blob-store.js");
      const bytes = await getObject(String(r.rows[0].storage_rel ?? ""));
      if (!bytes) return reply.code(404).send({ error: "文件字节已丢失, 请重新上传" });
      buf = bytes;
    } else {
      if (!body?.base64) return reply.code(400).send({ error: "缺少 base64 文件内容(或给 fileId 指向已上传的文件)" });
      buf = Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
    }
    if (buf.length === 0) return reply.code(400).send({ error: "文件内容为空" });
    const r = ocrJobService.createOcrJob({
      userId: user.id, fileName: filename, buf,
      ...(srcFileId ? { sourceFileId: rawFileId(srcFileId) } : {}),
    });
    if (!r.ok) return reply.code(429).send({ error: r.error });
    return { job: ocrJobService.publicOcrJob(r.job) };
  });
  app.get("/api/ocr/jobs/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { id } = request.params as { id: string };
    const { ocrJobService } = await import("../services/ocr-job-service.js");
    const job = ocrJobService.getOcrJob(user.id, id);
    if (!job) return reply.code(404).send({ error: "任务不存在或不属于你" });
    return { job: ocrJobService.publicOcrJob(job, true) };
  });
  app.post("/api/ocr/jobs/:id/cancel", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { id } = request.params as { id: string };
    const { ocrJobService } = await import("../services/ocr-job-service.js");
    return { ok: ocrJobService.cancelOcrJob(user.id, id) };
  });
  app.delete("/api/ocr/jobs/:id", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { id } = request.params as { id: string };
    const { ocrJobService } = await import("../services/ocr-job-service.js");
    return { ok: await ocrJobService.deleteOcrJob(user.id, id) };
  });
  /** OCR 能力是否就绪(前端据此决定给不给用户「转 OCR」这条路) */
  app.get("/api/ocr/capability", async () => {
    const { effectiveToken } = await import("../services/service-token-store.js");
    const ready = !!(await effectiveToken("mineru"));
    return { ready, hint: ready ? "" : "平台没有配置 OCR 密钥，扫描件暂时无法识别。到「设置 → 外部服务密钥」填一个 MinerU 密钥。" };
  });

  // ═══ SocialSci 补漏组3: 用户文件/默认任务/viz_data节点/知识库会话 ═══
  // 1) 用户文件仓(HAR: files/upload → profile → content)
  app.post("/api/files/upload", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { filename?: string; base64?: string; mime?: string };
    if (!body?.base64) return reply.code(400).send({ error: "缺少 base64 文件内容" });
    const id = randomUUID();
    const buf = Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
    // 相对**数据根**存(不再是相对 SAG_ROOT): 上云后数据根可能挂到共享卷或对象存储
    const rel = `user-files/${user.id}/${id}.bin`;
    // 2026-09-09 xlsx 支持(主仓): .xlsx/.xls → openpyxl 转 CSV 后按文本剖析
    // 与本分支的对象存储改造合并: Python 只能读**真实文件**, 所以先把字节落到临时文件转换,
    //   再把转换结果(或原字节)交给 blob-store 落库 —— 不要既写临时文件又写数据目录。
    let rawBuf = buf;
    const lower = String(body.filename ?? "").toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const os = await import("node:os");
      const tmpXlsx = path.join(os.tmpdir(), `sag-xlsx-${id}.xlsx`);
      try {
        fs.writeFileSync(tmpXlsx, buf);
        const { execFile } = await import("node:child_process");
        const PY = process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON || "python";
        const csvText = await new Promise<string>((resolve, reject) => {
          execFile(PY, [path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "xlsx2csv.py"), tmpXlsx],
            { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout);
            });
        });
        rawBuf = Buffer.from(csvText, "utf-8");
      } catch (e) {
        return reply.code(400).send({ error: `xlsx 解析失败: ${String((e as Error).message).slice(0, 160)}` });
      } finally {
        try { fs.unlinkSync(tmpXlsx); } catch { /* 忽略 */ }
      }
    }
    await putObject(rel, rawBuf);
    // 文本自动剖析(前 200KB → 行列概览 + 变量类型推断; xlsx 转换后 rawBuf 为 CSV 文本)
    let profile: Record<string, unknown> = {};
    const text = rawBuf.length <= 200_000 ? rawBuf.toString("utf-8") : "";
    if (text.trim()) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      profile = { kind: "text", lines: lines.length, chars: text.length };
      if (lines.length > 1 && lines[0].includes(",")) {
        const cols = lines[0].split(",").map((c) => c.trim());
        // M3: 变量类型推断(参考产品 profile.variables[{name,type}] 契约) — 采样前 50 行数值探测
        const sample = lines.slice(1, 51).map((l) => l.split(",").map((c) => c.trim()));
        const variables = cols.slice(0, 20).map((c, ci) => {
          let num = 0;
          let total = 0;
          for (const row of sample) {
            const v = row[ci];
            if (v === undefined || v === "") continue;
            total++;
            if (v !== "" && !Number.isNaN(Number(v))) num++;
          }
          const ratio = total ? num / total : 0;
          const type = ratio >= 0.9 ? "scale" : ratio <= 0.1 ? "nominal" : "unknown";
          return { name: c, type };
        });
        profile = {
          kind: "csv",
          parseStatus: "completed", // viz 前端契约(参考产品同名函数 判定)
          rowCount: lines.length - 1,
          columnCount: cols.length,
          colCount: cols.length, // 别名(viz 前端读 colCount)
          columns: cols.slice(0, 20),
          variables,
          sampleRows: sample.slice(0, 20) // 前 20 行样例(viz 绑定数据/预览)
        };
      }
    }
    await pool.query(
      `insert into user_files (id, user_id, filename, mime, size_bytes, storage_rel, profile)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, user.id, body.filename ?? "upload.bin", body.mime ?? "application/octet-stream", rawBuf.length, rel, JSON.stringify(profile)]);
    return { fileId: `file_${id}`, filename: body.filename ?? "upload.bin", profile };
  });

  /**
   * 文件正文(fileId → 纯文本)。
   *
   * 由来(2026-09-29): 这条路由此前**不存在**, 于是"上传的那份 PDF 正文是什么"没人能回答 ——
   *   审稿建 job 只能让用户粘贴全文, `review_jobs.source_file_id` 永远写不进值。
   *   邻近那条 `/api/files/extract-text` 解决的是另一半问题(手上**已有字节**, 当场抽一次就丢),
   *   它对扫描件是硬失败, 也不落库。这条不一样: 它按 **id** 取, 抽完存进 user_files.text。
   *
   * ⚠ 扫描件**不在这里等 OCR**(分钟级, 同步等会把连接与前端轮询一起拖死):
   *   返回 needsOcr=true 让调用方去走「识别文字」, OCR 完成后经 attachOcrText 写回同一列。
   */
  app.get("/api/files/:fileId/text", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { fileId } = request.params as { fileId: string };
    const force = String((request.query as { force?: string })?.force ?? "") === "1";
    const { ensureFileText } = await import("../services/file-text-service.js");
    const r = await ensureFileText(user.id, fileId, { force });
    // 抽不出正文**不是**服务端错误: 扫描件要用户去做 OCR, 那是 200 + needsOcr。
    // 只有"文件不存在/字节丢了"才是 404。
    if (!r.ok && !r.needsOcr && !r.text) {
      if (/不存在|不属于你|字节已丢失/.test(r.error)) return reply.code(404).send({ error: r.error, code: "FILE_NOT_FOUND" });
      return reply.code(200).send({ fileId: r.fileId, filename: r.fileName, ext: r.ext, ok: false, text: "", charCount: 0, pageCount: r.pageCount, extraction: r.extraction, needsOcr: r.needsOcr, error: r.error });
    }
    return {
      ok: r.ok, fileId: r.fileId, filename: r.fileName, ext: r.ext,
      text: r.text, charCount: r.charCount, pageCount: r.pageCount,
      extraction: r.extraction, needsOcr: r.needsOcr, error: r.error,
    };
  });

  // 文件剖析(读库 profile)
  app.get("/api/files/:fileId/profile", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const rawId = (request.params as { fileId: string }).fileId.replace(/^file_/, "");
    const r = await pool.query(`select id, filename, size_bytes, profile, created_at from user_files where id=$1 and user_id=$2`, [rawId, user.id]);
    if (!r.rows.length) return reply.code(404).send({ error: "文件不存在" });
    const row = r.rows[0];
    return { fileId: `file_${row.id}`, filename: row.filename, sizeBytes: row.size_bytes, profile: row.profile, createdAt: row.created_at };
  });

  // 文件原始字节读取(HAR: files/{id}/content → 下载原文件)
  app.get("/api/files/:fileId/content", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const rawId = (request.params as { fileId: string }).fileId.replace(/^file_/, "");
    const r = await pool.query(`select storage_rel, filename, mime from user_files where id=$1 and user_id=$2`, [rawId, user.id]);
    if (!r.rows.length) return reply.code(404).send({ error: "文件不存在" });
    const data = await getObject(String(r.rows[0].storage_rel));
    if (!data) return reply.code(404).send({ error: "文件已丢失" });
    reply.header("Content-Type", r.rows[0].mime || "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(r.rows[0].filename)}"`);
    return reply.send(data);
  });

  // 2) 默认任务容器(HAR: PUT /api/tasks/default + nodes/{key} — 未选项目时的"草稿容器")
  app.get("/api/tasks/default", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const r = await pool.query(`select id, title, status from research_projects where user_id=$1 order by updated_at desc limit 1`, [user.id]);
    // 无项目则返回空默认
    return { task: r.rows[0] ? { id: r.rows[0].id, module: "workflow", title: r.rows[0].title } : null };
  });

  // 3) viz_data 节点(viz 数据集/表格挂在任务节点上, HAR 实测存在 GET tasks/{id}/nodes/viz_data)
  app.get("/api/tasks/:taskId/nodes/viz_data", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { taskId } = request.params as { taskId: string };
    // 该任务项目的 viz_data 节点(兼容: 没有独立表则从 research_nodes 兜底)
    const r = await pool.query(
      `select n.* from research_nodes n
         join research_projects p on p.id=n.project_id and p.user_id=$2
        where n.project_id=$1 and n.node_key='viz_data'`, [taskId, user.id]);
    return { node: r.rows[0] ?? null };
  });

  // 4) 知识库/聊天会话删除(HAR: DELETE knowledge/sessions/sess_xxx)
  app.delete("/api/knowledge/sessions/:sessionId", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sessionId } = request.params as { sessionId: string };
    const id = sessionId.replace(/^sess_/, "");
    await pool.query(`delete from mcp_sessions where id=$1 and user_id=$2`, [id, user.id]);
    await pool.query(`delete from mcp_messages where session_id=$1`, [id]);
    return { ok: true };
  });

  // ═══ SocialSci 补漏R2: aiSkill 写作卡 + 工作台整包快照(迁移124) ═══
  app.post("/api/research/projects/:projectId/skill-card", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { sectionId?: string; sectionTitle?: string; level?: number; outlineTree?: string; parentTitle?: string; topic?: string; researchMethod?: string };
    if (!body?.sectionId || !body?.sectionTitle) return reply.code(400).send({ error: "缺少 sectionId/sectionTitle" });
    const r = await chapterSkill.generateChapterSkillCard({
      userId: user.id, projectId,
      sectionId: body.sectionId, sectionTitle: body.sectionTitle,
      level: body.level, outlineTree: body.outlineTree,
      parentTitle: body.parentTitle, topic: body.topic, researchMethod: body.researchMethod,
    });
    if (!r.ok) return reply.code(422).send({ error: r.error });
    return { card: r.card };
  });
  app.post("/api/research/projects/:projectId/skill-cards/batch", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { sections?: Array<{ id: string; title: string; level?: number }> };
    if (!Array.isArray(body?.sections) || !body.sections.length) return reply.code(400).send({ error: "缺少 sections" });
    return await chapterSkill.batchGenerateSkillCards(user.id, projectId, body.sections);
  });
  app.get("/api/research/projects/:projectId/skill-cards", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    return { cards: await chapterSkill.getChapterSkillCards(user.id, projectId) };
  });
  // 工作台整包快照(23键全状态, HAR: PUT task snapshot 语义)
  app.get("/api/research/projects/:projectId/workbench", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const r = await chapterSkill.getWorkbenchSnapshot(user.id, projectId);
    if (!r) return reply.code(404).send({ error: "项目不存在" });
    return { snapshot: r.snapshot, englishAbstract: r.englishAbstract };
  });
  /**
   * 工作台整包快照。
   *
   * 2026-09-18: 这里从"只写快照列"改成**由服务端负责同步到节点**。
   *   此前节点侧靠每个调用点自己记得补一刀, 忘了就静默丢数据 ——
   *   实测栽过:「已定稿」只写快照而读侧只从 finalize 节点读 → 刷新后丢失;
   *   要件生成只写快照 → 刷新后被 sections 节点盖回去。
   *   现在客户端只管提交视图, 同步由 `workbench-sync` 的映射表保证
   *   (含 diff 守卫: 值没变不写节点, 免得把 research_node_history 撑爆)。
   *
   *   两道写(快照 + 节点)放**同一事务**: 任一步失败整体回滚, 不留"列新节点旧"的分叉。
   */
  app.put("/api/research/projects/:projectId/workbench", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { snapshot?: Record<string, unknown> };
    if (!body?.snapshot) return reply.code(400).send({ error: "缺少 snapshot" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const owned = await client.query(
        `select id from research_projects where id=$1 and user_id=$2`, [projectId, user.id]);
      if (!owned.rows.length) { await client.query("rollback"); return reply.code(404).send({ error: "项目不存在" }); }
      // 快照列 —— 用 jsonb `||` **合并**而不是整块替换。
      //
      // 2026-09-18: 原来是 `workbench_snapshot=$2` 整块覆盖。正常路径(前端一次提交全部
      //   28 个键)看不出问题, 但只要有一次**部分提交**(比如只带 phase/phaseLabel 的推进),
      //   之前存的键就被抹掉了 —— 实测: 只提交 3 个键后, 快照里原本的 sections /
      //   statisticsFileId 全没了。
      //   本地图里没有任何"删除快照键"的语义(前端 resetLocal 只清内存态并换 taskId),
      //   所以合并写严格优于覆盖写。
      const en = body.snapshot._englishAbstract;
      await client.query(
        `update research_projects
            set workbench_snapshot = coalesce(workbench_snapshot,'{}'::jsonb) || $2::jsonb,
                english_abstract = coalesce($3, english_abstract), updated_at=now()
          where id=$1`,
        [projectId, JSON.stringify(body.snapshot), typeof en === "string" ? en : null]);
      const sync = await syncSnapshotToNodes(client, projectId, body.snapshot);
      await client.query("commit");
      return { ok: true, syncedNodes: sync.synced };
    } catch (e) {
      await client.query("rollback").catch(() => null);
      request.log.error({ err: e, projectId }, "workbench 保存失败");
      return reply.code(500).send({ error: "保存失败" });
    } finally {
      client.release();
    }
  });

  // ═══ SocialSci R5: 需求澄清(HAR: clarify/generate) ═══
  // E4(参考产品 2 轮集中补齐): 透传 round/answers — 前端第一轮答完可再发起第二轮追问
  app.post("/api/clarify/generate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = request.body as { title?: string; outline?: string; requirements?: string; researchMethod?: string; totalWordCount?: number; sampleContent?: string; round?: number; answers?: Array<{ question: string; answer: string }> };
    if (!body?.title?.trim()) return reply.code(400).send({ error: "缺少 title" });
    return { success: true, data: await researchPipeline.generateClarify(body as never) };
  });

  // ═══ SocialSci R5: 版本状态(HAR: workflow/versions/task/{id}/current → state 含 stale 检测) ═══
  app.get("/api/research/versions/current", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const q = request.query as { projectId?: string };
    if (!q.projectId) return reply.code(400).send({ error: "缺少 projectId" });
    // 从项目快照+版本表组装 state(含 stale: 节点比版本新=旧了)
    const project = await researchPipeline.getProject(user.id, q.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const r = await pool.query(
      `select version, label, status, created_at from research_versions where project_id=$1 order by version desc limit 1`,
      [q.projectId]);
    const last = r.rows[0] ?? null;
    // 2026-09-15: 此前 phase2/3/4 的版本与 stale 全是**硬编码常量**(phase2Version: null,
    //   phase2Stale: false…), 只有 phase5Version 是真查的 —— 这个端点是合稿门禁
    //   ("请先完成当前 Phase 4 正文生成")的底座, 假数据等于门禁永不触发。
    //   真实来源: 该阶段发布过的最近一个版本(research_versions.label = phaseN_*),
    //   戳点取版本创建时间; 节点在该时间点之后又更新过 → 该阶段产物已过期(stale)。
    const st = await pool.query(
      `select distinct on (label) label, version, id, created_at
         from research_versions
        where project_id=$1 and label = any($2::text[])
        order by label, version desc`,
      [q.projectId, RESEARCH_STAGES.map((s) => s.versionLabel).filter(Boolean)]);
    const byLabel = new Map<string, { id: string; version: number; label: string; status: string | null; created_at: string }>();
    for (const row of st.rows as Array<{ label: string; version: number; id: string; created_at: string }>) {
      byLabel.set(row.label, { id: row.id, version: row.version, label: row.label, status: null, created_at: row.created_at });
    }
    /**
     * 阶段 → (版本标签, 该阶段的节点键) —— **从真源取**，不再手写。
     *
     * ⚠ 2026-09-26 改。原先这里是硬编码的三元组数组，只覆盖 phase2/3/4，
     *   而 `phase5Stale` 直接写死 `false` —— 于是**合稿阶段的门禁永远不会触发**
     *   （注释里自认"只有 phase5Version 是真查的"）。现在每个阶段的 stale 都由
     *   `research-stages.ts` 的 `staleNodeKeys` 驱动，phase6 一并有了真判据。
     *
     *   顺带修掉一个更隐蔽的：原来页面里的字段名（phase2/3/4/5）与**阶段号**是两套东西
     *   （`phase3` 其实是"文献与资料"= 新编号 4）。所以下面的映射按阶段表**算出来**，
     *   字段名统一用 `phase${ph}`，前端也照这个读。
     */
    const stagesWithVersion = RESEARCH_STAGES.filter((s) => !!s.versionLabel);
    const nodes = await pool.query(
      `select node_key, updated_at from research_nodes where project_id=$1`,
      [q.projectId]);
    const nodeUpdated = new Map<string, string>();
    for (const n of nodes.rows as Array<{ node_key: string; updated_at: string }>) nodeUpdated.set(n.node_key, n.updated_at);
    const phaseState: Record<string, { version: unknown; stale: boolean }> = {};
    for (const stage of stagesWithVersion) {
      const v = byLabel.get(stage.versionLabel!);
      if (!v) { phaseState[`phase${stage.ph}`] = { version: null, stale: false }; continue; }
      const pubAt = new Date(v.created_at).getTime();
      // 该阶段的节点在这个版本之后又被写过 → 版本落后于内容
      const stale = stage.staleNodeKeys.some((k) => {
        const u = nodeUpdated.get(k);
        return !!u && new Date(u).getTime() > pubAt + 1000;
      });
      phaseState[`phase${stage.ph}`] = { version: { id: v.id, version: v.version, label: v.label }, stale };
    }
    const pv = (ph: number) => phaseState[`phase${ph}`] ?? { version: null, stale: false };
    return {
      success: true,
      state: {
        taskId: q.projectId,
        inputVersion: project.workbench_snapshot?.phase2VersionId ? { id: project.workbench_snapshot.phase2VersionId } : null,
        // 各阶段的版本与 stale 按真源逐条给出（此前 phase3~5 是硬编码常量或恒 false）
        phase2Version: pv(2).version, phase2Stale: pv(2).stale,
        phase4Version: pv(4).version, phase4Stale: pv(4).stale,
        phase5Version: pv(5).version, phase5Stale: pv(5).stale,
        phase6Version: pv(6).version, phase6Stale: pv(6).stale,
        publishedVersion: project.published_version ?? 0,
        updatedAt: new Date().toISOString(),
      },
    };
  });

  // 注册"可跨实例重建"的执行方式: 必须在 DB 领取扫描开始前完成, 否则重启后队列里的
  //   条目会被当成"未知 runner"丢弃 —— 那等于副本重启即任务蒸发。
  void registerAgentQueueRunners().catch((e) =>
    console.error("[agent-queue] 执行方式注册失败:", String(e?.message ?? e).slice(0, 140)));

  return app;
}

/** V395-13: 批量任务序列化（Set → 数组, 供 JSON 返回） */
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
  // SOCIOSEEK_PREVIEW=1 时跳过 MCP 池（省内存预览界面，推理/检索不可用）
  if (process.env.SOCIOSEEK_PREVIEW !== "1") {
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

  // T4-1: research 流水线任务调度泵 — queued→执行(章节批量/merge/review/revise 等)
  // 此前只在前端手动 POST /run-scheduling-round 触发, 任务建后无人消费卡 queued
  //
  // V417 关于"多副本要不要加 leader 租约"的结论: **不加**。判据是 —— 这里的正确性靠
  //   `markRunning` 的原子抢占(update ... where status='queued' returning id)保证, 每个任务
  //   只会被一个执行者拿到, 多副本同时泵也不会双跑、不会重复烧 LLM。而租约会让"只有一个副本
  //   在消费队列", 吞吐反而从 N 倍降到 1 倍。leader 门只适用于"重复执行有副作用"的任务
  //   (期刊抓取会被风控、Dream 会重复写隔离区、自愈会重复修复同一条告警) —— 那些都加了。
  let execPumping = false;
  setInterval(async () => {
    if (execPumping) return; // 防止上一轮未完成时重入
    execPumping = true;
    try {
      const r = await researchExec.runSchedulingRound();
      if (r.executed > 0) console.log(`[research-exec] 调度一轮: 执行 ${r.executed} 个任务`);
    } catch (e) {
      console.log(`[research-exec] 调度异常: ${String(e).slice(0, 160)}`);
    } finally {
      execPumping = false;
    }
  }, 2000);
  console.log("[research-exec] 调度泵启动(2s)");

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
    setInterval(runAutonomousResearch, 86400000);
  }, msTo3am);
  autoTimer.unref?.();
  console.log(`[autonomous] 自主研究定时器已启动（下次 ${new Date(Date.now() + msTo3am).toLocaleString("zh-CN")}）`);
}
