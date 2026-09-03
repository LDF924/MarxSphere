// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// capabilities-service.ts — 运行时能力探测(对齐 Zleap capabilities 机制)
// 参照: zleap/sag/core/adapters/capabilities.py + 本地 backup-service isNeo4jUp 先例
// 探测: PG 健康 / Graphiti(11001) / Cognee(11003) / rerank 配置 / embedding 模型
import neo4j, { type Driver } from "neo4j-driver";
import { pool } from "../db/pool.js";
import { config } from "../config/env.js";
import { getVectorStore, getLanceDbStore } from "../db/vector-store.js";
import { getLlmEndpoint } from "../ai/llm-common.js";

const NEO4J_AUTH = { user: "neo4j", password: "neo4j123" };
const NEO4J_PORTS = { graphiti: 11001, cognee: 11003 } as const;

const _drivers = new Map<number, Driver>();

function neo4jDriver(port: number): Driver {
  let driver = _drivers.get(port);
  if (!driver) {
    driver = neo4j.driver(`bolt://127.0.0.1:${port}`, neo4j.auth.basic(NEO4J_AUTH.user, NEO4J_AUTH.password), {
      connectionTimeout: 5000,
    });
    _drivers.set(port, driver);
  }
  return driver;
}

export interface CapabilityStatus {
  ok: boolean;
  detail?: string;
}

export interface CapabilitiesReport {
  pg: CapabilityStatus;
  graphiti: CapabilityStatus;
  cognee: CapabilityStatus;
  rerank: CapabilityStatus;
  embedding: CapabilityStatus;
  vectorStore: CapabilityStatus;
  lancedb: CapabilityStatus;
  /** 检索源可用性(供前端降级提示) */
  retrievalSources: { pg: boolean; graphiti: boolean; cognee: boolean };
  /** OpenAI 端点可见的能力边界 */
  openai: { search: boolean; citedAnswers: boolean };
}

async function probeNeo4j(port: number): Promise<CapabilityStatus> {
  try {
    const driver = neo4jDriver(port);
    await driver.getServerInfo();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 120) : String(error) };
  }
}

export async function probeCapabilities(): Promise<CapabilitiesReport> {
  // PG 健康
  let pg: CapabilityStatus = { ok: false, detail: "unchecked" };
  try {
    await pool.query("select 1");
    pg = { ok: true };
  } catch (error) {
    pg = { ok: false, detail: error instanceof Error ? error.message.slice(0, 120) : String(error) };
  }

  // Neo4j 两库(并行探测)
  const [graphiti, cognee] = await Promise.all([probeNeo4j(NEO4J_PORTS.graphiti), probeNeo4j(NEO4J_PORTS.cognee)]);

  // rerank 配置(端点可解析即视为可用)
  let rerank: CapabilityStatus = { ok: false, detail: "未配置" };
  try {
    const ep = getLlmEndpoint({});
    if (config.RERANK_BASE_URL || (ep && ep.url)) {
      rerank = { ok: true, detail: config.RERANK_MODEL || "default" };
    }
  } catch {
    rerank = { ok: false, detail: "rerank 端点不可用" };
  }

  // embedding(向量存储健康即视为可用)
  const vectorStore = await getVectorStore().health();
  const embedding: CapabilityStatus = vectorStore.ok
    ? { ok: true, detail: config.EMBEDDING_MODEL }
    : { ok: false, detail: vectorStore.detail };

  // LanceDB 可选
  const lance = getLanceDbStore();
  const lancedb: CapabilityStatus = lance
    ? await lance.health()
    : { ok: false, detail: "未安装(可选)" };

  return {
    pg,
    graphiti,
    cognee,
    rerank,
    embedding,
    vectorStore,
    lancedb,
    retrievalSources: { pg: pg.ok, graphiti: graphiti.ok, cognee: cognee.ok },
    openai: { search: pg.ok, citedAnswers: pg.ok },
  };
}
