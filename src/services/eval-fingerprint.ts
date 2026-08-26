// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// eval-fingerprint.ts — 评测数据指纹共享服务（V399-2 P2: stale 判定）
// 设计: docs/DATA-HASH-VERSIONING-DESIGN.md 3.3/改动点E
// 目标: 数据指纹是"基于哪批文献数据"的摘要, 数据变更 → 指纹变 → 旧评测结果可判 stale
// 共享方: scripts/eval-32-metrics.ts（评测启动算指纹写入输出）/ server.ts（列表返回当前指纹+每文件 stale）
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";

export interface EvalFingerprint {
  algorithm: string;
  value: string | null;      // 连 PG 失败/无文献时降级 null
  sampledAt: string;
}

/** 纯函数: 聚合 content_hash 列表 → sha256 指纹（排序+去重保证与行序无关的确定性） */
export function aggregateContentHashFingerprint(hashes: string[]): string {
  const sorted = [...new Set(hashes)].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/** 纯函数: 内容 → sha256 产物哈希（产物哈希登记 3.6） */
export function artifactHashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 计算当前数据指纹: 查库内全部文献 content_hash 聚合。
 * 连 PG 失败 → 返回 {value: null}（调用方降级处理, 不抛异常）。
 */
export async function computeDataFingerprint(
  projectId: string,
  opts?: { warn?: (msg: string) => void }
): Promise<EvalFingerprint> {
  const fp: EvalFingerprint = {
    algorithm: "sha256-of-doc-content-hashes",
    value: null,
    sampledAt: new Date().toISOString(),
  };
  try {
    const res = await pool.query(
      `select content_hash from documents
       where source_id = $1 and archived_at is null
         and content_hash is not null
       order by content_hash`,
      [projectId]
    );
    const hashes: string[] = res.rows.map((r: any) => r.content_hash);
    fp.value = aggregateContentHashFingerprint(hashes);
  } catch (e: any) {
    opts?.warn?.("数据指纹计算失败(PG不可用?), 降级为 null: " + String(e?.message || e).substring(0, 120));
  }
  return fp;
}

/** stale 判定: 历史指纹 vs 当前指纹 — 不一致(数据已变) → stale */
export function isStaleFingerprint(
  historical: EvalFingerprint | null | undefined,
  current: EvalFingerprint | null | undefined
): boolean {
  if (!historical || !current) return false;          // 缺指纹(旧产物/降级) → 不误判 stale
  if (!historical.value || !current.value) return false;
  return historical.value !== current.value;
}
