// 精确检测 documents_v2 中"正文里嵌了 JSON"的损坏文档
// 判据: 解析 content 为 tiptap JSON 后, 存在某个 text 节点的 text 以 {"type": 开头
import { pool } from "../src/db/pool.js";

interface Hit { depth: number; path: string; head: string }

function findNestedJson(node: unknown, depth = 0, path = "$"): Hit[] {
  const hits: Hit[] = [];
  if (!node || typeof node !== "object") return hits;
  const n = node as Record<string, any>;
  if (n.type === "text" && typeof n.text === "string") {
    const t = n.text.trim();
    if (t.startsWith("{") && /"type"\s*:/.test(t.slice(0, 40))) {
      hits.push({ depth, path, head: t.slice(0, 70) });
    }
  }
  if (Array.isArray(n.content)) {
    n.content.forEach((c: unknown, i: number) => hits.push(...findNestedJson(c, depth + 1, `${path}.content[${i}]`)));
  }
  return hits;
}

const r = await pool.query(
  `select id, title, length(content) as len, updated_at from documents_v2 order by updated_at desc limit 60`);
let bad = 0;
for (const row of r.rows) {
  let doc: unknown;
  try { doc = JSON.parse(row.content); } catch {
    console.log(`[非JSON] ${row.title} (${row.len}B) id=${row.id}`);
    continue;
  }
  const hits = findNestedJson(doc);
  if (hits.length) {
    bad++;
    console.log(`\n[X] ${row.title}  ${row.len}B  ${new Date(row.updated_at).toISOString().slice(0, 16)}`);
    console.log(`    id=${row.id}`);
    for (const h of hits.slice(0, 3)) console.log(`    嵌套深度${h.depth} @${h.path}  →  ${h.head}...`);
  }
}
console.log(`\n=== 检查 ${r.rows.length} 篇, 正文嵌 JSON 的 ${bad} 篇 ===`);
process.exit(0);
