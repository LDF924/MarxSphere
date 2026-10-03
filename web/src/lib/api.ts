// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EventDetailRecord,
  EventRecord,
  McpSessionDetail,
  McpSessionRecord,
  McpStreamEvent,
  ModelCallLogRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  PublicAiProviderSettings,
  PublicMcpSettings,
  ChunkingMode,
  DataSourceRecord,
  LiteratureDetailRecord,
  LiteratureRecord,
  PdfRecord,
  PolicyTreeNode,
  SearchMode,
  SearchStreamEvent,
  SearchResult,
  SciverseResponse,
  SkillRecord,
  SkillUpdateResult,
  DiscoverResult,
  EvalStreamEvent,
  SourceRecord,
  TruthEntryRecord,
  TruthPageDetail,
  TruthPageRecord,
  UploadJobRecord,
  VaultFileRecord,
  VaultTreeNode,
  ForumThread,
  ForumReply
} from "../types";


/** API 错误(对齐 Zleap ApiError): 携带 status 与业务 code。 */
export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  layer?: string;
  stage?: string;
  retryable?: boolean;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    layer?: string,
    stage?: string,
    retryable?: boolean,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.layer = layer;
    this.stage = stage;
    this.retryable = retryable;
  }
}

function safeParseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Minion 任务队列条目（对齐后端 jobs-service MinionJob） */
export interface MinionJob {
  id: string;
  jobType: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed" | "dead" | "cancelled" | "waiting-children" | "paused";
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  delayUntil?: string;
  parentJobId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** 与 request() 一致的鉴权头构造（流式接口手写 fetch 时复用，避免缺失 Authorization 被 401 拦截） */
function authHeaders(init?: { headers?: HeadersInit }): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    const token = localStorage.getItem("sag_token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = authHeaders(init);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  const text = await response.text();
  const data = safeParseJson(text);
  if (!response.ok) {
    const message = data?.error?.message ?? `请求失败：${response.status}`;
    throw new ApiError(
      response.status,
      data?.error?.code ?? "http_error",
      message,
    );
  }
  // 防御: 200 但空 body/非 JSON（服务重启瞬间/代理故障/SPA fallback 接住请求）
  // → safeParseJson 返回 null → 调用方 .projects 等访问崩溃弹错误条
  if (data === null) {
    throw new Error(`接口返回空响应：${url}`);
  }
  return data as T;
}

/** 广场条目 —— 列表与详情共用; `status` 比提交状态多一个 `local`(本机有、还没提交) */
export interface PlazaItemRecord {
  id: string; slug: string; title: string; summary: string; category: string; tags: string[];
  origin: string; version: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "local";
  reviewNote: string; ownerId: string; ownerName: string;
  installCount: number; commentCount: number;
  submittedAt: string; reviewedAt: string | null;
  installed: boolean; mine: boolean; useCount?: number;
}

export const api = {
  // ═══ Skill 广场(2026-10-03) ═══
  // 全都走 request()(自带 Authorization) —— 裸 fetch 漏鉴权头这个坑本轮已经踩过两次
  // (首页当前课题、Word 预览), 表现都是"界面上什么都没有, 而控制台不报错"。
  async getSkillPlaza(o: { scope?: "" | "mine" | "pending"; q?: string; category?: string; sort?: "new" | "hot" | "name" } = {}) {
    const p = new URLSearchParams();
    if (o.scope) p.set("scope", o.scope);
    if (o.q) p.set("q", o.q);
    if (o.category) p.set("category", o.category);
    if (o.sort) p.set("sort", o.sort);
    return request<{
      items: PlazaItemRecord[];
      total: number;
      counts: { approved: number; pending: number; mine: number; local: number };
      /** 侧栏统计 —— 服务端基于全量算(不是当前筛选结果) */
      facets: {
        categories: Array<{ name: string; count: number }>;
        tags: Array<{ name: string; count: number }>;
        sources: Array<{ name: string; count: number }>;
      };
    }>(`/api/skills/plaza?${p}`);
  },
  async getSkillPlazaStats() {
    return request<{ approved: number; pending: number; installs: number; contributors: number; comments: number }>("/api/skills/plaza/stats");
  },
  async getSkillSubmission(id: string) {
    return request<{ item: PlazaItemRecord; steps: string[]; currentStep: number }>(
      `/api/skills/plaza/${encodeURIComponent(id)}`);
  },
  async submitSkill(input: { slug: string; title: string; summary?: string; category?: string; tags?: string[]; version?: string }) {
    return request<{ ok: boolean; id: string; status: string }>("/api/skills/plaza/submit", {
      method: "POST", body: JSON.stringify(input),
    });
  },
  async reviewSkill(id: string, approve: boolean, note = "") {
    return request<{ ok: boolean; status: string }>(`/api/skills/plaza/${encodeURIComponent(id)}/review`, {
      method: "POST", body: JSON.stringify({ approve, note }),
    });
  },
  async withdrawSkill(id: string) {
    return request<{ ok: boolean }>(`/api/skills/plaza/${encodeURIComponent(id)}/withdraw`, { method: "POST", body: "{}" });
  },
  async installSkill(id: string) {
    return request<{ ok: boolean; already?: boolean }>(`/api/skills/plaza/${encodeURIComponent(id)}/install`, { method: "POST", body: "{}" });
  },
  async getSkillComments(id: string) {
    return request<{ comments: Array<{ id: string; parentId: string | null; userId: string; author: string; body: string; createdAt: string }> }>(
      `/api/skills/plaza/${encodeURIComponent(id)}/comments`);
  },
  async addSkillComment(id: string, body: string, parentId?: string | null) {
    return request<{ ok: boolean; id: string }>(`/api/skills/plaza/${encodeURIComponent(id)}/comments`, {
      method: "POST", body: JSON.stringify({ body, parentId }),
    });
  },
  async curateSkills() {
    return request<{ added: number; skipped: number }>("/api/skills/plaza/curate", { method: "POST", body: "{}" });
  },

  // ═══ 学友论坛(2026-10-03) ═══
  async getForumBoards() {
    return request<{ boards: Array<{ id: string; slug: string; name: string; description: string; sortOrder: number; isBuiltin: boolean; threadCount: number; todayCount: number; lastReplyAt: string | null }> }>("/api/forum/boards");
  },
  async getForumStats() {
    return request<{
      stats: { boards: number; threads: number; replies: number; todayThreads: number; todayReplies: number; members: number };
      recent: Array<{ threadId: string; title: string; author: string; at: string }>;
    }>("/api/forum/stats");
  },
  async getForumThreads(o: { board?: string; q?: string; tag?: string; sort?: string; limit?: number } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
    return request<{ threads: ForumThread[]; total: number }>(`/api/forum/threads?${p}`);
  },
  async createForumThread(input: { board: string; title: string; body: string; tags?: string[] }) {
    return request<{ ok: boolean; id: string }>("/api/forum/threads", { method: "POST", body: JSON.stringify(input) });
  },
  async getForumThread(id: string) {
    return request<{ thread: ForumThread; replies: ForumReply[] }>(`/api/forum/threads/${encodeURIComponent(id)}`);
  },
  async addForumReply(threadId: string, body: string, parentId?: string | null) {
    return request<{ ok: boolean; id: string }>(`/api/forum/threads/${encodeURIComponent(threadId)}/replies`, {
      method: "POST", body: JSON.stringify({ body, parentId }),
    });
  },
  async voteForum(targetType: "thread" | "reply", targetId: string) {
    return request<{ ok: boolean; voted: boolean; count: number }>("/api/forum/vote", {
      method: "POST", body: JSON.stringify({ targetType, targetId }),
    });
  },
  async starForum(threadId: string) {
    return request<{ ok: boolean; starred: boolean }>("/api/forum/star", { method: "POST", body: JSON.stringify({ threadId }) });
  },
  async moderateForum(threadId: string, action: "pin" | "unpin" | "digest" | "undigest" | "delete") {
    return request<{ ok: boolean }>("/api/forum/moderate", { method: "POST", body: JSON.stringify({ threadId, action }) });
  },


  /**
   * 首页「当前课题」。
   *
   * ⚠ 必须走 `request()`(它带 Authorization), **不能**裸 `fetch` —— 这两条路由要登录,
   *   而裸 fetch 不带 token, 结果是 401 被 `.catch(()=>{})` 吞掉, 首页上那块直接不渲染。
   *   界面上看不出任何异常(服务器没报错、控制台没红字), 只有"那里什么都没有"。
   *   我第一版正是这么写的, 实测首页课题块整个消失, 排查到才发现是缺鉴权头。
   */
  async getHomeTopic() {
    return request<{ title: string; keywords: string[]; updatedAt: string }>("/api/home/topic");
  },
  async setHomeTopic(input: { title: string; keywords: string[] }) {
    return request<{ title: string; keywords: string[]; updatedAt: string }>("/api/home/topic", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  async suggestHomeTopicKeywords(topic: string) {
    return request<{
      topic: string;
      candidates: Array<{ text: string; origin: "corpus" | "llm"; from?: string }>;
      sources: Array<{ id: string; ok: boolean; count: number; note?: string }>;
    }>("/api/home/topic/suggest", {
      method: "POST",
      body: JSON.stringify({ topic }),
    });
  },

  async listProjects(includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ projects: SourceRecord[] }>(`/api/projects${query}`);
  },

  async createProject(input: { name: string; description?: string | null }) {
    return request<{ project: SourceRecord }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async updateProject(projectId: string, input: { name?: string; description?: string | null }) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/archive`, {
      method: "POST"
    });
  },

  async restoreProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/restore`, {
      method: "POST"
    });
  },

  async deleteProject(projectId: string) {
    return request<{ deleted: boolean }>(`/api/projects/${projectId}?permanent=true`, {
      method: "DELETE"
    });
  },

  async listDocuments(projectId: string, includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ documents: DocumentRecord[] }>(`/api/projects/${projectId}/documents${query}`);
  },

