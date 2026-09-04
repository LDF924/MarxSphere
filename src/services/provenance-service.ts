// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// provenance-service.ts — 文件级溯源(移植 ai4s-research/open-science provenance 机制, MIT)
// 每次 agent 写文件 → append 一条记录到 data/provenance/provenance.jsonl(append-only, 单行 JSON)
// 版本号按文件路径递增 → 可回看文件演化。详见 docs/PROVENANCE-DESIGN.md。
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProvenanceRecord {
  path: string;          // 相对 agent_workspace 的路径
  version: number;       // 该文件版本号(按路径递增: 1,2,3…)
  ts: string;            // ISO 时间
  tool: string;          // 哪个工具写的: file_write/apply_patch/todo_update/run_code…
  sessionId?: string;
  model?: string;
  contentHash: string;   // 写入内容 sha256(前 12 位)
  size: number;          // 字节数
  op: "write" | "delete" | "patch";
  runId?: string;        // 关联的任务/run(可复现入口)
}

function provenanceDir(): string {
  return path.join(process.env.SAG_ROOT || process.cwd(), "data", "provenance");
}

export function provenanceFile(): string {
  return path.join(provenanceDir(), "provenance.jsonl");
}

// 内存版本计数(进程内按路径递增); 首次启动扫描 JSONL 兜底
const versionCache = new Map<string, number>();
let scanned = false;

async function ensureDir(): Promise<void> {
  await fs.mkdir(provenanceDir(), { recursive: true });
}

async function scanVersions(): Promise<void> {
  if (scanned) return;
  scanned = true;
  try {
    const text = await fs.readFile(provenanceFile(), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ProvenanceRecord;
        versionCache.set(rec.path, Math.max(versionCache.get(rec.path) ?? 0, rec.version));
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 = 首次 */ }
}

// 串行化 append(Mutex 防并发写坏行)
let chain: Promise<void> = Promise.resolve();

/** 记录一次文件写入(Mutex 串行 append; fire-and-forget 调用) */
export async function recordProvenance(
  rec: Omit<ProvenanceRecord, "version" | "ts" | "contentHash" | "size"> & { content?: string },
): Promise<void> {
  const full: ProvenanceRecord = {
    ...rec,
    ts: new Date().toISOString(),
    contentHash: createHash("sha256").update(rec.content ?? "").digest("hex").slice(0, 12),
    size: Buffer.byteLength(rec.content ?? "", "utf8"),
    version: 0,
  };
  chain = chain.then(async () => {
    await ensureDir();
    await scanVersions();
    const next = (versionCache.get(rec.path) ?? 0) + 1;
    versionCache.set(rec.path, next);
    full.version = next;
    await fs.appendFile(provenanceFile(), JSON.stringify(full) + "\n", "utf8");
  });
  await chain;
}

/** 查询留痕: 按时间倒序, 可按 path/sessionId 过滤, 键集分页 */
export async function queryProvenance(opts: {
  path?: string;
  sessionId?: string;
  limit?: number;
  cursor?: string; // 上一页最后一条 ts(简化游标)
}): Promise<{ records: ProvenanceRecord[]; nextCursor?: string }> {
  try {
    const text = await fs.readFile(provenanceFile(), "utf8");
    const rows: ProvenanceRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ProvenanceRecord;
        if (opts.path && rec.path !== opts.path) continue;
        if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
        rows.push(rec);
      } catch { /* 坏行跳过 */ }
    }
    rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const limit = opts.limit ?? 50;
    let start = 0;
    if (opts.cursor) {
      const idx = rows.findIndex((r) => r.ts === opts.cursor);
      if (idx >= 0) start = idx + 1;
    }
    const page = rows.slice(start, start + limit);
    const nextCursor = rows.length > start + limit ? page[page.length - 1]?.ts : undefined;
    return { records: page, nextCursor };
  } catch {
    return { records: [] };
  }
}

/** 单文件全部版本历史(升序) */
export async function fileHistory(filePath: string): Promise<ProvenanceRecord[]> {
  const { records } = await queryProvenance({ path: filePath, limit: 10_000 });
  return records.reverse();
}
