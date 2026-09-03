// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import "dotenv/config";
import { z } from "zod";

export const SUPPORTED_EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_302AI_BASE_URL = "https://api.302ai.cn/v1";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4173),
  DATABASE_URL: z.string().min(1).default("postgres://sag_lite:sag_lite_pass@localhost:5432/sag_lite"),
  DEFAULT_TENANT_ID: z.string().min(1).default("default"),
  AUTH_MODE: z.enum(["none", "bearer", "external"]).default("none"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(SUPPORTED_EMBEDDING_DIMENSIONS)
    .refine((value) => value === SUPPORTED_EMBEDDING_DIMENSIONS, `EMBEDDING_DIMENSIONS must be ${SUPPORTED_EMBEDDING_DIMENSIONS} because pgvector columns are vector(${SUPPORTED_EMBEDDING_DIMENSIONS})`),
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-large"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_BASE_URL: z.string().url().default(DEFAULT_302AI_BASE_URL),
  // P1备份: .sagbak 产物目录与 Neo4j 导出批大小
  BACKUP_DIR: z.string().min(1).default("backups"),
  NEO4J_EXPORT_BATCH_SIZE: z.coerce.number().int().positive().default(10000),
  // P1备份: 保留最近 N 份备份(0=不清理, 默认 3, 防磁盘堆积)
  BACKUP_KEEP: z.coerce.number().int().min(0).default(3),
  // P2检索: 关系边向量剪枝阈值(0-1, 0=禁用剪枝, 默认 0.35)
  RELATIONAL_EDGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  // G5: 查询改写开关(默认关, 开启后 multiSearch 开头 LLM 改写+实体提取)
  QUERY_REWRITE_ENABLED: z.coerce.boolean().default(false),
  LLM_MODEL: z.string().min(1).default("qwen3.6-flash"),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().url().default(DEFAULT_302AI_BASE_URL),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  GITHUB_TOKEN: z.string().default(""),
  RERANK_BASE_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().min(1).default("qwen3-rerank"),
  RERANK_INSTRUCT: z.string().min(1).default("Given a user question, rank SAG event candidates by relevance and usefulness for retrieval-augmented question answering."),
  DEFAULT_SEARCH_MODE: z.enum(["standard", "fast"]).default("fast"),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(4174),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // 2026-08-27: IM 接入（飞书/钉钉/Telegram webhook 机器人）
  IM_FEISHU_WEBHOOK: z.string().default(""),
  IM_DINGTALK_WEBHOOK: z.string().default(""),
  IM_TELEGRAM_TOKEN: z.string().default(""),
  IM_TELEGRAM_CHAT_ID: z.string().default(""),
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

export const hasRemoteEmbedding = config.EMBEDDING_API_KEY.trim().length > 0;
export const hasRemoteLlm = config.LLM_API_KEY.trim().length > 0;
