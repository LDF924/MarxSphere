// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// backup-service.ts — 知识库轻量备份/恢复(.sagbak)
// 引入背景: Zleap-AI/SAG 评审 P1 — 参照 OCTX 设计契约(semver/清单/完整性校验/向量声明),
// 用本地表结构实现: PG(pg_dump) + Neo4j(JSONL) + manifest.json
// 与现有 E 盘脚本(E:\SAG-backups\backup-pg.sh 每日 pg_dump -F c)并存:
//   本服务是"可手动触发 + 带清单校验 + 覆盖图谱 + 可恢复"的完整方案, 脚本是轻量兜底。
// 边界: Cognee LanceDB 在仓库外(COGNEE_DIR), 明确不支持(manifest.warnings)。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import neo4j, { type Driver, type Session } from "neo4j-driver";
import { pool } from "../db/pool.js";
import { config } from "../config/env.js";

// ═══ 常量 ═══

export const BACKUP_FORMAT = "sag-knowledge-base";
export const BACKUP_VERSION = "1.0.0";
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_MODEL = "text-embedding-v4";

const PG_CONTAINER = "sag_lite_postgres";
const PG_USER = "sag_lite";
const PG_DB = "sag_lite";
const NEO4J_AUTH = { user: "neo4j", password: "neo4j123" };
const NEO4J_PORTS = { graphiti: 11001, cognee: 11003 } as const;
const NEO4J_BATCH = 10000;

export interface BackupPartMeta {
  sha256: string;
  size: number;
  rows?: Record<string, number>;
  nodes?: number;
  relationships?: number;
  skipped?: boolean;
}

export interface BackupManifest {
  format: string;
  version: string;
  created_at: string;
  generator: { name: string; version: string };
  schema_version: string;
  parts: Record<string, BackupPartMeta>;
  counts: Record<string, number>;
  embedding: { dimensions: number; model: string };
  includes: { postgres: boolean; graphiti: boolean; cognee: boolean; lancedb: boolean };
  warnings: string[];
}

export interface BackupSummary {
  id: string;
  name: string;
  path: string;
  size: number;
  manifest: BackupManifest | null;
  createdAt: string;
  restoredAt: string | null;
  status: string;
}

// ═══ 纯函数(可单测) ═══

export function computeSha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildManifest(input: {
  createdAt: string;
  schemaVersion: string;
  parts: Record<string, BackupPartMeta>;
  counts: Record<string, number>;
  warnings: string[];
}): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: input.createdAt,
    generator: { name: "SAG", version: "1.0.0" },
    schema_version: input.schemaVersion,
    parts: input.parts,
    counts: input.counts,
    embedding: { dimensions: EMBEDDING_DIMENSIONS, model: EMBEDDING_MODEL },
    includes: { postgres: true, graphiti: true, cognee: true, lancedb: false },
    warnings: [
      "Cognee LanceDB 向量库位于仓库外(COGNEE_DIR), 不在备份范围内",
      ...input.warnings,
    ],
  };
}

export function buildRestorePlan(
  manifest: BackupManifest,
): Array<{ part: string; action: "skip" | "restore"; reason?: string }> {
  return Object.entries(manifest.parts).map(([part, meta]) => ({
    part,
    action: meta.skipped ? "skip" : "restore",
    reason: meta.skipped ? "备份时已跳过" : undefined,
  }));
}

// ═══ 工具 ═══

function backupDir(): string {
  return join(config.BACKUP_DIR || "backups");
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(Buffer.from(chunk));
  return hash.digest("hex");
}

// ═══ Neo4j 导出(JSONL 两遍法) ═══

const _neo4jDrivers = new Map<number, Driver>();

function neo4jDriver(port: number): Driver {
  let driver = _neo4jDrivers.get(port);
  if (!driver) {
    driver = neo4j.driver(`bolt://127.0.0.1:${port}`, neo4j.auth.basic(NEO4J_AUTH.user, NEO4J_AUTH.password), {
      connectionTimeout: 8000,
    });
    _neo4jDrivers.set(port, driver);
  }
  return driver;
}

async function isNeo4jUp(port: number): Promise<boolean> {
  try {
    const driver = neo4jDriver(port);
    await driver.getServerInfo();
    return true;
  } catch {
    return false;
  }
}

