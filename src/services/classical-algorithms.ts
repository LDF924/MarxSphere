// classical-algorithms.ts — 经典文本研究专属算法（纯算法，不依赖 LLM）
// 版本校勘 LCS diff / 互文段落对齐 / 概念语义漂移检测
import { pool } from "../db/pool.js";
import { embeddingClient } from "../ai/embedding-client.js";

// ═══ A. LCS 字符级 diff（版本校勘核心，不烧 token）═══
// 返回: 差异块列表（每块含 位置/类型: insert|delete|replace|equal/ 新旧文本）
export function lcsDiff(oldText: string, newText: string): Array<{
  type: "insert" | "delete" | "replace" | "equal";
  oldText: string;
  newText: string;
  oldStart: number;
  newStart: number;
}> {
  const a = oldText;
  const b = newText;
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "insert", oldText: "", newText: b, oldStart: 0, newStart: 0 }];
  if (m === 0) return [{ type: "delete", oldText: a, newText: "", oldStart: 0, newStart: 0 }];

  // DP LCS 表（n*m 空间，限制最大长度 20000 防爆内存）
  const MAX_LEN = 20000;
  if (n > MAX_LEN || m > MAX_LEN) {
    return [{ type: "replace", oldText: a.slice(0, 500) + "…(过长省略)", newText: b.slice(0, 500) + "…(过长省略)", oldStart: 0, newStart: 0 }];
  }
  const dp: Uint32Array[] = [new Uint32Array(m + 1)];
  for (let i = 1; i <= n; i++) {
    const row = new Uint32Array(m + 1);
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    dp.push(row);
  }

  // 回溯构建 diff
  const ops: Array<{ type: "insert" | "delete" | "replace" | "equal"; oldStart: number; newStart: number }> = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ type: "equal", oldStart: i - 1, newStart: j - 1 }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ type: "delete", oldStart: i - 1, newStart: j }); i--; }
    else { ops.push({ type: "insert", oldStart: i, newStart: j - 1 }); j--; }
  }
  while (i > 0) { ops.push({ type: "delete", oldStart: i - 1, newStart: 0 }); i--; }
  while (j > 0) { ops.push({ type: "insert", oldStart: 0, newStart: j - 1 }); j--; }
  ops.reverse();

  // 合并相邻同类 op + 生成差异块
  const blocks: Array<{ type: "insert" | "delete" | "replace" | "equal"; oldText: string; newText: string; oldStart: number; newStart: number }> = [];
  for (const op of ops) {
    const last = blocks[blocks.length - 1];
    if (op.type === "equal") {
      blocks.push({ type: "equal", oldText: a[op.oldStart], newText: b[op.newStart], oldStart: op.oldStart, newStart: op.newStart });
    } else if (op.type === "delete") {
      if (last?.type === "delete") { last.oldText += a[op.oldStart]; }
      else if (last?.type === "insert") { last.type = "replace"; last.oldText += a[op.oldStart]; }
      else blocks.push({ type: "delete", oldText: a[op.oldStart], newText: "", oldStart: op.oldStart, newStart: op.newStart });
    } else { // insert
      if (last?.type === "insert") { last.newText += b[op.newStart]; }
      else if (last?.type === "delete") { last.type = "replace"; last.newText += b[op.newStart]; }
      else blocks.push({ type: "insert", oldText: "", newText: b[op.newStart], oldStart: op.oldStart, newStart: op.newStart });
    }
  }
  return blocks;
}

/** 差异类型细化：replace 块中纯标点差异 → punctuation；数字差异 → numeric */
export function classifyDiffBlock(block: { type: string; oldText: string; newText: string }): string {
  if (block.type === "insert") return "增补";
  if (block.type === "delete") return "删改";
  if (block.type === "replace") {
    const oldPunct = (block.oldText.match(/[，。；：！？、""''（）《》—…]/g) ?? []).length;
    const newPunct = (block.newText.match(/[，。；：！？、""''（）《》—…]/g) ?? []).length;
    const oldOnly = block.oldText.replace(/[，。；：！？、""''（）《》—…\s]/g, "");
    const newOnly = block.newText.replace(/[，。；：！？、""''（）《》—…\s]/g, "");
    if (oldOnly === newOnly && oldPunct !== newPunct) return "标点";
    if (/[\d]/.test(oldOnly) || /[\d]/.test(newOnly)) return "数字改写";
    return "改写";
  }
  return "相同";
}

