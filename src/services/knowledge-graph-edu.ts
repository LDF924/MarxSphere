// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// knowledge-graph-edu.ts — 教育知识点先修图 + 拓扑路径规划（复赛冲刺期实现）
// 基于 kp_points / kp_edges（迁移 080）：
//   ① 先修缺失检测：学习某知识点前，检测其先修是否未掌握（联动 knowledge_mastery）
//   ② 拓扑排序路径规划：按先修图生成有序学习链，跳过已掌握节点，输出「先修-目标」最短链
//   ③ 路径合理性校验：拓扑路径无先修逆序
// 复用: knowledge_mastery（掌握度过滤）
import { pool } from "../db/pool.js";

// ═══ ① 先修缺失检测 ═══
export async function checkPrerequisites(input: { studentId?: string; subject: string; knowledgePoint: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // 该知识点的直接先修（递归一层即可：直接先修 + 先修的先修）
  const direct = await pool.query(
    `select from_point from kp_edges where subject = $1 and to_point = $2 and edge_type = 'prerequisite'`,
    [input.subject, input.knowledgePoint]
  );
  const directPrereqs = direct.rows.map((r) => r.from_point as string);

  if (directPrereqs.length === 0) return { ok: true, knowledgePoint: input.knowledgePoint, missing: [], note: "无直接先修或图中未收录" };

  // 检查每个先修是否已掌握（knowledge_mastery ≥ 0.7）
  const missing: Array<{ point: string; masteryLevel: string; score: number }> = [];
  for (const p of directPrereqs) {
    const km = await pool.query(
      `select mastery_level, score from knowledge_mastery
       where student_id = $1 and subject = $2 and knowledge_point = $3`,
      [studentId, input.subject, p]
    );
    const row = km.rows[0] as { mastery_level: string; score: number } | undefined;
    const score = row ? Number(row.score) : 0;
    if (!row || score < 0.7) missing.push({ point: p, masteryLevel: row?.mastery_level ?? "unlearned", score });
  }

  return {
    ok: true,
    knowledgePoint: input.knowledgePoint,
    directPrereqs,
    missing,
    needReview: missing.length > 0,
    suggestion: missing.length > 0
      ? `先修「${missing.map((m) => m.point).join("、")}」未掌握（掌握度 <0.7），建议先复习后再学「${input.knowledgePoint}」`
      : `「${input.knowledgePoint}」先修均已掌握，可以开始学习`,
  };
}

// ═══ ② 拓扑排序路径规划 ═══
/** 有向图拓扑排序（Kahn 算法）；返回有序节点或检测到环 */
export function topoSort(adj: Map<string, string[]>, all: Set<string>): { order: string[]; cyclic: boolean } {
  const indeg = new Map<string, number>();
  for (const n of all) indeg.set(n, 0);
  for (const [, tos] of adj) for (const t of tos) indeg.set(t, (indeg.get(t) || 0) + 1);

  const queue: string[] = [];
  for (const [n, d] of indeg) if (d === 0) queue.push(n);
  const order: string[] = [];
  while (queue.length > 0) {
    // 按名称排序出队（确定性）
    queue.sort();
    const n = queue.shift()!;
    order.push(n);
    for (const t of adj.get(n) || []) {
      const nd = (indeg.get(t) || 1) - 1;
      indeg.set(t, nd);
      if (nd === 0) queue.push(t);
    }
  }
  return { order, cyclic: order.length !== all.size };
}

export async function planPath(input: {
  studentId?: string;
  subject: string;
  target: string;               // 目标知识点
  skipMastered?: boolean;       // 跳过已掌握节点（默认 true）
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const skipMastered = input.skipMastered !== false;

  // ① 取该科目全图（先修边）
  const edges = await pool.query(
    `select from_point, to_point from kp_edges where subject = $1 and edge_type = 'prerequisite'`,
    [input.subject]
  );
  const adj = new Map<string, string[]>();
  const all = new Set<string>([input.target]);
  for (const e of edges.rows as Array<{ from_point: string; to_point: string }>) {
    all.add(e.from_point); all.add(e.to_point);
    if (!adj.has(e.from_point)) adj.set(e.from_point, []);
    adj.get(e.from_point)!.push(e.to_point);
  }

  // ② 目标不在图中 → 无路径
  if (!all.has(input.target)) {
    return { ok: true, subject: input.subject, target: input.target, path: [], note: "目标知识点未在图中收录，无法规划先修路径" };
  }

  // ③ 拓扑排序（仅保留可达目标的子图：先收集所有先修节点）
  const reachable = new Set<string>();
  const collect = (n: string) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    // 找指向 n 的边（反向）
    for (const e of edges.rows as Array<{ from_point: string; to_point: string }>) {
      if (e.to_point === n) collect(e.from_point);
    }
  };
  collect(input.target);

  const subAdj = new Map<string, string[]>();
  for (const [from, tos] of adj) {
    if (reachable.has(from)) subAdj.set(from, tos.filter((t) => reachable.has(t)));
  }
  const { order, cyclic } = topoSort(subAdj, reachable);

  // ④ 跳过已掌握
  let filtered = order;
  if (skipMastered && order.length > 0) {
    const km = await pool.query(
      `select knowledge_point from knowledge_mastery
       where student_id = $1 and subject = $2 and mastery_level = 'mastered'`,
      [studentId, input.subject]
    );
    const mastered = new Set(km.rows.map((r) => r.knowledge_point as string));
    // 保留目标本身，跳过已掌握的中间先修
    filtered = order.filter((n) => n === input.target || !mastered.has(n));
  }

  return {
    ok: true,
    subject: input.subject,
    target: input.target,
    path: order,
    skipMastered,
    filteredPath: filtered,
    cyclic,
    note: cyclic ? "图中存在环，拓扑排序不完整（部分节点未覆盖）" : "拓扑有序，无先修逆序",
  };
}

// ═══ ③ 路径合理性校验（供评测）═══
export async function validatePath(input: { subject: string; path: string[] }): Promise<Record<string, unknown>> {
  const edges = await pool.query(
    `select from_point, to_point from kp_edges where subject = $1 and edge_type = 'prerequisite'`,
    [input.subject]
  );
  const prereqOf = new Map<string, string[]>();
  for (const e of edges.rows as Array<{ from_point: string; to_point: string }>) {
    if (!prereqOf.has(e.to_point)) prereqOf.set(e.to_point, []);
    prereqOf.get(e.to_point)!.push(e.from_point);
  }

  const pos = new Map<string, number>();
  input.path.forEach((n, i) => pos.set(n, i));

  const violations: Array<{ prereq: string; point: string }> = [];
  for (const [point, prereqs] of prereqOf) {
    const pPos = pos.get(point);
    if (pPos === undefined) continue;
    for (const pre of prereqs) {
      const prePos = pos.get(pre);
      if (prePos !== undefined && prePos > pPos) violations.push({ prereq: pre, point });
    }
  }

  return { ok: true, violations, valid: violations.length === 0, note: violations.length === 0 ? "路径无先修逆序" : `存在 ${violations.length} 处先修逆序` };
}

export const knowledgeGraphEduService = { checkPrerequisites, planPath, validatePath };