  async getProjectStats(projectId: string) {
    return request<{ stats: ProjectStatsRecord }>(`/api/projects/${projectId}/stats`);
  },

  async getProjectGraph(projectId: string) {
    return request<{ graph: ProjectGraphRecord }>(`/api/projects/${projectId}/graph`);
  },

  async getDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`);
  },

  async listChunks(documentId: string) {
    return request<{ chunks: ChunkRecord[] }>(`/api/documents/${documentId}/chunks`);
  },

  async listEvents(documentId: string) {
    return request<{ events: EventRecord[] }>(`/api/documents/${documentId}/events`);
  },

  async listEntities(documentId: string) {
    return request<{ entities: EntityRecord[] }>(`/api/documents/${documentId}/entities`);
  },

  async updateDocument(documentId: string, input: { title?: string }) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/archive`, {
      method: "POST"
    });
  },

  async restoreDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/restore`, {
      method: "POST"
    });
  },

  async deleteDocument(documentId: string) {
    return request<{ deleted: boolean }>(`/api/documents/${documentId}?permanent=true`, {
      method: "DELETE"
    });
  },

  // ── 论文分享（2026-08-29, frowang /s/:token 分享模式）──
  async createPaperShare(documentId: string, opts: { expiresHours?: number; maxUses?: number } = {}) {
    return request<{ ok: boolean; url: string; token: string }>("/api/papers/share", {
      method: "POST",
      body: JSON.stringify({ documentId, ...opts })
    });
  },

  async receivePaperShare(token: string, sourceId: string) {
    return request<{ ok: boolean; imported: boolean; title?: string }>(`/api/papers/share/${encodeURIComponent(token)}/receive`, {
      method: "POST",
      body: JSON.stringify({ sourceId })
    });
  },

  async listMyShares() {
    return request<{ ok: boolean; shares: Array<{ token: string; title: string; useCount: number; maxUses: number | null; expiresAt: string | null }> }>("/api/papers/share/my");
  },

  async getEvent(eventId: string) {
    return request<EventDetailRecord>(`/api/events/${eventId}`);
  },

  async getEntity(entityId: string) {
    return request<EntityDetailRecord>(`/api/entities/${entityId}`);
  },

  async uploadDocument(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{
      sourceId: string;
      documentId: string;
      chunkCount: number;
      eventCount: number;
      document: DocumentRecord | null;
    }>("/api/documents/upload", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createUploadJob(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{ job: UploadJobRecord }>("/api/documents/upload/jobs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getUploadJob(jobId: string) {
    return request<{ job: UploadJobRecord }>(`/api/documents/upload/jobs/${jobId}`);
  },

  async listActiveUploadJobs() {
    return request<{ jobs: UploadJobRecord[] }>("/api/documents/upload/jobs");
  },

  async listModelCallLogs(afterSequence = 0) {
    return request<{
      logs: ModelCallLogRecord[];
      latestSequence: number;
    }>(`/api/model-call-logs?after=${encodeURIComponent(String(afterSequence))}`);
  },

  async search(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
  }) {
    return request<SearchResult>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK
      })
    });
  },

  async streamSearch(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
    sources?: Array<"pg" | "graphiti" | "cognee">;
    /** G2: 返回请求级检索图(query→entity→event→chunk) */
    returnGraph?: boolean;
  }, onEvent: (event: SearchStreamEvent) => void) {
    const response = await fetch("/api/search/stream", {
      method: "POST",
      headers: authHeaders({ headers: { "Content-Type": "application/json" } }),
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK,
        ...(input.returnGraph ? { returnGraph: true } : {}),
        ...(input.sources ? { sources: input.sources } : {})
      })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  },

  /** 评测实时运行：POST /api/eval/run（SSE）— 事件流复用 readSseStream */
  async streamEvalRun(input: {
    script: "eval-32-metrics" | "run-eval-dual" | "ablation-eval";
    questions?: string;
    output?: string;
    dims?: string;
    mergePolicy?: string;
    limit?: number;
    operators?: string;
    /** V381: 评测配置（模型/模式/机制）——透传为 EVAL_* 环境变量 */
    env?: Record<string, string>;
  }, onEvent: (event: EvalStreamEvent) => void, signal?: AbortSignal) {
    const response = await fetch("/api/eval/run", {
      method: "POST",
      headers: authHeaders({ headers: { "Content-Type": "application/json" } }),
      body: JSON.stringify(input),
      ...(signal ? { signal } : {})
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  },

  /** 评测学习引擎：P0-2 归因数据（GET /api/eval/failures） */
  async getEvalFailures() {
    return request<{
      categoryCounts: Array<{ category: string; count: number }>;
      layerCounts?: Array<{ layer: string; count: number }>;  // V329: 三层验证分布
      items: Array<{
        eval_run_id: string; question_id: string; failure_category: string;
        first_error_step: string | null; tool_name: string | null; evidence: string | null;
        root_cause: string | null; is_recoverable: boolean | null; confidence: number | null;
        layer?: string | null;
      }>;
      runId: string | null;
      total: number;
    }>("/api/eval/failures");
  },

  /** 评测学习引擎：读报告文件内容（GET /api/eval/reports?name=xxx_report.md） */
  async getEvalReport(name: string) {
    return request<{
      name: string; exists: boolean; content: string; updatedAt: string | null;
    }>(`/api/eval/reports?name=${encodeURIComponent(name)}`);
  },

  /** 评测学习引擎：列报告文件列表（GET /api/eval/reports） */
  async listEvalReports() {
    return request<{
      files: Array<{ name: string; updatedAt: string; size: number }>;
    }>("/api/eval/reports");
  },

  /** V298: 闭环流转聚合（GET /api/eval/loop）— 四闭环状态一次返回 */
  async getEvalLoop() {
    return request<{
      loops: Record<string, {
        id: string; label: string; enabled: boolean; trigger: string;
        status: "ready" | "empty"; counts: Record<string, number>;
        lastRun: string | null; items: Array<{ id: string; source: string; status: string }>;
      }>;
    }>("/api/eval/loop");
  },

  /** V326: 记忆统计（P1-4/P1-8 前端展示） */
  async getMemoryStats() {
    return request<{ total: number; archived: number; conflicts: number; vectorized: number }>("/api/memory/stats");
  },

  /** V335: 睡眠学习报告（P1-8） */
  async getSleepReport() {
    return request<{ lastReport: { duplicates: number; archived_duplicates: number; conflicts: number; pruned: number; at: string | null } | null; current: { archived: number; conflicts: number } }>("/api/memory/sleep-report");
  },

  /** V337: 记忆注入设置（用户控制） */
  async getMemoryInjectSettings() {
    return request<{ settings: { enabled: string; mode: string; count: string }; note?: string }>("/api/settings/memory-inject");
  },
  async saveMemoryInjectSettings(input: { enabled?: string; mode?: string; count?: number }) {
    return request<{ ok: boolean; settings?: { enabled: string; mode: string; count: string }; note?: string; error?: string }>("/api/settings/memory-inject", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  /** V338: 成本监控（P2-3） */
  async getCostSummary(days = 7) {
    return request<{ totalTokensIn: number; totalTokensOut: number; estimatedCost: number; taskCount: number; byModel: Record<string, { tokensIn: number; tokensOut: number; cost: number }> }>(`/api/cost/summary?days=${days}`);
  },
  async getTodayCost() {
    return request<{ date: string; cost: number; tokensIn: number; tokensOut: number }>("/api/cost/today");
  },

  /** V326: 最近记忆列表 */
  async getRecentMemories(limit = 10) {
    return request<{ items: Array<{ query: string; qtype: string; success: boolean; quality_score: number | null; archived: boolean; conflict_unsolved: boolean; created_at: string }> }>(`/api/memory/recent?limit=${limit}`);
  },

  /** V327: 技能审计摘要（P1-2） */
  async getSkillAudit() {
    return request<{ exists: boolean; total?: number; complete?: number; gaps?: Array<{ gap: string; count: number }> }>("/api/skills/audit");
  },

  /** V331: 技能语义搜索（P1-3 找技能） */
  async searchSkills(q: string, top = 5) {
    return request<{ found: boolean; candidates: Array<{ skillName: string; similarity: number }> }>(`/api/skills/search?q=${encodeURIComponent(q)}&top=${top}`);
  },

  /** V331: 预算感知记录（P1-9） */
  async getBudgetPrunes(limit = 10) {
    return request<{ items: Array<{ taskId: string; query: string; op: string; executedCost: number; budget: number; createdAt: string }> }>(`/api/eval/budget-prunes?limit=${limit}`);
  },

  /** V328: 知识 PR 草稿状态（P1-7） */
  async getTruthDrafts() {
    return request<{ statusCounts: Array<{ status: string; n: number }>; recent: Array<{ id: number; title: string; status: string; review_verdict: string | null; proposer_model: string | null; reviewer_model: string | null; created_at: string }> }>("/api/truth/drafts");
  },

  async listMcpSessions(projectId?: string) {
    if (projectId) {
      return request<{ sessions: McpSessionRecord[] }>(`/api/projects/${projectId}/mcp/sessions`);
    }
    return request<{ sessions: McpSessionRecord[] }>("/api/mcp/sessions");
  },

  async createMcpSession(input: { title?: string; sourceIds?: string[]; kind?: "project" | "chat" }) {
    return request<{ session: McpSessionRecord }>("/api/mcp/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}`);
  },

  async clearMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}/clear`, {
      method: "POST"
    });
  },

  async deleteMcpSession(sessionId: string) {
    return request<{ deleted: boolean }>(`/api/mcp/sessions/${sessionId}`, {
      method: "DELETE"
    });
  },

  async deleteMcpMessage(sessionId: string, messageId: string) {
    return request<{ deleted: boolean }>(`/api/mcp/sessions/${sessionId}/messages/${messageId}`, {
      method: "DELETE"
    });
  },

  async sendMcpMessage(sessionId: string, content: string) {
    return request<{
      detail: McpSessionDetail;
    }>(`/api/mcp/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
  },

  async streamMcpMessage(
    sessionId: string,
    content: string,
    onEvent: (event: McpStreamEvent) => void,
    options: { signal?: AbortSignal } = {}
  ) {
    const response = await fetch(`/api/mcp/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      signal: options.signal,
      headers: authHeaders({ headers: { "Content-Type": "application/json" } }),
      body: JSON.stringify({ content })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }

    await readSseStream(response, onEvent);
  },

  // ── V398: 通用 AI 对话（ChatPanel）──

  async renameMcpSession(sessionId: string, title: string) {
    return request<{ session: McpSessionRecord }>(`/api/mcp/sessions/${sessionId}/rename`, {
      method: "POST",
      body: JSON.stringify({ title })
    });
  },

  async listChatSessions() {
    return request<{ sessions: McpSessionRecord[] }>("/api/chat/sessions");
  },

  async uploadChatImage(dataUrl: string) {
    return request<{ path: string; name: string; sizeKB: number }>("/api/chat/uploads", {
      method: "POST",
      body: JSON.stringify({ dataUrl })
    });
  },

  async approveChatTool(approvalId: string, approved: boolean) {
    return request<{ ok: boolean; approved: boolean }>(`/api/chat/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ approved })
    });
  },

  async streamChatMessage(
    sessionId: string,
    input: { content: string; images?: Array<{ dataUrl: string; name: string }>; webSearch?: boolean; deepMode?: boolean; reasoningEffort?: "low" | "high" | "max"; docs?: Array<{ dataUrl: string; name: string }> },
    onEvent: (event: McpStreamEvent) => void,
    options: { signal?: AbortSignal } = {}
  ) {
    const response = await fetch(`/api/chat/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      signal: options.signal,
      headers: authHeaders({ headers: { "Content-Type": "application/json" } }),
      body: JSON.stringify(input)
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }

    await readSseStream(response, onEvent);
  },

  async getAiSettings() {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai");
  },

  async getMcpSettings() {
    return request<{ settings: PublicMcpSettings }>("/api/settings/mcp");
  },

  async updateAiSettings(input: {
    embeddingBaseUrl: string;
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingApiKey?: string;
    clearEmbeddingApiKey?: boolean;
    llmBaseUrl: string;
    llmModel: string;
    llmApiKey?: string;
    clearLlmApiKey?: boolean;
    llmTimeoutMs: number;
    llmMaxRetries: number;
    defaultSearchMode: SearchMode;
    defaultSearchTopK: number;
    defaultChunkingMode: ChunkingMode;
    chunkTokenLimit: number;
    chunkOverlapTokens: number;
  }) {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },

  // ─── Sciverse 外部检索 ───
  async sciverseStatus() {
    return request<{ configured: boolean; baseUrl: string }>("/api/sciverse/status");
  },

  async sciverseCatalog(collection = "papers") {
    return request<SciverseResponse>(`/api/sciverse/catalog?collection=${encodeURIComponent(collection)}`);
  },

  async sciverseSearch(tool: string, params: Record<string, unknown>) {
    return request<SciverseResponse>("/api/sciverse/search", {
      method: "POST",
      body: JSON.stringify({ tool, ...params })
    });
  },

  // ─── Skills 注册表 ───
  async listSkills() {
    return request<{ skills: SkillRecord[] }>("/api/skills");
  },

  async runSkillHealthcheck(name: string) {
    return request<{
      name: string;
      exists: boolean;
      status: string;
      output: string;
      exitCode: number | null;
    }>(`/api/skills/${encodeURIComponent(name)}/healthcheck`, {
      method: "POST"
    });
  },

  // ─── 技能自动更新检测 ───
  // ── 研究速递 (2026-10-02) ──
  async digestGet(days?: number) {
    return request<{ date: string; total: number; topics: Record<string, unknown[]>; journals: Record<string, unknown[]>; uncoveredJournals: string[] }>(
      `/api/digest${days ? `?days=${days}` : ""}`
    );
  },
  async digestRefresh() {
    return request<{ ok: boolean; users: number; topics: number; inserted: number; dup: number; summarized: number }>(
      "/api/digest/refresh", { method: "POST" }
    );
  },
  async digestDates(limit = 30) {
    return request<{ dates: string[] }>(`/api/digest/dates?limit=${limit}`);
  },
  async digestUnread() {
    return request<{ unread: number }>("/api/digest/unread");
  },
  async digestRead(ids: string[] = []) {
    return request<{ marked: number }>("/api/digest/read", { method: "POST", body: JSON.stringify({ ids }) });
  },
  async digestTopicsGet() {
    return request<{ topics: string[]; preferredJournals: string[]; days: number; uncoveredJournals: string[] }>("/api/digest/topics");
  },
  async digestTopicsSet(input: { topics: string[]; preferredJournals: string[]; days?: number }) {
    return request<{ topics: string[]; preferredJournals: string[]; days: number; uncoveredJournals: string[] }>(
      "/api/digest/topics", { method: "POST", body: JSON.stringify(input) }
    );
  },
  async digestRuns(limit = 10) {
    return request<{ runs: unknown[] }>(`/api/digest/runs?limit=${limit}`);
  },

  // ── 用户通知中心 (2026-10-02) ──
  async notificationsList(opts: { unread?: boolean; limit?: number; category?: string } = {}) {
    const p = new URLSearchParams();
    if (opts.unread) p.set("unread", "1");
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.category) p.set("category", opts.category);
    const qs = p.toString();
    return request<{ notifications: Array<{ id: string; category: string; level: string; title: string; body: string; link: Record<string, unknown>; readAt: string | null; createdAt: string }> }>(
      `/api/notifications${qs ? `?${qs}` : ""}`
    );
  },
  async notificationsUnread() {
    return request<{ unread: number }>("/api/notifications/unread");
  },
  async notificationsRead(ids: string[] = []) {
    return request<{ marked: number }>("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids }) });
  },
  async notificationsClear() {
    return request<{ cleared: number }>("/api/notifications/clear", { method: "POST" });
  },

  async scanSkillUpdates() {
    return request<SkillUpdateResult>("/api/skills/update-scan");
  },

  async checkSkillUpstream(skillName?: string) {
    return request<SkillUpdateResult>("/api/skills/update-scan/upstream", {
      method: "POST",
      body: JSON.stringify({ skillName })
    });
  },

  async confirmNewSkill(name: string) {
    return request<{ ok: boolean; category: string }>("/api/skills/update/confirm", {
      method: "POST",
      body: JSON.stringify({ name })
    });
  },

  async dismissSkillUpdate(name: string) {
    return request<{ ok: boolean }>("/api/skills/update/dismiss", {
      method: "POST",
      body: JSON.stringify({ name })
    });
  },

  // ─── GitHub 发现（需求直通）───
  async githubDiscover(input: { need: string; mode: "api" | "claude"; perSource?: number }) {
    return request<DiscoverResult>("/api/github/discover", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getSkillDetail(name: string) {
    return request<{
      name: string;
      skillMd: string;
      zhDoc?: string;
      files: string[];
    }>(`/api/skills/${encodeURIComponent(name)}/detail`);
  },

  async skillify(input: {
    name: string;
    title: string;
    description?: string;
    triggers?: string[];
    notTriggers?: string[];
    steps: string[];
    checklist?: string[];
    recipes?: string[];
  }) {
    return request<{ ok: boolean; path?: string; error?: string }>("/api/skills/skillify", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // ─── Vault 政策资料库 ───
  async getVaultTree() {
    return request<{ root: string; nodes: VaultTreeNode[] }>("/api/vault/tree");
  },

  async getVaultFile(filePath: string) {
    return request<{ file: VaultFileRecord }>(`/api/vault/file?path=${encodeURIComponent(filePath)}`);
  },

  // ─── Compiled Truth + Timeline ───
  async listTruthPages() {
    return request<{ pages: TruthPageRecord[] }>("/api/truth/pages");
  },

  async getTruthPage(pageId: string) {
    return request<TruthPageDetail>(`/api/truth/pages/${pageId}`);
  },

  async createTruthPage(input: { title: string; compiledTruth?: string; sourceHint?: string; tags?: string[] }) {
    return request<{ page: TruthPageRecord }>("/api/truth/pages", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async rewriteTruth(pageId: string, input: { compiledTruth: string; source?: string }) {
    return request<{ result: { oldTruth: string; page: TruthPageRecord } }>(`/api/truth/pages/${pageId}/compiled-truth`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },

  async appendTruthEntry(pageId: string, input: { content: string; entryType?: string; source?: string; confidence?: number }) {
    return request<{ entry: TruthEntryRecord }>(`/api/truth/pages/${pageId}/entries`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async deleteTruthEntry(pageId: string, entryId: string) {
    return request<{ deleted: boolean }>(`/api/truth/pages/${pageId}/entries/${entryId}`, {
      method: "DELETE"
    });
  },

  async deleteTruthPage(pageId: string) {
    return request<{ deleted: boolean }>(`/api/truth/pages/${pageId}`, {
      method: "DELETE"
    });
  },

  // ─── 本地文献库 ───
  async getLiterature(input: { topic?: string; author?: string; year?: string; keyword?: string; page?: number; pageSize?: number }) {
    const params = new URLSearchParams();
    if (input.topic) params.set("topic", input.topic);
    if (input.author) params.set("author", input.author);
    if (input.year) params.set("year", input.year);
    if (input.keyword) params.set("keyword", input.keyword);
    if (input.page) params.set("page", String(input.page));
    if (input.pageSize) params.set("pageSize", String(input.pageSize));
    return request<{ total: number; items: LiteratureRecord[]; page: number; pageSize: number }>(`/api/literature?${params.toString()}`);
  },

  async getLiteratureCatalog() {
    return request<{ catalog: { topics: string[]; authors: string[]; years: string[]; total: number }; scanDir: string }>("/api/literature/catalog");
  },

  async getLiteratureDetail(id: string) {
    return request<{ detail: LiteratureDetailRecord }>(`/api/literature/${id}`);
  },

  async getLiteratureCitations(id: string) {
    return request<{ citations: { count: number; entries: Array<{ raw: string; authors?: string; title?: string; year?: string; type?: string }> } | null }>(`/api/literature/${id}/citations`);
  },

  // 知网引文网络（CDP 代理）
  async getCnkiCitations(type: string) {
    return request<{
      ok: boolean;
      type: string;
      paperTitle?: string;
      items: Array<{ raw: string }>;
      /** 注意: `ok:true` 且 items 为空时, 这里带的是**空结果的解释**(如「此类引文为 0, 属正常」), 不是失败原因 */
      error?: string;
    }>(`/api/cnki/citations/${encodeURIComponent(type)}`);
  },

  // 知网搜索并打开论文详情页
  async searchCnkiOpen(query: string) {
    return request<{
      ok: boolean;
      tabId?: string;
      paperTitle?: string;
      error?: string;
    }>("/api/cnki/search-open", {
      method: "POST",
      body: JSON.stringify({ query })
    });
  },

  // AI 执行桥（面板 → Claude Code）
  async aiExecuteStatus() {
    return request<{ available: boolean }>("/api/ai-execute/status");
  },
  async aiExecute(input: { prompt: string; cwd?: string; timeoutMs?: number; noTools?: boolean; model?: string }) {
    return request<{
      ok: boolean;
      output: string;
      exitCode: number | null;
      tookMs: number;
      error?: string;
    }>("/api/ai-execute", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  /** 2026-08-07 LLM 直接执行（替代 Claude CLI）：直调 LLM API */
  async executeLlm(input: { prompt: string; model?: string }) {
    return request<{
      ok: boolean;
      output: string;
      model: string;
      tookMs: number;
    }>("/api/ai/execute", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // LLM 关系抽取（快速建联深度模式）
  async llmExtractRelations(input: {
    text: string;
    relationTypes: Array<{ id: string; label: string }>;
  }) {
    return request<{ triples: Array<{ subject: string; relation: string; relationLabel: string; object: string }> }>("/api/quick-links/llm-extract", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // Jobs 任务队列
  async listJobs(input?: { status?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.status) params.set("status", input.status);
    if (input?.limit) params.set("limit", String(input.limit));
    return request<{ jobs: MinionJob[]; stats: Record<string, number> }>(`/api/jobs?${params.toString()}`);
  },
  async enqueueJob(jobType: string, payload?: Record<string, unknown>) {
    return request<{ job: MinionJob }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ jobType, payload })
    });
  },
  async deleteJob(jobId: string) {
    return request<{ deleted: boolean }>(`/api/jobs/${jobId}`, { method: "DELETE" });
  },
  // Trace Waterfall
  async listTraces(input?: { limit?: number }) {
    const params = new URLSearchParams();
    if (input?.limit) params.set("limit", String(input.limit));
    return request<{ traces: Array<{ traceId: string; name: string; spanCount: number; startedAt: string }> }>(`/api/traces?${params.toString()}`);
  },
  async listTracesGrouped(input?: { perGroup?: number }) {
    const params = new URLSearchParams();
    if (input?.perGroup) params.set("perGroup", String(input.perGroup));
    return request<{ ask: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>; ingest: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>; other: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }> }>(`/api/traces/grouped?${params.toString()}`);
  },
  async listTraceSpans(traceId: string) {
    return request<{ spans: Array<Record<string, unknown>> }>(`/api/traces/${traceId}`);
  },
  async deleteTrace(traceId: string) {
    return request<{ ok: boolean; deleted: number }>(`/api/traces/${traceId}`, { method: "DELETE" });
  },
  async deleteTracesBatch(traceIds: string[]) {
    return request<{ ok: boolean; deleted: number }>("/api/traces/batch", {
      method: "DELETE",
      body: JSON.stringify({ traceIds })
    });
  },
  async clearTraces() {
    return request<{ ok: boolean; deleted: number }>("/api/traces", { method: "DELETE" });
  },

  // PDF 全库检索（1 万篇）
  async searchPdfs(input: { topic?: string; keyword?: string; page?: number; pageSize?: number }) {
    const params = new URLSearchParams();
    if (input.topic) params.set("topic", input.topic);
    if (input.keyword) params.set("keyword", input.keyword);
    if (input.page) params.set("page", String(input.page));
    if (input.pageSize) params.set("pageSize", String(input.pageSize));
    return request<{ total: number; items: PdfRecord[]; page: number; pageSize: number }>(`/api/literature/pdfs?${params.toString()}`);
  },

  /** PDF 文件下载 URL（PdfReader 深度阅读用）: path=磁盘路径 或 id=文献 id */
  pdfFileUrl(input: { path?: string; id?: string }) {
    const params = new URLSearchParams();
    if (input.path) params.set("path", input.path);
    if (input.id) params.set("id", input.id);
    return `/api/literature/pdf-file?${params.toString()}`;
  },

  /** 划词翻译（翻译服务, 模型中立） */
  async translateSnippet(input: { snippet: string; context?: string; targetLang?: string }) {
    return request<{ ok: boolean; original?: string; translated?: string; error?: string }>("/api/translate/snippet", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  /** PDF 选中文本 AI 卡片（Agentero 对照: 解释/总结/翻译/追问） */
  async readerAi(input: { action: "explain" | "summarize" | "translate" | "ask"; snippet: string; context?: string; question?: string }) {
    return request<{ ok: boolean; result?: string; error?: string }>("/api/reader/ai", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // 中国政府网政策检索
  async searchPolicy(input: { keyword: string; pageSize?: number }) {
    const params = new URLSearchParams();
    params.set("keyword", input.keyword);
    if (input.pageSize) params.set("pageSize", String(input.pageSize));
    return request<{ count: number; items: Array<{ title: string; url: string; date: string; level: string; summary?: string }>; error?: string }>(`/api/policy/search?${params.toString()}`);
  },

  // 外部数据源体系（29 源）
  async getSources() {
    return request<{ sources: DataSourceRecord[]; total: number }>("/api/external-sources");
  },

  async searchExternalSource(input: { source: "openalex" | "core" | "worldbank" | "github"; query: string; limit?: number }) {
    const params = new URLSearchParams();
    params.set("source", input.source);
    params.set("q", input.query);
    if (input.limit) params.set("limit", String(input.limit));
    return request<{ source: string; items: Array<Record<string, unknown>>; error?: string }>(`/api/sources/search?${params.toString()}`);
  },

  // 运行模式徽标（preview/full）
  async getMode() {
    return request<{
      mode: "preview" | "full" | "degraded";
      mcpPoolSize: number;
      health?: { neo4j: { graphiti: boolean; cognee: boolean }; pythonProcesses: number; label: string };
    }>("/api/mode");
  },
  async switchMode(mode: "preview" | "full") {
    return request<{ ok: boolean; mode: string; note: string }>("/api/mode", {
      method: "POST",
      body: JSON.stringify({ mode })
    });
  },

  // 检索步骤详情文档（GBrain 教学台）───
  async getSearchStepDocs() {
    return request<{ steps: Array<{ key: string; title: string; what: string; sql?: string; formula?: string; code?: string }> }>("/api/search/step-docs");
  },

  // 消融实验（关掉算子对比检索效果）
  async runAblation(input: { query: string; sourceIds: string[] }) {
    return request<{ baselineCount: number; operators: Array<{ operator: string; ablatedCount: number; overlapWithBaseline: number; hitChangePct: number }> }>("/api/search/ablation", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  // 自定义组合消融（勾选任意算子组合关闭，对比基线）
  async runCustomAblation(input: { query: string; sourceIds: string[]; ablation: string[] }) {
    return request<{ baselineCount: number; ablatedCount: number; overlapWithBaseline: number; hitChangePct: number; closedOperators: string[] }>("/api/search/ablation/custom", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // 政策资料库
  async getPolicyLibraryTree() {
    return request<{ root: string; nodes: PolicyTreeNode[] }>("/api/policy-library/tree");
  },

  async savePolicyToLibrary(input: { title: string; url: string; date?: string; summary?: string; category?: string }) {
    return request<{ ok: boolean; path?: string; existed?: boolean; error?: string }>("/api/policy-library/save", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // 已连接的 MCP 工具大全
  async getMcpTools() {
    return request<{ servers: Array<{ serverId: string; serverName: string; description: string; tools: string[]; toolDescriptions: Array<{ name: string; desc: string; group: string; schema?: Record<string, { type: string; description: string; required?: boolean }>; example?: Record<string, unknown> }>; connected: boolean }>; total: number }>("/api/mcp/tools");
  },

  // MCP 动态连接状态
  async getMcpStatus() {
    return request<{ status: Record<string, boolean> }>("/api/mcp/status");
  },

  // ─── 证据 → LLM 综合回答（Ask 面板闭环）───
  async composeAnswer(query: string, evidence: Array<{ title: string; content: string; heading?: string }>) {
    return request<{ answer: string; citations: Array<{ index: number; title: string }> }>("/api/compose-answer", {
      method: "POST",
      body: JSON.stringify({ query, evidence })
    });
  },

  // ─── 检索即记忆：检索结果关联知识页 ───
  async associateSearch(query: string, evidence: Array<{ title: string; content: string }>) {
    return request<{ matchedPage: boolean; pageId?: string; pageTitle?: string; evidenceAdded: number }>("/api/truth/associate", {
      method: "POST",
      body: JSON.stringify({ query, evidence })
    });
  },

  // ─── Skillify 自动检测固化 ───
  async recordSkillifyPattern(query: string, success: boolean, evidenceTitles: string[]) {
    return request<{ ok: boolean }>("/api/skills/skillify/record", {
      method: "POST",
      body: JSON.stringify({ query, success, evidenceTitles })
    });
  },

  async getSkillifyCandidates(threshold = 3) {
    return request<{ candidates: Array<{ topic: string; count: number; lastQuery: string }> }>(`/api/skills/skillify/candidates?threshold=${threshold}`);
  },

  async generateSkillifySkill(topic: string) {
    return request<{ ok: boolean; path?: string; error?: string }>(`/api/skills/skillify/candidates/${encodeURIComponent(topic)}/generate`, {
      method: "POST"
    });
  }
};

async function readSseStream<T>(response: Response, onEvent: (event: T) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine.slice(6)) as T);
    }
  }
  if (buffer.trim()) {
    const dataLine = buffer.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) {
      onEvent(JSON.parse(dataLine.slice(6)) as T);
    }
  }
}

// ─── 对外 API 令牌（SocioSeek 对外接入）───
export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  revoked: boolean;
  last_used_at: string | null;
  created_at: string;
  quotaStatus?: TokenQuotaStatus;
}

export interface TokenQuota {
  dailySearchLimit: number;
  dailyIngestBytesLimit: number;
  monthlyCostLimitUsd: number;
  rateLimitPerMin: number;
  dailyP2oLimit: number;  // V395-11: 每日 PDF 导入上限
}

export interface TokenQuotaStatus extends TokenQuota {
  searchesToday: number;
  blockedSearches: number;
  ingestBytesToday: number;
  p2oTasksToday: number;  // V395-11
  costThisMonth: number;
  overSearchQuota: boolean;
  overIngestQuota: boolean;
  overP2oQuota: boolean;  // V395-11
  overCostQuota: boolean;
  retryAfterSec: number;
}

export interface DailyUsagePoint {
  date: string;
  searches: number;
  ingestBytes: number;
  cost: number;
  calls: number;
}

// ─── 实证研究执行工作台（V348+）───
export interface EmpiricalMethod {
  id: string; label: string; en: string; desc: string; category: string; engine: string; skills: string[];
}
export interface EmpiricalRunInput {
  data: { columnOrder: string[]; rows: (string | number | null)[][] };
  method: string;
  params: Record<string, unknown>;
  preprocess?: { winsorize?: string[]; log?: string[]; standardize?: string[] };
  projectId?: string;  // V413: 落课题流水线(回归类自动出森林图)
}
export const apiEmpirical = {
  async methods(): Promise<{ methods: EmpiricalMethod[] }> {
    return request<{ methods: EmpiricalMethod[] }>("/api/empirical/methods");
  },
  async reliability(input: {
    projectId?: string | null; dataVersionId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    scaleGroups: { name: string; columns: string[] }[];
  }): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    return request<{ ok: boolean; taskId?: string; error?: string }>("/api/empirical/reliability", {
      method: "POST", body: JSON.stringify(input),
    });
  },
  async diagnosis(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    fieldNotes: string;
  }): Promise<{ ok: boolean; report: any }> {
    return request<{ ok: boolean; report: any }>("/api/empirical/diagnosis", {
      method: "POST", body: JSON.stringify(input),
    });
  },
  async gates(projectId: string): Promise<{ gates: any[] }> {
    return request<{ gates: any[] }>(`/api/empirical/gates?projectId=${encodeURIComponent(projectId)}`);
  },
  async gateAction(id: string, action: "lock" | "confirm" | "reopen", note?: string): Promise<{ gate: any }> {
    return request<{ gate: any }>(`/api/empirical/gates/${encodeURIComponent(id)}/${action}`, {
      method: "POST", body: JSON.stringify(note ? { note } : {}),
    });
  },
  async gateUpsert(projectId: string, node: string, content: any): Promise<{ gate: any }> {
    return request<{ gate: any }>("/api/empirical/gates/upsert", {
      method: "POST", body: JSON.stringify({ projectId, node, content }),
    });
  },
  // ── LLM 民调插补（V380+）──
  async imputationStart(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    targetCol: string; contextCols: string[]; fieldInfo?: string; codingOptions?: number[];
  }): Promise<{ ok: boolean; runId?: string; nImputed?: number; junkCells?: any[] }> {
    return request("/api/empirical/imputation/start", { method: "POST", body: JSON.stringify(input) });
  },
  async imputationGet(runId: string): Promise<{ run: any }> {
    return request(`/api/empirical/imputation/${encodeURIComponent(runId)}`);
  },
  async imputationBatch(runId: string, cells: { id: string; confirmed?: boolean; editedValue?: string }[]): Promise<{ ok: boolean; confirmed: number }> {
    return request("/api/empirical/imputation/batch", { method: "POST", body: JSON.stringify({ runId, cells }) });
  },
  async imputationCompare(input: {
    runId: string;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    targetCol: string; contextCols: string[]; fieldInfo?: string; codingOptions?: number[];
  }): Promise<{ ok: boolean; baselineCompare?: any[]; stats?: any }> {
    return request("/api/empirical/imputation/compare", { method: "POST", body: JSON.stringify(input) });
  },
  // ── 变量敲定（V380+）──
  async variablesSuggest(input: {
    projectId?: string | null; topic?: string; columns: string[]; nRows: number;
    missingRates?: Record<string, number>; questionMeta?: any;
  }): Promise<{ ok: boolean; suggestion: any }> {
    return request("/api/empirical/variables/suggest", { method: "POST", body: JSON.stringify(input) });
  },
  async variablesSave(projectId: string, content: any): Promise<{ gate: any }> {
    return request("/api/empirical/variables/save", { method: "POST", body: JSON.stringify({ projectId, node: "variable_definition", content }) });
  },
  // ── 数据管道（V380+）──
  async pipeline(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    steps: any;
  }): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    return request("/api/empirical/pipeline", { method: "POST", body: JSON.stringify(input) });
  },
  async pipelineStata(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    steps: any;
  }): Promise<{ ok: boolean; stataCode?: string; error?: string }> {
    return request("/api/empirical/pipeline/stata", { method: "POST", body: JSON.stringify(input) });
  },
  async pipelineVerify(input: any): Promise<{ ok: boolean; report: any }> {
    return request("/api/empirical/pipeline/verify", { method: "POST", body: JSON.stringify(input) });
  },
  // ── 回归生成（V380+）──
  async regressionGenerate(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    spec: any;
  }): Promise<{ ok: boolean; code?: string; meta?: any; error?: string }> {
    return request("/api/empirical/regression/generate", { method: "POST", body: JSON.stringify(input) });
  },
  async regressionRun(input: {
    projectId?: string | null;
    data: { columnOrder: string[]; rows: (string | number | null)[][] };
    spec: any; code: string;
  }): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    return request("/api/empirical/regression/run", { method: "POST", body: JSON.stringify(input) });
  },
  async regressionDebug(input: { projectId?: string | null; code: string; errorLog: string; columns: string[] }): Promise<{ ok: boolean; fixedCode?: string; explanation?: string; changedLines?: string[] }> {
    return request("/api/empirical/regression/debug", { method: "POST", body: JSON.stringify(input) });
  },
  async regressionTemplates(spec: any): Promise<{ templates: Record<string, string> }> {
    const qs = `dep=${encodeURIComponent(spec.dep ?? "y")}&core=${encodeURIComponent(spec.core?.[0] ?? "x")}`;
    return request(`/api/empirical/regression/templates?${qs}`);
  },
  // ── 证据账本 / 结果解释（V380+）──
  async ledgerList(projectId: string): Promise<{ entries: any[] }> {
    return request(`/api/empirical/ledger?projectId=${encodeURIComponent(projectId)}`);
  },
  async ledgerAdd(input: { projectId: string; runId: string; tableIndex: number; rowIndex: number; colIndex: number; dataVersionId?: string | null; citeKeys?: string[] }): Promise<{ ok: boolean; entry?: any; error?: string }> {
    return request("/api/empirical/ledger/add-from-result", { method: "POST", body: JSON.stringify(input) });
  },
  async ledgerUpdateRefs(id: string, input: { codeSnippet?: string; dataVersionId?: string | null; citeKeys?: string[] }): Promise<{ ok: boolean; entry?: any }> {
    return request(`/api/empirical/ledger/${encodeURIComponent(id)}/update-refs`, { method: "POST", body: JSON.stringify(input) });
  },
  async ledgerDelete(id: string): Promise<{ ok: boolean }> {
    return request(`/api/empirical/ledger/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async ledgerCitations(projectId: string): Promise<{ citations: any[] }> {
    return request(`/api/empirical/ledger/citations?projectId=${encodeURIComponent(projectId)}`);
  },
  async ledgerAddCitation(input: { projectId: string; citeKey: string; title: string; authors?: string; source?: string; url?: string }): Promise<{ ok: boolean; citation?: any }> {
    return request("/api/empirical/ledger/citations", { method: "POST", body: JSON.stringify(input) });
  },
  async interpretationDraft(input: { projectId?: string | null; runId: string; tablesText: string }): Promise<{ ok: boolean; draft?: any; error?: string }> {
    return request("/api/empirical/interpretation/draft", { method: "POST", body: JSON.stringify(input) });
  },
  async interpretationSave(projectId: string, content: any): Promise<{ gate: any }> {
    return request("/api/empirical/interpretation/save", { method: "POST", body: JSON.stringify({ projectId, node: "result_interpretation", content }) });
  },
  async run(input: EmpiricalRunInput): Promise<{ ok: boolean; taskId: string; error?: string }> {
    return request<{ ok: boolean; taskId: string; error?: string }>("/api/empirical/run", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  async result(taskId: string): Promise<{ status: string; result?: unknown; error?: string }> {
    return request<{ status: string; result?: unknown; error?: string }>(`/api/empirical/result/${encodeURIComponent(taskId)}`);
  },
  async skills(): Promise<{ skills: unknown[] }> {
    return request<{ skills: unknown[] }>("/api/empirical/skills");
  },
  async meta(): Promise<{ venvReady: boolean; statsModels: boolean; statspai: boolean; python: string }> {
    return request<{ venvReady: boolean; statsModels: boolean; statspai: boolean; python: string }>("/api/empirical/meta");
  },
  async history(limit = 20): Promise<{ history: unknown[] }> {
    return request<{ history: unknown[] }>(`/api/empirical/history?limit=${limit}`);
  },
  async historyDetail(id: string): Promise<{ record: unknown }> {
    return request<{ record: unknown }>(`/api/empirical/history/${encodeURIComponent(id)}`);
  },
  async historyDelete(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/empirical/history/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async export(format: "latex" | "csv", recordId?: string, table?: unknown): Promise<string> {
    const r = await fetch("/api/empirical/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format, recordId, table }),
    });
    return r.text();
  },
  async saveKnowledge(id: string): Promise<{ ok: boolean; pageId?: string }> {
    return request<{ ok: boolean; pageId?: string }>(`/api/empirical/${encodeURIComponent(id)}/knowledge`, { method: "POST" });
  },
  async datasets(): Promise<{ datasets: unknown[] }> {
    return request<{ datasets: unknown[] }>("/api/empirical/datasets");
  },
  async fetchDataset(table: string, limit = 2000): Promise<{ data: { columnOrder: string[]; rows: (string | number | null)[][] } }> {
    return request<{ data: { columnOrder: string[]; rows: (string | number | null)[][] } }>("/api/empirical/datasets/fetch", {
      method: "POST",
      body: JSON.stringify({ table, limit }),
    });
  },
};

// ─── 实证研究工作台增强（V380+）: 课题/问卷/数据版本 ───
export interface QuestionOption { code: number; label: string }
export interface SkipLogic { ifQid: string; ifOption: number | null; goto: string }
export interface Question {
  qid: string; varName: string; stem: string;
  type: "cat" | "ordinal" | "cont" | "text" | "multi";
  options?: QuestionOption[]; skipLogic?: SkipLogic | null; derived?: string;
}
export interface EmpiricalProject { id: string; title: string; topic: string; status: string; created_at: string }
export interface EmpiricalQuestionnaire { id: string; projectId: string | null; title: string; source: string; columns: string[]; meta: any; created_at: string }
export interface EmpiricalDataVersion {
  id: string; projectId: string | null; name: string; columns: string[]; nRows: number;
  meta: any; created_at: string;
  /** V399-2 P2 补齐(ScienceX 实验表格哈希): 数据内容哈希 — 前端可判重/溯源 */
  contentHash?: string | null;
  /** V399-2 P2(092): 数据本体(行数组) — 下游分析选中版本时用真数据 */
  data?: (string | number | null)[][] | null;
}

export const apiEmpiricalWorkshop = {
  async projects(): Promise<{ projects: EmpiricalProject[] }> {
    return request<{ projects: EmpiricalProject[] }>("/api/empirical/projects");
  },
  async createProject(input: { title: string; topic?: string }): Promise<{ project: EmpiricalProject }> {
    return request<{ project: EmpiricalProject }>("/api/empirical/projects", { method: "POST", body: JSON.stringify(input) });
  },
  async generateQuestionnaire(input: { projectId?: string; title?: string; topic: string; extra?: string; nQuestions?: number }): Promise<{ ok: boolean; questionnaire: { id: string; questions: Question[]; meta: any; columns: string[] } }> {
    return request("/api/empirical/questionnaires/generate", { method: "POST", body: JSON.stringify(input) });
  },
  async recognizeQuestionnaire(input: { projectId?: string; title?: string; rawText: string }): Promise<{ ok: boolean; questionnaire: { id: string; questions: Question[]; meta: any; columns: string[] } }> {
    return request("/api/empirical/questionnaires/recognize", { method: "POST", body: JSON.stringify(input) });
  },
  // V412: 问卷文件解析（PDF/Word/Excel/PPT → 文本，服务端 Python 解析）
  async parseQuestionnaireFile(input: { fileName: string; base64: string }): Promise<{ ok: boolean; text: string; error?: string }> {
    return request("/api/empirical/questionnaires/parse-file", { method: "POST", body: JSON.stringify(input) });
  },
  async questionnaires(projectId?: string): Promise<{ questionnaires: EmpiricalQuestionnaire[] }> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/empirical/questionnaires${qs}`);
  },
  // V413: 问卷仿真数据生成(按已识别结构 → N 份带内在结构的模拟作答; 可带 latent 设计/跳答/挖缺)
  async simulateData(input: { projectId?: string; questionnaireId?: string; questionnaire?: Question[]; params?: Record<string, unknown> }): Promise<{ ok: boolean; taskId?: string; error?: string; questionnaireId?: string | null }> {
    return request("/api/empirical/simulate", { method: "POST", body: JSON.stringify(input) });
  },
  // V413: 论文级图表生成(alpha_bar/boxplot/heatmap/forest/compare → PNG/PDF, 静态可访问)
  async generateFigures(spec: Record<string, unknown>): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    return request("/api/empirical/figures", { method: "POST", body: JSON.stringify({ spec }) });
  },
  figuresUrl(file: string): string {
    return `/api/empirical/figures/${encodeURIComponent(file)}`;
  },
  /** V413: 查询实证 Python 任务结果(仿真/绘图等共用) */
  async taskResult(taskId: string): Promise<{ status: string; result?: any; error?: string }> {
    return request(`/api/empirical/result/${taskId}`);
  },
  /** V413: 课题流水线总览(问卷+数据版本+全阶段 runs) */
  async projectPipeline(projectId: string): Promise<{ overview: any }> {
    return request(`/api/empirical/projects/${projectId}/pipeline`);
  },
  /** V413: 课题全套报告导出(LaTeX + Word) */
  async exportReport(projectId: string): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    return request(`/api/empirical/projects/${projectId}/report`, { method: "POST", body: "{}" });
  },
  async dataVersions(projectId?: string): Promise<{ versions: EmpiricalDataVersion[] }> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/empirical/data-versions${qs}`);
  },
  async saveDataVersion(input: {
    projectId?: string; name: string; columns: string[]; nRows: number;
    /** V399-2 P2 补齐: 数据内容 sha256（同内容重传服务端判重返回 duplicate） */
    contentHash?: string;
    /** V399-2 P2 补齐: 数据行（可选）— 服务端自动生成列画像存 meta.profile */
    rows?: unknown[][];
    meta?: any;
  }): Promise<{ version: { id: string; duplicate?: boolean; duplicateReason?: string } }> {
    return request("/api/empirical/data-versions", { method: "POST", body: JSON.stringify(input) });
  },
};

// ─── 演示数据（V380+）: 基于农村经营形态问卷 PDF 生成的全量模拟作答 ───
export interface DemoData { ok: boolean; data?: { columnOrder: string[]; rows: (string | number | null)[][] }; meta?: any; error?: string }
export const apiEmpiricalDemo = {
  async load(missing?: boolean): Promise<DemoData> {
    return request<DemoData>(`/api/empirical/demo${missing ? "?missing=1" : ""}`);
  },
  async questionnaireText(): Promise<{ ok: boolean; text?: string; meta?: any; error?: string }> {
    return request<{ ok: boolean; text?: string; meta?: any; error?: string }>("/api/empirical/demo/questionnaire-text");
  },
};

export const apiTokens = {
  async list(): Promise<ApiTokenRecord[]> {
    const r = await request<{ tokens: ApiTokenRecord[] }>("/api/tokens");
    return r.tokens;
  },
  async create(name: string, permissions: string[], quota?: Partial<TokenQuota>): Promise<{ token: string; record: ApiTokenRecord }> {
    return request<{ token: string; record: ApiTokenRecord }>("/api/tokens", {
      method: "POST",
      body: JSON.stringify(quota ? { name, permissions, quota } : { name, permissions }),
    });
  },
  async revoke(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/tokens/${id}/revoke`, { method: "POST" });
  },
  async remove(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/tokens/${id}`, { method: "DELETE" });
  },
  quota: {
    async get(id: string): Promise<{ status: TokenQuotaStatus }> {
      return request<{ status: TokenQuotaStatus }>(`/api/tokens/${id}/quota`);
    },
    async update(id: string, patch: Partial<TokenQuota>): Promise<{ quota: TokenQuota }> {
      return request<{ quota: TokenQuota }>(`/api/tokens/${id}/quota`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
    },
    async usage(id: string, days = 7): Promise<{ days: DailyUsagePoint[] }> {
      return request<{ days: DailyUsagePoint[] }>(`/api/tokens/${id}/usage?days=${days}`);
    },
  },
};

// ─── 文档浏览（DocsPanel 渲染 docs/*.md）───
export interface DocEntry {
  id: string;
  title: string;
  group: string;
  /**
   * 相对 docs/ 的文件路径(如 `integrations/claude-code.md`)。
   * ⚠ 2026-09-29 补: 文档正文里的相对链接是**按文件名**写的(`[项目概述](PROJECT-OVERVIEW.md)`),
   *   前端要靠 path 把它反查成 id 才能"切到该文档"——没有它就只能显示成点不动的字面量。
   */
  path: string;
}

export const apiDocs = {
  async get(id?: string): Promise<{ index: DocEntry[]; current: { id: string; title: string; content: string } }> {
    return request<{ index: DocEntry[]; current: { id: string; title: string; content: string } }>(
      `/api/docs${id ? `?id=${id}` : ""}`
    );
  },
};

// ─── Explore 知识宇宙(阶段4b 快照契约, 对齐 Zleap /api/v1/universe/*)───
import type {
  UniverseGraphPatch,
  UniverseManifest,
  UniverseNodeDetail,
  UniverseTimelineSlice,
} from "./universe-types";

export interface UniverseBackgroundJob {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "paused";
  source_id: string | null;
  document_id: string | null;
  progress: number;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const apiUniverse = {
  async manifest(): Promise<UniverseManifest> {
    return request<UniverseManifest>("/api/universe/manifest");
  },
  async timeline(
    body: {
      epoch: number;
      source_id: string;
      limit?: number;
      direction?: "older" | "newer";
      cursor?: string | null;
      snapshot_id?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<UniverseTimelineSlice> {
    return request<UniverseTimelineSlice>("/api/universe/timeline", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  },
  async expand(
    body: {
      epoch: number;
      source_id: string;
      node_kind: "event" | "entity";
      node_id: string;
      limit?: number;
      cursor?: string | null;
      snapshot_id?: string | null;
      after?: string | null;
      before?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<UniverseGraphPatch> {
    return request<UniverseGraphPatch>("/api/universe/expand", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  },
  async nodeDetail(
    kind: "event" | "entity",
    id: string,
    sourceId?: string | null,
  ): Promise<UniverseNodeDetail> {
    const query = sourceId ? `?source_id=${encodeURIComponent(sourceId)}` : "";
    return request<UniverseNodeDetail>(`/api/universe/nodes/${kind}/${id}${query}`);
  },
  async rebuild(signal?: AbortSignal): Promise<UniverseBackgroundJob> {
    return request<UniverseBackgroundJob>("/api/universe/rebuild", {
      method: "POST",
      signal,
    });
  },
  async job(id: string, signal?: AbortSignal): Promise<UniverseBackgroundJob> {
    return request<UniverseBackgroundJob>(`/api/universe/jobs/${id}`, { signal });
  },
};


/**
 * 支付订单(2026-10-01)。
 *
 * 由来: 此前前端"充值"直接 POST /api/billing/recharge —— 那个接口**不给钱也加余额**,
 *   是开发期占位。现在改走真链路: 下单 → 出二维码 → 轮询查单。
 *   `/api/billing/recharge` 已收紧为本机/管理员, 前端不再调用它。
 *
 * 查单要带 `sync=1`: 让后端**主动向微信查一次**并补入账。
 *   回调可能永远不来(网络抖动/服务重启), 只靠回调会出现"付了钱但余额没动"。
 */
export interface PaymentOrder {
  id: string;
  outTradeNo: string;
  userId: string;
  amountCents: number;
  currency: string;
  subject: string;
  kind: string;
  targetRef: string | null;
  status: "created" | "pending" | "paid" | "closed" | "failed" | "refunding" | "refunded";
  provider: string;
  transactionId: string | null;
  codeUrl: string | null;
  paidAt: string | null;
  expireAt: string;
  createdAt: string;
}

export interface PayConfig {
  mchId: string;
  enabled: boolean;
  hasPlatformCert: boolean;
  notifyUrl: string;
  isMock: boolean;
}

export const payApi = {
  async config(signal?: AbortSignal): Promise<PayConfig> {
    return request<PayConfig>("/api/pay/config", { signal });
  },

  /** 下单。idemKey 用来防重复点击 —— 同一 key 重复提交只会有一单 */
  async createOrder(body: {
    amountCents: number;
    subject?: string;
    kind?: "recharge" | "subscription" | "points";
    targetRef?: string;
    idemKey?: string;
  }, signal?: AbortSignal): Promise<{ ok: boolean; order: PaymentOrder; mock: boolean; reused: boolean }> {
    return request("/api/pay/orders", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },

  async listOrders(limit = 50, signal?: AbortSignal): Promise<{ orders: PaymentOrder[] }> {
    return request(`/api/pay/orders?limit=${limit}`, { signal });
  },

  /** 查单。sync=true 时后端会主动向渠道查一次并补入账 */
  async getOrder(outTradeNo: string, sync = false, signal?: AbortSignal): Promise<{ ok: boolean; order: PaymentOrder }> {
    return request(`/api/pay/orders/${encodeURIComponent(outTradeNo)}${sync ? "?sync=1" : ""}`, { signal });
  },

  async refund(body: {
    outTradeNo: string; amountCents?: number; reason?: string; idemKey?: string;
  }, signal?: AbortSignal): Promise<{ ok: boolean; refundedCents: number; duplicate?: boolean }> {
    return request("/api/pay/refunds", { method: "POST", body: JSON.stringify(body), signal });
  },
};

/** Word 成品构建: LaTeX→OMML 公式 / 封面+目录(自旧项目移植) */
export const docxBuildApi = {
  async health(signal?: AbortSignal): Promise<{ ok: boolean; python: string; missing: string[]; hint?: string }> {
    return request("/api/docx-build/health", { signal });
  },
  async latexToDocx(body: {
    content: string; title?: string; fontName?: string; fontSize?: number;
  }, signal?: AbortSignal): Promise<{ ok: boolean; base64: string; meta?: Record<string, unknown> }> {
    return request("/api/docx-build/latex-to-docx", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },
  async coverToc(body: {
    docxBase64: string; title?: string;
    position?: "high" | "center" | "low"; engine?: "auto" | "python" | "com";
  }, signal?: AbortSignal): Promise<{ ok: boolean; base64: string; meta?: Record<string, unknown> }> {
    return request("/api/docx-build/cover-toc", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },
};

/**
 * 2026-10-01 新增能力的客户端(自旧项目 AItoolman 移植的那 9 项)。
 * 逐条对应 src/api/server.ts 里的路由。
 */
export const aigcApi = {
  async detect(text: string, lang: "auto" | "zh" | "en" = "auto", signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/aigc/detect", {
      method: "POST", body: JSON.stringify({ text, lang }), signal,
    });
  },
  /** 降重前后对比 —— 这条才是"降 AIGC 到底有没有用"的判据 */
  async diff(before: string, after: string, lang: "auto" | "zh" | "en" = "auto", signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/aigc/diff", {
      method: "POST", body: JSON.stringify({ before, after, lang }), signal,
    });
  },
};

export const literatureImportApi = {
  async formats(signal?: AbortSignal) {
    return request<{ formats: Array<{ id: string; label: string; extensions: string[] }> }>(
      "/api/literature-import/formats", { signal });
  },
  /** 先预览再入库 —— 用户能看清"识别成什么格式、前几条长什么样" */
  async preview(content: string, fileName?: string, signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/literature-import/preview", {
      method: "POST", body: JSON.stringify({ content, fileName }), signal,
    });
  },
  async run(content: string, fileName?: string, format?: string, signal?: AbortSignal) {
    return request<{ imported: number; skipped: number; failed: number }>(
      "/api/literature-import/run", {
        method: "POST", body: JSON.stringify({ content, fileName, format }), signal,
      });
  },
};

export const opinionApi = {
  async sources(signal?: AbortSignal) {
    return request<{ sources: Array<Record<string, unknown>> }>("/api/opinion/sources", { signal });
  },
  async search(body: { query: string; days?: number; limit?: number }, signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/opinion/search", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },
  async sentiment(texts: string[], signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/opinion/sentiment", {
      method: "POST", body: JSON.stringify({ texts }), signal,
    });
  },
};

export const keywordNetworkApi = {
  /** 从平台文献库现算图谱 */
  async fromLibrary(body: {
    limit?: number; topic?: string; keyword?: string;
    lang?: "zh" | "en" | "both"; measure?: "jaccard" | "pmi" | "count";
  }, signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/keyword-network/from-library", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },
  async build(texts: string[], lang: "zh" | "en" | "both" = "zh", signal?: AbortSignal) {
    return request<Record<string, unknown>>("/api/keyword-network/build", {
      method: "POST", body: JSON.stringify({ texts, lang }), signal,
    });
  },
};

export const wordcloudApi = {
  async health(signal?: AbortSignal) {
    return request<{ ok: boolean; font?: string; error?: string }>("/api/wordcloud/health", { signal });
  },
  async render(body: { text?: string; width?: number; height?: number; maxWords?: number }, signal?: AbortSignal) {
    return request<{ ok: boolean; base64?: string; words?: Array<{ word: string; weight: number }> }>(
      "/api/wordcloud/render", { method: "POST", body: JSON.stringify(body), signal });
  },
};

export const pptApi = {
  /** 建任务 —— 服务端会**顺手生成大纲**, 返回 outlinePages 表示出了几页 */
  async createJob(body: { topic: string; title?: string; kind?: "topic" | "paper" | "outline"; wishPages?: number }, signal?: AbortSignal) {
    return request<{ ok: boolean; job: { id: string }; outlinePages?: number }>("/api/ppt/jobs", {
      method: "POST", body: JSON.stringify(body), signal,
    });
  },
  /** 单独重生成大纲(改了主题或想换页数时用) */
  async regenOutline(id: string, body: { wantPages?: number; sourceText?: string } = {}, signal?: AbortSignal) {
    return request<{ ok: boolean; pages: number }>(
      `/api/ppt/jobs/${encodeURIComponent(id)}/outline`, {
        method: "POST", body: JSON.stringify(body), signal,
      });
  },
  async listJobs(signal?: AbortSignal) {
    return request<{ jobs: Array<Record<string, unknown>> }>("/api/ppt/jobs", { signal });
  },
  async getJob(id: string, signal?: AbortSignal) {
    return request<Record<string, unknown>>(`/api/ppt/jobs/${encodeURIComponent(id)}`, { signal });
  },
  async pages(id: string, signal?: AbortSignal) {
    return request<{ pages: Array<Record<string, unknown>> }>(`/api/ppt/jobs/${encodeURIComponent(id)}/pages`, { signal });
  },
  async editOutline(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return request<Record<string, unknown>>(`/api/ppt/jobs/${encodeURIComponent(id)}/outline`, {
      method: "PUT", body: JSON.stringify(body), signal,
    });
  },
  async generateScripts(id: string, signal?: AbortSignal) {
    return request<Record<string, unknown>>(`/api/ppt/jobs/${encodeURIComponent(id)}/scripts`, {
      method: "POST", body: "{}", signal,
    });
  },
  async illustrate(id: string, seq?: number, signal?: AbortSignal) {
    return request<Record<string, unknown>>(`/api/ppt/jobs/${encodeURIComponent(id)}/illustrate`, {
      method: "POST", body: JSON.stringify({ seq }), signal,
    });
  },
  async regenPage(id: string, seq: number, instruction?: string, signal?: AbortSignal) {
    return request<Record<string, unknown>>(
      `/api/ppt/jobs/${encodeURIComponent(id)}/pages/${seq}/regen`, {
        method: "POST", body: JSON.stringify({ instruction }), signal,
      });
  },
  async annotate(id: string, seq: number, note: string, rect: { x: number; y: number; w: number; h: number }, signal?: AbortSignal) {
    return request<Record<string, unknown>>(
      `/api/ppt/jobs/${encodeURIComponent(id)}/pages/${seq}/annotate`, {
        method: "POST", body: JSON.stringify({ note, rect }), signal,
      });
  },
  async pageVersions(id: string, seq: number, signal?: AbortSignal) {
    return request<{ versions: Array<Record<string, unknown>> }>(
      `/api/ppt/jobs/${encodeURIComponent(id)}/pages/${seq}/versions`, { signal });
  },
  async rollback(id: string, seq: number, version: number, signal?: AbortSignal) {
    return request<Record<string, unknown>>(
      `/api/ppt/jobs/${encodeURIComponent(id)}/pages/${seq}/rollback`, {
        method: "POST", body: JSON.stringify({ version }), signal,
      });
  },
  async exportPptx(id: string, mode: "editable" | "image" = "editable", signal?: AbortSignal) {
    return request<{ ok: boolean; base64?: string }>(`/api/ppt/jobs/${encodeURIComponent(id)}/export`, {
      method: "POST", body: JSON.stringify({ mode }), signal,
    });
  },
};

// ═══ 中文互联网热榜 + 网页归档(2026-10-03) ═══
// 与 api 对象分开导出, 因为它们是**后来的一组能力**(对照观澜/Guanlan), 不挤进主 api 命名空间
export const apiWeb = {
  async getHotBoards() {
    return request<{ boards: Array<{ id: string; name: string; category: string; evidenceRole: string }> }>("/api/hotboard/list");
  },
  async fetchHotBoards(o: { ids?: string[]; limit?: number } = {}) {
    return request<{
      boards: Array<{
        id: string; name: string; category: string; evidenceRole: string;
        ok: boolean; via: string; stale: boolean; error?: string;
        items: Array<{ rank: number; title: string; url: string; heat: number; summary?: string }>;
      }>;
      okCount: number; total: number; fetchedAt: string;
    }>("/api/hotboard/fetch", { method: "POST", body: JSON.stringify(o) });
  },
  async readWebPage(url: string, maxChars?: number) {
    return request<{
      ok: boolean; url: string; finalUrl?: string; title: string; markdown: string; error?: string;
      quality: { label: string; score: number; chars: number; cjkChars: number; noiseHits: string[]; mojibake: boolean; weak: boolean; lineCount: number; avgLineLen: number; noiseRatio: number };
    }>("/api/web/read", { method: "POST", body: JSON.stringify({ url, maxChars }) });
  },
  async listArchives(o: { limit?: number; q?: string } = {}) {
    const p = new URLSearchParams();
    if (o.limit) p.set("limit", String(o.limit));
    if (o.q) p.set("q", o.q);
    return request<{
      items: Array<{
        id: string; url: string; title: string; snapshotCount: number;
        firstSeenAt: string; lastSeenAt: string; qualityScore: number | null; qualityLabel: string; tags: string[];
      }>;
    }>(`/api/archive/list?${p}`);
  },
  async addArchive(o: { url: string; text?: string; title?: string; tags?: string[]; toVault?: boolean }) {
    return request<{
      ok: boolean; status: "created" | "unchanged" | "failed";
      archiveId?: string; snapshotId?: string; error?: string;
      vault: { path: string; name: string } | null;
    }>("/api/archive/add", { method: "POST", body: JSON.stringify(o) });
  },
  async archiveHistory(id: string) {
    return request<{
      snapshots: Array<{ id: string; fetchedAt: string; chars: number; passages: number; via: string; quality: { label?: string; score?: number } }>;
    }>(`/api/archive/history?id=${encodeURIComponent(id)}`);
  },
  async archiveDiff(left: string, right: string) {
    return request<{ added: string[]; removed: string[]; unchanged: number }>(
      `/api/archive/diff?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
  },
  async locateArchive(q: string) {
    return request<{ hits: Array<{ url: string; ord: number; startOffset: number; text: string; fetchedAt: string }> }>(
      `/api/archive/locate?q=${encodeURIComponent(q)}`);
  },
  async deleteArchive(id: string) {
    return request<{ ok: boolean }>(`/api/archive/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