async function exportNeo4jToJsonl(port: number, outPath: string): Promise<{ nodes: number; relationships: number }> {
  const driver = neo4jDriver(port);
  const session: Session = driver.session();
  const stream = createWriteStream(outPath, { flags: "w" });
  let nodes = 0;
  let relationships = 0;
  try {
    // 第一遍: 节点(分页)
    let skip = 0;
    for (;;) {
      const result = await session.run(
        `MATCH (n) RETURN id(n) AS nid, labels(n) AS labels, properties(n) AS props ORDER BY nid SKIP $skip LIMIT $limit`,
        { skip: neo4j.int(skip), limit: neo4j.int(NEO4J_BATCH) },
      );
      const rows = result.records;
      if (rows.length === 0) break;
      for (const record of rows) {
        stream.write(
          JSON.stringify({
            type: "node",
            nid: (record.get("nid") as any).toNumber ? (record.get("nid") as any).toNumber() : record.get("nid"),
            labels: record.get("labels"),
            props: record.get("props"),
          }) + "\n",
        );
      }
      nodes += rows.length;
      if (rows.length < NEO4J_BATCH) break;
      skip += rows.length;
    }
    // 第二遍: 关系(分页)
    skip = 0;
    for (;;) {
      const result = await session.run(
        `MATCH ()-[r]->() RETURN id(r) AS rid, id(startNode(r)) AS src, id(endNode(r)) AS dst, type(r) AS t, properties(r) AS props ORDER BY rid SKIP $skip LIMIT $limit`,
        { skip: neo4j.int(skip), limit: neo4j.int(NEO4J_BATCH) },
      );
      const rows = result.records;
      if (rows.length === 0) break;
      for (const record of rows) {
        const num = (v: any) => (v && typeof v.toNumber === "function" ? v.toNumber() : v);
        stream.write(
          JSON.stringify({
            type: "rel",
            rid: num(record.get("rid")),
            src: num(record.get("src")),
            dst: num(record.get("dst")),
            t: record.get("t"),
            props: record.get("props"),
          }) + "\n",
        );
      }
      relationships += rows.length;
      if (rows.length < NEO4J_BATCH) break;
      skip += rows.length;
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await session.close();
  }
  return { nodes, relationships };
}

// ═══ PG 导出 ═══

async function pgRowCounts(): Promise<Record<string, number>> {
  const tables = [
    "sources", "documents", "source_chunks", "document_sections",
    "entity_types", "entities", "events", "event_entities",
    "external_entities", "knowledge_pages", "page_entries", "document_versions",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      const r = await pool.query(`select count(*) as c from ${table}`);
      counts[table] = Number(r.rows[0]?.c ?? 0);
    } catch {
      counts[table] = 0; // 表不存在(旧库)则计 0
    }
  }
  return counts;
}

