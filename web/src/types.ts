export interface SourceRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  title: string;
  status: string;
  parseStatus: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  source?: SourceRecord;
}

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
}

export interface ChunkRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  heading?: string | null;
  content: string;
  rawContent?: string | null;
  rank: number;
  references: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  embedding?: EmbeddingPreview | null;
}

export interface EventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  chunkId?: string | null;
  title: string;
  summary: string;
  content: string;
  rank: number;
  score?: number;
  entityCount?: number;
  entities?: EntityRecord[];
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  description?: string | null;
  eventCount?: number;
  score?: number;
  embedding?: EmbeddingPreview | null;
}

export interface EventDetailRecord {
  event: EventRecord;
  entities: EntityRecord[];
  document?: DocumentRecord | null;
  source?: SourceRecord | null;
  chunk?: {
    chunkId: string;
    sourceId?: string;
    documentId?: string | null;
    heading?: string;
    content: string;
    rank?: number;
  };
}

export interface EntityDetailRecord {
  entity: EntityRecord & { eventCount: number };
  events: EventRecord[];
  source?: SourceRecord | null;
}

export interface SearchResult {
  traceId: string;
  sections: Array<{
    chunkId: string;
    sourceId: string;
    documentId?: string;
    heading?: string;
    content: string;
    rank: number;
    score: number;
    /** 来源溯源：被哪个检索算子捞到 */
    sourceStep?: string;
  }>;
  trace?: Record<string, unknown>;
}

export type SearchMode = "standard" | "fast";
export type ChunkingMode = "heading_strict" | "token";

export interface SearchProgressEvent {
  type: "step";
  status: "running" | "done" | "failed";
  key: string;
  title: string;
  detail: string;
  payload?: unknown;
  durationMs?: number;
}

export interface ProjectStatsRecord {
  documentCount: number;
  chunkCount: number;
  eventCount: number;
  entityCount: number;
}

export interface ProjectGraphEntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  eventCount: number;
}

export interface ProjectGraphEventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  title: string;
  rank: number;
  entityIds: string[];
  /** LLM 推断的事件方向：subject（主动方/指向方）实体 id 列表 */
  subjectIds?: string[];
  /** LLM 推断的事件方向：object（被动方/被指向方）实体 id 列表 */
  objectIds?: string[];
}

export interface ProjectGraphRecord {
  entities: ProjectGraphEntityRecord[];
  events: ProjectGraphEventRecord[];
  edges: Array<{
    entityId: string;
    eventId: string;
  }>;
}

export type SearchStreamEvent =
  | SearchProgressEvent
  | { type: "done"; result: SearchResult }
  | { type: "error"; message: string };

/** 评测实时运行事件（POST /api/eval/run SSE 流） */
export type EvalStreamEvent =
  | { type: "phase"; phase: "start" | "done" | "exit"; total?: number; output?: string; code?: number | null; baseline?: unknown; results?: unknown }
  | { type: "question_start"; question: string; qtype?: string; index?: number; total?: number; phase?: string }
  | { type: "question_done"; question: string; ok: boolean; error?: string; overall?: number; dimA?: number; dimB?: number; dimC?: number; dimD?: number; tMs?: number; aMs?: number; planOps?: number; phase?: string; mrr?: number; ndcg?: number; paperHit?: number }
  | { type: "metric_done"; question: string; key: string; cat?: string; score?: number | null; rule_score?: number | null; llm_score?: number | null; source?: string; reason?: string | null }
  | { type: "log"; line: string }
  | { type: "done"; code?: number | null; output?: string }
  | { type: "error"; message: string };

export interface ModelCallLogRecord {
  sequence: number;
  id: string;
  kind: "llm" | "embedding";
  operation: string;
  status: "SUCCEEDED" | "FAILED";
  createdAt: string;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type UploadJobStage =
  | "QUEUED"
  | "READING"
  | "PARSING"
  | "CHUNKING"
  | "EMBEDDING_CHUNKS"
  | "EXTRACTING_EVENTS"
  | "EMBEDDING_EVENTS"
  | "WRITING_GRAPH"
  | "COMPLETED"
  | "FAILED";

export interface UploadJobRecord {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: UploadJobStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpSessionRecord {
  id: string;
  tenantId: string;
  title: string;
  status: string;
  model?: string | null;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** V398: 会话种类 — project(项目绑定/MCP工具对话) | chat(通用AI对话) */
  kind?: "project" | "chat";
}

export interface McpMessageImage {
  path: string;
  name: string;
}

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  images?: McpMessageImage[] | null;
}

export interface McpToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
  createdAt: string;
}

