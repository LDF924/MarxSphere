// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// neo4j-query.ts — 安全的 Neo4j 参数化查询工具
// 替代 execSync + python -c 的脆弱的字符串拼接（中文实体名会转义出错）
// 用法: await neo4jQuery(11001, "MATCH (e:Entity {name: $n}) RETURN e", {n: "风险共担"})
import neo4j, { type Driver, type Session } from "neo4j-driver";

const AUTH = { user: "neo4j", password: "neo4j123" };
const drivers = new Map<number, Driver>();

function getDriver(port: number): Driver {
  let driver = drivers.get(port);
  if (!driver) {
    driver = neo4j.driver(`bolt://127.0.0.1:${port}`, neo4j.auth.basic(AUTH.user, AUTH.password), {
      connectionTimeout: 8000,
      maxConnectionLifetime: 30 * 60 * 1000
    });
    drivers.set(port, driver);
  }
  return driver;
}

/**
 * 执行参数化 Cypher 查询（中文安全）
 * @param port Neo4j 端口（11001 Graphiti / 11003 Cognee）
 * @param cypher 含 $参数的查询
 * @param params 参数对象
 * @param timeoutMs 超时
 */
export async function neo4jQuery<T = Record<string, unknown>>(
  port: number,
  cypher: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000
): Promise<T[]> {
  const driver = getDriver(port);
  const session: Session = driver.session();
  try {
    // 参数规范化: JS number 会被 driver 序列化成 5.0, Neo4j LIMIT/offset 拒绝
    // → 整数参数自动转 neo4j.int
    const normalizedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      normalizedParams[key] = Number.isInteger(value) ? neo4j.int(value as number) : value;
    }
    const result = await session.run(cypher, normalizedParams, { timeout: timeoutMs });
    return result.records.map((record) => {
      // toObject() 的 key 可能是 "e.name"（带别名前缀），规范化：取点号后最后一段
      const obj = record.toObject() as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const shortKey = key.includes(".") ? key.split(".").pop()! : key;
        normalized[shortKey] = value;
      }
      return normalized as T;
    });
  } finally {
    await session.close().catch(() => {});
  }
}

/** 关闭所有连接（进程退出时） */
export async function closeNeo4jDrivers(): Promise<void> {
  await Promise.all(Array.from(drivers.values()).map((driver) => driver.close().catch(() => {})));
  drivers.clear();
}