async function exportPgSql(outPath: string, schemaOnly: boolean): Promise<void> {
  const args = ["pg_dump", "-U", PG_USER, "-d", PG_DB, "--no-owner", "--no-privileges"];
  if (schemaOnly) args.push("--schema-only");
  else args.push("--data-only", "--column-inserts");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", PG_CONTAINER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stream = createWriteStream(outPath, { flags: "w" });
    child.stdout.pipe(stream);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      stream.end(() => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump 失败 (${code}): ${stderr.slice(0, 500)}`));
      });
    });
    child.on("error", (e) => reject(new Error(`docker exec 失败: ${e.message}`)));
  });
}

// ═══ 核心编排 ═══

/** 保留策略: 创建新备份后清理超出 BACKUP_KEEP 的旧备份(0=不清理) */
export async function pruneOldBackups(keep: number): Promise<string[]> {
  if (keep <= 0) return [];
  const r = await pool.query(
    `select id, path from backups where status = 'completed' order by created_at desc`,
  );
  const removed: string[] = [];
  for (const row of r.rows.slice(keep)) {
    try {
      await rm(String(row.path), { recursive: true, force: true });
    } catch {
      // 目录删除失败不阻塞元数据清理
    }
    await pool.query(`delete from backups where id = $1`, [row.id]);
    removed.push(String(row.path));
  }
  return removed;
}

export async function createBackup(input: { includeGraphs?: boolean } = {}): Promise<BackupSummary> {
  const includeGraphs = input.includeGraphs ?? true;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const name = `sagbak_${stamp}`;
  const dir = join(backupDir(), `${name}.sagbak`);
  const tmpDir = join(backupDir(), `${name}.tmp`);
  await mkdir(tmpDir, { recursive: true });

  const warnings: string[] = [];
  const parts: Record<string, BackupPartMeta> = {};

  try {
    // 1. PG 数据
    const pgDataPath = join(tmpDir, "pg_data.sql");
    await exportPgSql(pgDataPath, false);
    const pgDataStat = await stat(pgDataPath);
    parts["pg_data.sql"] = {
      sha256: await fileSha256(pgDataPath),
      size: pgDataStat.size,
      rows: await pgRowCounts(),
    };

    // 2. PG schema(冗余快照, 恢复时全量回放)
    const schemaPath = join(tmpDir, "schema.sql");
    await exportPgSql(schemaPath, true);
    const schemaStat = await stat(schemaPath);
    parts["schema.sql"] = { sha256: await fileSha256(schemaPath), size: schemaStat.size };

    // 3. Neo4j 两库
    for (const [engine, port] of Object.entries(NEO4J_PORTS) as Array<[string, number]>) {
      const partName = `neo4j_${engine}.json`;
      if (!includeGraphs) {
        parts[partName] = { sha256: "", size: 0, skipped: true };
        warnings.push(`${engine} 图谱已跳过(includeGraphs=false)`);
        continue;
      }
      if (!(await isNeo4jUp(port))) {
        parts[partName] = { sha256: "", size: 0, skipped: true };
        warnings.push(`${engine} 容器未运行(bolt://127.0.0.1:${port}), 已跳过; 启动: docker compose up -d neo4j-${engine === "graphiti" ? "graphiti" : "cognee"}`);
        continue;
      }
      const path = join(tmpDir, partName);
      const { nodes, relationships } = await exportNeo4jToJsonl(port, path);
      const s = await stat(path);
      parts[partName] = { sha256: await fileSha256(path), size: s.size, nodes, relationships };
    }

    // 4. manifest
    const counts = parts["pg_data.sql"].rows ?? {};
    const manifest = buildManifest({
      createdAt: new Date().toISOString(),
      schemaVersion: "001-101",
      parts,
      counts,
      warnings,
    });
    await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    parts["manifest.json"] = {
      sha256: await fileSha256(join(tmpDir, "manifest.json")),
      size: (await stat(join(tmpDir, "manifest.json"))).size,
    };

    // 5. 原子提交: tmp → 正式目录
    await rm(dir, { recursive: true, force: true });
    await rename(tmpDir, dir);

    // 6. 登记元数据
    const totalSize = Object.values(parts).reduce((sum, p) => sum + (p.size ?? 0), 0);
    const id = randomUUID();
    await pool.query(
      `insert into backups (id, name, path, manifest, size, status)
       values ($1, $2, $3, $4, $5, 'completed')`,
      [id, name, dir, manifest, totalSize],
    );

    return {
      id, name, path: dir, size: totalSize, manifest, createdAt: manifest.created_at, restoredAt: null, status: "completed",
    };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  } finally {
    // 保留策略: 创建成功后清理超出 BACKUP_KEEP 的旧备份(防磁盘堆积)
    if (config.BACKUP_KEEP > 0) {
      try {
        await pruneOldBackups(config.BACKUP_KEEP);
      } catch (e) {
        // 清理失败不影响本次备份结果
        console.error("[backup] pruneOldBackups failed:", e instanceof Error ? e.message : String(e));
      }
    }
  }
}

export async function listBackups(): Promise<BackupSummary[]> {
  const r = await pool.query(`select id, name, path, manifest, size, created_at, restored_at, status from backups order by created_at desc`);
  return r.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    size: Number(row.size ?? 0),
    manifest: row.manifest as BackupManifest | null,
    createdAt: String(row.created_at),
    restoredAt: row.restored_at ? String(row.restored_at) : null,
    status: String(row.status),
  }));
}

