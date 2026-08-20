// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-asset-store.ts — 教育复用资产存储（按角色空间隔离）
// 学生端与教师端各自独立的资产空间（role=student / role=teacher）：
//   学生端操作只影响学生空间，教师端操作只影响教师空间，互不同步互不干扰。
// 预置内容（模板/案例/示例课程）两端各初始化一份（seed 时按 role 复制）。
import { pool } from "../db/pool.js";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.env.SAG_ROOT || path.resolve(process.cwd());

/** 列表（按角色空间过滤） */
export async function listAssets(input: { role: "student" | "teacher"; kind?: string }): Promise<Record<string, unknown>> {
  const role = input.role || "teacher";
  // 首次访问时按角色初始化预置内容
  await seedPublicForRole(role);

  let sql = `select id, role, kind, name, data, updated_at from edu_assets where role = $1`;
  const params: unknown[] = [role];
  if (input.kind) {
    params.push(input.kind);
    sql += ` and kind = $${params.length}`;
  }
  sql += ` order by updated_at desc`;
  const r = await pool.query(sql, params);
  return { ok: true, assets: r.rows, role };
}

/** 新增资产（进入当前角色空间） */
export async function addAsset(input: {
  role: "student" | "teacher"; kind: string; name: string; data: unknown;
}): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `insert into edu_assets (role, kind, name, data) values ($1, $2, $3, $4) returning id, role, kind, name, data`,
    [input.role, input.kind, input.name, JSON.stringify(input.data)]
  );
  return { ok: true, asset: r.rows[0] };
}

/** 删除资产（仅当前角色空间内） */
export async function deleteAsset(input: { role: "student" | "teacher"; id: number }): Promise<Record<string, unknown>> {
  const r = await pool.query(`delete from edu_assets where id = $1 and role = $2 returning id`, [input.id, input.role]);
  return { ok: true, deleted: (r.rowCount ?? 0) > 0 };
}

/** 按角色初始化预置内容（模板/案例，两端各一份，幂等） */
async function seedPublicForRole(role: string): Promise<void> {
  try {
    const count = await pool.query(`select count(*)::int as n from edu_assets where role = $1`, [role]);
    if ((count.rows[0]?.n || 0) > 0) return;

    // 模板：education-templates/*.json
    const tplDir = path.join(rootDir, "education-templates");
    if (fs.existsSync(tplDir)) {
      for (const f of fs.readdirSync(tplDir).filter((x) => x.endsWith(".json"))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(tplDir, f), "utf-8"));
          await pool.query(
            `insert into edu_assets (role, kind, name, data) values ($1, 'templates', $2, $3)`,
            [role, j.name || f, JSON.stringify(j)]
          );
        } catch { /* 忽略单个文件 */ }
      }
    }
    // 案例：data/education-cases.json
    const casesPath = path.join(rootDir, "data", "education-cases.json");
    if (fs.existsSync(casesPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(casesPath, "utf-8"));
        for (const c of j.cases || []) {
          await pool.query(
            `insert into edu_assets (role, kind, name, data) values ($1, 'cases', $2, $3)`,
            [role, c.title || c.id, JSON.stringify(c)]
          );
        }
      } catch { /* 忽略 */ }
    }
  } catch { /* 表未建时忽略 */ }
}

export const educationAssetStoreService = { listAssets, addAsset, deleteAsset };
