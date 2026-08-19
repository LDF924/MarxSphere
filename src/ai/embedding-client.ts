// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { createHash } from "node:crypto";
import { normalizeVector } from "../db/vector.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { createModelCallLogger } from "../observability/model-call-log.js";

export interface EmbeddingClient {
  generate(text: string): Promise<number[]>;
  batchGenerate(texts: string[]): Promise<number[][]>;
}

export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  async generate(text: string): Promise<number[]> {
    const [embedding] = await this.batchGenerate([text]);
    return embedding;
  }

  async batchGenerate(texts: string[]): Promise<number[][]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteEmbedding) {
      const request = {
        url: "local://embedding/deterministic",
        method: "POST",
        body: {
          model: "deterministic-local",
          input: texts,
          dimensions: settings.embeddingDimensions
        }
      };
      const log = createModelCallLogger({
        kind: "embedding",
        operation: "batchGenerate",
        request
      });
      const embeddings = texts.map((text) => deterministicEmbedding(text, settings.embeddingDimensions));
      log.succeed({
        data: embeddings.map((embedding, index) => ({
          index,
          embedding
        }))
      });
      return embeddings;
    }

    // 阿里云 text-embedding-v4 限制单次最多 10 条，拆分成小批次
    const MAX_BATCH = 10;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH);
      const batchResult = await this.remoteBatchGenerate(settings, chunk);
      allEmbeddings.push(...batchResult);
    }
    return allEmbeddings;
  }

  private async remoteBatchGenerate(settings: any, texts: string[]): Promise<number[][]> {
    const url = `${settings.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;
    const body = {
      model: settings.embeddingModel,
      input: texts,
      dimensions: settings.embeddingDimensions
    };
    const log = createModelCallLogger({
      kind: "embedding",
      operation: "batchGenerate",
      request: {
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body
      }
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.embeddingApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const { responseText, responseBody } = await readResponseBody(response);

    if (!response.ok) {
      const error = new Error(`embedding request failed: ${response.status} ${responseText.slice(0, 500)}`);
      log.fail(error, {
        status: response.status,
        body: responseBody
      });
      throw error;
    }

    const json = responseBody as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embeddings = json.data?.map((item) => item.embedding ?? []) ?? [];
    if (embeddings.length !== texts.length) {
      const error = new Error(`embedding count mismatch: expected=${texts.length}, actual=${embeddings.length}`);
      log.fail(error, {
        status: response.status,
        body: responseBody
      });
      throw error;
    }
    for (const embedding of embeddings) {
      if (embedding.length !== settings.embeddingDimensions) {
        const error = new Error(`embedding dimension mismatch: expected=${settings.embeddingDimensions}, actual=${embedding.length}`);
        log.fail(error, {
          status: response.status,
          body: responseBody
        });
        throw error;
      }
    }
    log.succeed({
      status: response.status,
      body: responseBody
    });
    return embeddings;
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.trim().toLowerCase();
  const values = new Array<number>(dimensions).fill(0);
  let offset = 0;
  while (offset < dimensions) {
    const hash = createHash("sha256").update(`${normalized}:${offset}`).digest();
    for (const byte of hash) {
      if (offset >= dimensions) {
        break;
      }
      values[offset] = (byte / 255) * 2 - 1;
      offset += 1;
    }
  }
  return normalizeVector(values);
}

export const embeddingClient = new OpenAICompatibleEmbeddingClient();