export interface McpSessionDetail {
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
}

export type McpStreamEvent =
  | { type: "stage"; label: string; detail?: string }
  | { type: "message"; message: McpMessageRecord }
  | { type: "assistant_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "model"; model: string }
  | { type: "tool_approval"; approvalId: string; sessionId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "done"; detail: McpSessionDetail }
  | { type: "error"; message: string };

export interface PublicAiProviderSettings {
  id: "global";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  llmBaseUrl: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  updatedAt: string;
}

export interface PublicMcpSettings {
  toolTimeoutMs: number;
  clientConfigs: Array<{
    id: string;
    title: string;
    description: string;
    config: Record<string, unknown>;
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    example: Record<string, unknown>;
  }>;
}

// ─── Sciverse 外部检索 ───
export interface SciverseResponse {
  configured: boolean;
  tool: string;
  mock: boolean;
  data: unknown;
  ok?: boolean;
  error?: string;
  meta?: {
    query?: string;
    tookMs?: number;
  };
}

// ─── Skills 注册表 ───
export interface SkillRecord {
  name: string;
  description: string;
  triggers: string[];
  notTriggers: string[];
  path: string;
  skillMdPath: string;
  hasHealthcheck: boolean;
  healthcheckPath?: string;
  zhName?: string;
  zhCategory?: string;
  zhDescription?: string;
  version?: string;
  sourceUrl?: string;
}

// ─── 技能自动更新检测 ───
export interface ModifiedSkill {
  name: string;
  kind: "content" | "files";
  since: string;
}

export interface NewSkill {
  name: string;
  category: string;
  detectedAt: string;
}

export interface UpstreamUpdate {
  name: string;
  url: string;
  localVersion: string;
  latestVersion: string;
}

export interface SkillUpdateResult {
  baselineVersion: number;
  newSkills: NewSkill[];
  modifiedSkills: ModifiedSkill[];
  upstreamUpdates: UpstreamUpdate[];
  baselineEstablished?: boolean;
  stats: { total: number; scannedMs: number };
}

// ─── GitHub 发现 ───
export interface DiscoverItem {
  repo: string;
  name: string;
  description: string;
  stars: number;
  language: string;
  updatedAt: string;
  url: string;
  matchedTerm: string;
  scope: string;
}

export interface DiscoverResult {
  intent: { searchTerms: string[]; scopes: string[]; category: string };
  items: DiscoverItem[];
  rateLimited: boolean;
  mode: "api" | "claude";
  analysis?: string;
  tookMs: number;
}

// ─── Vault 政策资料库 ───
export interface VaultTreeNode {
  name: string;
  type: "dir" | "file";
  path: string;
  children?: VaultTreeNode[];
}

export interface VaultFileRecord {
  path: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: string;
}

// ─── Compiled Truth + Timeline ───
export interface TruthPageRecord {
  id: string;
  title: string;
  compiledTruth: string;
  sourceHint?: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
}

export interface TruthEntryRecord {
  id: string;
  pageId: string;
  content: string;
  entryType: string;
  source?: string;
  confidence: number;
  createdAt: string;
}

export interface TruthPageDetail extends TruthPageRecord {
  timeline: TruthEntryRecord[];
}

// ─── 本地文献库 ───
export interface LiteratureRecord {
  id: string;
  title: string;
  paperTitle: string;
  authors: string[];
  topic: string;
  year: string;
  path: string;
  sourcePdf?: string;
  createdAt?: string;
  hasSummary: boolean;
  hasQa: boolean;
  hasTerms: boolean;
}

export interface LiteratureDetailRecord extends LiteratureRecord {
  summary?: string;
  qa?: string;
  terms?: string;
  originalExcerpt?: string;
  originalText?: string;
  indexMeta?: string;
  keywords?: string[];
  category?: string;
}

export interface PdfRecord {
  fileName: string;
  title: string;
  author?: string;
  topic: string;
  path: string;
  indexed: boolean;
}

export interface DataSourceRecord {
  id: string;
  name: string;
  type: "api" | "web" | "mcp" | "auth";
  status: "active" | "ready" | "requires_auth";
  url: string;
  category: string;
  description: string;
  fitScore: number;
}

export interface PolicyTreeNode {
  name: string;
  type: "dir" | "file";
  path: string;
  children?: PolicyTreeNode[];
}
