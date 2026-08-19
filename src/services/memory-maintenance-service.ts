// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// memory-maintenance-service.ts — V391(P1-5): 记忆自动遗忘/合并
// 防记忆膨胀: 相似记忆自动归并 + 长期未召回的记忆自动遗忘
// 与 OpenViking 配合: 写入记忆时登记指纹, 定期整理(合并/遗忘)避免重复积累
import { pool } from "../db/pool.js";

/** 指纹: 内容归一化取前 24 字符（去空格标点, 判断近似重复） */
function fingerprint(content: string): string {
  return content.replace(/[\s，。；：、！？（）"'「」【】\n\r]/g, "").substring(0, 24);
}

/** 登记一条记忆（写入 OpenViking 前/后调用, 供整理用） */
export async function registerMemory(input: {
  category: string;
  subtype?: string;
  content: string;
}): Promise<{ merged: boolean; keptId?: number }> {
  if (!input.content || input.content.length < 10) return { merged: false };
  const fp = fingerprint(input.content);
  // 查相似指纹（同一分类下, 前缀 12 字相同视为近似重复）
  const similar = await pool.query(
    `select id, content from memory_maintenance
     where category = $1 and left(fingerprint, 12) = left($2, 12)
     order by written_at desc limit 1`,
    [input.category, fp]
  );
  if (similar.rows.length > 0) {
    // 近似重复 → 合并: 新条目指向旧条目（保留旧条目, 不重复写入）
    const r = await pool.query(
      `insert into memory_maintenance (category, subtype, content, fingerprint, merged_into_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.category, input.subtype ?? null, input.content, fp, similar.rows[0].id]
    );
    return { merged: true, keptId: Number(similar.rows[0].id) };
  }
  const r = await pool.query(
    `insert into memory_maintenance (category, subtype, content, fingerprint)
     values ($1, $2, $3, $4) returning id`,
    [input.category, input.subtype ?? null, input.content, fp]
  );
  return { merged: false, keptId: Number(r.rows[0].id) };
}

/** 标记记忆被召回（更新 last_recalled_at, 遗忘判定用） */
export async function touchMemory(memoryId: number): Promise<void> {
  await pool.query("update memory_maintenance set last_recalled_at = now() where id = $1", [memoryId]);
}

/**
 * 自动整理:
 * 1. 合并: 同分类同前缀指纹的已合并条目清理（旧条目保留）
 * 2. 遗忘: 超过 N 天未召回且写入超 M 天的条目标记可遗忘（默认 90 天未召回）
 * 返回整理统计
 */
export async function runMemoryMaintenance(opts?: { recallDays?: number }): Promise<{ merged: number; forgotten: number; total: number }> {
  const recallDays = opts?.recallDays ?? 90;
  // 1. 清理已合并的旧条目（merged_into_id 指向且保留条目仍存在 → 合并者删除）
  const merged = await pool.query(
    `delete from memory_maintenance where merged_into_id is not null returning id`
  );
  // 2. 遗忘: 写入超 30 天 且 从未召回 或 超过 recallDays 天未召回
  const forgotten = await pool.query(
    `delete from memory_maintenance
     where written_at < now() - interval '30 days'
       and (last_recalled_at is null or last_recalled_at < now() - make_interval(days => $1))`,
    [recallDays]
  );
  const total = await pool.query("select count(*) as n from memory_maintenance");
  return {
    merged: merged.rowCount ?? 0,
    forgotten: forgotten.rowCount ?? 0,
    total: Number(total.rows[0]?.n || 0),
  };
}

/** 当前记忆统计（前端展示） */
export async function memoryMaintenanceStats(): Promise<{ total: number; byCategory: Record<string, number>; stale: number }> {
  const total = await pool.query("select count(*) as n from memory_maintenance");
  const byCat = await pool.query("select category, count(*) as n from memory_maintenance group by category");
  const stale = await pool.query(
    `select count(*) as n from memory_maintenance
     where written_at < now() - interval '30 days' and (last_recalled_at is null or last_recalled_at < now() - interval '90 days')`
  );
  const byCategory: Record<string, number> = {};
  for (const r of byCat.rows) byCategory[r.category] = Number(r.n);
  return { total: Number(total.rows[0]?.n || 0), byCategory, stale: Number(stale.rows[0]?.n || 0) };
}

export const memoryMaintenanceService = {
  registerMemory,
  touchMemory,
  runMemoryMaintenance,
  memoryMaintenanceStats,
};
