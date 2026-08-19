// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import type { AiProviderSettingsRecord, ChunkingMode, PublicAiProviderSettings, SearchMode } from "../types.js";

export const DEFAULT_SEARCH_TOP_K = 10;
export const MAX_SEARCH_TOP_K = 50;
export const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
export const DEFAULT_CHUNK_TOKEN_LIMIT = 512;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;

export interface AiRuntimeSettings {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey: string;
  hasRemoteEmbedding: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  hasRemoteLlm: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
}

export interface UpdateAiSettingsInput {
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
}

export class AiSettingsService {
  async getPublicSettings(): Promise<PublicAiProviderSettings> {
    return toPublicSettings(await this.getSettingsOrFallback());
  }

  async getRuntimeSettings(): Promise<AiRuntimeSettings> {
    const settings = await this.getSettingsOrFallback();
    const embeddingApiKey = settings.embeddingApiKey?.trim() ?? "";
    const llmApiKey = settings.llmApiKey?.trim() ?? "";
    const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    return {
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
      embeddingApiKey,
      hasRemoteEmbedding: embeddingApiKey.length > 0,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey,
      hasRemoteLlm: llmApiKey.length > 0,
      llmTimeoutMs: settings.llmTimeoutMs,
      llmMaxRetries: settings.llmMaxRetries,
      defaultSearchMode: readDefaultSearchMode(settings.metadata),
      defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
      defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
      chunkTokenLimit,
      chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1)
    };
  }

  async updateSettings(input: UpdateAiSettingsInput): Promise<PublicAiProviderSettings> {
    if (input.embeddingDimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new Error(`embeddingDimensions must be ${SUPPORTED_EMBEDDING_DIMENSIONS}`);
    }
    const chunkTokenLimit = clampInteger(input.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    const chunkOverlapTokens = clampInteger(input.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1);
    const current = await this.getSettingsOrFallback();
    const embeddingApiKey = input.clearEmbeddingApiKey ? null : normalizeOptionalSecret(input.embeddingApiKey);
    const llmApiKey = input.clearLlmApiKey ? null : normalizeOptionalSecret(input.llmApiKey);
    const updated = await upsertAiProviderSettings({
      embeddingBaseUrl: input.embeddingBaseUrl.trim(),
      embeddingModel: input.embeddingModel.trim(),
      embeddingDimensions: input.embeddingDimensions,
      embeddingApiKey,
      preserveEmbeddingApiKey: !input.clearEmbeddingApiKey && embeddingApiKey == null,
      llmBaseUrl: input.llmBaseUrl.trim(),
      llmModel: input.llmModel.trim(),
      llmApiKey,
      preserveLlmApiKey: !input.clearLlmApiKey && llmApiKey == null,
      llmTimeoutMs: input.llmTimeoutMs,
      llmMaxRetries: input.llmMaxRetries,
      metadata: {
        updatedVia: "webui",
        previousUpdatedAt: current.updatedAt,
        defaultSearchMode: input.defaultSearchMode,
        defaultSearchTopK: clampInteger(input.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
        defaultChunkingMode: input.defaultChunkingMode,
        chunkTokenLimit,
        chunkOverlapTokens
      }
    });
    return toPublicSettings(updated);
  }

  private async getSettingsOrFallback(): Promise<AiProviderSettingsRecord> {
    if (config.NODE_ENV === "test") {
      return envSettings();
    }
    try {
      const settings = await getAiProviderSettings();
      if (settings) {
        // 2026-08-07 会话显示模型名跟随注册表 reason 角色（用户选择），与推理页/检索页模型选择一致
        const { getRoleModel } = await import("./llm-model-registry.js");
        settings.llmModel = getRoleModel("reason");
        return settings;
      }
    } catch {
      // Tests and fresh installs can run before migrations. Runtime callers still
      // need a deterministic fallback so local operation stays bootstrappable.
    }
    return envSettings();
  }
}

function envSettings(): AiProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: "global",
    embeddingBaseUrl: config.EMBEDDING_BASE_URL,
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: SUPPORTED_EMBEDDING_DIMENSIONS,
    embeddingApiKey: config.EMBEDDING_API_KEY || null,
    llmBaseUrl: config.LLM_BASE_URL,
    llmModel: config.LLM_MODEL,
    llmApiKey: config.LLM_API_KEY || null,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    metadata: {
      defaultSearchMode: config.DEFAULT_SEARCH_MODE,
      defaultSearchTopK: DEFAULT_SEARCH_TOP_K,
      defaultChunkingMode: DEFAULT_CHUNKING_MODE,
      chunkTokenLimit: DEFAULT_CHUNK_TOKEN_LIMIT,
      chunkOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS
    },
    createdAt: now,
    updatedAt: now
  };
}

function toPublicSettings(settings: AiProviderSettingsRecord): PublicAiProviderSettings {
  const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
  return {
    id: "global",
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDimensions: settings.embeddingDimensions,
    hasEmbeddingApiKey: (settings.embeddingApiKey?.trim() ?? "").length > 0,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    hasLlmApiKey: (settings.llmApiKey?.trim() ?? "").length > 0,
    llmTimeoutMs: settings.llmTimeoutMs,
    llmMaxRetries: settings.llmMaxRetries,
    defaultSearchMode: readDefaultSearchMode(settings.metadata),
    defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
    defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
    chunkTokenLimit,
    chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
    updatedAt: settings.updatedAt
  };
}

function readDefaultSearchMode(metadata: Record<string, unknown>): SearchMode {
  return metadata.defaultSearchMode === "standard" ? "standard" : "fast";
}

function readDefaultChunkingMode(metadata: Record<string, unknown>): ChunkingMode {
  return metadata.defaultChunkingMode === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return clampInteger(value, fallback, min, max);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export const aiSettingsService = new AiSettingsService();