// ═══ B. 互文对照：段落对齐（embedding 余弦相似度）═══
// 输入: 两文本的段落列表 → 贪心匹配最相似段落对 → 对齐结果
export async function alignParagraphs(
  docA: Array<{ heading: string; content: string }>,
  docB: Array<{ heading: string; content: string }>
): Promise<Array<{
  aHeading: string; bHeading: string; aText: string; bText: string;
  similarity: number;
}>> {
  if (docA.length === 0 || docB.length === 0) return [];
  // 批量生成向量（10 条/批，上限 100 段）
  const limitA = docA.slice(0, 50);
  const limitB = docB.slice(0, 50);
  const vecA = await embeddingClient.batchGenerate(limitA.map((p) => p.heading + "\n" + p.content.substring(0, 500)));
  const vecB = await embeddingClient.batchGenerate(limitB.map((p) => p.heading + "\n" + p.content.substring(0, 500)));
  const cos = (v1: number[], v2: number[]) => {
    let dot = 0, n1 = 0, n2 = 0;
    for (let k = 0; k < v1.length; k++) { dot += v1[k] * v2[k]; n1 += v1[k] * v1[k]; n2 += v2[k] * v2[k]; }
    return n1 && n2 ? dot / (Math.sqrt(n1) * Math.sqrt(n2)) : 0;
  };
  // 贪心匹配（每次取全局最相似对，移除后继续）
  const usedA = new Set<number>(), usedB = new Set<number>();
  const pairs: Array<{ i: number; j: number; sim: number }> = [];
  while (usedA.size < limitA.length && usedB.size < limitB.length) {
    let best: { i: number; j: number; sim: number } | null = null;
    for (let i = 0; i < limitA.length; i++) {
      if (usedA.has(i)) continue;
      for (let j = 0; j < limitB.length; j++) {
        if (usedB.has(j)) continue;
        const sim = cos(vecA[i], vecB[j]);
        if (!best || sim > best.sim) best = { i, j, sim };
      }
    }
    if (!best || best.sim < 0.55) break; // 相似度低于 0.55 不再匹配
    pairs.push(best);
    usedA.add(best.i);
    usedB.add(best.j);
  }
  pairs.sort((x, y) => x.i - y.i);
  return pairs.map((p) => ({
    aHeading: limitA[p.i].heading,
    bHeading: limitB[p.j].heading,
    aText: limitA[p.i].content.substring(0, 400),
    bText: limitB[p.j].content.substring(0, 400),
    similarity: Math.round(p.sim * 1000) / 1000,
  }));
}

// ═══ C. 概念语义漂移检测（embedding 质心随时间漂移）═══
// 输入: 概念名 → 检索含概念的段落（带时间/来源）→ 按时段分窗 → 各窗质心 → 漂移距离
export async function semanticDrift(
  concept: string,
  sourceId: string,
  windows: Array<{ label: string; filter?: string }>
): Promise<{
  concept: string;
  windows: Array<{ label: string; centroidDist: number | null; count: number }>;
  driftSummary: string;
}> {
  const words = concept.replace(/[？?。，,、；;：:！!（）\(\)"「」『』《》【】\[\]{}''\s]/g, " ").split(" ").filter((w) => w.length >= 2).slice(0, 4);
  if (words.length === 0) return { concept, windows: [], driftSummary: "无法解析概念名" };
  const likeClauses = words.map((_, i) => `c.content ILIKE $${i + 2}`).join(" OR ");
  const res = await pool.query(
    `SELECT c.heading, c.content, d.title, d.created_at
     FROM source_chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.source_id = $1 AND (${likeClauses}) AND length(c.content) > 80
     ORDER BY d.created_at`,
    [sourceId, ...words.map((w) => `%${w}%`)]
  );
  const chunks = res.rows;
  if (chunks.length === 0) return { concept, windows: [], driftSummary: "知识库中未检索到该概念相关文本" };

  // 分窗：按时段过滤
  const windowResults: Array<{ label: string; centroidDist: number | null; count: number }> = [];
  let prevCentroid: number[] | null = null;
  for (const w of windows) {
    const inWindow = w.filter
      ? chunks.filter((c: any) => new Date(c.created_at) >= new Date(w.filter!.split("~")[0]) && new Date(c.created_at) <= new Date(w.filter!.split("~")[1]))
      : chunks;
    if (inWindow.length === 0) { windowResults.push({ label: w.label, centroidDist: null, count: 0 }); continue; }
    const vecs = await embeddingClient.batchGenerate(inWindow.slice(0, 20).map((c: any) => (c.heading || "") + "\n" + c.content.substring(0, 500)));
    const centroid = vecs[0].map((_, k) => vecs.reduce((s, v) => s + v[k], 0) / vecs.length);
    let dist = null;
    if (prevCentroid) {
      dist = Math.sqrt(centroid.reduce((s, v, k) => s + (v - prevCentroid![k]) ** 2, 0));
    }
    windowResults.push({ label: w.label, centroidDist: dist === null ? null : Math.round(dist * 1000) / 1000, count: vecs.length });
    prevCentroid = centroid;
  }
  const driftSummary = windowResults.filter((w) => w.centroidDist !== null).length >= 2
    ? (() => {
        const dists = windowResults.filter((w) => w.centroidDist !== null).map((w) => w.centroidDist!);
        const max = Math.max(...dists);
        const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
        return max > 0.15 ? `检测到显著语义漂移（最大窗间距离 ${max.toFixed(3)}，均值 ${avg.toFixed(3)}）——概念在不同时期语义发生明显变化` : `语义相对稳定（最大窗间距离 ${max.toFixed(3)}，均值 ${avg.toFixed(3)}）——概念语义随时间变化不大`;
      })()
    : "数据不足以计算漂移（需至少 2 个时段）";
  return { concept, windows: windowResults, driftSummary };
}

export const classicalAlgorithms = { lcsDiff, classifyDiffBlock, alignParagraphs, semanticDrift };
