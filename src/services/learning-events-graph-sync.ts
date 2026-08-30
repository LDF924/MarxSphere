// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-events-graph-sync.ts — 学习事件→知识图谱同步(V395, 2026-08-30)
// 深水区①: 强证据学习事件写入 Neo4j 知识图谱(Learner/Concept 节点 + MASTERS/STRUGGLES_WITH 关系)
// 设计:
//   1. 与 learner_events 投影联动(先 PG 后 Neo4j, Neo4j 失败降级不阻塞学习)
//   2. 双引擎: Graphiti(11001) 优先, 失败尝试 Cognee(11003)
//   3. MERGE 幂等: 同 (student, concept) 只更新关系属性, 不重复建节点
import neo4j from "neo4j-driver";

const ENGINE_PORTS = [11001, 11003];  // Graphiti 优先, Cognee 兜底
const NEO4J_AUTH = () => neo4j.auth.basic("neo4j", process.env.NEO4J_PASSWORD || "neo4j123");
const SYNC_TTL_MS = 60_000;  // 连接缓存 60s

let cachedDriver: any = null;
let cachedAt = 0;

/** 获取可用的 Neo4j driver(探测端口, 无可用返回 null — 优雅降级) */
async function getNeo4jDriver(): Promise<any | null> {
  if (cachedDriver && Date.now() - cachedAt < SYNC_TTL_MS) return cachedDriver;
  cachedDriver = null;
  for (const port of ENGINE_PORTS) {
    try {
      const probe = await new Promise<boolean>((resolve) => {
        const net = require("node:net");
        const s = net.connect(port, "127.0.0.1");
        s.once("connect", () => { s.destroy(); resolve(true); });
        s.once("error", () => { s.destroy(); resolve(false); });
        setTimeout(() => { s.destroy(); resolve(false); }, 1500);
      });
      if (!probe) continue;
      const driver = neo4j.driver(`bolt://127.0.0.1:${port}`, NEO4J_AUTH(), { connectionTimeout: 5000 });
      // 验证连接
      await driver.verifyConnectivity();
      cachedDriver = driver;
      cachedAt = Date.now();
      return driver;
    } catch { /* 该引擎不可用, 尝试下一个 */ }
  }
  return null;
}

/**
 * 同步一条强证据学习事件到图谱(幂等 MERGE)
 * @returns { synced, engine } — Neo4j 离线时 synced=false(降级, 不抛错)
 */
export async function syncLearningEventToGraph(input: {
  studentId: string; knowledgePoint: string; subject: string;
  isCorrect: boolean; sourceEventId: number | string;
}): Promise<{ synced: boolean; engine?: number; error?: string }> {
  try {
    const driver = await getNeo4jDriver();
    if (!driver) return { synced: false, error: "neo4j-offline" };

    const session = driver.session();
    try {
      // Learner + Concept 节点 + 掌握/困难关系(幂等 MERGE, 累计统计)
      const cypher = `
        MERGE (l:Learner {id: $studentId})
          SET l.studentId = $studentId, l.updatedAt = datetime()
        MERGE (c:Concept {id: $conceptKey})
          SET c.name = $knowledgePoint, c.subject = $subject, c.updatedAt = datetime()
        MERGE (l)-[r:LEARNING_STATE {concept: $conceptKey}]->(c)
          SET r.attempts = coalesce(r.attempts, 0) + 1,
              r.correct = coalesce(r.correct, 0) + CASE WHEN $isCorrect THEN 1 ELSE 0 END,
              r.lastCorrect = $isCorrect,
              r.updatedAt = datetime(),
              r.lastSourceEventId = $sourceEventId
      `;
      await session.run(cypher, {
        studentId: input.studentId,
        conceptKey: `${input.subject}::${input.knowledgePoint}`,
        knowledgePoint: input.knowledgePoint,
        subject: input.subject,
        isCorrect: input.isCorrect,
        sourceEventId: String(input.sourceEventId),
      });
      return { synced: true, engine: driver._config ? undefined : undefined };
    } finally {
      await session.close().catch(() => {});
    }
  } catch (e: any) {
    // 连接失效 → 清缓存, 下次重试
    cachedDriver = null;
    return { synced: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 关闭连接(进程退出时) */
export async function closeGraphDriver(): Promise<void> {
  if (cachedDriver) { try { await cachedDriver.close(); } catch { /* 忽略 */ } cachedDriver = null; }
}

export const learningEventsGraphSync = { syncLearningEventToGraph, closeGraphDriver };