export async function verifyBackup(backupId: string): Promise<{ ok: boolean; mismatches: string[] }> {
  const r = await pool.query(`select path, manifest from backups where id = $1`, [backupId]);
  if (r.rows.length === 0) throw new Error("备份不存在");
  const dir = String(r.rows[0].path);
  const manifest = r.rows[0].manifest as BackupManifest;
  const mismatches: string[] = [];
  for (const [part, meta] of Object.entries(manifest.parts)) {
    if (meta.skipped) continue;
    const path = join(dir, part);
    try {
      const actual = await fileSha256(path);
      if (actual !== meta.sha256) mismatches.push(`${part}: sha256 不符`);
    } catch {
      mismatches.push(`${part}: 文件缺失`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export async function deleteBackup(backupId: string): Promise<void> {
  const r = await pool.query(`select path from backups where id = $1`, [backupId]);
  if (r.rows.length === 0) return;
  await rm(String(r.rows[0].path), { recursive: true, force: true });
  await pool.query(`delete from backups where id = $1`, [backupId]);
}

// ═══ 恢复(全量替换, 幂等) ═══

async function runPgSqlFile(sqlPath: string): Promise<void> {
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn("docker", ["exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    createReadStream(sqlPath).pipe(child.stdin);
  });
  if (result.code !== 0) throw new Error(`psql 执行失败 (${result.code}): ${result.stderr.slice(0, 500)}`);
}

async function clearNeo4j(port: number): Promise<void> {
  const driver = neo4jDriver(port);
  const session: Session = driver.session();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
  } finally {
    await session.close();
  }
}

async function restoreNeo4jFromJsonl(port: number, jsonlPath: string): Promise<{ nodes: number; relationships: number }> {
  const driver = neo4jDriver(port);
  const session: Session = driver.session();
  const idMap = new Map<number, number>();
  try {
    const lineReader = createReadStream(jsonlPath, { encoding: "utf-8" });
    let buffer = "";
    const lines: string[] = [];
    for await (const chunk of lineReader) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts);
      while (lines.length >= 500) {
        await flushBatch(lines.splice(0, 500), session, idMap);
      }
    }
    if (buffer.trim()) lines.push(buffer);
    while (lines.length > 0) {
      await flushBatch(lines.splice(0, 500), session, idMap);
    }
  } finally {
    await session.close();
  }
  return { nodes: idMap.size, relationships: relCount };
}

let relCount = 0;

async function flushBatch(
  lines: string[],
  session: Session,
  idMap: Map<number, number>,
): Promise<void> {
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === "node") {
      const result = await session.run(
        `CREATE (n) SET n = $props SET n:_sag_restored_labels RETURN id(n) AS nid`,
        { props: row.props ?? {} },
      );
      const newId = (result.records[0]?.get("nid") as any).toNumber();
      idMap.set(row.nid, newId);
      // 标签无法参数化, 用 UNWIND 方式: 先建节点再逐个加标签
      if (Array.isArray(row.labels) && row.labels.length > 0) {
        // 用 merge 避免重复: 直接再次匹配设置标签
        await session.run(`MATCH (n) WHERE id(n) = $id SET n:${row.labels.map((l: string) => `\`${l}\``).join(":")}`, { id: newId });
      }
    } else if (row.type === "rel") {
      const src = idMap.get(row.src);
      const dst = idMap.get(row.dst);
      if (src === undefined || dst === undefined) continue; // 孤立关系跳过
      await session.run(
        `MATCH (a) WHERE id(a) = $src MATCH (b) WHERE id(b) = $dst CREATE (a)-[r:${row.t}]->(b) SET r = $props`,
        { src: neo4j.int(src), dst: neo4j.int(dst), props: row.props ?? {} },
      );
      relCount++;
    }
  }
}

export async function restoreBackup(
  backupId: string,
): Promise<{ restored: string[]; counts: Record<string, number> }> {
  // 1. 读元数据 + 校验清单
  const r = await pool.query(`select path, manifest from backups where id = $1`, [backupId]);
  if (r.rows.length === 0) throw new Error("备份不存在");
  const dir = String(r.rows[0].path);
  const manifest = r.rows[0].manifest as BackupManifest;

  const { ok, mismatches } = await verifyBackup(backupId);
  if (!ok) throw new Error(`备份校验失败: ${mismatches.join(", ")}`);

  const restored: string[] = [];

  // 2. PG: schema 重建(有 schema.sql 则全量回放, 否则 TRUNCATE 后导入)
  const schemaPath = join(dir, "schema.sql");
  const pgDataPath = join(dir, "pg_data.sql");
  try {
    await stat(schemaPath);
    await runPgSqlFile(schemaPath);
    restored.push("schema");
  } catch {
    // 无 schema.sql(老备份): TRUNCATE 核心表
    await pool.query(`truncate table event_entities, events, entities, entity_types, source_chunks, document_sections, documents, sources cascade`);
  }
  await runPgSqlFile(pgDataPath);
  restored.push("pg_data");

  // 3. Neo4j 重建(有 part 才执行)
  for (const [engine, port] of Object.entries(NEO4J_PORTS) as Array<[string, number]>) {
    const partName = `neo4j_${engine}.json`;
    const meta = manifest.parts[partName];
    if (!meta || meta.skipped) continue;
    const path = join(dir, partName);
    await clearNeo4j(port);
    const { nodes, relationships } = await restoreNeo4jFromJsonl(port, path);
    restored.push(`${engine}(nodes=${nodes}, rels=${relationships})`);
  }

  // 4. 校验: PG COUNT 对比
  const counts = await pgRowCounts();
  const manifestCounts = manifest.counts ?? {};
  const mismatched = Object.entries(manifestCounts).filter(
    ([table, expected]) => counts[table] !== expected,
  );
  if (mismatched.length > 0) {
    throw new Error(`恢复后行数校验不符: ${mismatched.map(([t, e]) => `${t}: 期望${e} 实际${counts[t]}`).join(", ")}`);
  }

  // 5. 收尾
  await pool.query(`update backups set restored_at = now(), status = 'completed' where id = $1`, [backupId]);
  return { restored, counts };
}
